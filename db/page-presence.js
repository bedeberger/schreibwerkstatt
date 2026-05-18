'use strict';
// page_presence: Live-Heartbeat fuer „X editiert gerade Seite Y".
// Client pingt im Edit-Mode alle 30s; Server filtert Stale-Eintraege (>90s)
// bei jedem List-Read. Daten sind ephemeral — kein Audit-Wert, daher kein
// Aufraeum-Cron (Stale-Filter beim Read reicht).

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

// Stale-Grenze: doppelter Ping-Interval + Puffer fuer Netz-Hickups. 90s ist
// konservativ — wer 90s lang nicht gepingt hat, hat den Tab geschlossen oder
// das Netz verloren; weiterer Hinweis im UI waere falsch-positiv.
const STALE_AFTER_MS = 90 * 1000;

function _staleCutoffIso() {
  return new Date(Date.now() - STALE_AFTER_MS).toISOString();
}

const _stmtUpsert = db.prepare(`
  INSERT INTO page_presence (page_id, user_email, book_id, last_ping_at)
  VALUES (?, ?, ?, ${NOW_ISO_SQL})
  ON CONFLICT(page_id, user_email)
  DO UPDATE SET last_ping_at = ${NOW_ISO_SQL}
`);

function ping(pageId, userEmail, bookId) {
  if (!pageId || !userEmail || !bookId) return false;
  _stmtUpsert.run(pageId, userEmail, bookId);
  return true;
}

const _stmtRemove = db.prepare(`
  DELETE FROM page_presence WHERE page_id = ? AND user_email = ?
`);

function leave(pageId, userEmail) {
  if (!pageId || !userEmail) return false;
  const r = _stmtRemove.run(pageId, userEmail);
  return r.changes > 0;
}

const _stmtListForBook = db.prepare(`
  SELECT p.page_id, p.user_email, p.book_id, p.last_ping_at,
         u.display_name AS user_display_name
    FROM page_presence p
    LEFT JOIN app_users u ON u.email = p.user_email
   WHERE p.book_id = ?
     AND p.last_ping_at > ?
   ORDER BY p.last_ping_at DESC
`);

function listForBook(bookId) {
  if (!bookId) return [];
  return _stmtListForBook.all(bookId, _staleCutoffIso());
}

const _stmtListForPage = db.prepare(`
  SELECT p.page_id, p.user_email, p.book_id, p.last_ping_at,
         u.display_name AS user_display_name
    FROM page_presence p
    LEFT JOIN app_users u ON u.email = p.user_email
   WHERE p.page_id = ?
     AND p.last_ping_at > ?
   ORDER BY p.last_ping_at DESC
`);

function listForPage(pageId) {
  if (!pageId) return [];
  return _stmtListForPage.all(pageId, _staleCutoffIso());
}

module.exports = {
  STALE_AFTER_MS,
  ping, leave, listForBook, listForPage,
};
