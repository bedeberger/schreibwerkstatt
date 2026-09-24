'use strict';
const { bus } = require('../../lib/book-events');
const { getBookRole } = require('../../db/book-access');
const bookPresence = require('../../db/book-presence');
const pagePresence = require('../../db/page-presence');

// Buch-Kanal des Event-Streams (GET /events/stream?book_id=…&device_id=…).
//
// Event:
//   book  { changed, presence }  — Anstoss, kein Datensatz. `changed`: jemand
//         anderes hat Seiten des Buchs geschrieben → Client holt /changes.
//         `presence`: ein Gerät ist dazugekommen/gegangen → Client holt
//         /presence bzw. seine Geräte-Zähler.
//   book  { gone: true }          — Zugriff aufs Buch ist weg. Der Kanal meldet
//         sich danach ab; der Client stösst seinen Geräte-Ping an, dessen 403 den
//         bestehenden Access-Lost-Pfad auslöst.
//
// ACL: geprüft beim Connect UND vor jedem Versand. Zugriff wird an mehreren
// Stellen entzogen (Freigabe-Verwaltung, Admin, Konto-Löschung) — statt jede
// davon an den Stream zu hängen, schlägt der Kanal die Rolle nach, bevor er
// etwas schreibt. Ein entzogener Leser erfährt so nie, DASS sich etwas geändert
// hat; die Daten selbst holt er ohnehin nur über ACL-geprüfte Routen.
//
// Echo: Anstösse, die von DIESEM Gerät ausgelöst wurden (gleiche E-Mail und
// gleiche oder fehlende device_id — Server-/Job-Writes gelten wie beim
// Self-Filter von /changes als eigener Edit), gehen nicht raus.
//
// Presence: eine offene Verbindung heisst „Gerät ist da". Der Heartbeat des
// Streams hält die book_presence-Row und die Edit-Rows (page_presence) dieses
// Geräts frisch; der Browser pingt deshalb nur noch bei Zustandswechsel
// (Seitenwechsel, Edit-Eintritt) plus einem seltenen Sicherheits-Tick.

// Anstösse, die dicht hintereinander kommen (Save + Presence-Wechsel), zu einem
// Event zusammenfassen. Klein genug, dass der Konflikt-Banner „sofort" bleibt.
const COALESCE_MS = 250;

function _sameEmail(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

// Liefert null, wenn der User das Buch nicht sehen darf — dann gibt es keinen
// Kanal. Sonst { heartbeat, detach }.
function attachBookChannel(write, { email, bookId, deviceId }) {
  if (!getBookRole(bookId, email)) return null;

  let closed = false;
  let timer = null;
  let flags = { changed: false, presence: false };

  const detach = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    bus.off('change', onChange);
    bus.off('presence', onPresence);
  };

  const flush = () => {
    timer = null;
    if (closed) return;
    if (!getBookRole(bookId, email)) {
      write('book', { gone: true });
      detach();
      return;
    }
    const out = flags;
    flags = { changed: false, presence: false };
    write('book', out);
  };

  const isEcho = (origin) =>
    _sameEmail(origin.email, email) && (!origin.deviceId || origin.deviceId === deviceId);

  const poke = (key, id, origin) => {
    if (closed || id !== bookId || isEcho(origin)) return;
    flags[key] = true;
    if (!timer) timer = setTimeout(flush, COALESCE_MS);
  };
  const onChange = (id, origin) => poke('changed', id, origin);
  const onPresence = (id, origin) => poke('presence', id, origin);

  bus.on('change', onChange);
  bus.on('presence', onPresence);

  const heartbeat = () => {
    if (closed || !deviceId) return;
    try {
      bookPresence.touch(bookId, email, deviceId);
      pagePresence.touchDevice(bookId, email, deviceId);
    } catch { /* ephemeral — der nächste Ping des Clients legt neu an */ }
  };

  return { heartbeat, detach };
}

module.exports = { attachBookChannel, COALESCE_MS };
