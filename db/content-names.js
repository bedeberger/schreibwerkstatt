'use strict';
// Lese-Lookups auf `pages`/`chapters` für Route- und Job-Handler, die zur
// Lesezeit einen Seiten-/Kapitelnamen oder eine Zuordnung brauchen — auch als
// Namens-JOIN einer abgeleiteten Tabelle (Muster db/sources/citations.js#
// listSourceCitations). Handler fassen `pages`/`chapters`/`books` nie selbst an
// (CLAUDE.md „Content-Store-Facade als einziger Eintrittspunkt"); was nicht über
// die Facade läuft, weil es nur ein Name oder eine ID ist, liegt hier.
//
// Rein lesend. Schreibpfade auf Buchinhalte gehören in lib/content-store.

const { db } = require('./connection');

function _inClause(ids) {
  return { sql: `(${ids.map(() => '?').join(',')})`, values: ids };
}

// ── Kapitel ─────────────────────────────────────────────────────────────────

const _stmtChaptersForBook = db.prepare(`
  SELECT chapter_id, chapter_name, parent_chapter_id, position
    FROM chapters
   WHERE book_id = ?
   ORDER BY position
`);

/** Kapitel eines Buchs in Leserichtung (position), mit Elternzeiger. */
function listChaptersForBook(bookId) {
  return _stmtChaptersForBook.all(bookId);
}

/** Kapitelname → chapter_id eines Buchs (für Namens-Auflösung von KI-Befunden). */
function chapterIdsByName(bookId) {
  return Object.fromEntries(listChaptersForBook(bookId).map(r => [r.chapter_name, r.chapter_id]));
}

// ── Seiten ──────────────────────────────────────────────────────────────────

const _stmtPageTitle = db.prepare('SELECT page_name AS title, book_id FROM pages WHERE page_id = ?');

/** `{ title, book_id }` einer Seite oder null (gelöscht). */
function pageTitle(pageId) {
  return _stmtPageTitle.get(pageId) || null;
}

/** preview_text je Seite (Map page_id → Text, '' wenn leer). */
function pagePreviewTexts(pageIds) {
  if (!pageIds.length) return new Map();
  const { sql, values } = _inClause(pageIds);
  const rows = db.prepare(`SELECT page_id, preview_text FROM pages WHERE page_id IN ${sql}`).all(...values);
  return new Map(rows.map(r => [r.page_id, r.preview_text || '']));
}

/** Kapitel je Seite (nur Seiten MIT Kapitel): Map page_id → { chapter_id, chapter_name }. */
function pageChapters(pageIds) {
  if (!pageIds.length) return new Map();
  const { sql, values } = _inClause(pageIds);
  const rows = db.prepare(`
    SELECT p.page_id, p.chapter_id, c.chapter_name
      FROM pages p
      JOIN chapters c ON c.chapter_id = p.chapter_id
     WHERE p.page_id IN ${sql}
  `).all(...values);
  return new Map(rows.map(r => [r.page_id, { chapter_id: r.chapter_id, chapter_name: r.chapter_name }]));
}

// ── Namens-JOINs abgeleiteter Tabellen ─────────────────────────────────────

/** Figuren-Ereignisse eines Buchs mit Figur- und Kapitelname (Plot-KI-Kontext). */
function listFigureEventsWithNames(bookId, userEmail, limit) {
  return db.prepare(`
    SELECT fe.datum, fe.ereignis, fe.typ, f.name AS figur, c.chapter_name AS kapitel
      FROM figure_events fe
      JOIN figures f ON f.id = fe.figure_id
      LEFT JOIN chapters c ON c.chapter_id = fe.chapter_id
     WHERE f.book_id = ? AND f.user_email = ?
     ORDER BY fe.sort_order, fe.id
     LIMIT ?
  `).all(bookId, userEmail, limit);
}

/** Szenen eines Buchs mit Kapitelname (Plot-KI-Kontext). */
function listScenesWithChapterNames(bookId, userEmail, limit) {
  return db.prepare(`
    SELECT fs.id, fs.titel, c.chapter_name AS kapitel
      FROM figure_scenes fs
      LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
     WHERE fs.book_id = ? AND fs.user_email = ?
     ORDER BY fs.sort_order, fs.id
     LIMIT ?
  `).all(bookId, userEmail, limit);
}

/** Kapitel-Bezüge von Songs mit Kapitelname, häufigste zuerst. */
function listSongChaptersWithNames(songIds) {
  if (!songIds.length) return [];
  const { sql, values } = _inClause(songIds);
  return db.prepare(`
    SELECT sc.song_id, sc.chapter_id, c.chapter_name, sc.haeufigkeit
      FROM song_chapters sc
      LEFT JOIN chapters c ON c.chapter_id = sc.chapter_id
     WHERE sc.song_id IN ${sql}
     ORDER BY sc.haeufigkeit DESC
  `).all(...values);
}

/** Welt-Fakten der Kategorien `kategorien` mit Kapitelname, eine Zeile je
 *  Fakt-Kapitel-Bezug (Fakten ohne Kapitel mit chapter_name NULL). */
function listWorldFactsWithChapterNames(bookId, userEmail, kategorien) {
  if (!kategorien.length) return [];
  return db.prepare(`
    SELECT wf.id, wf.kategorie, wf.subjekt, wf.fakt, c.chapter_name
      FROM world_facts wf
      LEFT JOIN world_fact_chapters wfc ON wfc.fact_id = wf.id
      LEFT JOIN chapters c ON c.chapter_id = wfc.chapter_id
     WHERE wf.book_id = ? AND wf.user_email IS ?
       AND wf.kategorie IN (${kategorien.map(() => '?').join(',')})
     ORDER BY wf.sort_order, wf.id
  `).all(bookId, userEmail, ...kategorien);
}

module.exports = {
  listChaptersForBook,
  chapterIdsByName,
  pageTitle,
  pagePreviewTexts,
  pageChapters,
  listFigureEventsWithNames,
  listScenesWithChapterNames,
  listSongChaptersWithNames,
  listWorldFactsWithChapterNames,
};
