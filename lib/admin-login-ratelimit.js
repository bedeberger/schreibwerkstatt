'use strict';
// Phase 4a (BookStack-Exit, docs/bookstack-exit.md): In-Memory-Rate-Limit
// fuer POST /auth/admin-login. 5 Fehlversuche pro IP pro 15 min → 429 mit
// `Retry-After`-Header bis zum Ende des Sperr-Fensters.
//
// Eigene Implementation statt express-rate-limit-Dep — Self-Hosted-OSS-Pattern
// (Memory ist Sache des Betreibers, kein Reverse-Proxy noetig). In-Memory ist
// ok: Brute-Force auf einen einzelnen Admin-Account, der ohnehin nur lokal
// existiert; bei Server-Restart faellt der Zaehler weg, aber Angreifer
// braucht sowieso Sekunden pro Anfrage → kein realer Schutzverlust.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const _entries = new Map(); // ip → { failCount, firstFailAt, blockedUntil }

function _purgeExpired(nowMs) {
  for (const [ip, e] of _entries) {
    const expiredBlock = e.blockedUntil && e.blockedUntil <= nowMs;
    const expiredWindow = !e.blockedUntil && e.firstFailAt + WINDOW_MS <= nowMs;
    if (expiredBlock || expiredWindow) _entries.delete(ip);
  }
}

function getState(ip) {
  if (!ip) return { blocked: false };
  const now = Date.now();
  const e = _entries.get(ip);
  if (!e) return { blocked: false, failCount: 0 };
  if (e.blockedUntil && e.blockedUntil > now) {
    return { blocked: true, retryAfterSec: Math.ceil((e.blockedUntil - now) / 1000), failCount: e.failCount };
  }
  if (e.blockedUntil && e.blockedUntil <= now) {
    _entries.delete(ip);
    return { blocked: false, failCount: 0 };
  }
  return { blocked: false, failCount: e.failCount || 0 };
}

function recordFailure(ip) {
  if (!ip) return getState(null);
  const now = Date.now();
  _purgeExpired(now);
  let e = _entries.get(ip);
  if (!e) {
    e = { failCount: 1, firstFailAt: now, blockedUntil: null };
    _entries.set(ip, e);
  } else {
    if (e.firstFailAt + WINDOW_MS <= now) {
      e.failCount = 1;
      e.firstFailAt = now;
      e.blockedUntil = null;
    } else {
      e.failCount += 1;
    }
  }
  if (e.failCount >= MAX_FAILS) {
    e.blockedUntil = now + WINDOW_MS;
  }
  return getState(ip);
}

function recordSuccess(ip) {
  if (ip) _entries.delete(ip);
}

// Nur fuer Tests: kompletten State leeren.
function _resetAll() {
  _entries.clear();
}

module.exports = { getState, recordFailure, recordSuccess, _resetAll, WINDOW_MS, MAX_FAILS };
