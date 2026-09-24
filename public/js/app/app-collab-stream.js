// Collab über den Event-Stream: der Buch-Kanal (public/js/event-stream.js,
// Server routes/events/book-channel.js) stösst an, die bestehenden Reads in
// app-collab.js holen die Daten. Der Stream trägt keine Change-Rows — Self-
// Filter, Geräte-Label und ACL bleiben in /changes und /presence.
//
// Reaktionen:
//   changed   voller Poll läuft → sofort ein Tick (Toast, Baum-Marker,
//             Konflikt-Banner); sonst Baum-Drift-Probe ohne Dedup
//   presence  Geräte-Ping (Zähler → Voll-Poll an/aus) + Presence-Read
//   reconnect alles einmal nachholen, Edit-Presence neu melden (die Rows können
//             während der Lücke abgelaufen sein)
//   gone      Geräte-Ping — seine 403 löst `_handleBookAccessLost` aus
//
// Die Timer in app-collab.js laufen weiter. Bei offenem Buch-Stream überspringt
// jeder seine Ticks bis zum Sicherheitsabstand in STREAM_SAFETY_MS: der Stream
// liefert die Änderungen, und sein Server-Heartbeat hält die eigenen
// Presence-Rows frisch. Ohne Stream (Proxy, Reconnect, alter Browser) tickt
// alles im normalen Takt.

import { setEventStreamBook, bookStreamOpen, onBookStream } from '../event-stream.js';

// Abstand, nach dem ein Timer trotz offenem Stream wieder selbst tickt.
//   poll      fängt ab, was kein Anstoss meldet: stumm abgelaufene fremde
//             Presence (Tab-Crash ohne DELETE)
//   ping      Geräte-Zähler nach stummem Wegfall eines Zweitgeräts
//   presence  eigener Edit-Heartbeat — deutlich unter dem 90-s-Stale-Fenster
//             bräuchte es ihn nur, wenn der Server-Heartbeat ausfiele
const STREAM_SAFETY_MS = { poll: 30_000, ping: 120_000, presence: 60_000 };

export const appCollabStreamMethods = {
  _attachCollabStream(bookId) {
    if (!this.$store.collab._streamOff) {
      this.$store.collab._streamOff = onBookStream((ev) => this._onCollabStreamEvent(ev));
    }
    setEventStreamBook(bookId || null);
  },

  _detachCollabStream() {
    setEventStreamBook(null);
  },

  // Zeitstempel eines gesendeten Ticks; `_collabStreamCovers` rechnet damit.
  _markCollabSent(kind) {
    this.$store.collab._lastSent[kind] = Date.now();
  },

  // true = der Timer-Tick darf ausfallen, weil der Stream das Buch abdeckt und
  // der letzte eigene Tick jünger als der Sicherheitsabstand ist.
  _collabStreamCovers(bookId, kind) {
    if (!bookStreamOpen(bookId)) return false;
    return Date.now() - (this.$store.collab._lastSent[kind] || 0) < STREAM_SAFETY_MS[kind];
  },

  _onCollabStreamEvent(ev) {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId || !ev) return;
    const fullPoll = !!this.$store.collab._collabPollTimer;
    if (ev.gone) { this._sendBookDevicePing(bookId); return; }
    if (ev.reconnect) {
      const pid = this.$store.collab._presencePingPageId;
      if (pid) this._sendPresencePing(pid);
      this._sendBookDevicePing(bookId);
      if (fullPoll) this._collabPollOnce(bookId);
      else this._checkTreeDrift(bookId, { force: true });
      return;
    }
    if (ev.presence) this._sendBookDevicePing(bookId);
    if (fullPoll) this._collabPollOnce(bookId);
    else if (ev.changed) this._checkTreeDrift(bookId, { force: true });
  },
};
