'use strict';
// page_presence: Live-Heartbeat fuer „X editiert gerade Seite Y".
// Client pingt im Edit-Mode alle 30s; Server filtert Stale-Eintraege (>90s)
// bei jedem List-Read. Daten sind ephemeral — kein Audit-Wert, daher kein
// Aufraeum-Cron (Stale-Filter beim Read reicht).
//
// PK ist (page_id, user_email, device_id): derselbe User auf zwei Geraeten
// belegt zwei Rows, damit das eigene andere Geraet im UI sichtbar bleibt.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { emitBookPresence } = require('../lib/book-events');

// Stale-Grenze: doppelter Ping-Interval + Puffer fuer Netz-Hickups. 90s ist
// konservativ — wer 90s lang nicht gepingt hat, hat den Tab geschlossen oder
// das Netz verloren; weiterer Hinweis im UI waere falsch-positiv.
const STALE_AFTER_MS = 90 * 1000;

function _staleCutoffIso() {
  return new Date(Date.now() - STALE_AFTER_MS).toISOString();
}

const _stmtUpsert = db.prepare(`
  INSERT INTO page_presence (page_id, user_email, device_id, book_id, last_ping_at)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})
  ON CONFLICT(page_id, user_email, device_id)
  DO UPDATE SET last_ping_at = ${NOW_ISO_SQL}
`);

const _stmtGet = db.prepare(`
  SELECT last_ping_at FROM page_presence
   WHERE page_id = ? AND user_email = ? AND device_id = ?
`);

// Presence-Anstoss an den Event-Stream nur, wenn die Row neu ist (oder nach
// Stale-Luecke zurueckkommt) — „X editiert hier" erscheint dann sofort bei den
// anderen. Der 30-s-Heartbeat feuert nichts.
function ping(pageId, userEmail, bookId, deviceId) {
  if (!pageId || !userEmail || !bookId || !deviceId) return false;
  const prev = _stmtGet.get(pageId, userEmail, deviceId);
  _stmtUpsert.run(pageId, userEmail, deviceId, bookId);
  if (!prev || prev.last_ping_at <= _staleCutoffIso()) emitBookPresence(bookId, userEmail, deviceId);
  return true;
}

const _stmtTouchDevice = db.prepare(`
  UPDATE page_presence SET last_ping_at = ${NOW_ISO_SQL}
   WHERE book_id = ? AND user_email = ? AND device_id = ?
     AND last_ping_at > ?
`);

// Haelt die (noch frischen) Edit-Rows eines Geraets im Buch am Leben, ohne neue
// anzulegen. Konsument ist der Heartbeat des Event-Streams: solange die
// Verbindung steht, bleibt „X editiert hier" sichtbar, auch wenn der Browser
// seinen eigenen Heartbeat aussetzt. Eine schon stale Row wird nicht
// wiederbelebt — die ist bewusst abgelaufen.
function touchDevice(bookId, userEmail, deviceId) {
  if (!bookId || !userEmail || !deviceId) return 0;
  return _stmtTouchDevice.run(bookId, userEmail, deviceId, _staleCutoffIso()).changes;
}

const _stmtRemove = db.prepare(`
  DELETE FROM page_presence
   WHERE page_id = ? AND user_email = ? AND device_id = ?
   RETURNING book_id
`);

function leave(pageId, userEmail, deviceId) {
  if (!pageId || !userEmail || !deviceId) return false;
  const rows = _stmtRemove.all(pageId, userEmail, deviceId);
  for (const r of rows) emitBookPresence(r.book_id, userEmail, deviceId);
  return rows.length > 0;
}

const _stmtListForBook = db.prepare(`
  SELECT p.page_id, p.user_email, p.device_id, p.book_id, p.last_ping_at,
         u.display_name AS user_display_name,
         d.label        AS device_label
    FROM page_presence p
    LEFT JOIN app_users          u ON u.email     = p.user_email
    LEFT JOIN app_users_devices  d ON d.device_id = p.device_id
   WHERE p.book_id = ?
     AND p.last_ping_at > ?
   ORDER BY p.last_ping_at DESC
`);

function listForBook(bookId) {
  if (!bookId) return [];
  return _stmtListForBook.all(bookId, _staleCutoffIso());
}

const _stmtListForPage = db.prepare(`
  SELECT p.page_id, p.user_email, p.device_id, p.book_id, p.last_ping_at,
         u.display_name AS user_display_name,
         d.label        AS device_label
    FROM page_presence p
    LEFT JOIN app_users          u ON u.email     = p.user_email
    LEFT JOIN app_users_devices  d ON d.device_id = p.device_id
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
  ping, touchDevice, leave, listForBook, listForPage,
};
