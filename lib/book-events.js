'use strict';
const { EventEmitter } = require('events');

// Prozess-interner Bus für Änderungen an einem Buch. Einzige Quelle für den
// Buch-Kanal des Event-Streams (routes/events/book-channel.js).
//
// Die Events sind ANSTÖSSE, keine Daten: der Client holt nach einem Anstoss
// selbst `/changes` bzw. `/presence`. So bleiben Self-Filter, Geräte-Label-Scope
// und ACL an genau der Stelle, an der sie heute schon gelten, und ein Event
// braucht keine empfängerabhängige Form.
//
// 'change' (bookId, origin): Seiteninhalt oder -bestand geändert. Gefeuert
//   ausschliesslich aus den Schreibpfaden der Content-Store-Facade
//   (savePage/createPage/deletePage/movePage).
// 'presence' (bookId, origin): ein Gerät ist am Buch/an einer Seite neu
//   aufgetaucht oder hat sich abgemeldet. Gefeuert aus db/book-presence.js und
//   db/page-presence.js — nur bei Zustandswechsel, nicht bei jedem Heartbeat.
//
// origin = { email, deviceId } des Auslösers; der Kanal filtert damit das Echo
// des eigenen Geräts aus (gleiche Regel wie der Self-Filter von /changes).
const bus = new EventEmitter();
bus.setMaxListeners(0); // ein Listener-Paar pro offenem Stream

function _origin(email, deviceId) {
  return { email: email || null, deviceId: deviceId || null };
}

function emitBookChange(bookId, email, deviceId) {
  if (bookId) bus.emit('change', Number(bookId), _origin(email, deviceId));
}

function emitBookPresence(bookId, email, deviceId) {
  if (bookId) bus.emit('presence', Number(bookId), _origin(email, deviceId));
}

module.exports = { bus, emitBookChange, emitBookPresence };
