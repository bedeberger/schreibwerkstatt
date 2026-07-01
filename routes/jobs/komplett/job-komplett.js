'use strict';
// Komplettanalyse-Kern-Job (Phasen P1–P8) + Nacht-Cron. Verify-Stufe,
// Anachronismus-Datenbasis und Per-Job-Claude-Overrides liegen in ./job-shared.
const logger = require('../../../logger');
const {
  db,
  saveCheckpoint, loadCheckpoint, deleteCheckpoint,
  backfillLocationChaptersFromScenes,
  saveFaktenToDb,
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
  retryOnTransientAi, settledAll,
} = require('../shared');
const contentStore = require('../../../lib/content-store');
const appSettings = require('../../../lib/app-settings');
const { setContext } = require('../../../lib/log-context');
const { runNonCritical, buildBookSystemBlockText, buildBookPagesSig, _stelleQuote, makePhaseTimer } = require('./utils');
const { loadAndValidateCheckpoint, restorePhase1FromCheckpoint } = require('./checkpoint');
const { remapSzenen, remapAssignments, saveSzenenAndEvents, saveKontinuitaetResult } = require('./remap');
const {
  runPhase1, runPhase2, runPhase3, runPhase3Songs, runPhase3b, runZeitstrahl,
  buildPrelimFigurenKompakt, runPhase3OrteCall, komplettMaxTokens,
} = require('./phases');
const { buildAnachronismusData, verifyKontinuitaetProbleme, _komplettClaudeOverrides } = require('./job-shared');

// ── Job: Komplettanalyse ─────────────────────────────────────────────────────
// Pipeline (token-optimiert):
//   P1 (Vollextraktion: Figuren+Orte+Fakten+Szenen+Events, parallel/Kapitel, SYSTEM_KOMPLETT_EXTRAKTION)
//      → Schema im System-Prompt gecacht; Szenen/Events mit Klarnamen (kein ID-Lookup nötig)
//   P2/P3 (Claude Multi-Pass parallel, sonst sequentiell):
//      P2 (Figuren konsolidieren + Soziogramm) → figNameToId aufbauen
//      P3 (Orte konsolidieren, prelim figurenKompakt im Prompt, figuren_namen→fig_id post-hoc) → ortNameToId
//   P3b (Kapitelübergreifende Beziehungen, nur Multi-Pass, non-critical)
//   P5 Szenen remappen
//   P6 Zeitstrahl + P8 Kontinuität: parallel bei Claude (P8 ownt Progress-Bar), sonst sequentiell
async function runKomplettAnalyseJob(jobId, bookId, bookName, userEmail, userToken, provider = undefined) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const log = makeJobLogger(jobId);
  const pt = makePhaseTimer(log);
  // call akzeptiert optional ein JSON-Schema als letztes Argument (11. Position in aiCall).
  // Schemas werden nur von lokalen Providern (ollama/llama) verwendet – Claude ignoriert sie.
  // WICHTIG: effektiven (aufgelösten) Provider binden, nicht die rohe `provider`-Variable.
  // Wird der Job ohne expliziten Provider gestartet (Regelfall), ist `provider` undefined →
  // getContextConfigFor(undefined) fiele in aiCall auf 'claude' zurück und würde das Output-
  // Ceiling fälschlich auf ai.claude.max_tokens_out kappen, während callAI intern den echten
  // Provider auflöst und z.B. openai-compat/ollama anspricht → vorzeitige Truncation.
  const effectiveProvider = provider || appSettings.get('ai.provider') || 'claude';
  const overrides = _komplettClaudeOverrides(effectiveProvider);
  if (overrides) {
    setContext(overrides);
    log.info(`Komplettanalyse-Claude-Override: ${JSON.stringify(overrides)} (global model=${appSettings.get('ai.claude.model')}, ctx=${appSettings.get('ai.claude.context_window')}, out=${appSettings.get('ai.claude.max_tokens_out')}, timeout=${appSettings.get('ai.claude.timeout_ms')}).`);
  }
  const komplettModel = overrides?.claudeModel || '';
  const call = (jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, schema) =>
    aiCall(jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, effectiveProvider, schema);
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
    const { chMap, chNameToId, pages } = await loadOrderedBookContents(bookId, userToken)
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
    // Kapitel-Umbenennung invalidiert den Multi-Pass-Delta-Cache über den Kapitelnamen
    // im Chunk-pages_sig (phases.js) — keine separate Invalidierungs-Funktion mehr nötig.

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

    // completeness_passes (geclampt) verändert den Single-Pass-Extraktionsinhalt (zusätzliche
    // Long-Tail-Entitäten), muss also Teil der Cache-Version sein — sonst liefert ein Hochsetzen
    // von 0→N bei unverändertem Seitenstand weiter den alten HIT ohne Long-Tail (stiller
    // Qualitätsverlust). Über cacheVersion fliesst der Wert automatisch in den Single-Pass-Key,
    // die Multi-Pass-Chunk-Keys und den Checkpoint-bookPagesSig (alle drei invalidieren).
    const completenessPasses = Math.max(0, Math.min(3,
      parseInt(appSettings.get('ai.komplett.completeness_passes'), 10) || 0));
    // Cache-Version: Modellname + Prompts-Schema-Version + completeness_passes. Ändert sich
    // eins davon, werden alle persistierten Phase-1-Caches automatisch verworfen (Hit-Test
    // matcht den vollen Sig-String inkl. dieser Version).
    const cacheVersion = `${komplettModel || _modelName(effectiveProvider)}:${prompts.PROMPTS_VERSION || ''}:cp${completenessPasses}`;
    // Buch-weite Signatur (Seitenstand + Settings + Modell/Prompt-Version) – dieselbe
    // Gate wie der chapter_extract_cache. Validiert den Checkpoint-Resume.
    const bookPagesSig = buildBookPagesSig(pageContents, getBookSettings(bookIdInt, email), cacheVersion);

    // Sammelt non-critical-Degradierungen (Soziogramm, P3b, Kontinuität), die
    // sonst nur in schreibwerkstatt.log landen → ins Job-Result, damit der User
    // „erfolgreich, aber Teilphase übersprungen" von „alles ok" unterscheiden kann.
    const warnings = [];
    const ctx = {
      jobId, bookIdInt, bookName, email, call, tok, log,
      effectiveProvider, singlePassLimit, perChunkLimit, cacheVersion, bookPagesSig, prompts, sys,
      idMaps, pageContents, groups, groupOrder, totalChars, fullBookText, warnings, completenessPasses,
    };
    pt.mark('Laden');

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
    pt.mark('P1 Extraktion');

    // Welt-Fakten persistieren (Full-Replace) — abfragbar im Buch-Chat via list_world_facts.
    saveFaktenToDb(bookIdInt, chapterFakten, email, idMaps.chNameToId);
    log.info(`${chapterFakten.reduce((s, c) => s + (c.fakten?.length || 0), 0)} Welt-Fakten gespeichert.`);

    // ── Phase 2 + 3: Figuren + Orte konsolidieren ────────────────────────────
    // Multi-Pass Claude: P2 (Figuren-AI) und P3 (Orte-AI) sind unabhängig und
    // werden parallel gefahren. P3 nutzt prelim figurenKompakt (Pre-P2-Merge) im
    // Prompt; nach P2-Merge werden die Orte-figuren_namen via figNameToId auf die
    // finalen kanonischen fig_ids aufgelöst.
    // Single-Pass: kein AI-Call in P2/P3 → Parallelisierung bringt nichts.
    // Lokale Provider: sequentiell (Mutex serialisiert AI-Calls ohnehin).
    const isMultiPassClaude = effectiveProvider === 'claude' && chapterFiguren.length > 1;
    let figuren, figNameToId, figNameToIdLower, figurenKompakt, isSinglePass;
    let orte, ortNameToId, ortNameToIdLower;
    if (isMultiPassClaude) {
      const prelimFigKompakt = buildPrelimFigurenKompakt(chapterFiguren);
      const [p2Result, orteRaw] = await Promise.all([
        runPhase2(ctx, chapterFiguren, chapterAssignments, chapterSzenen),
        runPhase3OrteCall(ctx, chapterOrte, prelimFigKompakt),
      ]);
      ({ figuren, figNameToId, figNameToIdLower, figurenKompakt, isSinglePass } = p2Result);
      ({ orte, ortNameToId, ortNameToIdLower } =
        await runPhase3(ctx, chapterOrte, figurenKompakt, isSinglePass, figNameToId, figNameToIdLower, { prefetchedOrteRaw: orteRaw }));
    } else {
      ({ figuren, figNameToId, figNameToIdLower, figurenKompakt, isSinglePass } =
        await runPhase2(ctx, chapterFiguren, chapterAssignments, chapterSzenen));
      ({ orte, ortNameToId, ortNameToIdLower } =
        await runPhase3(ctx, chapterOrte, figurenKompakt, isSinglePass, figNameToId, figNameToIdLower));
    }
    pt.mark('P2+P3 Konsolidierung');

    // ── Phase 3 Songs: Musikbibliothek konsolidieren ─────────────────────────
    const { songs } = await runPhase3Songs(ctx, chapterSongs || [], figurenKompakt, isSinglePass, figNameToId, figNameToIdLower);

    // ── Phase 3b: Kapitelübergreifende Beziehungen (non-critical, nur Multi-Pass) ──
    if (chapterFiguren.length > 1 && figuren.length >= 2) {
      await runNonCritical('Phase 3b kapitelübergreifende Beziehungen',
        () => runPhase3b(ctx, figuren), log,
        { warnings, warnKey: 'job.warn.crossChapterFailed' });
    }
    pt.mark('Songs+P3b');

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
    const szenen = remapSzenen(chapterSzenen, figNameToId, figNameToIdLower, ortNameToId, ortNameToIdLower, idMaps.chNameToId, log);
    const assignments = remapAssignments(chapterAssignments, figNameToId, figNameToIdLower, idMaps.chNameToId, log, jobId);
    updateJob(jobId, { progress: 76, statusText: 'job.phase.savingScenes' });
    const szenenResult = saveSzenenAndEvents(bookIdInt, email, szenen, assignments, locIdToDbId, idMaps, log, jobId);
    backfillLocationChaptersFromScenes(bookIdInt, email);
    pt.mark('P5 Szenen');

    const figKompakt = figuren.map(f => ({ name: f.name, typ: f.typ || 'andere', beschreibung: f.beschreibung || '' }));
    const ortRows = db.prepare(
      'SELECT name, typ, beschreibung FROM locations WHERE book_id = ? AND user_email = ? AND stale = 0 ORDER BY sort_order'
    ).all(bookIdInt, email);
    const orteKompakt = ortRows.map(o => ({ name: o.name, typ: o.typ, beschreibung: o.beschreibung || '' }));

    // Anachronismus-Kontext (nur bei echter Zeitlinie) – Daten stehen hier bereits in der DB
    // (Figuren-Events, Songs, Fakten alle vor Block 2 persistiert).
    const anachronismus = buildAnachronismusData(bookIdInt, email);
    // Single-Pass nur bei Claude (voller Buchtext im 1h-Cache); sonst Fakten-Multi-Pass.
    const kontMultiPass = !(totalChars <= singlePassLimit && effectiveProvider === 'claude');
    // P8-Call als Closure – wird je nach Provider parallel oder sequentiell ausgeführt.
    const runP8 = async () => {
      try {
        if (!kontMultiPass) {
          log.info(`Kontinuität Single-Pass: ${fullBookText.length} Zeichen, ${figKompakt.length} Figuren, ${orteKompakt.length} Orte`);
          const bookSystemBlock = { text: buildBookSystemBlockText(bookName, pageContents.length, fullBookText), ttl: '1h' };
          return await retryOnTransientAi(() => call(jobId, tok,
            prompts.buildKontinuitaetSinglePassPrompt(bookName, null, figKompakt, orteKompakt, narrativeLabels(getBookSettings(bookIdInt, email)), anachronismus),
            [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KONTINUITAET_BLOCKS, '1h')],
            82, 97, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
          ), { log, label: 'Kontinuität Single-Pass (P8)' });
        }
        log.info(`Kontinuität facts-basiert: ${chapterFakten.length} Kapitel, ${figKompakt.length} Figuren`);
        return await retryOnTransientAi(() => call(jobId, tok,
          prompts.buildKontinuitaetCheckPrompt(bookName, chapterFakten, figKompakt, orteKompakt, anachronismus),
          sys.SYSTEM_KONTINUITAET_BLOCKS, 82, 97, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
        ), { log, label: 'Kontinuität facts-basiert (P8)' });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        // P8 ist die letzte, read-only Phase: Figuren/Orte/Szenen sind bereits gültig
        // gespeichert. Ein Fehler hier (Trunkierung bei zu vielen Befunden, Parse-Fehler,
        // erschöpfter Retry) darf den Katalog NICHT als „fehlgeschlagen" verwerfen.
        // Kontinuität überspringen (vorheriges Ergebnis bleibt), Warnung sammeln, Job ok.
        log.warn(`Kontinuitätsprüfung fehlgeschlagen (Katalog bleibt erhalten): ${e.message}`);
        warnings.push({ key: 'job.warn.continuityFailed' });
        return null;
      }
    };

    let kontResult;
    // P6 (Zeitstrahl) non-critical kapseln: ein Fehler im Zeitstrahl-DB-Save (oder im
    // Konsolidierungs-Call, der im Fallback synchron speichert) darf den bereits gültig
    // gespeicherten Katalog NICHT verwerfen — P6 ist Endphase, kein kritischer Pfad.
    // AbortError (User-Cancel) muss aber durchschlagen → eigene Kapselung statt
    // runNonCritical (das AbortError schluckt). runP8 ist intern bereits so abgesichert;
    // damit kann keiner der beiden Promise.all-Zweige den Job über failJob kippen.
    const runZeitstrahlSafe = async (opts) => {
      try { await runZeitstrahl(ctx, opts); }
      catch (e) {
        if (e.name === 'AbortError') throw e;
        log.warn(`Zeitstrahl-Phase fehlgeschlagen (Katalog bleibt erhalten): ${e.message}`);
        warnings.push({ key: 'job.warn.timelineFailed' });
      }
    };
    if (effectiveProvider === 'claude') {
      // Parallel: P6 silent, P8 ownt Bar (82..97).
      updateJob(jobId, { progress: 82, statusText: 'job.phase.checkContinuity' });
      const [, p8Out] = await Promise.all([
        runZeitstrahlSafe({ silent: true }),
        runP8(),
      ]);
      kontResult = p8Out;
    } else {
      await runZeitstrahlSafe();
      updateJob(jobId, { progress: 82, statusText: 'job.phase.checkContinuity' });
      kontResult = await runP8();
    }
    // Pflichtfeld-Check als Degradierung (P8 read-only → kein throw): ein schema-valides
    // Ergebnis ohne «zusammenfassung» würde saveKontinuitaetResult wortlos null liefern
    // (kein Befund, kein Hinweis) → der User hielte die Prüfung für sauber durchgelaufen.
    if (kontResult && typeof kontResult.zusammenfassung === 'undefined') {
      log.warn('Kontinuitätsprüfung: Pflichtfeld «zusammenfassung» fehlt – Ergebnis verworfen, Warnung gesammelt.');
      warnings.push({ key: 'job.warn.continuityFailed' });
      kontResult = null;
    }
    if (kontResult) {
      // Multi-Pass-Befunde gegen den Originaltext verifizieren (False-Positive-Filter).
      if (kontMultiPass && effectiveProvider === 'claude') {
        kontResult = await verifyKontinuitaetProbleme(ctx, kontResult, 96, 97);
      }
      // Single-Pass (Claude, voller Buchtext im Prompt): Beleg-Zitate gegen den Text
      // prüfen. Multi-Pass-Claude hat die separate verify-Stufe; der Fakten-Pfad zitiert
      // paraphrasiert → requireQuoteEvidence dort aus (false negatives sonst).
      saveKontinuitaetResult(bookIdInt, email, kontResult, figNameToId, idMaps.chNameToId, effectiveProvider, log,
        { fullBookText, requireQuoteEvidence: !kontMultiPass });
    }

    pt.mark('Block 2 (Zeitstrahl+Kontinuität)');

    deleteCheckpoint('komplett-analyse', bookIdInt, email);
    log.info(`Phasen-Timing: ${pt.summary()}`);
    completeJob(jobId, {
      figCount:    figuren.length,
      orteCount:   orte.length,
      songsCount:  songs.length,
      szenenCount: szenenResult.szenenCount,
      warnings,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), `fig=${figuren.length} orte=${orte.length} songs=${songs.length} szenen=${szenenResult.szenenCount}${warnings.length ? ` warn=${warnings.length}` : ''}`);
  } catch (e) {
    if (e.name !== 'AbortError') {
      const cause = e.cause?.message || e.cause?.code || '';
      log.error(`Fehler: ${e.message}${cause ? ' (cause: ' + cause + ')' : ''}`);
    }
    failJob(jobId, e);
  }
}

// ── Nacht-Cron: Komplettanalyse für alle Bücher × alle User ──────────────────
async function runKomplettAnalyseAll() {
  const cronProvider = appSettings.get('ai.provider') || 'claude';
  const cronHostOk = cronProvider === 'openai-compat' ? !!appSettings.get('ai.openai-compat.host')
                   : cronProvider === 'ollama'        ? !!appSettings.get('ai.ollama.host')
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

module.exports = { runKomplettAnalyseJob, runKomplettAnalyseAll };
