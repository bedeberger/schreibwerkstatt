'use strict';
// In-Memory-Rate-Limit fuer POST /register.
// max Anfragen pro IP pro Zeitfenster — schuetzt vor Spam-Anmeldungen via
// oeffentliches Register-Formular. Self-Hosted-Pattern (kein Reverse-Proxy
// noetig); In-Memory ist ok, weil Restart-Reset bei niedrigem Risiko OK ist.
// Limit + Fenster sind live aus app_settings konfigurierbar
// (auth.register.rate_limit_max / .rate_limit_window_min).

const appSettings = require('./app-settings');

const _entries = new Map(); // ip → { count, firstAt }

function _windowMs() {
  return (appSettings.get('auth.register.rate_limit_window_min') || 60) * 60 * 1000;
}
function _maxRequests() {
  return appSettings.get('auth.register.rate_limit_max') || 3;
}

function _purge(now) {
  const windowMs = _windowMs();
  for (const [ip, e] of _entries) {
    if (e.firstAt + windowMs <= now) _entries.delete(ip);
  }
}

function check(ip) {
  if (!ip) return { allowed: true, count: 0 };
  const now = Date.now();
  _purge(now);
  const e = _entries.get(ip);
  if (!e) return { allowed: true, count: 0 };
  if (e.count < _maxRequests()) return { allowed: true, count: e.count, retryAfterSec: 0 };
  const retryAfter = Math.max(1, Math.ceil((e.firstAt + _windowMs() - now) / 1000));
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

module.exports = { check, record, _resetAll };
