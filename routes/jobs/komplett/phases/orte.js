'use strict';
// Phase 3: Orte + Songs konsolidieren (inkl. regelbasierter Fallback-Merges) +
// Prelim-figurenKompakt + paralleler Orte-Call (Multi-Pass).
const { saveOrteToDb, saveSongsToDb } = require('../../../../db/schema');
const { updateJob } = require('../../shared');
const { _remapFigRefs, _remapFigNames } = require('../utils');
const { komplettMaxTokens } = require('./tokens');

/** Regelbasierter Orte-Merge als Fallback, wenn die KI-Konsolidierung scheitert (z.B.
 *  aiTruncated bei kleinem lokalem Modell). Flattet chapterOrte über alle Kapitel, dedupliziert
 *  nach Name (case-insensitive, erstes Vorkommen gewinnt, figuren-Refs vereinigt) und biegt
 *  figuren-IDs gegen idRemap um bzw. filtert nicht (mehr) existente heraus – analog Single-Pass. */
function buildFallbackOrte(chapterOrte, validFigIds, idRemap) {
  const byName = new Map();
  for (const ch of (chapterOrte || [])) {
    for (const o of (ch.orte || [])) {
      const key = (o.name || '').trim().toLowerCase();
      if (!key) continue;
      const figIds = (o.figuren || [])
        .map(fid => idRemap?.[fid] || fid)
        .filter(fid => validFigIds.has(fid));
      if (!byName.has(key)) {
        byName.set(key, { ...o, figuren: [...new Set(figIds)] });
      } else {
        const ex = byName.get(key);
        ex.figuren = [...new Set([...ex.figuren, ...figIds])];
        if (!ex.beschreibung && o.beschreibung) ex.beschreibung = o.beschreibung;
      }
    }
  }
  // loc_id IMMER sequenziell neu vergeben: die kapitelweise extrahierten Orte tragen
  // pro Kapitel neu startende ids (ort_1, ort_2, …), nach dem Flatten kollidieren also
  // verschiedene Namen auf derselben id → UNIQUE(book_id, loc_id, user_email) in
  // saveOrteToDb. Das run-interne Text-Handle ist frei wählbar (ortNameToId wird daraus
  // gebaut, downstream zählt die DB-id), darum hier kollisionsfrei durchnummerieren.
  return [...byName.values()].map((o, i) => ({ ...o, id: 'ort_' + (i + 1) }));
}

/** Regelbasierter Songs-Merge als Fallback, wenn die KI-Konsolidierung scheitert (analog
 *  buildFallbackOrte). Flattet chapterSongs über alle Kapitel, dedupliziert nach Titel+Interpret
 *  (case-insensitive, erstes Vorkommen gewinnt, figuren-Refs vereinigt), löst figuren_namen gegen
 *  die kanonische Figurenliste zu fig_ids auf und vergibt song_uid kollisionsfrei sequenziell neu
 *  (UNIQUE(book_id, song_uid, user_email)). */
function buildFallbackSongs(chapterSongs, figNameToId, figNameToIdLower) {
  const byKey = new Map();
  for (const ch of (chapterSongs || [])) {
    for (const s of (ch.songs || [])) {
      const titel = (s.titel || s.title || '').trim();
      const key = (titel + '|' + (s.interpret || '').trim()).toLowerCase();
      if (!titel) continue;
      const figIds = _remapFigNames(s.figuren_namen, figNameToId, figNameToIdLower);
      if (!byKey.has(key)) {
        byKey.set(key, { ...s, figuren: [...new Set(figIds)] });
      } else {
        const ex = byKey.get(key);
        ex.figuren = [...new Set([...ex.figuren, ...figIds])];
        if (!ex.beschreibung && s.beschreibung) ex.beschreibung = s.beschreibung;
      }
    }
  }
  return [...byKey.values()].map((s, i) => ({ ...s, id: 'song_' + (i + 1) }));
}

/** Phase 3: Orte konsolidieren + Name→ID Lookup.
 *  Single-Pass-Optimierung analog zu Phase 2: Wenn Phase 1 im Single-Pass-Modus lief,
 *  sind die Orte bereits holistisch extrahiert – ein Konsolidierungs-Call fügt nichts
 *  hinzu und kostet ~15K Tokens. Die figuren-Referenzen in den Orten werden gegen das
 *  idRemap aus mergeDuplicateFiguren abgeglichen (gemergte Figuren werden umgebogen,
 *  nicht mehr existente entfernt). */
async function runPhase3(ctx, chapterOrte, figurenKompakt, isSinglePass, idRemap, opts = {}) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, prompts, sys, idMaps, effectiveProvider } = ctx;
  // prefetchAttempted: im Claude-Parallel-Pfad wurde der Orte-Call bereits gefahren (Promise.all).
  // null heisst dann „Prefetch fehlgeschlagen" (Warnung schon geloggt) → direkt Fallback, kein Re-Call.
  const prefetchAttempted = 'prefetchedOrteRaw' in opts;
  const prefetched = opts.prefetchedOrteRaw || null;

  let orte;
  if (isSinglePass) {
    updateJob(jobId, { progress: 43, statusText: 'job.phase.consolidatingOrte' });
    const validFigIds = new Set(figurenKompakt.map(f => f.id));
    const raw = chapterOrte[0]?.orte || [];
    orte = raw.map((o, i) => ({
      ...o,
      // loc_id run-intern IMMER sequenziell neu vergeben (nicht o.id||-Fallback): der
      // Single-Pass-Completeness-Gap (runPhase1) kann ort_1… doppelt erzeugen, wenn der
      // Erst-Pass id-lose Orte lieferte → Kollision im konkatenierten Array →
      // UNIQUE(book_id, loc_id, user_email) in saveOrteToDb. Das Handle ist frei wählbar
      // (ortNameToId wird daraus gebaut; downstream zählt die DB-id). Orte haben — anders
      // als Figuren — kein ensureUniqueLocIds-Netz, darum hier deterministisch durchnummerieren.
      id: 'ort_' + (i + 1),
      figuren: _remapFigRefs(o.figuren, idRemap, validFigIds),
    }));
    log.info(`Phase 3 übersprungen (Single-Pass, ${orte.length} Orte aus P1 übernommen) – spart einen KI-Call.`);
    updateJob(jobId, { progress: 55 });
  } else {
    updateJob(jobId, { progress: 43, statusText: 'job.phase.consolidatingOrte' });
    const validFigIds = new Set(figurenKompakt.map(f => f.id));
    let orteResultRaw = prefetched;
    if (!orteResultRaw && !prefetchAttempted) {
      try {
        orteResultRaw = await call(jobId, tok,
          prompts.buildLocationsConsolidationPrompt(bookName, chapterOrte, figurenKompakt),
          sys.SYSTEM_ORTE_BLOCKS, 43, 55, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_ORTE_KONSOL,
        );
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        // Wie Phase 2 (Figuren) / Zeitstrahl: die Orte-Konsolidierung ist nicht
        // katalog-kritisch – die Orte sind in chapterOrte bereits kapitelweise extrahiert.
        // Ein Konsolidierungs-Fehler (typisch: aiTruncated, wenn ein kleines lokales Modell
        // viele Orte in einen Output packen müsste, Parse-Fehler, erschöpfter Retry) darf den
        // gesamten Job – inkl. bereits gespeicherter Figuren/Soziogramm/Fakten – NICHT verwerfen.
        log.warn(`Orte-Konsolidierung fehlgeschlagen (${e.message}) – Fallback auf kapitel-extrahierte Orte.`);
        ctx.warnings?.push({ key: 'job.warn.orteKonsolidierungDegraded' });
        orteResultRaw = null;
      }
    }
    if (!Array.isArray(orteResultRaw?.orte)) {
      // Call gescheitert ODER Antwort ohne orte-Array: kapitelweise extrahierte Orte
      // regelbasiert mergen (flatten + Dedup nach Name, figuren-Refs gegen idRemap+validFigIds).
      if (orteResultRaw !== null) {
        log.warn('Orte-Konsolidierung lieferte kein orte-Array – Fallback auf kapitel-extrahierte Orte.');
        ctx.warnings?.push({ key: 'job.warn.orteKonsolidierungDegraded' });
      }
      orte = buildFallbackOrte(chapterOrte, validFigIds, idRemap);
      updateJob(jobId, { progress: 55 });
    } else if (prefetched) {
      orte = orteResultRaw.orte.map((o, i) => ({
        ...o,
        id: o.id || ('ort_' + (i + 1)),
        figuren: _remapFigRefs(o.figuren, idRemap, validFigIds),
      }));
      updateJob(jobId, { progress: 55 });
    } else {
      orte = orteResultRaw.orte.map((o, i) => ({ ...o, id: o.id || ('ort_' + (i + 1)) }));
    }
  }
  // Name-Match + stale: locations.id bleibt ueber Re-Analysen stabil (FK-Refs wie
  // research_item_links.location_id ueberleben); verschwundene Orte werden als stale
  // markiert statt geloescht (kein CASCADE auf die Verknuepfungen).
  saveOrteToDb(bookIdInt, orte, email, idMaps.chNameToId, idMaps.pageNameToIdByChapter,
    { preserveExistingCoords: true, matchBy: 'name', onMissing: 'stale' });
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
async function runPhase3Songs(ctx, chapterSongs, figurenKompakt, isSinglePass, figNameToId, figNameToIdLower) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, prompts, sys, idMaps, effectiveProvider } = ctx;

  let songs;
  if (isSinglePass) {
    updateJob(jobId, { progress: 56, statusText: 'job.phase.consolidatingSongs' });
    const raw = chapterSongs[0]?.songs || [];
    songs = raw.map((s, i) => ({
      ...s,
      // song_uid run-intern IMMER neu vergeben (analog Orte, Rang 15) — kollisionsfrei
      // gegen UNIQUE(book_id, song_uid, user_email) in saveSongsToDb.
      id: 'song_' + (i + 1),
      figuren: _remapFigNames(s.figuren_namen, figNameToId, figNameToIdLower),
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
      let songsResultRaw = null;
      try {
        songsResultRaw = await call(jobId, tok,
          prompts.buildSongsConsolidationPrompt(bookName, chapterSongs, figurenKompakt),
          sys.SYSTEM_ORTE_BLOCKS, 55, 56, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_SONGS_KONSOL,
        );
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        // Wie Orte/Figuren/Zeitstrahl: nicht katalog-kritisch – die Songs sind kapitelweise
        // bereits extrahiert. Ein Konsolidierungs-Fehler (typisch: aiTruncated) darf den Job
        // inkl. bereits gespeicherter Figuren/Orte NICHT verwerfen.
        log.warn(`Songs-Konsolidierung fehlgeschlagen (${e.message}) – Fallback auf kapitel-extrahierte Songs.`);
        ctx.warnings?.push({ key: 'job.warn.songsKonsolidierungDegraded' });
      }
      if (Array.isArray(songsResultRaw?.songs)) {
        songs = songsResultRaw.songs.map((s, i) => ({
          ...s,
          id: s.id || ('song_' + (i + 1)),
          figuren: _remapFigNames(s.figuren_namen, figNameToId, figNameToIdLower),
        }));
      } else {
        if (songsResultRaw !== null) {
          log.warn('Songs-Konsolidierung lieferte kein songs-Array – Fallback auf kapitel-extrahierte Songs.');
          ctx.warnings?.push({ key: 'job.warn.songsKonsolidierungDegraded' });
        }
        songs = buildFallbackSongs(chapterSongs, figNameToId, figNameToIdLower);
      }
      updateJob(jobId, { progress: 56 });
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
  const { jobId, bookName, call, tok, log, prompts, sys, effectiveProvider } = ctx;
  try {
    return await call(jobId, tok,
      prompts.buildLocationsConsolidationPrompt(bookName, chapterOrte, figurenKompaktForPrompt),
      sys.SYSTEM_ORTE_BLOCKS,
      null, null,
      komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_ORTE_KONSOL,
    );
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // Läuft parallel zu Phase 2 (Figuren) in Promise.all – ein Reject würde auch das
    // P2-Ergebnis verwerfen. null zurückgeben; runPhase3 fällt dann auf den regelbasierten
    // Orte-Merge zurück (kapitel-extrahierte Orte), statt den Job zu killen.
    log.warn(`Orte-Konsolidierung (parallel) fehlgeschlagen (${e.message}) – Fallback auf kapitel-extrahierte Orte.`);
    return null;
  }
}

module.exports = { runPhase3, runPhase3Songs, buildPrelimFigurenKompakt, runPhase3OrteCall };
