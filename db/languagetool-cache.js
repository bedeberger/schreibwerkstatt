'use strict';
// Per-Page-Cache fuer LanguageTool-Resultate.
//
// Key: (page_id, content_hash, lang, picky). content_hash = sha1 ueber den
// Text-Stream, der ans LT-API geht (gleiche Normalisierung wie der Proxy).
// Cache-Eintrag haelt JSON-Array der LT-Matches; FK CASCADE auf pages, d.h.
// Page-Loeschung raeumt Cache automatisch.
//
// TTL: keine harte Frist. Wenn LT-Server-Regeln aktualisiert werden, ist
// Stale-Risiko akzeptabel (User wuerde manuell auf "Re-Check" klicken;
// derzeit kein UI dafuer -- Phase 3).

const crypto = require('crypto');
const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const _stmtGet = db.prepare(
  `SELECT matches_json FROM page_languagetool_cache
   WHERE page_id = ? AND content_hash = ? AND lang = ? AND picky = ?`
);
const _stmtUpsert = db.prepare(
  `INSERT INTO page_languagetool_cache (page_id, content_hash, lang, picky, matches_json, created_at)
   VALUES (?, ?, ?, ?, ?, ${NOW_ISO_SQL})
   ON CONFLICT(page_id, content_hash, lang, picky) DO UPDATE SET
     matches_json = excluded.matches_json,
     created_at = excluded.created_at`
);
const _stmtPurgeForPage = db.prepare(
  `DELETE FROM page_languagetool_cache WHERE page_id = ?`
);

function hashText(text) {
  return crypto.createHash('sha1').update(typeof text === 'string' ? text : '').digest('hex');
}

function getCached({ pageId, contentHash, lang, picky }) {
  if (!pageId || !contentHash || !lang) return null;
  const row = _stmtGet.get(pageId, contentHash, lang, picky ? 1 : 0);
  if (!row) return null;
  try { return JSON.parse(row.matches_json); }
  catch { return null; }
}

function setCached({ pageId, contentHash, lang, picky, matches }) {
  if (!pageId || !contentHash || !lang) return;
  const json = JSON.stringify(Array.isArray(matches) ? matches : []);
  _stmtUpsert.run(pageId, contentHash, lang, picky ? 1 : 0, json);
}

function purgeForPage(pageId) {
  if (!pageId) return 0;
  return _stmtPurgeForPage.run(pageId).changes;
}

module.exports = { hashText, getCached, setCached, purgeForPage };
