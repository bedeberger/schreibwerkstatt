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
  i18nError, settledAll, retryOnTransientAi, splitGroupsIntoChunks, updateJob,
  toSystemBlocks,
} = require('../shared');
const {
  buildBookSystemBlockText, buildBookPagesSig, bookSettingsSigPart,
  extractField, buildFigNameLookup,
} = require('./utils');
const {
  preMergeChapterFiguren, applySozialschichtModeVote,
  mergeDuplicateFiguren, validateBeziehungenDescriptions,
  mergeBeziehungenIntoFiguren, backfillFiguren, ensureUniqueFigIds,
} = require('./figuren-merge');
const appSettings = require('../../../lib/app-settings');
const { getContextConfigFor } = require('../../../lib/ai');

/**
 * Output-Cap für Komplettanalyse-Calls (Extraktion + Konsolidierung), provider-abhängig.
 * Claude rechnet nur generierte Tokens ab — reserviertes max_tokens ist gratis — also
 * grosszügig aufs Provider-Ceiling deckeln (kein Truncation-Risiko, keine Retry-Ladder).
 * Lokale Provider knapper auf das konfigurierte ai.komplett.extract_max_tokens (VRAM/Latenz),
 * gedeckelt aufs jeweilige Ceiling. aiCall deckelt selbst nochmal aufs Provider-Ceiling.
 */
function komplettMaxTokens(provider) {
  const ceiling = getContextConfigFor(provider).maxTokensOut;
  if (provider === 'claude') return ceiling;
  const base = Math.max(1024, parseInt(appSettings.get('ai.komplett.extract_max_tokens'), 10) || 16000);
  return Math.min(base, ceiling);
}

/**
 * Phase 1: Vollextraktion (Figuren+Orte+Fakten+Szenen+Events).
 * Single-Pass für kleine Bücher, Multi-Pass mit Delta-Cache für grosse.
 * Schema und Regeln im System-Prompt (SYSTEM_KOMPLETT_EXTRAKTION) → gecacht über alle Kapitel.
 * Szenen/Assignments verwenden Klarnamen statt IDs; Remapping nach P2/P3-Konsolidierung.
 */
async function runPhase1(ctx) {
  const { jobId, bookIdInt, bookName, email, call, tok, log,
    effectiveProvider, singlePassLimit, perChunkLimit: ctxPerChunkLimit, cacheVersion,
    prompts, sys, pageContents, groups, groupOrder, totalChars, fullBookText } = ctx;

  // Claude packt alles in einen Chunk (singlePassLimit als obere Schranke), lokale
  // Provider chunken nach `ai.<provider>.context_window` (siehe ctx.perChunkLimit aus chunkLimitsFor).
  const perChunkLimit = effectiveProvider === 'claude' ? singlePassLimit : ctxPerChunkLimit;
  const { chunkOrder, chunks } = splitGroupsIntoChunks(groups, groupOrder, perChunkLimit);

  // Output-Cap für lokale Extraktions-Calls (Single-Pass-lokal + Multi-Pass Split A/B):
  // ai.komplett.extract_max_tokens, gedeckelt aufs Provider-Ceiling (komplettMaxTokens).
  // KEIN Eskalations-Retry: lokale Modelle, die hier trunkieren, tun das wegen
  // Wiederholungsschleifen — ein höherer Cap generiert nur länger, bevor er ebenso
  // reisst (verdoppelt die Wartezeit). Gegen die Schleifen wirkt repeat_penalty
  // (ai.<provider>.repeat_penalty, lib/ai.js); echte Truncation einzelner Chunks wird
  // in der Multi-Pass-Auswertung als nicht-fatal behandelt (Teilabdeckung + Warnung).
  // Claude rechnet nur generierte Tokens ab — reserviertes max_tokens ist gratis —,
  // darum die Claude-Extraktions-Calls direkt grosszügig aufs Provider-Ceiling deckeln.
  const claudeExtractCap = getContextConfigFor(effectiveProvider).maxTokensOut;
  const callExtract = (label, prompt, system, fromPct, toPct, expectedChars, schema) =>
    retryOnTransientAi(() => call(jobId, tok, prompt, system, fromPct, toPct, expectedChars, 0.2, komplettMaxTokens(effectiveProvider), schema),
      { log, label });

  log.info(`Phase 1 – ${totalChars} Zeichen, ${effectiveProvider} → ${totalChars <= singlePassLimit ? 'Single-Pass' : `Multi-Pass (${groupOrder.length} Kapitel → ${chunkOrder.length} Chunks)`}`);

  let chapterFiguren, chapterOrte, chapterSongs, chapterFakten, chapterSzenen, chapterAssignments;

  if (totalChars <= singlePassLimit) {
    // ── Single-Pass ──
    // Persistenter Cache: wenn Pages+Kapitelnamen unverändert, P1-Ergebnis wiederverwenden.
    // Key: chapter_key='__singlepass__' + Gesamt-Seitensignatur. Überlebt Job-Ende
    // (der Anthropic-Prompt-Cache deckt nur eine 1h-Fensterspanne ab).
    const bookPagesSig = buildBookPagesSig(pageContents, getBookSettings(bookIdInt, email), cacheVersion);
    const cached = loadChapterExtractCache(bookIdInt, email, '__singlepass__', bookPagesSig, effectiveProvider);
    // HIT auf Cache-Präsenz gaten, nicht auf Figuren-Count: Bücher ohne Figuren
    // (Sachbuch, Lyrik) sind legitim – sonst Cache-MISS bei jedem Run trotz
    // identischem Seitenstand.
    if (cached && Array.isArray(cached.chapterFiguren) && cached.chapterFiguren.length > 0) {
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
      let passA, passB;
      // A2 (Beziehungen) kann scheitern, nachdem A1 Figuren erfolgreich lieferte. Dann
      // dürfen die beziehungslosen Figuren NICHT als '__singlepass__'-Cache eingefroren
      // werden (sonst Phantom-Erfolg bei jedem Folgelauf bis zur Seitenedition).
      let relationsFailed = false;
      let faktenFailed = false;
      if (effectiveProvider === 'claude') {
        // Claude-Split: Figuren-Stammdaten (A1) + Orte/Szenen (B) + Fakten (C) parallel,
        // danach Beziehungen (A2) aus den A1-IDs. Alle Calls teilen denselben Buchtext-
        // Block (cache_control 1h) → Folge-Calls zahlen cache_read; Phase 8 trifft
        // denselben Prefix. Kleinere Schemas pro Call senken das Truncation-Risiko.
        // Fakten als eigener Call (C): volle Modell-Aufmerksamkeit auf dichte
        // Faktenerfassung statt im 4-Array-Orte-Pass um Output-Budget zu konkurrieren.
        const bookSystemBlock = { text: buildBookSystemBlockText(bookName, pageContents.length, fullBookText), ttl: '1h' };
        const [stammRes, orteRes, faktenRes] = await settledAll([
          () => retryOnTransientAi(() => call(jobId, tok,
            prompts.buildExtraktionFigurenStammPrompt('Gesamtbuch', bookName, pageContents.length, null),
            [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_FIGUREN_STAMM_BLOCKS, '1h')],
            12, 20, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_FIGUREN_STAMM,
          ), { log, label: 'Single-Pass Figuren-Stamm (A1)' }),
          () => retryOnTransientAi(() => call(jobId, tok,
            prompts.buildExtraktionOrtePassPrompt('Gesamtbuch', bookName, pageContents.length, null),
            [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS, '1h')],
            12, 20, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_ORTE_PASS,
          ), { log, label: 'Single-Pass Orte/Szenen (B)' }),
          () => retryOnTransientAi(() => call(jobId, tok,
            prompts.buildExtraktionFaktenPassPrompt('Gesamtbuch', bookName, pageContents.length, null),
            [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_FAKTEN_PASS_BLOCKS, '1h')],
            12, 20, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_FAKTEN_PASS,
          ), { log, label: 'Single-Pass Fakten (C)' }),
        // warmup: A1 läuft seriell zuerst und schreibt den 1h-bookSystemBlock-Cache;
        // B/C (und das nachgelagerte A2/P8) lesen ihn dann statt ihn ein zweites Mal
        // teuer neu zu erstellen. Spart ~1× cache_creation auf dem ~grössten Block.
        ], { warmup: true });
        if (stammRes.status === 'rejected') throw stammRes.reason;
        const stamm = stammRes.value || {};
        // Orte/Szenen-Pass nicht still degradieren: ein durch Call-Fehler leerer
        // Katalog würde unter '__singlepass__' gecacht und bei jedem Folgelauf als
        // HIT geliefert (Phantom-Erfolg), bis eine Seitenedition die Signatur ändert.
        // Wie A1 hart werfen – transiente Fehler sind oben bereits geretryt. Ein
        // legitim ortloses Buch liefert fulfilled mit leerem Array und cached korrekt.
        if (orteRes.status === 'rejected') throw orteRes.reason;
        passB = orteRes.value || {};
        // Fakten-Pass (C): nicht fatal – ein gescheiterter Fakten-Call soll die
        // teure Figuren-/Orte-Extraktion nicht verwerfen. Stattdessen leere Fakten +
        // Warnung; faktenFailed verhindert das Einfrieren des '__singlepass__'-Caches
        // (sonst Phantom-leere-Fakten bis zur nächsten Seitenedition).
        if (faktenRes.status === 'rejected') {
          faktenFailed = true;
          log.warn(`Single-Pass Fakten-Pass (C) fehlgeschlagen, Fakten leer: ${faktenRes.reason?.message}`);
          ctx.warnings?.push({ key: 'job.warn.faktenFailed' });
          passB.fakten = [];
        } else {
          passB.fakten = faktenRes.value?.fakten || [];
        }

        // A2: Beziehungen separat – braucht die stabilen IDs aus A1.
        let stammFiguren = stamm.figuren || [];
        if (stammFiguren.length >= 2) {
          updateJob(jobId, { progress: 20, statusText: 'job.phase.extractingRelations' });
          try {
            const bzRes = await retryOnTransientAi(() => call(jobId, tok,
              prompts.buildFigurenBeziehungenExtraktionPrompt(bookName, stammFiguren, null),
              [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_FIGUREN_BLOCKS, '1h')],
              20, 28, claudeExtractCap, 0.2, null, prompts.SCHEMA_BEZIEHUNGEN,
            ), { log, label: 'Single-Pass Beziehungen (A2)' });
            const flatBz = Array.isArray(bzRes?.beziehungen) ? bzRes.beziehungen : [];
            stammFiguren = mergeBeziehungenIntoFiguren(stammFiguren, flatBz);
            log.info(`Single-Pass Beziehungs-Pass (A2) – ${flatBz.length} Beziehungen extrahiert.`);
          } catch (e) {
            relationsFailed = true;
            log.warn(`Single-Pass Beziehungs-Pass (A2) fehlgeschlagen, Figuren ohne Beziehungen: ${e.message}`);
            ctx.warnings?.push({ key: 'job.warn.relationsFailed' });
          }
        }
        passA = { figuren: stammFiguren, assignments: stamm.assignments };
      } else {
        // Lokale Provider: kombinierter Call (kein 1h-Cache → Split wäre 3× voller Input).
        const r = await callExtract('Single-Pass Extraktion (lokal)',
          prompts.buildExtraktionKomplettChapterPrompt('Gesamtbuch', bookName, pageContents.length, fullBookText),
          sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS, 12, 28, 16000, prompts.SCHEMA_KOMPLETT_EXTRAKTION);
        passA = { figuren: r?.figuren, assignments: r?.assignments };
        passB = { orte: r?.orte, songs: r?.songs, fakten: r?.fakten, szenen: r?.szenen };
      }
      chapterFiguren     = [{ kapitel: 'Gesamtbuch', figuren:     passA.figuren     || [] }];
      chapterOrte        = [{ kapitel: 'Gesamtbuch', orte:        passB.orte        || [] }];
      chapterSongs       = [{ kapitel: 'Gesamtbuch', songs:       passB.songs       || [] }];
      chapterFakten      = [{ kapitel: 'Gesamtbuch', fakten:      passB.fakten      || [] }];
      chapterSzenen      = [{ kapitel: 'Gesamtbuch', szenen:      passB.szenen      || [] }];
      chapterAssignments = [{ kapitel: 'Gesamtbuch', assignments: passA.assignments || [] }];
      const totalEvents = (passA.assignments || []).reduce((s, a) => s + (a.lebensereignisse?.length || 0), 0);
      log.info(`Single-Pass OK – fig=${chapterFiguren[0].figuren.length} orte=${chapterOrte[0].orte.length} songs=${chapterSongs[0].songs.length} fakten=${chapterFakten[0].fakten.length} sz=${chapterSzenen[0].szenen.length} (${totalEvents} Ereignisse)`);
      if (relationsFailed || faktenFailed) {
        log.warn(`Single-Pass Cache übersprungen – ${relationsFailed ? 'A2 (Beziehungen)' : 'C (Fakten)'} gescheitert, Teilstand wird nicht eingefroren.`);
      } else {
        saveChapterExtractCache(bookIdInt, email, '__singlepass__', bookPagesSig, {
          chapterFiguren, chapterOrte, chapterSongs, chapterFakten, chapterSzenen, chapterAssignments,
        }, effectiveProvider);
      }
    }
  } else {
    // ── Multi-Pass mit Delta-Cache ──
    // Für lokale Modelle: Kapitel die PER_CHUNK_LIMIT überschreiten, werden in Seiten-Untergruppen
    // aufgeteilt. Jeder Chunk bekommt einen eigenen KI-Call mit eigenem Delta-Cache-Eintrag.
    // Claude nutzt singlePassLimit (250K) als Chunk-Grenze → kein Splitting in der Praxis.
    updateJob(jobId, { progress: 12, statusText: 'job.phase.extractingChunks', statusParams: { n: chunkOrder.length } });
    // Settings-Anteil identisch zum Single-Pass-Key (buildBookPagesSig): Buchtyp/
    // Kontext fliessen in den Extraktions-Prompt, also muss ihr Wechsel auch die
    // Per-Chunk-Caches invalidieren – sonst liefert der Multi-Pass-Cache stale
    // Extraktion mit den alten Autoren-Vorgaben.
    const settingsSig = bookSettingsSigPart(getBookSettings(bookIdInt, email));
    const chunkTexts = chunkOrder.map(chunkKey => {
      const chunk = chunks.get(chunkKey);
      return {
        chunk, key: chunkKey,
        pagesSig: chunk.pages.map(p => `${p.id}:${p.updated_at}`).sort().join('|') + `||${settingsSig}||${cacheVersion || ''}`,
        chText: chunk.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n'),
      };
    });
    // Claude-Warmup laeuft seriell (settledAll(..., {warmup:true})) und schreibt
    // den Prompt-Cache fuer die parallelen Folge-Chunks. Damit der serielle
    // Pass keine Verzoegerung kostet, faengt der kleinste Chunk an
    // (Seitenzahl als Proxy; bei Gleichstand stabile chunkOrder-Reihenfolge).
    if (effectiveProvider === 'claude' && chunkTexts.length > 1) {
      const minIdx = chunkTexts.reduce((best, ct, i, arr) =>
        ct.chunk.pages.length < arr[best].chunk.pages.length ? i : best, 0);
      if (minIdx > 0) {
        const [smallest] = chunkTexts.splice(minIdx, 1);
        chunkTexts.unshift(smallest);
      }
    }
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
    // Progress wird pro abgeschlossenem Chunk gebumpt – nicht via aiCall-Stream.
    // Parallele Chunks würden sonst alle in 12-28 ticken, jeder mit eigenem
    // chars/dynExpectedChars: der schnellste Stream pusht die Bar früh auf 28
    // (Clamp lässt sie dort sitzen) während andere noch streamen. Monotone
    // Chunk-Completion-Updates = ehrlicher Verlauf.
    let chunksDone = 0;
    const bumpChunkProgress = () => {
      chunksDone++;
      updateJob(jobId, { progress: 12 + Math.round((chunksDone / chunkTexts.length) * 16) });
    };
    const settled = await settledAll(
      chunkTexts.map(({ chunk, key, pagesSig, chText }, chunkIdx) => async () => {
        const chunkLabel = `Chunk ${chunkIdx + 1}/${chunkTexts.length} «${chunk.name}»`;
        log.info(`${chunkLabel} – ${chunk.pages.length} Seiten${isSplit ? ' (Split-Pässe)' : ''}`);

        if (!isSplit) {
          const cached = loadChapterExtractCache(bookIdInt, email, key, pagesSig, effectiveProvider);
          if (cached) { cacheHits++; log.info(`${chunkLabel} – Cache-HIT.`); bumpChunkProgress(); return cached; }
          log.info(`${chunkLabel} – Cache-MISS, KI-Call…`);
          const result = await retryOnTransientAi(() => call(jobId, tok,
            prompts.buildExtraktionKomplettChapterPrompt(chunk.name, bookName, chunk.pages.length, chText),
            sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS, null, null, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_EXTRAKTION,
          ), { log, label: chunkLabel });
          saveChapterExtractCache(bookIdInt, email, key, pagesSig, result, effectiveProvider);
          log.info(`${chunkLabel} – OK (fig=${result?.figuren?.length ?? 0} orte=${result?.orte?.length ?? 0} songs=${result?.songs?.length ?? 0} sz=${result?.szenen?.length ?? 0}).`);
          bumpChunkProgress();
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
          passA = await callExtract(`${chunkLabel} Pass A`,
            prompts.buildExtraktionFigurenPassPrompt(chunk.name, bookName, chunk.pages.length, chText),
            sys.SYSTEM_KOMPLETT_FIGUREN_PASS_BLOCKS, null, null, 8000, prompts.SCHEMA_KOMPLETT_FIGUREN_PASS);
          saveChapterExtractCache(bookIdInt, email, figKey, pagesSig, passA, effectiveProvider);
        }

        let passB = cachedOrt;
        if (passB) { cacheHits++; log.info(`${chunkLabel} Pass B (Orte/Szenen) – Cache-HIT.`); }
        else {
          log.info(`${chunkLabel} Pass B (Orte/Szenen) – KI-Call…`);
          passB = await callExtract(`${chunkLabel} Pass B`,
            prompts.buildExtraktionOrtePassPrompt(chunk.name, bookName, chunk.pages.length, chText),
            sys.SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS, null, null, 6000, prompts.SCHEMA_KOMPLETT_ORTE_PASS);
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
        bumpChunkProgress();
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
    const cacheLookups = chunkTexts.length * (isSplit ? 2 : 1);
    log.info(`Phase 1 Multi-Pass – ${settled.length - failedChunks.length}/${settled.length} OK (${cacheHits}/${cacheLookups} Cache-Hits), fig=${chapterFiguren.reduce((s, c) => s + c.figuren.length, 0)} orte=${chapterOrte.reduce((s, c) => s + c.orte.length, 0)} songs=${chapterSongs.reduce((s, c) => s + (c.songs?.length || 0), 0)} sz=${chapterSzenen.reduce((s, c) => s + c.szenen.length, 0)}`);
    if (failedChunks.length > 0) {
      const failedInfo = chunkTexts
        .map((ct, i) => ({ ct, r: settled[i] }))
        .filter(({ r }) => r.status === 'rejected')
        .map(({ ct, r }) => ({ name: ct.chunk.name, message: r.reason?.message || 'unbekannt' }));
      const details = failedInfo.map(f => `${f.name}: ${f.message}`).join('; ');
      const onlyTruncation = failedInfo.every(f => f.message === 'job.error.aiTruncated');
      const someSucceeded = (settled.length - failedChunks.length) > 0;
      // Truncation einzelner Chunks ist nicht-fatal, SOLANGE mindestens ein Chunk
      // Daten lieferte: das lokale Modell dreht bei dichten Kapiteln in Wiederholungs-
      // schleifen (kein Cap fixt das — repeat_penalty mildert es). Betroffene
      // (Teil-)Chunks tragen dann nichts bei; wiederkehrende Figuren/Orte werden über
      // die übrigen Chunks meist trotzdem erfasst. Andere Fehlerarten (Provider down,
      // Parse-Fehler) ODER ein Totalausfall (0 OK) bleiben hart — dann hat Phase 1
      // keine verlässliche Basis und der Job bricht ehrlich ab, statt ein leeres
      // Ergebnis als „fertig" auszugeben.
      if (onlyTruncation && someSucceeded) {
        const skippedChapters = [...new Set(failedInfo.map(f => f.name))];
        log.warn(`Phase 1 – ${failedChunks.length} Chunk(s) durch Truncation übersprungen (nicht-fatal): ${details}`);
        ctx.warnings?.push({
          key: 'job.warn.chunksTruncated',
          params: { count: failedChunks.length, chapters: skippedChapters.join(', ') },
        });
      } else {
        throw i18nError('job.error.phase1Incomplete', { count: failedChunks.length, details });
      }
    }
  }

  saveCheckpoint('komplett-analyse', bookIdInt, email, {
    phase: 'p1_full_done',
    bookPagesSig: ctx.bookPagesSig,
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
async function runPhase2(ctx, chapterFiguren, chapterAssignments, chapterSzenen) {
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
    let figResult;
    try {
      figResult = await call(jobId, tok,
        prompts.buildFiguresBasisConsolidationPrompt(bookName, preMerged, sys.BUCH_KONTEXT || ''),
        sys.SYSTEM_FIGUREN_BLOCKS, 30, figProgressEnd, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_FIGUREN_KONSOL,
      );
      if (!Array.isArray(figResult?.figuren)) throw i18nError('job.error.figurenMissing');
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // Konsolidierungs-Call fehlgeschlagen (typisch: aiTruncated, wenn ein kleines lokales Modell
      // viele Figuren in einen Output packen müsste). Statt den gesamten Job – inkl. mehrstündiger
      // Phase-1-Arbeit – zu verwerfen, auf die bereits regelbasiert pre-gemergten Figuren zurückfallen.
      // mergeDuplicateFiguren + backfill unten laufen ohnehin noch; das Soziogramm wird sparser
      // (kapitel-lokale Beziehungs-Refs filtert die Soziogramm-Stufe via validIds heraus).
      // Kapitel-lokale fig_ids sind NICHT global eindeutig (jedes Kapitel beginnt bei fig_1);
      // normalerweise vergibt Phase 2 eindeutige IDs. Im Fallback selbst neu durchnummerieren,
      // sonst kollidieren gleiche Kapitel-Indizes verschiedener Figuren im
      // UNIQUE(book_id, fig_id, user_email) von saveFigurenToDb.
      const fallback = preMerged.flatMap(c => c.figuren || []).map((f, i) => ({ ...f, id: 'fig_' + (i + 1) }));
      log.warn(`Phase-2-Figuren-Konsolidierung übersprungen (${e.message}) – Fallback auf ${fallback.length} pre-gemergte Figuren.`);
      ctx.warnings?.push({ key: 'job.warn.figurenKonsolidierungDegraded' });
      figResult = { figuren: fallback };
      updateJob(jobId, { progress: figProgressEnd });
    }
    figuren = figResult.figuren.map((f, i) => ({ ...f, id: f.id || ('fig_' + (i + 1)) }));
  }
  const { figuren: mergedFiguren, mergedCount, stage1Saved, stage2Saved, idRemap } = mergeDuplicateFiguren(figuren);
  if (mergedCount > 0) log.info(`${mergedCount} Figuren-Duplikate zusammengeführt (exakt: ${stage1Saved}, Teilname+Indizien: ${stage2Saved}).`);
  figuren = mergedFiguren;
  // Beziehungs-Beschreibungs-Rescue ist pure + billig und hilft jedem Provider:
  // auch Claude attribuiert gelegentlich eine Beschreibung der falschen Figur zu.
  const { cleared, moved } = validateBeziehungenDescriptions(figuren);
  if (cleared > 0 || moved > 0) log.info(`Beziehungs-Beschreibungen bereinigt – ${moved} verschoben, ${cleared} geleert.`);
  // Sozialschicht-Mehrheitsvotum nur für lokale Modelle: Claude läuft durch den
  // holistischen Soziogramm-Refine-Call und braucht das nicht.
  if (effectiveProvider && effectiveProvider !== 'claude') {
    const schichtChanges = applySozialschichtModeVote(chapterFiguren, figuren);
    if (schichtChanges > 0) log.info(`Sozialschicht per Mehrheitsvotum korrigiert (${schichtChanges} Figuren).`);
  }
  const backfilled = backfillFiguren(figuren, chapterSzenen, chapterAssignments, log);
  if (backfilled > 0) log.info(`${backfilled} Figur(en) aus Szenen/Events nachgetragen (Phase-1-Recall-Lücke).`);
  const reassignedIds = ensureUniqueFigIds(figuren);
  if (reassignedIds > 0) log.warn(`${reassignedIds} kollidierende/leere Figuren-IDs neu vergeben (Schutz vor UNIQUE-Verletzung beim Speichern).`);
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
          sys.SYSTEM_FIGUREN_BLOCKS, 40, 43, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_SOZIOGRAMM_KONSOL,
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
        ctx.warnings?.push({ key: 'job.warn.soziogrammDegraded' });
        updateJob(jobId, { progress: 43 });
      }
    }

    updateFigurenSoziogramm(bookIdInt, sozFiguren, sozBeziehungen, email);
    log.info(`Soziogramm: ${sozFiguren.length} Figuren, ${sozBeziehungen.length} Machtbeziehungen.`);
  }

  const figurenKompakt = figuren.map(f => ({ id: f.id, name: f.name, typ: f.typ || 'andere' }));
  const { figNameToId, figNameToIdLower } = buildFigNameLookup(figuren, chapterFiguren, chapterAssignments, chapterSzenen, log, jobId);

  return { figuren, figNameToId, figNameToIdLower, figurenKompakt, idRemap, isSinglePass };
}

/** Phase 3: Orte konsolidieren + Name→ID Lookup.
 *  Single-Pass-Optimierung analog zu Phase 2: Wenn Phase 1 im Single-Pass-Modus lief,
 *  sind die Orte bereits holistisch extrahiert – ein Konsolidierungs-Call fügt nichts
 *  hinzu und kostet ~15K Tokens. Die figuren-Referenzen in den Orten werden gegen das
 *  idRemap aus mergeDuplicateFiguren abgeglichen (gemergte Figuren werden umgebogen,
 *  nicht mehr existente entfernt). */
async function runPhase3(ctx, chapterOrte, figurenKompakt, isSinglePass, idRemap, opts = {}) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, prompts, sys, idMaps, effectiveProvider } = ctx;
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
      sys.SYSTEM_ORTE_BLOCKS, 43, 55, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_ORTE_KONSOL,
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
  saveOrteToDb(bookIdInt, orte, email, idMaps.chNameToId, idMaps.pageNameToIdByChapter, { preserveExistingCoords: true });
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
  const { jobId, bookIdInt, bookName, email, call, tok, log, prompts, sys, idMaps, effectiveProvider } = ctx;
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
    updateJob(jobId, { statusText: 'job.phase.consolidatingSongs' });
    const hasInput = chapterSongs.some(cs => (cs.songs || []).length > 0);
    if (!hasInput) {
      songs = [];
      updateJob(jobId, { progress: 56 });
      log.info(`Phase 3 Songs übersprungen (keine Songs in Pass B – KI-Call gespart).`);
    } else {
      // Songs-Range 55→56 (klein, ~3K Out): lässt 56→58 frei für P3b.
      // Vorher überlappten Songs 56-58 mit P3b 55-58 → sichtbarer Range-Konflikt.
      const songsResultRaw = await call(jobId, tok,
        prompts.buildSongsConsolidationPrompt(bookName, chapterSongs, figurenKompakt),
        sys.SYSTEM_ORTE_BLOCKS, 55, 56, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_SONGS_KONSOL,
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
  const { jobId, bookName, call, tok, prompts, sys, effectiveProvider } = ctx;
  return call(jobId, tok,
    prompts.buildLocationsConsolidationPrompt(bookName, chapterOrte, figurenKompaktForPrompt),
    sys.SYSTEM_ORTE_BLOCKS,
    null, null,
    komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_ORTE_KONSOL,
  );
}

/**
 * Phase 3b: Kapitelübergreifende Beziehungen (nur Multi-Pass).
 * Single-Pass: Phase 1 hat den vollständigen Text gesehen → Beziehungen bereits erfasst.
 * Multi-Pass: Kapitel wurden isoliert analysiert → Beziehungen zwischen Figuren
 * verschiedener Kapitel hier nachträglich identifiziert.
 */
async function runPhase3b(ctx, figuren) {
  const { jobId, bookIdInt, email, call, tok, log, prompts, sys, singlePassLimit, bookName, fullBookText, pageContents, effectiveProvider } = ctx;

  updateJob(jobId, { progress: 56, statusText: 'job.phase.crossChapterRelations' });

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
    sys.SYSTEM_FIGUREN_BLOCKS, 56, 58, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_BEZIEHUNGEN,
  );
  const newBz = Array.isArray(bzResult?.beziehungen) ? bzResult.beziehungen : [];
  if (newBz.length > 0) addFigurenBeziehungen(bookIdInt, newBz, email, ctx.idMaps);
  log.info(`Phase 3b – ${newBz.length} kapitelübergreifende Beziehungen.`);
}

/** P6: Zeitstrahl aus gespeicherten Events konsolidieren. */
async function runZeitstrahl(ctx, opts = {}) {
  const { jobId, bookIdInt, email, call, tok, log, prompts, sys, idMaps, effectiveProvider } = ctx;
  // silent: keine Progress-/Status-Updates; nötig wenn parallel zu P8 (Claude),
  // damit P8 die Bar exklusiv kontrolliert.
  const silent = !!opts.silent;

  if (!silent) updateJob(jobId, { progress: 78, statusText: 'job.phase.consolidatingTimeline' });
  const rawEvtRows = db.prepare(`
    SELECT f.fig_id, f.name AS fig_name, f.typ AS fig_typ,
           fe.datum, fe.datum_label,
           fe.datum_year, fe.datum_month, fe.datum_day,
           fe.datum_ende_year, fe.datum_ende_month, fe.datum_ende_day,
           fe.story_tag, fe.subtyp,
           fe.ereignis, fe.typ AS evt_typ, fe.bedeutung,
           c.chapter_name AS kapitel, p.page_name AS seite
    FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fe.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fe.page_id
    WHERE f.book_id = ? AND f.user_email IS ?
    ORDER BY
      COALESCE(fe.datum_year,  9999),
      COALESCE(fe.datum_month, 99),
      COALESCE(fe.datum_day,   99),
      COALESCE(fe.story_tag,   99999),
      f.sort_order
  `).all(bookIdInt, email);
  if (!rawEvtRows.length) return;

  const evtGroupMap = new Map();
  for (const row of rawEvtRows) {
    const key = `${row.datum}||${(row.ereignis || '').trim().toLowerCase()}`;
    if (!evtGroupMap.has(key)) {
      evtGroupMap.set(key, {
        datum: row.datum,
        datum_label:      row.datum_label,
        datum_year:       row.datum_year,
        datum_month:      row.datum_month,
        datum_day:        row.datum_day,
        datum_ende_year:  row.datum_ende_year,
        datum_ende_month: row.datum_ende_month,
        datum_ende_day:   row.datum_ende_day,
        story_tag:        row.story_tag,
        subtyp:           row.subtyp || 'sonstiges',
        ereignis: row.ereignis, typ: row.evt_typ,
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

  // Strukturierte Sortierung — Events ohne Jahr ans Ende.
  const _sortKey = ev => [
    ev.datum_year  ?? 9999,
    ev.datum_month ?? 99,
    ev.datum_day   ?? 99,
    ev.story_tag   ?? 99999,
  ];
  const zeitstrahlEvents = [...evtGroupMap.values()].sort((a, b) => {
    const ka = _sortKey(a), kb = _sortKey(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });

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
    komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_ZEITSTRAHL,
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
  komplettMaxTokens,
};
