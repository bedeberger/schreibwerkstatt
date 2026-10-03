'use strict';
// In-Memory-Ablage fuer fertige PDF-Buffer des Custom-PDF-Exports
// (routes/jobs/pdf-export.js). Das Job-Result ist JSON und traegt nur
// Metadaten; der Buffer liegt hier, bis der User ihn ueber
// `/jobs/pdf-export/:id/file` abholt.
//
// Zwei Deckel, weil ein Buchsatz mit Bildern leicht dreistellige MB erreicht
// und der Prozess sonst mit jedem Export waechst:
//   - TTL (2 h) pro Eintrag — danach `410 RESULT_EXPIRED`.
//   - Gesamt-Bytes (MAX_TOTAL_BYTES) mit LRU-Verdraengung: der am laengsten
//     nicht abgeholte Eintrag faellt zuerst. Ein verdraengter Eintrag verhaelt
//     sich fuer den Client wie ein abgelaufener (410).
// Abholen loescht NICHT — ein zweiter Download (Browser-Abbruch, zweites
// Geraet) muss gehen; er frischt nur die LRU-Position auf.
//
// Map-Einfuegereihenfolge = LRU-Reihenfolge (get() setzt den Eintrag ans Ende).

const logger = require('../../logger');

const RESULT_TTL_MS   = 2 * 60 * 60 * 1000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

function createResultStore({ ttlMs = RESULT_TTL_MS, maxBytes = MAX_TOTAL_BYTES, now = () => Date.now() } = {}) {
  const entries = new Map(); // jobId → { buffer, mime, filename, bytes, expiresAt, timer }
  let totalBytes = 0;

  function _drop(jobId) {
    const e = entries.get(jobId);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    entries.delete(jobId);
    totalBytes -= e.bytes;
  }

  function set(jobId, { buffer, mime, filename }) {
    _drop(jobId);
    const bytes = buffer?.length || 0;
    // Aelteste zuerst verdraengen, bis der neue Eintrag passt. Ist er allein
    // groesser als der Deckel, bleibt er trotzdem (sonst waere ein grosses
    // Buch nie lieferbar) — dann als einziger Eintrag.
    for (const [id, e] of entries) {
      if (totalBytes + bytes <= maxBytes) break;
      logger.info(`PDF-Ergebnis ${id} verdraengt (${Math.round(e.bytes / 1024)} KB, Deckel ${Math.round(maxBytes / 1048576)} MB)`);
      _drop(id);
    }
    const timer = setTimeout(() => {
      const cur = entries.get(jobId);
      if (cur && cur.timer === timer) _drop(jobId);
    }, ttlMs);
    timer.unref?.();
    entries.set(jobId, { buffer, mime, filename, bytes, expiresAt: now() + ttlMs, timer });
    totalBytes += bytes;
  }

  function get(jobId) {
    const e = entries.get(jobId);
    if (!e) return null;
    if (now() >= e.expiresAt) { _drop(jobId); return null; }
    // LRU auffrischen.
    entries.delete(jobId);
    entries.set(jobId, e);
    return { buffer: e.buffer, mime: e.mime, filename: e.filename };
  }

  return {
    set, get,
    delete: _drop,
    has: (jobId) => entries.has(jobId),
    clear: () => { for (const id of [...entries.keys()]) _drop(id); },
    get totalBytes() { return totalBytes; },
    get size() { return entries.size; },
  };
}

module.exports = { createResultStore, RESULT_TTL_MS, MAX_TOTAL_BYTES };
