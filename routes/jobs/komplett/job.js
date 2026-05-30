'use strict';
const logger = require('../../../logger');
const {
  db,
  saveCheckpoint, loadCheckpoint, deleteCheckpoint,
  backfillLocationChaptersFromScenes,
  getBookSettings,
} = require('../../../db/schema');
const appUsers = require('../../../db/app-users');
const bookAccess = require('../../../db/book-access');
const { narrativeLabels } = require('../narrative-labels');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, contentHttpError,
  aiCall, toSystemBlocks, getPrompts, getBookPrompts,
  loadOrderedBookContents, loadPageContents, groupByChapter, buildSinglePassBookText, cleanPageTextForClaude,
  chunkLimitsFor, BATCH_SIZE, jobAbortControllers,
  _modelName, fmtTok, tps,
  createJob, enqueueJob, findActiveJobId,
  retryOnTransientAi,
} = require('../shared');
const contentStore = require('../../../lib/content-store');
const appSettings = require('../../../lib/app-settings');
const { runNonCritical, buildBookSystemBlockText, buildBookPagesSig } = require('./utils');
const { invalidateRenamedChapterCaches, loadAndValidateCheckpoint, restorePhase1FromCheckpoint } = require('./checkpoint');
const { remapSzenen, remapAssignments, saveSzenenAndEvents, saveKontinuitaetResult } = require('./remap');
const {
  runPhase1, runPhase2, runPhase3, runPhase3Songs, runPhase3b, runZeitstrahl,
  buildPrelimFigurenKompakt, runPhase3OrteCall,
} = require('./phases');

// ── Verify-Stufe für den Multi-Pass-Kontinuitätscheck ────────────────────────
// Der Fakten-basierte Check sieht nur extrahierte Fakten, nicht den Volltext –
// auflösender Kontext (Rückblende, Ironie, Konjunktiv, indirekte Rede) ist dort
// schon weg und erzeugt systematisch False-Positives. Pro gemeldetem Problem
// laden wir die Original-Textstellen nach und lassen das Modell den Widerspruch
// mit echtem Kontext bestätigen oder verwerfen. Single-Pass braucht das nicht
// (hat den Volltext bereits beim Check).
const _VERIFY_RADIUS = 1500;

function _stelleQuote(stelle) {
  const m = String(stelle || '').match(/[«„"“]([^»"”]{3,})[»"”]/);
  return m ? m[1].trim() : '';
}

// Textfenster rund um das Zitat aus den im Problem referenzierten Kapiteln.
// Whitespace-normalisiert (matcht den Single-Pass-/Fakten-Textfluss); findet das
// Zitat und schneidet ±_VERIFY_RADIUS Zeichen aus. Fallback: Kapitel-Anfang.
function _verifyExcerpt(groups, groupOrder, kapitelNames, quote) {
  const texts = [];
  for (const key of groupOrder) {
    const g = groups.get(key);
    if (kapitelNames.includes(g.name)) texts.push(g.pages.map(p => p.text).join('\n'));
  }
  if (!texts.length) return '';
  const full = texts.join('\n\n').replace(/\s+/g, ' ');
  if (quote) {
    const needle = quote.replace(/\s+/g, ' ').slice(0, 40);
    const idx = full.indexOf(needle);
    if (idx >= 0) return full.slice(Math.max(0, idx - _VERIFY_RADIUS), Math.min(full.length, idx + needle.length + _VERIFY_RADIUS));
  }
  return full.slice(0, _VERIFY_RADIUS * 2);
}

// Filtert die Probleme des Fakten-Checks: verwirft nur explizit als unecht
// eingestufte (bestaetigt=false); nicht lokalisierbare/fehlgeschlagene bleiben
// konservativ erhalten. Nur Claude (lokale Provider: zu kleines Kontextfenster
// für zuverlässige Verify-Urteile, Mutex serialisiert zudem jeden Call).
async function verifyKontinuitaetProbleme(ctx, result, fromPct, toPct) {
  const { call, prompts, sys, jobId, tok, bookName, groups, groupOrder, log } = ctx;
  const probleme = Array.isArray(result?.probleme) ? result.probleme : [];
  if (!probleme.length) return result;
  updateJob(jobId, { progress: fromPct, statusText: 'job.phase.verifyContradictions' });
  const verdicts = await Promise.all(probleme.map(async (p) => {
    const kap = Array.isArray(p.kapitel) ? p.kapitel : [];
    if (!kap.length) return { p, keep: true };
    const exA = _verifyExcerpt(groups, groupOrder, kap, _stelleQuote(p.stelle_a));
    const exB = _verifyExcerpt(groups, groupOrder, kap, _stelleQuote(p.stelle_b));
    if (!exA && !exB) return { p, keep: true };
    try {
      const v = await call(jobId, tok,
        prompts.buildKontinuitaetVerifyPrompt(bookName, p, exA, exB),
        sys.SYSTEM_KONTINUITAET_BLOCKS, null, null, 400, 0.3, 600, prompts.SCHEMA_KONTINUITAET_VERIFY);
      return { p, keep: v?.bestaetigt !== false };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      log.warn(`Kontinuität Verify übersprungen: ${e.message}`);
      return { p, keep: true };
    }
  }));
  const kept = verdicts.filter(v => v.keep).map(v => v.p);
  const dropped = probleme.length - kept.length;
  if (dropped > 0) log.info(`Kontinuität Verify: ${dropped}/${probleme.length} False-Positive(s) verworfen.`);
  updateJob(jobId, { progress: toPct });
  return { ...result, probleme: kept };
}

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
  const effectiveProvider = provider || appSettings.get('ai.provider') || 'claude';
  // Per-Provider-Skalierung aus dessen `ai.<p>.context_window` (lib/ai.js#getContextConfigFor).
  // Bei Claude 200K-Kontext ≈ 420K Zeichen Single-Pass – reicht für fast alle Bücher.
  const { singlePass: singlePassLimit, perChunk: perChunkLimit } = chunkLimitsFor(effectiveProvider);
  const prompts = await getPrompts();
  const sys = await getBookPrompts(bookId, email);
  const tok = { in: 0, out: 0, ms: 0, inflight: new Map() };

  try {
    const cp = loadAndValidateCheckpoint(bookIdInt, email, log, jobId);

    // ── Seiten laden ──────────────────────────────────────────────────────────
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const { chMap, chNameToId, chaptersFlat, pages } = await loadOrderedBookContents(bookId, userToken)
      .catch(e => { throw contentHttpError(e); });
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 12),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, userToken, jobAbortControllers.get(jobId)?.signal);

    const idMaps = {
      chNameToId,
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
    invalidateRenamedChapterCaches(bookIdInt, chaptersFlat, log, jobId);

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
    // Buch-weite Signatur (Seitenstand + Settings + Modell/Prompt-Version) – dieselbe
    // Gate wie der chapter_extract_cache. Validiert den Checkpoint-Resume.
    const bookPagesSig = buildBookPagesSig(pageContents, getBookSettings(bookIdInt, email), cacheVersion);

    const ctx = {
      jobId, bookIdInt, bookName, email, call, tok, log,
      effectiveProvider, singlePassLimit, perChunkLimit, cacheVersion, bookPagesSig, prompts, sys,
      idMaps, pageContents, groups, groupOrder, totalChars, fullBookText,
    };

    // ── Phase 1: Vollextraktion ───────────────────────────────────────────────
    // Checkpoint nur resumen, wenn Seitenstand + Modell/Prompt-Version unverändert.
    // Sonst liefert restorePhase1FromCheckpoint stale Extraktion (Edit nach Crash,
    // PROMPTS_VERSION-Bump) – der chapter_extract_cache wäre hier sig-invalidiert,
    // der Checkpoint umging das bisher komplett.
    const cpUsable = cp?.phase === 'p1_full_done' && cp.bookPagesSig === bookPagesSig;
    if (cp && !cpUsable) {
      log.info('Checkpoint verworfen (Seiten oder Modell/Prompt-Version geändert) – Phase 1 neu.');
      deleteCheckpoint('komplett-analyse', bookIdInt, email);
    }
    const p1 = cpUsable
      ? restorePhase1FromCheckpoint(cp, tok, log, jobId)
      : await runPhase1(ctx);
    const { chapterFiguren, chapterOrte, chapterSongs, chapterFakten, chapterSzenen, chapterAssignments } = p1;

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

    // ── Phase 3 Songs: Musikbibliothek konsolidieren ─────────────────────────
    const { songs } = await runPhase3Songs(ctx, chapterSongs || [], figurenKompakt, isSinglePass, idRemap);

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

    // Single-Pass nur bei Claude (voller Buchtext im 1h-Cache); sonst Fakten-Multi-Pass.
    const kontMultiPass = !(totalChars <= singlePassLimit && effectiveProvider === 'claude');
    // P8-Call als Closure – wird je nach Provider parallel oder sequentiell ausgeführt.
    const runP8 = async () => {
      if (!kontMultiPass) {
        log.info(`Kontinuität Single-Pass: ${fullBookText.length} Zeichen, ${figKompakt.length} Figuren, ${orteKompakt.length} Orte`);
        const bookSystemBlock = { text: buildBookSystemBlockText(bookName, pageContents.length, fullBookText), ttl: '1h' };
        return retryOnTransientAi(() => call(jobId, tok,
          prompts.buildKontinuitaetSinglePassPrompt(bookName, null, figKompakt, orteKompakt, narrativeLabels(getBookSettings(bookIdInt, email))),
          [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KONTINUITAET_BLOCKS, '1h')],
          82, 97, 5000, 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
        ), { log, label: 'Kontinuität Single-Pass (P8)' });
      }
      log.info(`Kontinuität facts-basiert: ${chapterFakten.length} Kapitel, ${figKompakt.length} Figuren`);
      return retryOnTransientAi(() => call(jobId, tok,
        prompts.buildKontinuitaetCheckPrompt(bookName, chapterFakten, figKompakt, orteKompakt),
        sys.SYSTEM_KONTINUITAET_BLOCKS, 82, 97, effectiveProvider === 'claude' ? 5000 : 2500, 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
      ), { log, label: 'Kontinuität facts-basiert (P8)' });
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
    // Multi-Pass-Befunde gegen den Originaltext verifizieren (False-Positive-Filter).
    if (kontMultiPass && effectiveProvider === 'claude') {
      kontResult = await verifyKontinuitaetProbleme(ctx, kontResult, 96, 97);
    }
    saveKontinuitaetResult(bookIdInt, email, kontResult, figNameToId, idMaps.chNameToId, effectiveProvider, log, jobId);

    deleteCheckpoint('komplett-analyse', bookIdInt, email);
    completeJob(jobId, {
      figCount:    figuren.length,
      orteCount:   orte.length,
      songsCount:  songs.length,
      szenenCount: szenenResult.szenenCount,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), `fig=${figuren.length} orte=${orte.length} songs=${songs.length} szenen=${szenenResult.szenenCount}`);
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
  const effectiveProvider = provider || appSettings.get('ai.provider') || 'claude';
  const { singlePass: singlePassLimit } = chunkLimitsFor(effectiveProvider);
  const prompts = await getPrompts();
  const sys = await getBookPrompts(bookId, email);

  try {
    const cp = loadCheckpoint('kontinuitaet', bookIdInt, email);
    if (cp) log.info(`Checkpoint gefunden (${cp.nextGi} Kapitel fertig).`);

    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const { chMap, chNameToId, pages } = await loadOrderedBookContents(bookId, userToken)
      .catch(e => { throw contentHttpError(e); });
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

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
      result = await retryOnTransientAi(() => call(jobId, tok,
        prompts.buildKontinuitaetSinglePassPrompt(bookName, bookText, figurenKompakt, orteKompakt, narrativeLabels(getBookSettings(bookIdInt, email))),
        sys.SYSTEM_KONTINUITAET_BLOCKS, 60, 97, 5000, 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
      ), { log, label: 'Kontinuität Single-Pass' });
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
          // Retry vor dem graceful-skip: der Checkpoint rückt nach gi+1 vor, ein
          // übersprungenes Kapitel wird auch beim Resume NIE nachgeholt – ein
          // transienter Blip würde sonst dauerhaft Fakten verlieren.
          const chResult = await retryOnTransientAi(() => call(jobId, tok,
            prompts.buildKontinuitaetChapterFactsPrompt(group.name, chText),
            sys.SYSTEM_KONTINUITAET_BLOCKS, fromPct, toPct, 1500, 0.2, null, prompts.SCHEMA_KONTINUITAET_FAKTEN,
          ), { log, label: `Fakten «${group.name}»` });
          chapterFacts.push({ kapitel: group.name, fakten: chResult.fakten || [] });
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          log.warn(`Fakten «${group.name}» übersprungen: ${e.message}`);
        }
        saveCheckpoint('kontinuitaet', bookIdInt, email, { chapterFacts, nextGi: gi + 1 });
      }

      updateJob(jobId, { progress: 88, statusText: 'job.phase.checkContradictions' });
      result = await retryOnTransientAi(() => call(jobId, tok,
        prompts.buildKontinuitaetCheckPrompt(bookName, chapterFacts, figurenKompakt, orteKompakt),
        sys.SYSTEM_KONTINUITAET_BLOCKS, 88, 95, 5000, 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
      ), { log, label: 'Kontinuität Check (Multi-Pass)' });
      // Fakten-basierte Befunde gegen den Originaltext verifizieren (False-Positive-Filter).
      if (effectiveProvider === 'claude') {
        result = await verifyKontinuitaetProbleme(
          { call, prompts, sys, jobId, tok, bookName, groups, groupOrder, log }, result, 95, 97);
      }
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
  const cronProvider = appSettings.get('ai.provider') || 'llama';
  const cronHostOk = cronProvider === 'llama'  ? !!appSettings.get('ai.llama.host')
                   : cronProvider === 'ollama' ? !!appSettings.get('ai.ollama.host')
                   : true;
  if (!cronHostOk) {
    logger.info(`Nacht-Analyse übersprungen: ai.${cronProvider}.host nicht konfiguriert.`);
    return;
  }

  const activeUsers = appUsers.listUsers().filter(u => u.status === 'active');
  if (!activeUsers.length) {
    logger.warn('Nacht-Analyse übersprungen: keine aktiven User.');
    return;
  }

  const books = await contentStore.listBooks(null);
  if (!books.length) {
    logger.info('Nacht-Analyse: keine Bücher vorhanden.');
    return;
  }

  // Pro Buch nur User mit book_access enqueuen — Privacy-Boundary respektiert.
  const accessByBook = new Map();
  for (const u of activeUsers) {
    for (const row of bookAccess.listBookIdsForUser(u.email)) {
      if (!accessByBook.has(row.book_id)) accessByBook.set(row.book_id, []);
      accessByBook.get(row.book_id).push(u.email);
    }
  }

  logger.info(`Nacht-Analyse: ${books.length} Buch/Bücher, ${activeUsers.length} aktive User.`);
  let queued = 0;
  for (const book of books) {
    const emails = accessByBook.get(book.id) || [];
    for (const email of emails) {
      if (findActiveJobId('komplett-analyse', book.id, email)) {
        logger.info(`Nacht-Analyse: Buch ${book.id} / ${email} läuft bereits – überspringe.`);
        continue;
      }
      const label = `Nacht · ${book.name}`;
      const jobId = createJob('komplett-analyse', book.id, email, label);
      enqueueJob(jobId, () => runKomplettAnalyseJob(jobId, book.id, book.name, email, null, cronProvider));
      queued++;
    }
  }
  logger.info(`Nacht-Analyse: ${queued} Job(s) in Warteschlange eingereiht.`);
}

module.exports = { runKomplettAnalyseJob, runKontinuitaetJob, runKomplettAnalyseAll };
