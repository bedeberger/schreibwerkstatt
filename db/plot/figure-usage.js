'use strict';
// Cross-Feature-Lesepfad der Plot-Werkstatt (Facade: db/plot.js).

const { db } = require('../connection');

// ── Cross-Feature: Plot-Beteiligung einer (Werkstatt-)Figur ──────────────────
// Welche Beats involvieren eine bestimmte Figur und an welche Stränge ist sie als
// Hauptfigur gebunden? Drei Quellen, dedupliziert:
//   a) direkt verknüpfte Werkstatt-Figur (plot_beat_draft_figures.draft_figure_id)
//   b) direkt verknüpfte Katalog-Figur (plot_beat_figures.figure_id = sourceFigureId)
//   c) implizit über einen Strang, an den die Figur gebunden ist (Live-Vererbung:
//      die Strang-Hauptfigur gilt in ALLEN Beats der Lane als beteiligt)
// Speist den Cross-Feature-Kontext der Figuren-Werkstatt-Jobs (Consistency/
// Brainstorm) und das „in N Beats geplant"-Badge (Navigation Werkstatt → Plot).
// Beats namensbasiert + lesefertig angereichert (Akt, Strang, effektives Kapitel,
// Status, Intensität), in Board-Lesereihenfolge.
function figurePlotUsage(bookId, userEmail, { draftFigureId = null, sourceFigureId = null } = {}) {
  const bid = parseInt(bookId);
  const dId = draftFigureId != null ? parseInt(draftFigureId) : null;
  const sId = sourceFigureId != null ? parseInt(sourceFigureId) : null;

  // (c) Gebundene Stränge: Katalog via figure_id, Werkstatt via draft_figure_id.
  const threads = db.prepare(`
    SELECT id, name FROM plot_threads
     WHERE book_id = ? AND user_email = ?
       AND ((? IS NOT NULL AND draft_figure_id = ?) OR (? IS NOT NULL AND figure_id = ?))
     ORDER BY position, id
  `).all(bid, userEmail, dId, dId, sId, sId);
  const threadIds = threads.map(t => t.id);

  const ids = new Set();
  if (dId != null) {
    for (const r of db.prepare(`
      SELECT pbdf.beat_id AS id FROM plot_beat_draft_figures pbdf
        JOIN plot_beats b ON b.id = pbdf.beat_id
       WHERE b.book_id = ? AND b.user_email = ? AND pbdf.draft_figure_id = ?
    `).all(bid, userEmail, dId)) ids.add(r.id);
  }
  if (sId != null) {
    for (const r of db.prepare(`
      SELECT pbf.beat_id AS id FROM plot_beat_figures pbf
        JOIN plot_beats b ON b.id = pbf.beat_id
       WHERE b.book_id = ? AND b.user_email = ? AND pbf.figure_id = ?
    `).all(bid, userEmail, sId)) ids.add(r.id);
  }
  if (threadIds.length) {
    const ph = threadIds.map(() => '?').join(',');
    for (const r of db.prepare(`
      SELECT id FROM plot_beats
       WHERE book_id = ? AND user_email = ? AND thread_id IN (${ph})
    `).all(bid, userEmail, ...threadIds)) ids.add(r.id);
  }
  if (!ids.size) return { beats: [], threads };

  const idList = [...ids];
  const ph = idList.map(() => '?').join(',');
  // Auch der Anreicherungs-JOIN ist auf (Buch, User) skopiert — die ID-Liste
  // stammt zwar aus skopierten Abfragen, aber die Grenze gehört an jede Abfrage,
  // nicht an die Herkunft ihrer Parameter.
  const beats = db.prepare(`
    SELECT b.titel, b.beschreibung, b.status, b.verworfen, b.intensitaet,
           b.sort_order, a.name AS act_name, a.position AS act_position,
           t.name AS thread_name,
           c.chapter_name AS beat_chapter_name, tc.chapter_name AS thread_chapter_name
      FROM plot_beats b
      JOIN plot_acts a ON a.id = b.act_id AND a.book_id = b.book_id AND a.user_email = b.user_email
      LEFT JOIN plot_threads t ON t.id = b.thread_id AND t.book_id = b.book_id AND t.user_email = b.user_email
      LEFT JOIN chapters c ON c.chapter_id = b.chapter_id
      LEFT JOIN chapters tc ON tc.chapter_id = t.chapter_id
     WHERE b.id IN (${ph}) AND b.book_id = ? AND b.user_email = ?
     ORDER BY a.position, b.sort_order, b.id
  `).all(...idList, bid, userEmail).map(b => ({
    titel: b.titel,
    beschreibung: b.beschreibung || null,
    status: b.status,
    verworfen: !!b.verworfen,
    intensitaet: b.intensitaet || null,
    akt: b.act_name || null,
    strang: b.thread_name || null,
    // Effektives Kapitel: eigenes hat Vorrang, sonst vom Strang geerbt (Live-Vererbung).
    kapitel: b.beat_chapter_name || b.thread_chapter_name || null,
  }));
  return { beats, threads };
}

module.exports = { figurePlotUsage };
