'use strict';
// Seiten-/Kapitel-JOINs der figurenfokussierten Buch-Chat-Tools
// (routes/jobs/book-chat-tools/tools-figures.js). Handler fassen
// `pages`/`chapters`/`books` nie selbst an (CLAUDE.md „Content-Store-Facade als
// einziger Eintrittspunkt").

const { db } = require('../connection');
require('../migrations');

const _stmtPronounsPerChapter = db.prepare(`
    SELECT p.chapter_id, c.chapter_name, ps.pronoun_counts
    FROM page_stats ps
    JOIN pages p      ON p.page_id = ps.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE ps.book_id = ? AND ps.pronoun_counts IS NOT NULL
  `);

/** pronoun_counts je Seite mit Kapitel-Zuordnung (für die Kapitel-Aggregation). */
function listPronounCountsWithChapters(bookId) {
  return _stmtPronounsPerChapter.all(bookId);
}

const _stmtFigureMentions = db.prepare(`
    SELECT p.page_id, p.page_name, p.chapter_id, c.chapter_name, pfm.count, pfm.first_offset
    FROM page_figure_mentions pfm
    JOIN pages p      ON p.page_id = pfm.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE pfm.figure_id = ? AND p.book_id = ?
    ORDER BY c.position, p.position, p.page_id
  `);

/** Index-Erwähnungen einer Figur je Seite, in Leserichtung. */
function listFigureMentionsWithPages(figureId, bookId) {
  return _stmtFigureMentions.all(figureId, bookId);
}

const _stmtAppearances = db.prepare(`
    SELECT fa.chapter_id, c.chapter_name, fa.haeufigkeit
    FROM figure_appearances fa
    LEFT JOIN chapters c ON c.chapter_id = fa.chapter_id
    WHERE fa.figure_id = ?
    ORDER BY c.position
  `);

/** Kapitel-Auftritte einer Figur mit Kapitelname. */
function listFigureAppearancesWithChapters(figureId) {
  return _stmtAppearances.all(figureId);
}

const _stmtEvents = db.prepare(`
    SELECT fe.datum, fe.ereignis, fe.bedeutung, fe.typ,
           fe.chapter_id, c.chapter_name,
           fe.page_id, p.page_name
    FROM figure_events fe
    LEFT JOIN chapters c ON c.chapter_id = fe.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fe.page_id
    WHERE fe.figure_id = ?
    ORDER BY fe.sort_order, fe.datum
  `);

/** Lebensereignisse einer Figur mit Kapitel- und Seitenname. */
function listFigureEventsWithPlaces(figureId) {
  return _stmtEvents.all(figureId);
}

const _stmtScenes = db.prepare(`
    SELECT fs.id, fs.titel, fs.wertung, fs.kommentar,
           fs.chapter_id, c.chapter_name,
           fs.page_id, p.page_name
    FROM figure_scenes fs
    JOIN scene_figures sf ON sf.scene_id = fs.id
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fs.page_id
    WHERE sf.figure_id = ? AND fs.book_id = ? AND fs.user_email IS ?
    ORDER BY fs.sort_order
  `);

/** Szenen, an denen eine Figur beteiligt ist, mit Kapitel- und Seitenname. */
function listFigureScenesWithPlaces(figureId, bookId, userEmail) {
  return _stmtScenes.all(figureId, bookId, userEmail);
}

module.exports = {
  listPronounCountsWithChapters,
  listFigureMentionsWithPages,
  listFigureAppearancesWithChapters,
  listFigureEventsWithPlaces,
  listFigureScenesWithPlaces,
};
