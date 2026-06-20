'use strict';
// In-Memory-Rate-Limit fuer POST /auth/admin-login. max_fails Fehlversuche pro IP
// pro Zeitfenster → 429 mit `Retry-After`-Header bis zum Ende des Sperr-Fensters.
// Limit + Fenster sind live aus app_settings konfigurierbar
// (auth.admin_login.max_fails / .window_min).
//
// Eigene Implementation statt express-rate-limit-Dep — Self-Hosted-OSS-Pattern
// (Memory ist Sache des Betreibers, kein Reverse-Proxy noetig). In-Memory ist
// ok: Brute-Force auf einen einzelnen Admin-Account, der ohnehin nur lokal
// existiert; bei Server-Restart faellt der Zaehler weg, aber Angreifer
// braucht sowieso Sekunden pro Anfrage → kein realer Schutzverlust.

const appSettings = require('./app-settings');

const _entries = new Map(); // ip → { failCount, firstFailAt, blockedUntil }

function _windowMs() {
  return (appSettings.get('auth.admin_login.window_min') || 15) * 60 * 1000;
}
function _maxFails() {
  return appSettings.get('auth.admin_login.max_fails') || 5;
}

function _purgeExpired(nowMs) {
  const windowMs = _windowMs();
  for (const [ip, e] of _entries) {
    const expiredBlock = e.blockedUntil && e.blockedUntil <= nowMs;
    const expiredWindow = !e.blockedUntil && e.firstFailAt + windowMs <= nowMs;
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
  const windowMs = _windowMs();
  let e = _entries.get(ip);
  if (!e) {
    e = { failCount: 1, firstFailAt: now, blockedUntil: null };
    _entries.set(ip, e);
  } else {
    if (e.firstFailAt + windowMs <= now) {
      e.failCount = 1;
      e.firstFailAt = now;
      e.blockedUntil = null;
    } else {
      e.failCount += 1;
    }
  }
  if (e.failCount >= _maxFails()) {
    e.blockedUntil = now + windowMs;
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

module.exports = { getState, recordFailure, recordSuccess, _resetAll };
