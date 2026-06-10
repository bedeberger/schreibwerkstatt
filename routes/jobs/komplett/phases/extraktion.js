'use strict';
// Phase 1: Vollextraktion (Single-/Multi-Pass) + additiver Completeness-/Gap-Pass.
const {
  saveCheckpoint, loadChapterExtractCache, saveChapterExtractCache, getBookSettings,
} = require('../../../../db/schema');
const {
  i18nError, settledAll, retryOnTransientAi, splitGroupsIntoChunks, updateJob, toSystemBlocks,
} = require('../../shared');
const {
  buildBookSystemBlockText, buildBookPagesSig, bookSettingsSigPart, extractField,
} = require('../utils');
const { mergeBeziehungenIntoFiguren, _normalizeName } = require('../figuren-merge');
const appSettings = require('../../../../lib/app-settings');
const { getContextConfigFor } = require('../../../../lib/ai');
const { komplettMaxTokens } = require('./tokens');

/**
 * Additiver Completeness-/Gap-Pass (nur Claude Single-Pass): nach der Erst-Extraktion
 * erneut gegen den GECACHTEN Buchtext-Block + dasselbe System-Schema prompten und gezielt
 * die Entitäten nachziehen, die der Erst-Call ausgelassen hat (Long-Tail: Nebenfiguren,
 * einmal erwähnte Schauplätze). Die bereits gefundenen Namen werden mitgegeben, damit das
 * Modell sie NICHT erneut ausgibt. Loop-until-dry (Stop, sobald eine Runde nichts Neues
 * liefert) bis maxPasses. NON-FATAL: ein gescheiterter Gap-Call verwirft die teure
 * Haupt-Extraktion nicht — er wird geloggt und übersprungen. Gibt die NEU gefundenen Items
 * zurück (dedupliziert gegen bekannte + frühere Gap-Treffer per normalisiertem Namen);
 * der Caller vereinigt additiv.
 */
async function runCompletenessGap(ctx, {
  label, statusText, knownNames, buildPrompt, systemBlocks, schema, extractItems, claudeExtractCap, maxPasses,
  // keyOf/isValid/displayOf generalisieren den Helper über die name-tragenden Entitäten
  // (Figuren/Orte) hinaus auf Fakten (subjekt+fakt) und Szenen (titel+kapitel). Für die
  // Dedup-Konsistenz MUSS keyOf dieselbe Zeichenkette liefern, die als knownNames-Seed und
  // via displayOf in die Prompt-Liste fliesst (beide werden mit _normalizeName normalisiert).
  keyOf = (it) => it.name, isValid = (it) => it && it.name, displayOf = (it) => it.name,
}) {
  const { call, jobId, tok, log } = ctx;
  const seen = new Set((knownNames || []).map(n => _normalizeName(n)).filter(Boolean));
  const display = (knownNames || []).filter(Boolean);
  const fresh = [];
  for (let round = 1; round <= maxPasses; round++) {
    updateJob(jobId, { statusText });
    let res;
    try {
      res = await retryOnTransientAi(() => call(jobId, tok,
        buildPrompt(display), systemBlocks, null, null, claudeExtractCap, 0.2, null, schema,
      ), { log, label: `${label} (Gap ${round}/${maxPasses})` });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      log.warn(`${label} Gap-Pass ${round} fehlgeschlagen (${e.message}) – übersprungen.`);
      break;
    }
    const items = (extractItems(res) || []).filter(isValid);
    const newOnes = [];
    for (const it of items) {
      const key = _normalizeName(keyOf(it));
      if (!key || seen.has(key)) continue;
      seen.add(key);
      display.push(displayOf(it));
      newOnes.push(it);
    }
    fresh.push(...newOnes);
    log.info(`${label} Gap-Pass ${round}: ${items.length} zurück, +${newOnes.length} neu.`);
    if (newOnes.length === 0) break; // loop-until-dry
  }
  return fresh;
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
  // Teilfehler-Flag: scheitert ein non-fatal Phase-1-Pass (Single-Pass: A2/C/E; Multi-Pass:
  // truncierte Chunks), wird der DELTA-Cache übersprungen (Phantom-Erfolg-Schutz). Derselbe
  // Schutz MUSS auch den Checkpoint gaten — sonst friert ein Crash nach Phase 1 den
  // degradierten Stand ein und der Resume überspringt Phase 1 komplett (A2/C/E laufen nie nach).
  let partialFailure = false;

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
      let eventsFailed = false;
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
        // Pflichtfeld-Check wie Phase 2 (figResult.figuren): eine schema-valide, aber
        // figuren-LOSE A1-Antwort darf NICHT still zu leerem Katalog werden und unter
        // '__singlepass__' eingefroren werden (Phantom-leerer-Katalog). A1 ist hart.
        // Legitim figurenloses Buch liefert figuren:[] (Array) → passiert den Guard.
        if (!Array.isArray(stamm.figuren)) throw i18nError('job.error.figurenMissing');
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

        // ── Completeness-/Gap-Pässe (Long-Tail-Recall, nur Claude Single-Pass) ──
        // Ein einzelner Extraktions-Call über das ganze Buch erfasst Haupt-Entitäten
        // zuverlässig, lässt aber den Long-Tail (Nebenfiguren, Einmal-Schauplätze) oft
        // aus. ai.komplett.completeness_passes (Default 2; 0 = aus) zieht sie additiv nach.
        // Läuft VOR A2, damit der Beziehungs-Pass die ergänzten Figuren mit abdeckt.
        // Wert kommt geclampt aus ctx (job.js) — er fliesst dort auch in die cacheVersion,
        // damit ein Setting-Wechsel die Single-/Multi-Pass-Caches + Checkpoint invalidiert
        // (sonst liefert ein Hochsetzen bei unverändertem Seitenstand weiter den alten HIT).
        let stammFiguren = stamm.figuren || [];
        const completenessPasses = ctx.completenessPasses || 0;
        if (completenessPasses > 0) {
          if (stammFiguren.length > 0) {
            const freshFig = await runCompletenessGap(ctx, {
              label: 'Single-Pass Figuren', statusText: 'job.phase.completenessFiguren',
              knownNames: stammFiguren.flatMap(f => [f.name, f.kurzname]),
              buildPrompt: (known) => prompts.buildFigurenStammGapPrompt(bookName, known),
              systemBlocks: [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_FIGUREN_STAMM_BLOCKS, '1h')],
              schema: prompts.SCHEMA_KOMPLETT_FIGUREN_STAMM,
              extractItems: (r) => r?.figuren,
              claudeExtractCap, maxPasses: completenessPasses,
            });
            if (freshFig.length) {
              // Frische, kollisionsfreie IDs (Gap-Output beginnt wieder bei fig_1).
              // Events/Assignments referenzieren Klarnamen → von der Neu-ID unberührt;
              // A2 unten bezieht die ergänzten Figuren über die vereinigte Liste ein.
              let maxIdx = 0;
              for (const f of stammFiguren) { const m = /^fig_(\d+)$/.exec(f.id || ''); if (m) maxIdx = Math.max(maxIdx, +m[1]); }
              for (const f of freshFig) f.id = 'fig_' + (++maxIdx);
              stammFiguren = stammFiguren.concat(freshFig);
              log.info(`Completeness: +${freshFig.length} Figuren ergänzt (gesamt ${stammFiguren.length}).`);
            }
          }
          const knownOrte = passB.orte || [];
          const freshOrte = await runCompletenessGap(ctx, {
            label: 'Single-Pass Orte', statusText: 'job.phase.completenessOrte',
            knownNames: knownOrte.map(o => o.name),
            buildPrompt: (known) => prompts.buildOrteGapPrompt(bookName, known),
            systemBlocks: [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS, '1h')],
            schema: prompts.SCHEMA_KOMPLETT_ORTE_PASS,
            extractItems: (r) => r?.orte,
            claudeExtractCap, maxPasses: completenessPasses,
          });
          if (freshOrte.length) {
            // Frische, kollisionsfreie ort_ids (Gap-Output beginnt wieder bei ort_1 →
            // Kollision mit dem Erst-Pass; Phase 3 Single-Pass behält explizite ids bei →
            // sonst UNIQUE(book_id, loc_id, user_email)-Verletzung beim Speichern).
            let maxIdx = 0;
            for (const o of knownOrte) { const m = /^ort_(\d+)$/.exec(o.id || ''); if (m) maxIdx = Math.max(maxIdx, +m[1]); }
            for (const o of freshOrte) o.id = 'ort_' + (++maxIdx);
            passB.orte = knownOrte.concat(freshOrte);
            log.info(`Completeness: +${freshOrte.length} Orte ergänzt (gesamt ${passB.orte.length}).`);
          }

          // Fakten-Gap nur wenn der Erst-Fakten-Pass (C) erfolgreich war – sonst würde der
          // Gap-Pass die ausgefallene Faktenerfassung kaschieren, während faktenFailed den
          // Cache-Skip beibehält (Teilstand bliebe trotzdem nicht eingefroren).
          if (!faktenFailed) {
            const knownFakten = passB.fakten || [];
            const faktKey = (f) => `${f.subjekt || ''}: ${f.fakt || ''}`;
            const freshFakten = await runCompletenessGap(ctx, {
              label: 'Single-Pass Fakten', statusText: 'job.phase.completenessFakten',
              knownNames: knownFakten.map(faktKey),
              buildPrompt: (known) => prompts.buildFaktenGapPrompt(bookName, known),
              systemBlocks: [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_FAKTEN_PASS_BLOCKS, '1h')],
              schema: prompts.SCHEMA_KOMPLETT_FAKTEN_PASS,
              extractItems: (r) => r?.fakten,
              keyOf: faktKey, displayOf: faktKey, isValid: (f) => f && f.fakt,
              claudeExtractCap, maxPasses: completenessPasses,
            });
            if (freshFakten.length) {
              passB.fakten = knownFakten.concat(freshFakten);
              log.info(`Completeness: +${freshFakten.length} Fakten ergänzt (gesamt ${passB.fakten.length}).`);
            }
          }

          const knownSzenen = passB.szenen || [];
          const szeneKey = (s) => `${s.titel || ''} (${s.kapitel || ''})`;
          const freshSzenen = await runCompletenessGap(ctx, {
            label: 'Single-Pass Szenen', statusText: 'job.phase.completenessSzenen',
            knownNames: knownSzenen.map(szeneKey),
            buildPrompt: (known) => prompts.buildSzenenGapPrompt(bookName, known),
            systemBlocks: [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS, '1h')],
            schema: prompts.SCHEMA_KOMPLETT_ORTE_PASS,
            extractItems: (r) => r?.szenen,
            keyOf: szeneKey, displayOf: szeneKey, isValid: (s) => s && s.titel,
            claudeExtractCap, maxPasses: completenessPasses,
          });
          if (freshSzenen.length) {
            passB.szenen = knownSzenen.concat(freshSzenen);
            log.info(`Completeness: +${freshSzenen.length} Szenen ergänzt (gesamt ${passB.szenen.length}).`);
          }
        }

        // E: Lebensereignisse separat – eigener Call gegen den gecachten Buchtext-Block
        // mit der finalen Figurenliste (post-Completeness). Volle Modell-Aufmerksamkeit
        // auf vollständige Event-Erfassung, statt in A1 mit den Figuren-Stammdaten ums
        // Output-Budget zu konkurrieren (analog Fakten-Pass C). Non-fatal: ein gescheiterter
        // Events-Call verwirft die teure Figuren-/Orte-Extraktion nicht – stattdessen leere
        // Events + Warnung; eventsFailed verhindert das Einfrieren des '__singlepass__'-
        // Caches (sonst Phantom-leere-Events bis zur nächsten Seitenedition).
        let assignments = [];
        if (stammFiguren.length > 0) {
          updateJob(jobId, { progress: 19, statusText: 'job.phase.extractingEvents' });
          try {
            const evRes = await retryOnTransientAi(() => call(jobId, tok,
              prompts.buildExtraktionEventsPassPrompt(bookName, stammFiguren, null),
              [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_EVENTS_PASS_BLOCKS, '1h')],
              19, 20, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_EVENTS,
            ), { log, label: 'Single-Pass Lebensereignisse (E)' });
            assignments = Array.isArray(evRes?.assignments) ? evRes.assignments : [];
            const nEv = assignments.reduce((s, a) => s + (a.lebensereignisse?.length || 0), 0);
            log.info(`Single-Pass Events-Pass (E) – ${nEv} Ereignisse für ${assignments.length} Figuren.`);
          } catch (e) {
            eventsFailed = true;
            log.warn(`Single-Pass Events-Pass (E) fehlgeschlagen, Events leer: ${e.message}`);
            ctx.warnings?.push({ key: 'job.warn.eventsFailed' });
          }
        }

        // A2: Beziehungen separat – braucht die stabilen IDs aus A1.
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
        passA = { figuren: stammFiguren, assignments };
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
      if (relationsFailed || faktenFailed || eventsFailed) {
        partialFailure = true;
        const which = [relationsFailed && 'A2 (Beziehungen)', faktenFailed && 'C (Fakten)', eventsFailed && 'E (Events)']
          .filter(Boolean).join(', ');
        log.warn(`Single-Pass Cache + Checkpoint übersprungen – ${which} gescheitert, Teilstand wird nicht eingefroren.`);
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
        // Kapitelname im Sig: er fliesst via buildExtraktionKomplettChapterPrompt(chunk.name)
        // in den Prompt, steht aber nicht in page_id:updated_at. Ohne ihn liefert eine reine
        // Kapitel-Umbenennung einen stale Cache-HIT mit altem Kapitelkontext. Rename → MISS.
        pagesSig: chunk.pages.map(p => `${p.id}:${p.updated_at}`).sort().join('|') + `||${settingsSig}||ch:${chunk.name || ''}||${cacheVersion || ''}`,
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
        // Teilfehler: Checkpoint überspringen (wie der Cache-Skip oben). Sonst friert ein
        // Crash nach Phase 1 die truncierten/fehlenden Chunks ein; der Resume lädt den
        // lückenhaften Stand statt die nie gecachten Chunks erneut zu extrahieren.
        partialFailure = true;
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

  // Checkpoint NUR bei vollständiger Phase 1 schreiben — symmetrisch zum Delta-Cache-Skip.
  // Bei Teilfehler (A2/C/E gescheitert bzw. truncierte Chunks) würde ein gespeicherter
  // Checkpoint den degradierten Stand einfrieren und der Resume Phase 1 überspringen, ohne
  // die fehlenden Pässe je nachzuholen (Phantom-Erfolg über den zweiten Resume-Mechanismus).
  if (partialFailure) {
    log.warn('Checkpoint übersprungen – Phase-1-Teilfehler; ein Resume re-extrahiert Phase 1 vollständig (gecachte Chunks per HIT).');
  } else {
    saveCheckpoint('komplett-analyse', bookIdInt, email, {
      phase: 'p1_full_done',
      bookPagesSig: ctx.bookPagesSig,
      chapterFiguren, chapterOrte, chapterSongs, chapterFakten, chapterSzenen, chapterAssignments,
      tokIn: tok.in, tokOut: tok.out, tokMs: tok.ms,
    });
  }
  return { chapterFiguren, chapterOrte, chapterSongs, chapterFakten, chapterSzenen, chapterAssignments };
}

module.exports = { runPhase1 };
