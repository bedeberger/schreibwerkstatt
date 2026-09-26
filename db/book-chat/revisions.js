'use strict';
// Lese-Abfragen des Buch-Chat-Tools `diff_page_revisions`
// (routes/jobs/book-chat-tools/tools-revisions.js). Handler fassen
// `pages`/`chapters`/`books` nie selbst an (CLAUDE.md „Content-Store-Facade als
// einziger Eintrittspunkt"); Namens-Lookups für die Tool-Antwort liegen hier.

const { db } = require('../connection');
require('../migrations');

const _stmtPageWithChapter = db.prepare(`
    SELECT p.page_id, p.page_name, c.chapter_name, p.book_id
    FROM pages p
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE p.page_id = ?
  `);

/** `{ page_id, page_name, chapter_name, book_id }` einer Seite oder undefined. */
function getPageWithChapterName(pageId) {
  return _stmtPageWithChapter.get(pageId);
}

module.exports = { getPageWithChapterName };
