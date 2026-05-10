'use strict';
const logger = require('../../../logger');
const {
  db,
  saveCheckpoint, loadCheckpoint, deleteCheckpoint,
  backfillLocationChaptersFromScenes,
  getAllUserTokens, getBookSettings,
} = require('../../../db/schema');
const { narrativeLabels } = require('../narrative-labels');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, getBookPrompts,
  loadPageContents, groupByChapter, buildSinglePassBookText, cleanPageTextForClaude,
  bsGetAll, SINGLE_PASS_LIMIT, BATCH_SIZE, jobAbortControllers,
  _modelName, fmtTok, tps,
  createJob, enqueueJob, findActiveJobId,
} = require('../shared');
const { runNonCritical, buildBookSystemBlockText } = require('./utils');
const { invalidateRenamedChapterCaches, loadAndValidateCheckpoint, restorePhase1FromCheckpoint } = require('./checkpoint');
const { remapSzenen, remapAssignments, saveSzenenAndEvents, saveKontinuitaetResult } = require('./remap');
const {
  runPhase1, runPhase2, runPhase3, runPhase3b, runZeitstrahl,
  buildPrelimFigurenKompakt, runPhase3OrteCall,
} = require('./phases');

// ── Job: Komplettanalyse ─────────────────────────────────────────────────────
// Pipeline (token-optimiert):
//   P1 (Vollextraktion: Figuren+Orte+Fakten+Szenen+Events, parallel/Kapitel, SYSTEM_KOMPLETT_EXTRAKTION)
//      → Schema im System-Prompt gecacht; Szenen/Events mit Klarnamen (kein ID-Lookup nötig)
//   P2/P3 (Claude Multi-Pass parallel, sonst sequentiell):
//      P2 (Figuren konsolidieren + Soziogramm) → figNameToId aufbauen
//      P3 (Orte konsolidieren, prelim figurenKompakt im Prompt, idRemap post-hoc) → ortNameToId
//   P3b (Kapitelübergreifende Beziehungen, nur Multi-Pass, non-critical)
//   P5 Szenen remappen
//   P6 Zeitstrahl + P8 Kontinuität: parallel bei Claude (P8 ownt Progress-Bar), sonst sequentiell
async function runKomplettAnalyseJob(jobId, bookId, bookName, userEmail, userToken, provider = undefined) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const log = makeJobLogger(jobId);
  // call akzeptiert optional ein JSON-Schema als letztes Argument (11. Position in aiCall).
  // Schemas werden nur von lokalen Providern (ollama/llama) verwendet – Claude ignoriert sie.
  const call = (jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, schema) =>
    aiCall(jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, provider, schema);
  const effectiveProvider = provider || process.env.API_PROVIDER || 'claude';
  // SINGLE_PASS_LIMIT skaliert jetzt dynamisch mit MODEL_CONTEXT (siehe shared/loader.js).
  // Bei 200K-Kontext ≈ 420K Zeichen Single-Pass – reicht für fast alle Bücher.
  const singlePassLimit = SINGLE_PASS_LIMIT;
  const prompts = await getPrompts();
  const sys = await getBookPrompts(bookId, email);
  const tok = { in: 0, out: 0, ms: 0, inflight: new Map() };

  try {
    const cp = loadAndValidateCheckpoint(bookIdInt, email, log, jobId);

    // ── Seiten laden ──────────────────────────────────────────────────────────
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?filter[book_id]=' + bookId, userToken),
      bsGetAll('pages?filter[book_id]=' + bookId, userToken),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 12),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, userToken, jobAbortControllers.get(jobId)?.signal);

    const idMaps = {
      chNameToId: Object.fromEntries(chaptersData.map(c => [c.name, c.id])),
      // Kapitel-scoped Page-Lookup gegen Namenskollisionen: derselbe Seitenname
      // kann in mehreren Kapiteln existieren (z.B. «Der Vater» als Kapitelname
      // und als Page-Titel in einem anderen Kapitel). Key 0 = Seiten ohne Kapitel.
      pageNameToIdByChapter: (() => {
        const map = {};
        for (const p of pages) {
          const k = p.chapter_id ?? 0;
          (map[k] ??= {})[p.name] = p.id;
        }
        return map;
      })(),
    };
    invalidateRenamedChapterCaches(bookIdInt, chaptersData, log, jobId);

    // Buchtext-Preprocessing (claude-only): unbekannte HTML-Entities (&nbsp;,
    // &mdash;, …), Zero-Width-Zeichen, Soft Hyphen, NBSP, doppelte Spaces raus.
    // Wirkt auf pageContents → schlägt automatisch in fullBookText UND
    // Multi-Pass-Chunks durch (beide werden aus pageContents gebaut).
    // P1 und P8 nutzen identischen Buchtext → 1h-Cache-Read in P8 bleibt intakt.
    if (effectiveProvider === 'claude') {
      let savedChars = 0;
      for (const p of pageContents) {
        const before = p.text.length;
        p.text = cleanPageTextForClaude(p.text);
        savedChars += before - p.text.length;
      }
      if (savedChars > 0) log.info(`Buchtext-Preprocessing ${savedChars} Zeichen entfernt (Entities/Whitespace/ZWS).`);
    }

    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    const { groupOrder, groups } = groupByChapter(pageContents);
    // Einmal bauen, wiederverwenden (Phase 1 Single-Pass, Phase 3b, P8 Kontinuität)
    const fullBookText = buildSinglePassBookText(groups, groupOrder);
    // Single/Multi-Pass-Signal für die Frontend-Phasenanzeige: Im Single-Pass wird
    // Phase 3b übersprungen, die UI blendet den entsprechenden Eintrag aus.
    const passMode = totalChars <= singlePassLimit ? 'single' : 'multi';
    updateJob(jobId, { passMode });

    // Cache-Version: Modellname + Prompts-Schema-Version. Ändert sich eins davon,
    // werden alle persistierten Phase-1-Caches automatisch verworfen (Hit-Test
    // matcht den vollen Sig-String inkl. dieser Version).
    const cacheVersion = `${_modelName(effectiveProvider)}:${prompts.PROMPTS_VERSION || ''}`;

    const ctx = {
      jobId, bookIdInt, bookName, email, call, tok, log,
      effectiveProvider, singlePassLimit, cacheVersion, prompts, sys,
      idMaps, pageContents, groups, groupOrder, totalChars, fullBookText,
    };

    // ── Phase 1: Vollextraktion ───────────────────────────────────────────────
    const p1 = cp?.phase === 'p1_full_done'
      ? restorePhase1FromCheckpoint(cp, tok, log, jobId)
      : await runPhase1(ctx);
    const { chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments } = p1;

    // ── Phase 2 + 3: Figuren + Orte konsolidieren ────────────────────────────
    // Multi-Pass Claude: P2 (Figuren-AI) und P3 (Orte-AI) sind unabhängig und
    // werden parallel gefahren. P3 nutzt prelim figurenKompakt (Pre-P2-Merge) im
    // Prompt; nach P2-Merge werden die Orte-figuren-IDs via idRemap+validFigIds
    // auf die finalen Post-Merge-IDs umgebogen.
    // Single-Pass: kein AI-Call in P2/P3 → Parallelisierung bringt nichts.
    // Lokale Provider: sequentiell (Mutex serialisiert AI-Calls ohnehin).
    const isMultiPassClaude = effectiveProvider === 'claude' && chapterFiguren.length > 1;
    let figuren, figNameToId, figNameToIdLower, figurenKompakt, idRemap, isSinglePass;
    let orte, ortNameToId, ortNameToIdLower;
    if (isMultiPassClaude) {
      const prelimFigKompakt = buildPrelimFigurenKompakt(chapterFiguren);
      const [p2Result, orteRaw] = await Promise.all([
        runPhase2(ctx, chapterFiguren, chapterAssignments),
        runPhase3OrteCall(ctx, chapterOrte, prelimFigKompakt),
      ]);
      ({ figuren, figNameToId, figNameToIdLower, figurenKompakt, idRemap, isSinglePass } = p2Result);
      ({ orte, ortNameToId, ortNameToIdLower } =
        await runPhase3(ctx, chapterOrte, figurenKompakt, isSinglePass, idRemap, { prefetchedOrteRaw: orteRaw }));
    } else {
      ({ figuren, figNameToId, figNameToIdLower, figurenKompakt, idRemap, isSinglePass } =
        await runPhase2(ctx, chapterFiguren, chapterAssignments));
      ({ orte, ortNameToId, ortNameToIdLower } =
        await runPhase3(ctx, chapterOrte, figurenKompakt, isSinglePass, idRemap));
    }

    // ── Phase 3b: Kapitelübergreifende Beziehungen (non-critical, nur Multi-Pass) ──
    if (chapterFiguren.length > 1 && figuren.length >= 2) {
      await runNonCritical('Phase 3b kapitelübergreifende Beziehungen',
        () => runPhase3b(ctx, figuren), log, jobId);
    }

    // ── Block 2: Szenen remappen → Zeitstrahl + Kontinuitätsprüfung ──────────
    // Claude: P6 (Zeitstrahl) und P8 (Kontinuität) sind unabhängig und laufen
    // parallel. P8 dominiert zeitlich (voller Buchtext bei Single-Pass, sonst
    // Fakten-Listen) und kontrolliert die Progress-Bar (82..97); P6 läuft
    // silent. Lokale Provider sequentiell (Mutex serialisiert ohnehin).
    updateJob(jobId, { progress: 58, statusText: 'job.phase.processingScenes' });
    const locRows = db.prepare(
      'SELECT id, loc_id FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
    ).all(bookIdInt, email);
    const locIdToDbId = Object.fromEntries(locRows.map(r => [r.loc_id, r.id]));
    const szenen = remapSzenen(chapterSzenen, figNameToId, figNameToIdLower, ortNameToId, ortNameToIdLower, idMaps.chNameToId);
    const assignments = remapAssignments(chapterAssignments, figNameToId, figNameToIdLower, idMaps.chNameToId, log, jobId);
    updateJob(jobId, { progress: 76, statusText: 'job.phase.savingScenes' });
    const szenenResult = saveSzenenAndEvents(bookIdInt, email, szenen, assignments, locIdToDbId, idMaps, log, jobId);
    backfillLocationChaptersFromScenes(bookIdInt, email);

    const figKompakt = figuren.map(f => ({ name: f.name, typ: f.typ || 'andere', beschreibung: f.beschreibung || '' }));
    const ortRows = db.prepare(
      'SELECT name, typ, beschreibung FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
    ).all(bookIdInt, email);
    const orteKompakt = ortRows.map(o => ({ name: o.name, typ: o.typ, beschreibung: o.beschreibung || '' }));

    // P8-Call als Closure – wird je nach Provider parallel oder sequentiell ausgeführt.
    const runP8 = async () => {
      if (totalChars <= singlePassLimit && effectiveProvider === 'claude') {
        log.info(`Kontinuität Single-Pass: ${fullBookText.length} Zeichen, ${figKompakt.length} Figuren, ${orteKompakt.length} Orte`);
        const bookSystemBlock = { text: buildBookSystemBlockText(bookName, pageContents.length, fullBookText), ttl: '1h' };
        return call(jobId, tok,
          prompts.buildKontinuitaetSinglePassPrompt(bookName, null, figKompakt, orteKompakt, narrativeLabels(getBookSettings(bookIdInt, email))),
          [bookSystemBlock, { text: sys.SYSTEM_KONTINUITAET }],
          82, 97, 5000, 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
        );
      }
      log.info(`Kontinuität facts-basiert: ${chapterFakten.length} Kapitel, ${figKompakt.length} Figuren`);
      return call(jobId, tok,
        prompts.buildKontinuitaetCheckPrompt(bookName, chapterFakten, figKompakt, orteKompakt),
        sys.SYSTEM_KONTINUITAET, 82, 97, effectiveProvider === 'claude' ? 5000 : 2500, 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
      );
    };

    let kontResult;
    if (effectiveProvider === 'claude') {
      // Parallel: P6 silent, P8 ownt Bar (82..97).
      updateJob(jobId, { progress: 82, statusText: 'job.phase.checkContinuity' });
      const [, p8Out] = await Promise.all([
        runZeitstrahl(ctx, { silent: true }),
        runP8(),
      ]);
      kontResult = p8Out;
    } else {
      await runZeitstrahl(ctx);
      updateJob(jobId, { progress: 82, statusText: 'job.phase.checkContinuity' });
      kontResult = await runP8();
    }
    saveKontinuitaetResult(bookIdInt, email, kontResult, figNameToId, idMaps.chNameToId, effectiveProvider, log, jobId);

    deleteCheckpoint('komplett-analyse', bookIdInt, email);
    completeJob(jobId, {
      figCount:    figuren.length,
      orteCount:   orte.length,
      szenenCount: szenenResult.szenenCount,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), `fig=${figuren.length} orte=${orte.length} szenen=${szenenResult.szenenCount}`);
  } catch (e) {
    if (e.name !== 'AbortError') {
      const cause = e.cause?.message || e.cause?.code || '';
      log.error(`Fehler: ${e.message}${cause ? ' (cause: ' + cause + ')' : ''}`);
    }
    failJob(jobId, e);
  }
}

// ── Job: Kontinuitätsprüfung (eigenständig) ──────────────────────────────────
async function runKontinuitaetJob(jobId, bookId, bookName, userEmail, userToken, provider = undefined) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const log = makeJobLogger(jobId);
  const call = (jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, schema) =>
    aiCall(jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, provider, schema);
  const effectiveProvider = provider || process.env.API_PROVIDER || 'claude';
  const singlePassLimit = SINGLE_PASS_LIMIT;
  const prompts = await getPrompts();
  const sys = await getBookPrompts(bookId, email);

  try {
    const cp = loadCheckpoint('kontinuitaet', bookIdInt, email);
    if (cp) log.info(`Checkpoint gefunden (${cp.nextGi} Kapitel fertig).`);

    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?filter[book_id]=' + bookId, userToken),
      bsGetAll('pages?filter[book_id]=' + bookId, userToken),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const chNameToId = Object.fromEntries(chaptersData.map(c => [c.name, c.id]));
    const tok = { in: 0, out: 0, ms: 0 };

    // Bekannte Figuren + Orte aus DB laden
    const figRows = db.prepare(`
      SELECT f.fig_id, f.name, f.typ, f.beschreibung FROM figures f
      WHERE f.book_id = ? AND f.user_email = ? ORDER BY f.sort_order
    `).all(bookIdInt, email);
    const figurenKompakt = figRows.map(f => ({ name: f.name, typ: f.typ || 'andere', beschreibung: f.beschreibung || '' }));
    const figNameToId = Object.fromEntries(figRows.map(r => [r.name, r.fig_id]));

    const ortRows = db.prepare(
      'SELECT name, typ, beschreibung FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
    ).all(bookIdInt, email);
    const orteKompakt = ortRows.map(o => ({ name: o.name, typ: o.typ, beschreibung: o.beschreibung || '' }));

    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 50),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, userToken, jobAbortControllers.get(jobId)?.signal);

    // Buchtext-Preprocessing claude-only (siehe runKomplettAnalyseJob).
    if (effectiveProvider === 'claude') {
      let savedChars = 0;
      for (const p of pageContents) {
        const before = p.text.length;
        p.text = cleanPageTextForClaude(p.text);
        savedChars += before - p.text.length;
      }
      if (savedChars > 0) log.info(`Buchtext-Preprocessing ${savedChars} Zeichen entfernt.`);
    }

    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    const { groupOrder, groups } = groupByChapter(pageContents);
    let result;

    if (totalChars <= singlePassLimit) {
      updateJob(jobId, { progress: 60, statusText: 'job.phase.checkContinuity' });
      const bookText = buildSinglePassBookText(groups, groupOrder);
      result = await call(jobId, tok,
        prompts.buildKontinuitaetSinglePassPrompt(bookName, bookText, figurenKompakt, orteKompakt, narrativeLabels(getBookSettings(bookIdInt, email))),
        sys.SYSTEM_KONTINUITAET, 60, 97, 5000, 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
      );
    } else {
      // Multi-Pass: Fakten pro Kapitel extrahieren – ggf. aus Checkpoint fortsetzen
      let chapterFacts = cp?.chapterFacts ?? [];
      const startGi = cp?.nextGi ?? 0;
      if (startGi > 0) {
        updateJob(jobId, {
          progress: 50 + Math.round((startGi / groupOrder.length) * 35),
          statusText: 'job.phase.resumeFacts',
          statusParams: { current: startGi, total: groupOrder.length },
        });
      }
      for (let gi = startGi; gi < groupOrder.length; gi++) {
        const group = groups.get(groupOrder[gi]);
        const fromPct = 50 + Math.round((gi / groupOrder.length) * 35);
        const toPct   = 50 + Math.round(((gi + 1) / groupOrder.length) * 35);
        updateJob(jobId, { progress: fromPct, statusText: 'job.phase.factsInGroup', statusParams: { name: group.name, current: gi + 1, total: groupOrder.length } });
        const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        try {
          const chResult = await call(jobId, tok,
            prompts.buildKontinuitaetChapterFactsPrompt(group.name, chText),
            sys.SYSTEM_KONTINUITAET, fromPct, toPct, 1500, 0.2, null, prompts.SCHEMA_KONTINUITAET_FAKTEN,
          );
          chapterFacts.push({ kapitel: group.name, fakten: chResult.fakten || [] });
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          log.warn(`Fakten «${group.name}» übersprungen: ${e.message}`);
        }
        saveCheckpoint('kontinuitaet', bookIdInt, email, { chapterFacts, nextGi: gi + 1 });
      }

      updateJob(jobId, { progress: 88, statusText: 'job.phase.checkContradictions' });
      result = await call(jobId, tok,
        prompts.buildKontinuitaetCheckPrompt(bookName, chapterFacts, figurenKompakt, orteKompakt),
        sys.SYSTEM_KONTINUITAET, 88, 97, 5000, 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
      );
    }

    if (typeof result?.zusammenfassung === 'undefined') throw i18nError('job.error.zusammenfassungMissing');
    const normalizedProbleme = saveKontinuitaetResult(bookIdInt, email, result, figNameToId, chNameToId, effectiveProvider, log, jobId);
    deleteCheckpoint('kontinuitaet', bookIdInt, email);
    completeJob(jobId, {
      count: normalizedProbleme.length,
      issues: normalizedProbleme,
      zusammenfassung: result.zusammenfassung,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), `${normalizedProbleme.length} Probleme`);
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Nacht-Cron: Komplettanalyse für alle Bücher × alle User ──────────────────
async function runKomplettAnalyseAll() {
  const cronProvider = process.env.API_PROVIDER || 'llama';
  const cronHostOk = cronProvider === 'llama'  ? !!process.env.LLAMA_HOST
                   : cronProvider === 'ollama' ? !!process.env.OLLAMA_HOST
                   : true;
  if (!cronHostOk) {
    logger.info(`Nacht-Analyse übersprungen: ${cronProvider.toUpperCase()}_HOST nicht konfiguriert.`);
    return;
  }

  const users = getAllUserTokens();
  if (!users.length) {
    logger.warn('Nacht-Analyse übersprungen: kein BookStack-Token in der Datenbank.');
    return;
  }

  let books;
  for (const u of users) {
    try {
      books = await bsGetAll('books', { id: u.token_id, pw: u.token_pw });
      break;
    } catch (e) {
      logger.warn(`Nacht-Analyse: Bücherliste mit Token von ${u.email} fehlgeschlagen – nächsten versuchen.`);
    }
  }
  if (!books) {
    logger.error('Nacht-Analyse abgebrochen: kein gültiger Token für Bücherliste gefunden.');
    return;
  }

  logger.info(`Nacht-Analyse: ${books.length} Buch/Bücher × ${users.length} User`);
  let queued = 0;
  for (const book of books) {
    for (const u of users) {
      if (findActiveJobId('komplett-analyse', book.id, u.email)) {
        logger.info(`Nacht-Analyse: Buch ${book.id} / ${u.email} läuft bereits – überspringe.`);
        continue;
      }
      const label = `Nacht · ${book.name}`;
      const userToken = { id: u.token_id, pw: u.token_pw };
      const jobId = createJob('komplett-analyse', book.id, u.email, label);
      enqueueJob(jobId, () => runKomplettAnalyseJob(jobId, book.id, book.name, u.email, userToken, cronProvider));
      queued++;
    }
  }
  logger.info(`Nacht-Analyse: ${queued} Job(s) in Warteschlange eingereiht.`);
}

module.exports = { runKomplettAnalyseJob, runKontinuitaetJob, runKomplettAnalyseAll };
