'use strict';
const {
  db,
  saveFigurenToDb, addFigurenBeziehungen, updateFigurenSoziogramm,
  saveZeitstrahlEvents, saveOrteToDb, saveSongsToDb,
  saveCheckpoint,
  loadChapterExtractCache, saveChapterExtractCache,
  getBookSettings,
} = require('../../../db/schema');
const { recomputeBookFigureMentions } = require('../../../lib/page-index');
const {
  i18nError, settledAll, splitGroupsIntoChunks, PER_CHUNK_LIMIT, updateJob,
  toSystemBlocks,
} = require('../shared');
const {
  buildBookSystemBlockText, buildBookPagesSig,
  extractField, buildFigNameLookup,
} = require('./utils');
const {
  preMergeChapterFiguren, applySozialschichtModeVote,
  mergeDuplicateFiguren, validateBeziehungenDescriptions,
} = require('./figuren-merge');
const appSettings = require('../../../lib/app-settings');

/**
 * Phase 1: Vollextraktion (Figuren+Orte+Fakten+Szenen+Events).
 * Single-Pass für kleine Bücher, Multi-Pass mit Delta-Cache für grosse.
 * Schema und Regeln im System-Prompt (SYSTEM_KOMPLETT_EXTRAKTION) → gecacht über alle Kapitel.
 * Szenen/Assignments verwenden Klarnamen statt IDs; Remapping nach P2/P3-Konsolidierung.
 */
async function runPhase1(ctx) {
  const { jobId, bookIdInt, bookName, email, call, tok, log,
    effectiveProvider, singlePassLimit, cacheVersion,
    prompts, sys, pageContents, groups, groupOrder, totalChars, fullBookText } = ctx;

  const perChunkLimit = effectiveProvider === 'claude' ? singlePassLimit : PER_CHUNK_LIMIT;
  const { chunkOrder, chunks } = splitGroupsIntoChunks(groups, groupOrder, perChunkLimit);

  log.info(`Phase 1 – ${totalChars} Zeichen, ${effectiveProvider} → ${totalChars <= singlePassLimit ? 'Single-Pass' : `Multi-Pass (${groupOrder.length} Kapitel → ${chunkOrder.length} Chunks)`}`);

  let chapterFiguren, chapterOrte, chapterSongs, chapterFakten, chapterSzenen, chapterAssignments;

  if (totalChars <= singlePassLimit) {
    // ── Single-Pass ──
    // Persistenter Cache: wenn Pages+Kapitelnamen unverändert, P1-Ergebnis wiederverwenden.
    // Key: chapter_key='__singlepass__' + Gesamt-Seitensignatur. Überlebt Job-Ende
    // (der Anthropic-Prompt-Cache deckt nur eine 1h-Fensterspanne ab).
    const bookPagesSig = buildBookPagesSig(pageContents, getBookSettings(bookIdInt, email), cacheVersion);
    const cached = loadChapterExtractCache(bookIdInt, email, '__singlepass__', bookPagesSig, effectiveProvider);
    if (cached && Array.isArray(cached.chapterFiguren) && cached.chapterFiguren[0]?.figuren?.length > 0) {
      chapterFiguren     = cached.chapterFiguren;
      chapterOrte        = cached.chapterOrte        || [{ kapitel: 'Gesamtbuch', orte: [] }];
      chapterSongs       = cached.chapterSongs       || [{ kapitel: 'Gesamtbuch', songs: [] }];
      chapterFakten      = cached.chapterFakten      || [{ kapitel: 'Gesamtbuch', fakten: [] }];
      chapterSzenen      = cached.chapterSzenen      || [{ kapitel: 'Gesamtbuch', szenen: [] }];
      chapterAssignments = cached.chapterAssignments || [{ kapitel: 'Gesamtbuch', assignments: [] }];
      log.info(`Phase 1 Single-Pass – Cache-HIT (pages_sig match) – spart den Extraktions-Call.`);
      updateJob(jobId, { progress: 28, statusText: 'job.phase.checkpointLoaded' });
    } else {
      updateJob(jobId, { progress: 12, statusText: 'job.phase.extracting' });
      // Ein kombinierter Call (Figuren+Orte+Fakten+Szenen+Assignments). Claude erhält den
      // Buchtext zusätzlich als eigenen cache_control-Block mit 1h-TTL, sodass Phase 8
      // Kontinuität denselben Prefix trifft und cache_read statt cache_write zahlt.
      let r;
      if (effectiveProvider === 'claude') {
        const bookSystemBlock = { text: buildBookSystemBlockText(bookName, pageContents.length, fullBookText), ttl: '1h' };
        r = await call(jobId, tok,
          prompts.buildExtraktionKomplettChapterPrompt('Gesamtbuch', bookName, pageContents.length, null),
          [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS, '1h')],
          12, 28, 22000, 0.2, null, prompts.SCHEMA_KOMPLETT_EXTRAKTION,
        );
      } else {
        r = await call(jobId, tok,
          prompts.buildExtraktionKomplettChapterPrompt('Gesamtbuch', bookName, pageContents.length, fullBookText),
          sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS, 12, 28, 16000, 0.2, null, prompts.SCHEMA_KOMPLETT_EXTRAKTION,
        );
      }
      const passA = { figuren: r?.figuren, assignments: r?.assignments };
      const passB = { orte: r?.orte, songs: r?.songs, fakten: r?.fakten, szenen: r?.szenen };
      chapterFiguren     = [{ kapitel: 'Gesamtbuch', figuren:     passA.figuren     || [] }];
      chapterOrte        = [{ kapitel: 'Gesamtbuch', orte:        passB.orte        || [] }];
      chapterSongs       = [{ kapitel: 'Gesamtbuch', songs:       passB.songs       || [] }];
      chapterFakten      = [{ kapitel: 'Gesamtbuch', fakten:      passB.fakten      || [] }];
      chapterSzenen      = [{ kapitel: 'Gesamtbuch', szenen:      passB.szenen      || [] }];
      chapterAssignments = [{ kapitel: 'Gesamtbuch', assignments: passA.assignments || [] }];
      const totalEvents = (passA.assignments || []).reduce((s, a) => s + (a.lebensereignisse?.length || 0), 0);
      log.info(`Single-Pass OK – fig=${chapterFiguren[0].figuren.length} orte=${chapterOrte[0].orte.length} songs=${chapterSongs[0].songs.length} sz=${chapterSzenen[0].szenen.length} (${totalEvents} Ereignisse)`);
      saveChapterExtractCache(bookIdInt, email, '__singlepass__', bookPagesSig, {
        chapterFiguren, chapterOrte, chapterSongs, chapterFakten, chapterSzenen, chapterAssignments,
      }, effectiveProvider);
    }
  } else {
    // ── Multi-Pass mit Delta-Cache ──
    // Für lokale Modelle: Kapitel die PER_CHUNK_LIMIT überschreiten, werden in Seiten-Untergruppen
    // aufgeteilt. Jeder Chunk bekommt einen eigenen KI-Call mit eigenem Delta-Cache-Eintrag.
    // Claude nutzt singlePassLimit (250K) als Chunk-Grenze → kein Splitting in der Praxis.
    updateJob(jobId, { progress: 12, statusText: 'job.phase.extractingChunks', statusParams: { n: chunkOrder.length } });
    const chunkTexts = chunkOrder.map(chunkKey => {
      const chunk = chunks.get(chunkKey);
      return {
        chunk, key: chunkKey,
        pagesSig: chunk.pages.map(p => `${p.id}:${p.updated_at}`).sort().join('|') + `||${cacheVersion || ''}`,
        chText: chunk.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n'),
      };
    });
    let cacheHits = 0;
    // Welle 4 · #11 – für lokale Modelle zweigeteilte Extraktion:
    //   Pass A: figuren + assignments (fokussiertes Schema)
    //   Pass B: orte + fakten + szenen
    // Cache-Keys entsprechend `${key}:figuren` / `${key}:orte`, damit alte
    // kombinierte Caches sauber neu entstehen statt fälschlich getroffen zu werden.
    const isSplit = effectiveProvider !== 'claude';
    // Claude-Multi-Pass: Anthropic-TPM-Burst dämpfen.
    //   - warmup: Erst-Chunk seriell → schreibt Prompt-Cache; Folge-Chunks
    //     hitten den Cache, ~10× günstiger Input + kürzere Reqs → kleinerer Burst.
    //   - concurrency-Cap: max. ai.claude.phase1_concurrency parallele Chunks.
    //     Default 4 — empirisch belastbar gegen Tier-1/2 TPM-Limits bei ~25k tok/Chunk.
    const claudeConcurrency = Math.max(1, parseInt(appSettings.get('ai.claude.phase1_concurrency'), 10) || 4);
    const settledOpts = (effectiveProvider === 'claude' && chunkTexts.length > claudeConcurrency)
      ? { concurrency: claudeConcurrency, warmup: true }
      : {};
    if (settledOpts.warmup) {
      log.info(`Phase 1 Multi-Pass – ${chunkTexts.length} Chunks, Warmup-Pass + Concurrency=${claudeConcurrency} (TPM-Schutz).`);
    }
    const settled = await settledAll(
      chunkTexts.map(({ chunk, key, pagesSig, chText }, chunkIdx) => async () => {
        const chunkLabel = `Chunk ${chunkIdx + 1}/${chunkTexts.length} «${chunk.name}»`;
        log.info(`${chunkLabel} – ${chunk.pages.length} Seiten${isSplit ? ' (Split-Pässe)' : ''}`);

        if (!isSplit) {
          const cached = loadChapterExtractCache(bookIdInt, email, key, pagesSig, effectiveProvider);
          if (cached) { cacheHits++; log.info(`${chunkLabel} – Cache-HIT.`); return cached; }
          log.info(`${chunkLabel} – Cache-MISS, KI-Call…`);
          const result = await call(jobId, tok,
            prompts.buildExtraktionKomplettChapterPrompt(chunk.name, bookName, chunk.pages.length, chText),
            sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS, 12, 28, 14000, 0.2, null, prompts.SCHEMA_KOMPLETT_EXTRAKTION,
          );
          saveChapterExtractCache(bookIdInt, email, key, pagesSig, result, effectiveProvider);
          log.info(`${chunkLabel} – OK (fig=${result?.figuren?.length ?? 0} orte=${result?.orte?.length ?? 0} songs=${result?.songs?.length ?? 0} sz=${result?.szenen?.length ?? 0}).`);
          return result;
        }

        const figKey = `${key}:figuren`;
        const ortKey = `${key}:orte`;
        const cachedFig = loadChapterExtractCache(bookIdInt, email, figKey, pagesSig, effectiveProvider);
        const cachedOrt = loadChapterExtractCache(bookIdInt, email, ortKey, pagesSig, effectiveProvider);

        let passA = cachedFig;
        if (passA) { cacheHits++; log.info(`${chunkLabel} Pass A (Figuren) – Cache-HIT.`); }
        else {
          log.info(`${chunkLabel} Pass A (Figuren) – KI-Call…`);
          passA = await call(jobId, tok,
            prompts.buildExtraktionFigurenPassPrompt(chunk.name, bookName, chunk.pages.length, chText),
            sys.SYSTEM_KOMPLETT_FIGUREN_PASS_BLOCKS, 12, 20, 8000, 0.2, null, prompts.SCHEMA_KOMPLETT_FIGUREN_PASS,
          );
          saveChapterExtractCache(bookIdInt, email, figKey, pagesSig, passA, effectiveProvider);
        }

        let passB = cachedOrt;
        if (passB) { cacheHits++; log.info(`${chunkLabel} Pass B (Orte/Szenen) – Cache-HIT.`); }
        else {
          log.info(`${chunkLabel} Pass B (Orte/Szenen) – KI-Call…`);
          passB = await call(jobId, tok,
            prompts.buildExtraktionOrtePassPrompt(chunk.name, bookName, chunk.pages.length, chText),
            sys.SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS, 20, 28, 6000, 0.2, null, prompts.SCHEMA_KOMPLETT_ORTE_PASS,
          );
          saveChapterExtractCache(bookIdInt, email, ortKey, pagesSig, passB, effectiveProvider);
        }

        const merged = {
          figuren:     passA?.figuren     || [],
          assignments: passA?.assignments || [],
          orte:        passB?.orte        || [],
          songs:       passB?.songs       || [],
          fakten:      passB?.fakten      || [],
          szenen:      passB?.szenen      || [],
        };
        log.info(`${chunkLabel} – Split-OK (fig=${merged.figuren.length} orte=${merged.orte.length} songs=${merged.songs.length} sz=${merged.szenen.length}).`);
        return merged;
      }),
      settledOpts,
    );

    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === 'rejected')
        log.warn(`Vollextraktion «${chunkTexts[i].chunk.name}» übersprungen: ${settled[i].reason?.message}`);
    }
    chapterFiguren     = extractField(settled, chunkTexts, 'figuren');
    chapterOrte        = extractField(settled, chunkTexts, 'orte');
    chapterSongs       = extractField(settled, chunkTexts, 'songs');
    chapterFakten      = extractField(settled, chunkTexts, 'fakten');
    chapterSzenen      = extractField(settled, chunkTexts, 'szenen');
    chapterAssignments = extractField(settled, chunkTexts, 'assignments');

    const failedChunks = settled.filter(r => r.status === 'rejected');
    log.info(`Phase 1 Multi-Pass – ${settled.length - failedChunks.length}/${settled.length} OK (${cacheHits} Cache-Hits), fig=${chapterFiguren.reduce((s, c) => s + c.figuren.length, 0)} orte=${chapterOrte.reduce((s, c) => s + c.orte.length, 0)} songs=${chapterSongs.reduce((s, c) => s + (c.songs?.length || 0), 0)} sz=${chapterSzenen.reduce((s, c) => s + c.szenen.length, 0)}`);
    if (failedChunks.length > 0) {
      const failedDetails = chunkTexts
        .map((ct, i) => ({ ct, r: settled[i] }))
        .filter(({ r }) => r.status === 'rejected')
        .map(({ ct, r }) => `${ct.chunk.name}: ${r.reason?.message || 'unbekannt'}`);
      throw i18nError('job.error.phase1Incomplete', { count: failedChunks.length, details: failedDetails.join('; ') });
    }
  }

  saveCheckpoint('komplett-analyse', bookIdInt, email, {
    phase: 'p1_full_done',
    chapterFiguren, chapterOrte, chapterSongs, chapterFakten, chapterSzenen, chapterAssignments,
    tokIn: tok.in, tokOut: tok.out, tokMs: tok.ms,
  });
  return { chapterFiguren, chapterOrte, chapterSongs, chapterFakten, chapterSzenen, chapterAssignments };
}

/** Phase 2: Figuren konsolidieren + Soziogramm + Name→ID Lookup.
 *  Single-Pass-Optimierung: Wenn Phase 1 im Single-Pass-Modus lief (ein „Kapitel"
 *  namens Gesamtbuch), sind die Figuren bereits holistisch extrahiert – eine
 *  weitere KI-Konsolidierung fügt nichts hinzu und kostet ~8K Tokens extra.
 *  Stattdessen übernehmen wir die P1-Figuren direkt (IDs werden normalisiert). */
async function runPhase2(ctx, chapterFiguren, chapterAssignments) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, prompts, sys, idMaps, effectiveProvider } = ctx;

  const isSinglePass = chapterFiguren.length === 1 && chapterFiguren[0].kapitel === 'Gesamtbuch';
  let figuren;

  if (isSinglePass) {
    updateJob(jobId, { progress: 30, statusText: 'job.phase.consolidatingFiguren' });
    const raw = chapterFiguren[0].figuren || [];
    figuren = raw.map((f, i) => ({ ...f, id: f.id || ('fig_' + (i + 1)) }));
    log.info(`Phase 2 übersprungen (Single-Pass, ${figuren.length} Figuren aus P1 übernommen) – spart einen KI-Call.`);
    updateJob(jobId, { progress: effectiveProvider === 'claude' ? 40 : 43 });
  } else {
    updateJob(jobId, { progress: 30, statusText: 'job.phase.consolidatingFiguren' });
    // Welle 3 · Rollierender Dedup: Duplikate regelbasiert VOR dem KI-Call entfernen.
    // Spart Eingabetokens und verhindert, dass Phase 2 aus Bequemlichkeit doppelte Figuren durchlässt.
    const { chapterFiguren: preMerged, dupesRemoved } = preMergeChapterFiguren(chapterFiguren);
    if (dupesRemoved > 0) log.info(`Rollierender Pre-Merge – ${dupesRemoved} Figuren-Duplikate regelbasiert zusammengeführt.`);
    const figProgressEnd = effectiveProvider === 'claude' ? 40 : 43;
    const figResult = await call(jobId, tok,
      prompts.buildFiguresBasisConsolidationPrompt(bookName, preMerged, sys.BUCH_KONTEXT || ''),
      sys.SYSTEM_FIGUREN_BLOCKS, 30, figProgressEnd, 8000, 0.2, null, prompts.SCHEMA_FIGUREN_KONSOL,
    );
    if (!Array.isArray(figResult?.figuren)) throw i18nError('job.error.figurenMissing');
    figuren = figResult.figuren.map((f, i) => ({ ...f, id: f.id || ('fig_' + (i + 1)) }));
  }
  const { figuren: mergedFiguren, mergedCount, stage1Saved, stage2Saved, idRemap } = mergeDuplicateFiguren(figuren);
  if (mergedCount > 0) log.info(`${mergedCount} Figuren-Duplikate zusammengeführt (exakt: ${stage1Saved}, Teilname+Indizien: ${stage2Saved}).`);
  figuren = mergedFiguren;
  if (effectiveProvider && effectiveProvider !== 'claude') {
    const { cleared, moved } = validateBeziehungenDescriptions(figuren);
    if (cleared > 0 || moved > 0) log.info(`Beziehungs-Beschreibungen bereinigt – ${moved} verschoben, ${cleared} geleert.`);
    const schichtChanges = applySozialschichtModeVote(chapterFiguren, figuren);
    if (schichtChanges > 0) log.info(`Sozialschicht per Mehrheitsvotum korrigiert (${schichtChanges} Figuren).`);
  }
  saveFigurenToDb(bookIdInt, figuren, email, idMaps);
  log.info(`${figuren.length} Figuren gespeichert.`);
  try {
    const { figures: figCount, pagesProcessed } = recomputeBookFigureMentions(bookIdInt, email);
    log.info(`Figuren-Mentions aktualisiert (${figCount} Figuren × ${pagesProcessed} Seiten).`);
  } catch (e) {
    log.warn(`Figuren-Mentions-Neuberechnung fehlgeschlagen: ${e.message}`);
  }

  // Soziogramm: preliminary-Werte aus P2-Ergebnis als Fallback
  if (figuren.length >= 4) {
    let sozFiguren = figuren.map(f => ({ fig_id: f.id, sozialschicht: f.sozialschicht || 'andere' }));
    let sozBeziehungen = figuren.flatMap(f =>
      (f.beziehungen || [])
        .filter(bz => bz.machtverhaltnis && bz.figur_id)
        .map(bz => ({ from_fig_id: f.id, to_fig_id: bz.figur_id, machtverhaltnis: bz.machtverhaltnis }))
    );

    // Claude-only + Multi-Pass: holistische Soziogramm-Konsolidierung (sozialschicht + machtverhaltnis)
    // Bei Single-Pass hat Claude das ganze Buch gesehen → preliminary-Werte sind bereits holistisch,
    // der Refine-Call fügt nichts hinzu und kostet ~3K Tokens extra.
    if (effectiveProvider === 'claude' && !isSinglePass) {
      updateJob(jobId, { progress: 40, statusText: 'job.phase.refiningSoziogramm' });
      try {
        const sozResult = await call(jobId, tok,
          prompts.buildSoziogrammConsolidationPrompt(bookName, figuren, sys.BUCH_KONTEXT || ''),
          sys.SYSTEM_FIGUREN_BLOCKS, 40, 43, 3000, 0.2, null, prompts.SCHEMA_SOZIOGRAMM_KONSOL,
        );
        const validIds = new Set(figuren.map(f => f.id));
        const prelimSchichtById = Object.fromEntries(sozFiguren.map(s => [s.fig_id, s.sozialschicht]));
        const prelimPairs = new Set(sozBeziehungen.map(bz => `${bz.from_fig_id}|${bz.to_fig_id}`));
        const schichtOverride = {};
        for (const f of (sozResult?.figuren || [])) {
          if (f && validIds.has(f.id) && f.sozialschicht) schichtOverride[f.id] = f.sozialschicht;
        }
        sozFiguren = figuren.map(f => ({
          fig_id: f.id,
          sozialschicht: schichtOverride[f.id] || prelimSchichtById[f.id] || 'andere',
        }));
        const refinedBz = (sozResult?.beziehungen || [])
          .filter(bz => bz && validIds.has(bz.from_fig_id) && validIds.has(bz.to_fig_id)
            && bz.from_fig_id !== bz.to_fig_id
            && Number.isFinite(bz.machtverhaltnis)
            && prelimPairs.has(`${bz.from_fig_id}|${bz.to_fig_id}`));
        if (refinedBz.length > 0) sozBeziehungen = refinedBz;
        const changedSchichten = Object.keys(schichtOverride).filter(id => schichtOverride[id] !== prelimSchichtById[id]).length;
        log.info(`Soziogramm-Konsolidierung: ${changedSchichten} Schicht-Korrekturen, ${refinedBz.length}/${prelimPairs.size} Machtbeziehungen verfeinert.`);
      } catch (e) {
        log.warn(`Soziogramm-Konsolidierung fehlgeschlagen, nutze preliminary-Werte: ${e.message}`);
        updateJob(jobId, { progress: 43 });
      }
    }

    updateFigurenSoziogramm(bookIdInt, sozFiguren, sozBeziehungen, email);
    log.info(`Soziogramm: ${sozFiguren.length} Figuren, ${sozBeziehungen.length} Machtbeziehungen.`);
  }

  const figurenKompakt = figuren.map(f => ({ id: f.id, name: f.name, typ: f.typ || 'andere' }));
  const { figNameToId, figNameToIdLower } = buildFigNameLookup(figuren, chapterFiguren, chapterAssignments, log, jobId);

  return { figuren, figNameToId, figNameToIdLower, figurenKompakt, idRemap, isSinglePass };
}

/** Phase 3: Orte konsolidieren + Name→ID Lookup.
 *  Single-Pass-Optimierung analog zu Phase 2: Wenn Phase 1 im Single-Pass-Modus lief,
 *  sind die Orte bereits holistisch extrahiert – ein Konsolidierungs-Call fügt nichts
 *  hinzu und kostet ~15K Tokens. Die figuren-Referenzen in den Orten werden gegen das
 *  idRemap aus mergeDuplicateFiguren abgeglichen (gemergte Figuren werden umgebogen,
 *  nicht mehr existente entfernt). */
async function runPhase3(ctx, chapterOrte, figurenKompakt, isSinglePass, idRemap, opts = {}) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, prompts, sys, idMaps } = ctx;
  const prefetched = opts.prefetchedOrteRaw || null;

  let orte;
  if (isSinglePass) {
    updateJob(jobId, { progress: 43, statusText: 'job.phase.consolidatingOrte' });
    const validFigIds = new Set(figurenKompakt.map(f => f.id));
    const raw = chapterOrte[0]?.orte || [];
    orte = raw.map((o, i) => ({
      ...o,
      id: o.id || ('ort_' + (i + 1)),
      figuren: (o.figuren || [])
        .map(fid => idRemap?.[fid] || fid)
        .filter(fid => validFigIds.has(fid)),
    }));
    log.info(`Phase 3 übersprungen (Single-Pass, ${orte.length} Orte aus P1 übernommen) – spart einen KI-Call.`);
    updateJob(jobId, { progress: 55 });
  } else {
    updateJob(jobId, { progress: 43, statusText: 'job.phase.consolidatingOrte' });
    const orteResultRaw = prefetched || await call(jobId, tok,
      prompts.buildLocationsConsolidationPrompt(bookName, chapterOrte, figurenKompakt),
      sys.SYSTEM_ORTE_BLOCKS, 43, 55, 6000, 0.2, null, prompts.SCHEMA_ORTE_KONSOL,
    );
    if (!Array.isArray(orteResultRaw?.orte)) throw i18nError('job.error.orteMissing');
    if (prefetched) {
      const validFigIds = new Set(figurenKompakt.map(f => f.id));
      orte = orteResultRaw.orte.map((o, i) => ({
        ...o,
        id: o.id || ('ort_' + (i + 1)),
        figuren: (o.figuren || [])
          .map(fid => idRemap?.[fid] || fid)
          .filter(fid => validFigIds.has(fid)),
      }));
      updateJob(jobId, { progress: 55 });
    } else {
      orte = orteResultRaw.orte.map((o, i) => ({ ...o, id: o.id || ('ort_' + (i + 1)) }));
    }
  }
  saveOrteToDb(bookIdInt, orte, email, idMaps.chNameToId, idMaps.pageNameToIdByChapter);
  log.info(`${orte.length} Schauplätze gespeichert.`);

  const ortNameToId = {}, ortNameToIdLower = {};
  for (const o of orte) {
    ortNameToId[o.name] = o.id;
    ortNameToIdLower[o.name.toLowerCase()] = o.id;
  }
  return { orte, ortNameToId, ortNameToIdLower };
}

/** Phase 3 Songs: Musikbibliothek konsolidieren analog zu Orten.
 *  Single-Pass: Songs aus Pass B übernehmen (figuren-Refs gegen idRemap+validFigIds filtern).
 *  Multi-Pass: KI-Call konsolidiert dedupliziert (Titel+Interpret) über alle Kapitel. */
async function runPhase3Songs(ctx, chapterSongs, figurenKompakt, isSinglePass, idRemap) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, prompts, sys, idMaps } = ctx;
  const validFigIds = new Set(figurenKompakt.map(f => f.id));

  let songs;
  if (isSinglePass) {
    updateJob(jobId, { progress: 56, statusText: 'job.phase.consolidatingSongs' });
    const raw = chapterSongs[0]?.songs || [];
    songs = raw.map((s, i) => ({
      ...s,
      id: s.id || ('song_' + (i + 1)),
      figuren: (s.figuren || [])
        .map(fid => idRemap?.[fid] || fid)
        .filter(fid => validFigIds.has(fid)),
    }));
    log.info(`Phase 3 Songs übersprungen (Single-Pass, ${songs.length} Songs aus P1 übernommen).`);
  } else {
    updateJob(jobId, { progress: 56, statusText: 'job.phase.consolidatingSongs' });
    const hasInput = chapterSongs.some(cs => (cs.songs || []).length > 0);
    if (!hasInput) {
      songs = [];
      log.info(`Phase 3 Songs übersprungen (keine Songs in Pass B – KI-Call gespart).`);
    } else {
      const songsResultRaw = await call(jobId, tok,
        prompts.buildSongsConsolidationPrompt(bookName, chapterSongs, figurenKompakt),
        sys.SYSTEM_ORTE_BLOCKS, 56, 58, 3000, 0.2, null, prompts.SCHEMA_SONGS_KONSOL,
      );
      const raw = Array.isArray(songsResultRaw?.songs) ? songsResultRaw.songs : [];
      songs = raw.map((s, i) => ({
        ...s,
        id: s.id || ('song_' + (i + 1)),
        figuren: (s.figuren || [])
          .map(fid => idRemap?.[fid] || fid)
          .filter(fid => validFigIds.has(fid)),
      }));
    }
  }
  saveSongsToDb(bookIdInt, songs, email, idMaps.chNameToId, idMaps.pageNameToIdByChapter);
  log.info(`${songs.length} Songs gespeichert.`);
  return { songs };
}

/** Pre-Merge figurenKompakt aus chapterFiguren – für parallelen Orte-Call vor P2-Merge.
 *  Dedup nach ID (Reihenfolge: erstes Vorkommen gewinnt). */
function buildPrelimFigurenKompakt(chapterFiguren) {
  const seen = new Set();
  const list = [];
  for (const c of chapterFiguren) {
    for (const f of (c.figuren || [])) {
      if (!f?.id || seen.has(f.id)) continue;
      seen.add(f.id);
      list.push({ id: f.id, name: f.name, typ: f.typ || 'andere' });
    }
  }
  return list;
}

/** Nur der Orte-Konso-AI-Call (Multi-Pass) – ohne DB-Save, ohne Progress-Update.
 *  Aufrufer wendet idRemap+validFigIds-Filter via runPhase3(opts.prefetchedOrteRaw) an. */
async function runPhase3OrteCall(ctx, chapterOrte, figurenKompaktForPrompt) {
  const { jobId, bookName, call, tok, prompts, sys } = ctx;
  return call(jobId, tok,
    prompts.buildLocationsConsolidationPrompt(bookName, chapterOrte, figurenKompaktForPrompt),
    sys.SYSTEM_ORTE_BLOCKS,
    null, null,
    6000, 0.2, null, prompts.SCHEMA_ORTE_KONSOL,
  );
}

/**
 * Phase 3b: Kapitelübergreifende Beziehungen (nur Multi-Pass).
 * Single-Pass: Phase 1 hat den vollständigen Text gesehen → Beziehungen bereits erfasst.
 * Multi-Pass: Kapitel wurden isoliert analysiert → Beziehungen zwischen Figuren
 * verschiedener Kapitel hier nachträglich identifiziert.
 */
async function runPhase3b(ctx, figuren) {
  const { jobId, bookIdInt, email, call, tok, log, prompts, sys, singlePassLimit, bookName, fullBookText, pageContents } = ctx;

  updateJob(jobId, { progress: 55, statusText: 'job.phase.crossChapterRelations' });

  // Welle 3 · Co-Occurrence-basierter Textauswahl: Statt fullBookText zu trunkieren
  // (was bei lokalen Modellen bis zu 2/3 des Buchs verwirft), zielen wir auf
  // die Seiten ab, wo mindestens zwei Figuren aus verschiedenen Kapiteln gemeinsam
  // vorkommen. Das liefert dichtere Evidenz bei viel kleinerem Token-Budget.
  let textForPrompt = null;

  try {
    const { computeFigureMentions } = require('../../../lib/page-index');
    const figInput = figuren.map(f => ({ id: f.id, name: f.name, kurzname: f.kurzname || '' }));
    const figPages = new Map();
    for (let pi = 0; pi < pageContents.length; pi++) {
      const mentions = computeFigureMentions(pageContents[pi].text, figInput);
      for (const m of mentions) {
        if (!figPages.has(m.figure_id)) figPages.set(m.figure_id, new Set());
        figPages.get(m.figure_id).add(pi);
      }
    }
    const figToHome = Object.fromEntries(figuren.map(f => [f.id, (f.kapitel || [])[0]?.name || null]));
    const existingPairs = new Set();
    for (const f of figuren) {
      for (const b of (f.beziehungen || [])) {
        const [a, c] = f.id < b.figur_id ? [f.id, b.figur_id] : [b.figur_id, f.id];
        existingPairs.add(`${a}|${c}`);
      }
    }
    const candidatePageIdx = new Set();
    const figIds = figuren.map(f => f.id);
    for (let i = 0; i < figIds.length; i++) {
      for (let j = i + 1; j < figIds.length; j++) {
        const a = figIds[i], b = figIds[j];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (existingPairs.has(key)) continue;
        if (figToHome[a] && figToHome[b] && figToHome[a] === figToHome[b]) continue;
        const pa = figPages.get(a), pb = figPages.get(b);
        if (!pa || !pb) continue;
        for (const pi of pa) if (pb.has(pi)) candidatePageIdx.add(pi);
      }
    }
    if (candidatePageIdx.size > 0) {
      const sortedIdx = [...candidatePageIdx].sort((x, y) => x - y);
      const parts = [];
      let total = 0;
      for (const pi of sortedIdx) {
        const p = pageContents[pi];
        const chunk = `## ${p.chapter || 'Sonstige'}\n### ${p.title}\n${p.text}`;
        if (total + chunk.length > singlePassLimit) break;
        parts.push(chunk);
        total += chunk.length;
      }
      if (parts.length > 0) {
        textForPrompt = parts.join('\n\n---\n\n');
        log.info(`Phase 3b Co-Occurrence – ${parts.length} Seiten (${total} Zeichen) aus ${candidatePageIdx.size} Kandidaten.`);
      }
    }
  } catch (e) {
    log.warn(`Phase 3b Co-Occurrence-Auswahl fehlgeschlagen, Fallback auf Trunkierung: ${e.message}`);
  }

  if (!textForPrompt) {
    textForPrompt = fullBookText.length <= singlePassLimit ? fullBookText : fullBookText.slice(0, singlePassLimit);
  }

  const bzResult = await call(jobId, tok,
    prompts.buildKapiteluebergreifendeBeziehungenPrompt(bookName, figuren, textForPrompt),
    sys.SYSTEM_FIGUREN_BLOCKS, 55, 58, 2000, 0.2, null, prompts.SCHEMA_BEZIEHUNGEN,
  );
  const newBz = Array.isArray(bzResult?.beziehungen) ? bzResult.beziehungen : [];
  if (newBz.length > 0) addFigurenBeziehungen(bookIdInt, newBz, email, ctx.idMaps);
  log.info(`Phase 3b – ${newBz.length} kapitelübergreifende Beziehungen.`);
}

/** P6: Zeitstrahl aus gespeicherten Events konsolidieren. */
async function runZeitstrahl(ctx, opts = {}) {
  const { jobId, bookIdInt, email, call, tok, log, prompts, sys, idMaps } = ctx;
  // silent: keine Progress-/Status-Updates; nötig wenn parallel zu P8 (Claude),
  // damit P8 die Bar exklusiv kontrolliert.
  const silent = !!opts.silent;

  if (!silent) updateJob(jobId, { progress: 78, statusText: 'job.phase.consolidatingTimeline' });
  const rawEvtRows = db.prepare(`
    SELECT f.fig_id, f.name AS fig_name, f.typ AS fig_typ,
           fe.datum, fe.ereignis, fe.typ AS evt_typ, fe.bedeutung,
           c.chapter_name AS kapitel, p.page_name AS seite
    FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fe.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fe.page_id
    WHERE f.book_id = ? AND f.user_email IS ?
    ORDER BY fe.datum, f.sort_order
  `).all(bookIdInt, email);
  if (!rawEvtRows.length) return;

  const evtGroupMap = new Map();
  for (const row of rawEvtRows) {
    const key = `${row.datum}||${(row.ereignis || '').trim().toLowerCase()}`;
    if (!evtGroupMap.has(key)) {
      evtGroupMap.set(key, {
        datum: row.datum, ereignis: row.ereignis, typ: row.evt_typ,
        bedeutung: row.bedeutung || '',
        kapitel: row.kapitel ? [row.kapitel] : [],
        seiten:  row.seite   ? [row.seite]   : [],
        figuren: [],
      });
    }
    const ev = evtGroupMap.get(key);
    if (!ev.figuren.some(f => f.id === row.fig_id))
      ev.figuren.push({ id: row.fig_id, name: row.fig_name, typ: row.fig_typ || 'andere' });
    if (row.kapitel && !ev.kapitel.includes(row.kapitel)) ev.kapitel.push(row.kapitel);
    if (row.seite   && !ev.seiten.includes(row.seite))   ev.seiten.push(row.seite);
  }

  const zeitstrahlEvents = [...evtGroupMap.values()].sort((a, b) => parseInt(a.datum) - parseInt(b.datum));

  // Bei wenigen pre-gegroupeten Events bringt die KI-Konsolidierung fast nichts
  // (Dedup-Chance klein, kanonische Formulierung marginal) – direkt speichern spart
  // einen KI-Call (~2K Input + 3K Output).
  if (zeitstrahlEvents.length < 5) {
    saveZeitstrahlEvents(bookIdInt, email, zeitstrahlEvents, idMaps.chNameToId, idMaps.pageNameToIdByChapter);
    log.info(`${zeitstrahlEvents.length} Zeitstrahl-Ereignisse direkt gespeichert (unter Konsolidierungs-Schwelle) – spart einen KI-Call.`);
    if (!silent) updateJob(jobId, { progress: 82 });
    return;
  }

  const ztResult = await call(jobId, tok,
    prompts.buildZeitstrahlConsolidationPrompt(zeitstrahlEvents),
    sys.SYSTEM_ZEITSTRAHL_BLOCKS,
    silent ? null : 78, silent ? null : 82,
    3000, 0.2, null, prompts.SCHEMA_ZEITSTRAHL,
  );
  if (Array.isArray(ztResult?.ereignisse)) {
    saveZeitstrahlEvents(bookIdInt, email, ztResult.ereignisse, idMaps.chNameToId, idMaps.pageNameToIdByChapter);
    log.info(`${ztResult.ereignisse.length} Zeitstrahl-Ereignisse gespeichert.`);
  }
  if (!silent) updateJob(jobId, { progress: 82 });
}

module.exports = {
  runPhase1, runPhase2, runPhase3, runPhase3Songs,
  buildPrelimFigurenKompakt, runPhase3OrteCall, runPhase3b, runZeitstrahl,
};
