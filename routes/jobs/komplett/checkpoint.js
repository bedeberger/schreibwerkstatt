'use strict';
const { db, loadCheckpoint, deleteCheckpoint } = require('../../../db/schema');
const { fmtTok, updateJob } = require('../shared');

/** Invalidiert Delta-Cache-Einträge für umbenannte Kapitel. */
function invalidateRenamedChapterCaches(bookIdInt, chaptersData, log, jobId) {
  const stored = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?').all(bookIdInt);
  const storedChMap = Object.fromEntries(stored.map(r => [r.chapter_id, r.chapter_name]));
  // Mig 75: chapter_id INTEGER + phase TEXT — DELETE alle phases pro umbenanntem Kapitel.
  const delCacheByChapterId = db.prepare('DELETE FROM chapter_extract_cache WHERE book_id = ? AND chapter_id = ?');
  for (const c of chaptersData) {
    if (storedChMap[c.id] !== undefined && storedChMap[c.id] !== c.name) {
      log.info(`Kapitel ${c.id} umbenannt («${storedChMap[c.id]}» → «${c.name}») – Cache invalidiert.`);
      delCacheByChapterId.run(bookIdInt, c.id);
    }
  }
}

/** Lädt und validiert einen Komplett-Analyse-Checkpoint. Gibt null zurück wenn ungültig. */
function loadAndValidateCheckpoint(bookIdInt, email, log, jobId) {
  let cp = loadCheckpoint('komplett-analyse', bookIdInt, email);
  if (!cp) return null;
  log.info(`Checkpoint gefunden (Phase: ${cp.phase}).`);
  if (cp.phase !== 'p1_full_done') {
    log.info(`Checkpoint Phase «${cp.phase}» ignoriert (altes Format) – Neustart.`);
    deleteCheckpoint('komplett-analyse', bookIdInt, email);
    return null;
  }
  // Auf Kapitel-Präsenz gaten, nicht auf Figuren-Count: Bücher ohne Figuren
  // (Sachbuch, Lyrik) sind legitim – sonst verwirft Resume jeden figurenlosen
  // Checkpoint und re-extrahiert die ganze Phase 1 (gleiche Semantik wie der
  // Single-Pass-Cache-Gate in phases.js).
  const hasPhase1 = Array.isArray(cp.chapterFiguren) && cp.chapterFiguren.length > 0;
  if (!hasPhase1) {
    log.warn(`Checkpoint ohne Phase-1-Daten – Neustart.`);
    deleteCheckpoint('komplett-analyse', bookIdInt, email);
    return null;
  }
  return cp;
}

/** Stellt Phase-1-Ergebnisse aus einem validen Checkpoint wieder her. */
function restorePhase1FromCheckpoint(cp, tok, log, jobId) {
  const { chapterFiguren, chapterOrte, chapterSongs, chapterFakten, chapterSzenen, chapterAssignments } = cp;
  if (cp.tokIn != null) { tok.in = cp.tokIn; tok.out = cp.tokOut || 0; tok.ms = cp.tokMs || 0; }
  const figTotal = (chapterFiguren || []).reduce((s, c) => s + (c.figuren?.length || 0), 0);
  const orteTotal = (chapterOrte || []).reduce((s, c) => s + (c.orte?.length || 0), 0);
  const songsTotal = (chapterSongs || []).reduce((s, c) => s + (c.songs?.length || 0), 0);
  const szTotal = (chapterSzenen || []).reduce((s, c) => s + (c.szenen?.length || 0), 0);
  log.info(`Phase 1 aus Checkpoint – ${chapterFiguren.length} Kapitel, fig=${figTotal} orte=${orteTotal} songs=${songsTotal} sz=${szTotal} (${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓)`);
  updateJob(jobId, { progress: 28, statusText: 'job.phase.checkpointLoaded', tokensIn: tok.in, tokensOut: tok.out });
  return { chapterFiguren, chapterOrte, chapterSongs: chapterSongs || [], chapterFakten, chapterSzenen, chapterAssignments };
}

module.exports = { invalidateRenamedChapterCaches, loadAndValidateCheckpoint, restorePhase1FromCheckpoint };
