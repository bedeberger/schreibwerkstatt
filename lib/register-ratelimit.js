'use strict';
// Phase 4a2 (BookStack-Exit): In-Memory-Rate-Limit fuer POST /register.
// 3 Anfragen pro IP pro 60 min — schuetzt vor Spam-Anmeldungen via
// oeffentliches Register-Formular. Self-Hosted-Pattern (kein Reverse-Proxy
// noetig); In-Memory ist ok, weil Restart-Reset bei niedrigem Risiko OK ist.

const WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS = 3;
const _entries = new Map(); // ip → { count, firstAt }

function _purge(now) {
  for (const [ip, e] of _entries) {
    if (e.firstAt + WINDOW_MS <= now) _entries.delete(ip);
  }
}

function check(ip) {
  if (!ip) return { allowed: true, count: 0 };
  const now = Date.now();
  _purge(now);
  const e = _entries.get(ip);
  if (!e) return { allowed: true, count: 0 };
  if (e.count < MAX_REQUESTS) return { allowed: true, count: e.count, retryAfterSec: 0 };
  const retryAfter = Math.max(1, Math.ceil((e.firstAt + WINDOW_MS - now) / 1000));
  return { allowed: false, count: e.count, retryAfterSec: retryAfter };
}

function record(ip) {
  if (!ip) return;
  const now = Date.now();
  _purge(now);
  const e = _entries.get(ip);
  if (!e) {
    _entries.set(ip, { count: 1, firstAt: now });
  } else {
    e.count += 1;
  }
}

function _resetAll() { _entries.clear(); }

module.exports = { check, record, _resetAll, WINDOW_MS, MAX_REQUESTS };
