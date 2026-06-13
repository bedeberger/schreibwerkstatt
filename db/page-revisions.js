'use strict';
// CRUD fuer page_revisions.
// Schreib-Pfad: content-store-Facade ruft `insert()` nach jedem erfolgreichen
//   Backend-Save und legt den gerade geschriebenen Stand als Snapshot ab (jede
//   Revision = Inhalt NACH ihrem Save, nicht der Vorzustand).
// Lese-Pfad: routes/content.js Revisions-Endpoints.
// Retention: lib/cache-cleanup.js POLICIES ruft `pruneTiered()` taeglich.
// Strategie: Grandfather-Father-Son (GFS).
//   <=1 Tag:  alle behalten
//   1-7 Tage:   1 pro Kalendertag  (aelteste)
//   7-60 Tage:  1 pro ISO-Woche    (aelteste)
//   60-365 T:   1 pro Kalendermonat (aelteste)
//   >1 Jahr:    1 pro Jahr         (aelteste)
// Floor `app.page_revision_limit` haelt zusaetzlich die N jueng­sten Revisions
// pro Seite (Safety-Net gegen Schema-Bugs + macht Rollback einfach moeglich).
// Aelteste-pro-Bucket: User-Intuition "Stand vor ~1 Monat" trifft den
// Bucket-Rand naeher als die juengste Rev des Buckets.

const { db } = require('./connection');
require('./migrations');
const { CHARS_PER_TOKEN } = require('../lib/ai');
const { NOW_ISO_SQL } = require('./now');
const { htmlToPlainText } = require('../lib/html-text');

const VALID_SOURCES = new Set([
  'focus', 'main', 'book', 'chat-apply', 'lektorat-apply',
  'import', 'conflict',
]);

function _statsFromHtml(html) {
  const text = htmlToPlainText(html);
  const chars = text.length;
  const words = text === '' ? 0 : text.split(/\s+/).length;
  const tok = Math.round(chars / CHARS_PER_TOKEN);
  return { chars, words, tok };
}

const _insertStmt = db.prepare(`
  INSERT INTO page_revisions
    (page_id, book_id, body_html, body_markdown, chars, words, tok,
     source, user_email, summary, created_at)
  VALUES
    (@page_id, @book_id, @body_html, @body_markdown, @chars, @words, @tok,
     @source, @user_email, @summary, ${NOW_ISO_SQL})
`);

const _lastBodyStmt = db.prepare(`
  SELECT body_html
    FROM page_revisions
   WHERE page_id = ?
   ORDER BY created_at DESC, id DESC
   LIMIT 1
`);

// Dedup: identischer Body ODER identischer sichtbarer Text zur juengsten
// Revision derselben Seite → skip. Byte-Vergleich faengt Autosave-Bursts;
// Plain-Text-Vergleich faengt Phantom-Revs aus rein nicht-sichtbaren
// HTML-Aenderungen (trailing NBSP, Attribut-Reorder, idempotenter Cleaner-
// Output), die sonst Revision-Rows mit irrefuehrendem chars-Delta erzeugen
// und im Side-by-Side-Diff als „unchanged" landen.
function insert({ pageId, bookId, bodyHtml, bodyMarkdown = null, source, userEmail = null, summary = null }) {
  if (!Number.isInteger(pageId) || pageId <= 0) throw new Error('page-revisions.insert: pageId required');
  if (!Number.isInteger(bookId) || bookId <= 0) throw new Error('page-revisions.insert: bookId required');
  if (typeof bodyHtml !== 'string') throw new Error('page-revisions.insert: bodyHtml required');
  if (!VALID_SOURCES.has(source)) throw new Error(`page-revisions.insert: invalid source "${source}"`);
  const last = _lastBodyStmt.get(pageId);
  if (last) {
    if (last.body_html === bodyHtml) return null;
    if (htmlToPlainText(last.body_html) === htmlToPlainText(bodyHtml)) return null;
  }
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

// Tiered Retention (GFS) + Floor. Single-Statement via CTE.
// `floor`: Mindestanzahl jueng­ste Revisions pro page_id, die zusaetzlich zum
// Bucket-Schema garantiert behalten werden.
// `now` (optional): ISO-Timestamp-Override; Default = SQLite 'now'. Nur fuer
// Tests; Produktion ruft ohne Argument auf.
function pruneTiered({ floor, now = null } = {}) {
  const n = parseInt(floor, 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error('pruneTiered: floor must be positive int');
  const nowExpr = now ? '@now' : "'now'";
  const sql = `
    WITH classified AS (
      SELECT
        id, page_id, created_at,
        CASE
          WHEN julianday(${nowExpr}) - julianday(created_at) <= 1   THEN 'raw'
          WHEN julianday(${nowExpr}) - julianday(created_at) <= 7   THEN 'd:' || date(created_at)
          WHEN julianday(${nowExpr}) - julianday(created_at) <= 60  THEN 'w:' || strftime('%Y-%W', created_at)
          WHEN julianday(${nowExpr}) - julianday(created_at) <= 365 THEN 'm:' || strftime('%Y-%m', created_at)
          ELSE                                                            'y:' || strftime('%Y', created_at)
        END AS bucket
        FROM page_revisions
    ),
    keep_buckets AS (
      SELECT id FROM classified WHERE bucket = 'raw'
      UNION
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
                     PARTITION BY page_id, bucket
                     ORDER BY created_at ASC, id ASC
                   ) AS rn
          FROM classified
         WHERE bucket <> 'raw'
      ) WHERE rn = 1
    ),
    keep_floor AS (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
                     PARTITION BY page_id
                     ORDER BY created_at DESC, id DESC
                   ) AS rn
          FROM page_revisions
      ) WHERE rn <= @floor
    )
    DELETE FROM page_revisions
     WHERE id NOT IN (SELECT id FROM keep_buckets)
       AND id NOT IN (SELECT id FROM keep_floor)
  `;
  const params = now ? { floor: n, now } : { floor: n };
  return db.prepare(sql).run(params).changes;
}

module.exports = {
  insert,
  listForPage,
  get,
  countForPage,
  pruneTiered,
  VALID_SOURCES,
};
