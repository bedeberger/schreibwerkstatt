'use strict';
// CRUD fuer page_revisions.
// Schreib-Pfad: content-store-Facade ruft `insert()` vor jedem Backend-Save.
// Lese-Pfad: routes/content.js Revisions-Endpoints.
// Retention: lib/cache-cleanup.js POLICIES ruft `pruneOverLimit()` taeglich.

const { db } = require('./connection');
require('./migrations');
const { CHARS_PER_TOKEN } = require('../lib/ai');

const VALID_SOURCES = new Set([
  'focus', 'main', 'chat-apply', 'lektorat-apply',
  'bookstack-sync', 'import', 'conflict',
]);

// Identische HTML→Text-Normalisierung wie routes/sync.js und
// public/js/tree.js (page_stats-Parity). Drift bricht Token-Schaetzungen.
function _htmlToText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function _statsFromHtml(html) {
  const text = _htmlToText(html);
  const chars = text.length;
  const words = text === '' ? 0 : text.split(/\s+/).length;
  const tok = Math.round(chars / CHARS_PER_TOKEN);
  return { chars, words, tok };
}

const _insertStmt = db.prepare(`
  INSERT INTO page_revisions
    (page_id, book_id, body_html, body_markdown, chars, words, tok,
     source, user_email, summary)
  VALUES
    (@page_id, @book_id, @body_html, @body_markdown, @chars, @words, @tok,
     @source, @user_email, @summary)
`);

function insert({ pageId, bookId, bodyHtml, bodyMarkdown = null, source, userEmail = null, summary = null }) {
  if (!Number.isInteger(pageId) || pageId <= 0) throw new Error('page-revisions.insert: pageId required');
  if (!Number.isInteger(bookId) || bookId <= 0) throw new Error('page-revisions.insert: bookId required');
  if (typeof bodyHtml !== 'string') throw new Error('page-revisions.insert: bodyHtml required');
  if (!VALID_SOURCES.has(source)) throw new Error(`page-revisions.insert: invalid source "${source}"`);
  const { chars, words, tok } = _statsFromHtml(bodyHtml);
  const result = _insertStmt.run({
    page_id: pageId,
    book_id: bookId,
    body_html: bodyHtml,
    body_markdown: bodyMarkdown,
    chars, words, tok,
    source,
    user_email: userEmail,
    summary,
  });
  return result.lastInsertRowid;
}

const _listForPageStmt = db.prepare(`
  SELECT id, page_id, book_id, chars, words, tok,
         source, user_email, created_at, summary
    FROM page_revisions
   WHERE page_id = ?
   ORDER BY created_at DESC, id DESC
   LIMIT ?
`);

function listForPage(pageId, limit = 100) {
  return _listForPageStmt.all(pageId, Math.min(Math.max(limit, 1), 500));
}

const _getStmt = db.prepare(`
  SELECT id, page_id, book_id, body_html, body_markdown, chars, words, tok,
         source, user_email, created_at, summary
    FROM page_revisions
   WHERE id = ?
`);

function get(id) {
  return _getStmt.get(id) || null;
}

const _countStmt = db.prepare('SELECT COUNT(*) AS n FROM page_revisions WHERE page_id = ?');
function countForPage(pageId) {
  return _countStmt.get(pageId)?.n || 0;
}

// Retention: pro page_id alle Revisions ausserhalb der jueng­sten `limit`
// purgen. Single-statement, kein Loop in JS. ROW_NUMBER haelt die jueng­sten
// `limit` (DESC), DELETE killt den Rest.
function pruneOverLimit(limit) {
  const n = parseInt(limit, 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error('pruneOverLimit: limit must be positive int');
  const sql = `
    DELETE FROM page_revisions
     WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (
                      PARTITION BY page_id
                      ORDER BY created_at DESC, id DESC
                    ) AS rn
           FROM page_revisions
       )
      WHERE rn > ?
     )
  `;
  return db.prepare(sql).run(n).changes;
}

module.exports = {
  insert,
  listForPage,
  get,
  countForPage,
  pruneOverLimit,
  VALID_SOURCES,
};
