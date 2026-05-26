'use strict';
// User-Custom-Dictionary fuer LanguageTool-Spellcheck.
//
// Wort-Eintraege werden vor dem Caching der LT-Response gefiltert: Matches,
// deren beanstandetes Wort im Dictionary steht, fallen raus. Beim Add/Remove
// wird der LT-Cache nur fuer Pages geleert, in deren body_html das Wort
// vorkommt (Scope: betroffenes Buch bzw. alle Buecher mit book_access).
//
// Granularitaet:
//   - book_id = NULL  -> User-globaler Eintrag (alle Buecher)
//   - book_id > 0     -> nur fuer das jeweilige Buch (FK CASCADE bei Buchloeschung)
//   - lang = '*'      -> sprachuebergreifend
//   - lang = 'de-CH'  -> nur fuer diese Locale
//
// Case-insensitive Lookup: Speicherung in Original-Case fuer Display, Vergleich
// ueber lower-cased Set.

const { db } = require('./connection');

const _stmtList = db.prepare(
  `SELECT word, book_id, lang, created_at FROM user_dictionary
   WHERE user_email = ?
   ORDER BY created_at DESC`
);
const _stmtListForCheck = db.prepare(
  `SELECT word FROM user_dictionary
   WHERE user_email = ?
     AND (book_id IS NULL OR book_id = ?)
     AND (lang = '*' OR lang = ?)`
);
const _stmtInsert = db.prepare(
  `INSERT OR IGNORE INTO user_dictionary (user_email, book_id, word, lang)
   VALUES (?, ?, ?, ?)`
);
const _stmtDelete = db.prepare(
  `DELETE FROM user_dictionary
   WHERE user_email = ? AND book_id IS ? AND word = ? AND lang = ?`
);
// Wort-scoped Purge: nur Pages mit body_html LIKE %word% verlieren ihren Cache.
// LIKE COLLATE NOCASE deckt ASCII-Case ab; Umlaute bleiben case-sensitive --
// gut genug fuer Invalidierung (False-Positive heisst ein Re-Fetch, False-
// Negative gibt's nicht, weil die geschriebene Form im HTML steht).
const _stmtPurgeCacheByWordGlobal = db.prepare(
  `DELETE FROM page_languagetool_cache
   WHERE page_id IN (
     SELECT p.page_id FROM pages p
     JOIN book_access ba ON ba.book_id = p.book_id
     WHERE ba.user_email = ?
       AND p.body_html LIKE ? ESCAPE '\\' COLLATE NOCASE
   )`
);
const _stmtPurgeCacheByWordForBook = db.prepare(
  `DELETE FROM page_languagetool_cache
   WHERE page_id IN (
     SELECT page_id FROM pages
     WHERE book_id = ?
       AND body_html LIKE ? ESCAPE '\\' COLLATE NOCASE
   )`
);

function listForUser(userEmail) {
  if (!userEmail) return [];
  return _stmtList.all(userEmail);
}

function getCheckSet(userEmail, bookId, lang) {
  if (!userEmail) return new Set();
  const rows = _stmtListForCheck.all(userEmail, bookId || null, lang || 'auto');
  const set = new Set();
  for (const r of rows) {
    if (r.word) set.add(r.word.toLowerCase());
  }
  return set;
}

function add(userEmail, { word, bookId = 0, lang = '*' }) {
  if (!userEmail || !word || !word.trim()) return false;
  const w = word.trim();
  _stmtInsert.run(userEmail, bookId || null, w, lang || '*');
  _purgeCacheForWord(userEmail, bookId, w);
  return true;
}

function remove(userEmail, { word, bookId = 0, lang = '*' }) {
  if (!userEmail || !word) return 0;
  const r = _stmtDelete.run(userEmail, bookId || null, word, lang || '*');
  if (r.changes > 0) _purgeCacheForWord(userEmail, bookId, word);
  return r.changes;
}

function _likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

function _purgeCacheForWord(userEmail, bookId, word) {
  // Cache nur fuer Pages leeren, deren body_html das Wort enthaelt. Bei
  // book_id=0 sind alle Buecher des Users im Scope, sonst nur das gewaehlte.
  const pattern = `%${_likeEscape(word)}%`;
  if (bookId && bookId > 0) {
    _stmtPurgeCacheByWordForBook.run(bookId, pattern);
  } else {
    _stmtPurgeCacheByWordGlobal.run(userEmail, pattern);
  }
}

// Filtert LT-Match-Array: alle Matches, deren beanstandetes Wort
// (context.text.slice(context.offset, context.offset+context.length)) im
// Dictionary steht, werden entfernt.
function filterMatches(matches, dictSet) {
  if (!Array.isArray(matches) || !dictSet || !dictSet.size) return matches;
  return matches.filter((m) => {
    const ctx = m?.context;
    if (!ctx || typeof ctx.text !== 'string') return true;
    const word = ctx.text.substr(ctx.offset || 0, ctx.length || 0).trim();
    if (!word) return true;
    return !dictSet.has(word.toLowerCase());
  });
}

module.exports = { listForUser, getCheckSet, add, remove, filterMatches };
