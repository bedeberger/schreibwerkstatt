'use strict';
// book_presence: leichter „Geraet X hat Buch Y, Seite P offen"-Heartbeat. Anders
// als page_presence (nur im Edit-Mode, von anderen als „editiert gerade" gelesen)
// pingt der Client hier, sobald ein Buch offen ist — egal ob Lese- oder Edit-Modus.
// Zweck: page-scoped Multi-Device-Erkennung. Sieht der Client >1 eigenes Geraet
// auf DERSELBEN Seite, schaltet er den teuren 5s-Collab-Poll auch fuer
// Einzel-Owner-Buecher frei (sonst bliebe das eigene Zweit-Geraet unsichtbar).
// Zwei Geraete auf verschiedenen Seiten desselben Buchs loesen ihn NICHT aus —
// es gibt keinen Seitenkonflikt.
//
// Ephemeral wie page_presence: kein Audit-Wert, kein Aufraeum-Cron — der
// 90s-Stale-Filter beim Read genuegt.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

// Gleiche Stale-Grenze wie page_presence (doppelter Ping-Interval + Puffer).
const STALE_AFTER_MS = 90 * 1000;

function _staleCutoffIso() {
  return new Date(Date.now() - STALE_AFTER_MS).toISOString();
}

const _stmtUpsert = db.prepare(`
  INSERT INTO book_presence (book_id, user_email, device_id, page_id, last_ping_at)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})
  ON CONFLICT(book_id, user_email, device_id)
  DO UPDATE SET page_id = excluded.page_id, last_ping_at = ${NOW_ISO_SQL}
`);

// pageId nullable: das Geraet kann das Buch ohne offene Seite anzeigen
// (z.B. Buch-Overview).
function ping(bookId, userEmail, deviceId, pageId = null) {
  if (!bookId || !userEmail || !deviceId) return false;
  _stmtUpsert.run(bookId, userEmail, deviceId, pageId || null);
  return true;
}

const _stmtRemove = db.prepare(`
  DELETE FROM book_presence
   WHERE book_id = ? AND user_email = ? AND device_id = ?
`);

function leave(bookId, userEmail, deviceId) {
  if (!bookId || !userEmail || !deviceId) return false;
  const r = _stmtRemove.run(bookId, userEmail, deviceId);
  return r.changes > 0;
}

const _stmtCountSelfDevicesOnPage = db.prepare(`
  SELECT COUNT(DISTINCT device_id) AS n
    FROM book_presence
   WHERE page_id = ? AND user_email = ?
     AND last_ping_at > ?
`);

// Anzahl der aktiven (nicht-stale) Geraete desselben Users auf DERSELBEN Seite —
// inkl. des soeben pingenden Geraets. >1 ⇒ derselbe User hat dieselbe Seite
// gerade auf mehreren Geraeten offen (Seitenkonflikt-Kandidat).
function countSelfDevicesOnPage(pageId, userEmail) {
  if (!pageId || !userEmail) return 0;
  const row = _stmtCountSelfDevicesOnPage.get(pageId, userEmail, _staleCutoffIso());
  return row?.n || 0;
}

module.exports = {
  STALE_AFTER_MS,
  ping, leave, countSelfDevicesOnPage,
};
