'use strict';
// Server-Helper für lokale Datums-Strings (YYYY-MM-DD).
// `new Date().toISOString().slice(0,10)` ist UTC und kann in CEST/CET um 1
// Tag verschoben sein (lokal Mitternacht = UTC vor-22:00). Bug-Symptom:
// heutige Schreibzeichen landen im Streak-Grid auf dem Vortag, weil Server
// und Frontend auf unterschiedliche Datums-Strings mappen.
//
// TZ kommt aus app_settings (`app.timezone`). Single Source of Truth — derselbe
// Wert treibt node-cron in server.js und Frontend-Display-Formatter.
// Lazy require fuer den Settings-Lookup vermeidet Boot-Reihenfolge-Bruch
// (lib/local-date.js wird sehr frueh geladen).

const FALLBACK_TZ = 'Europe/Zurich';

function currentTz() {
  try {
    const appSettings = require('./app-settings');
    return appSettings.get('app.timezone') || FALLBACK_TZ;
  } catch (_) {
    return FALLBACK_TZ;
  }
}

/**
 * Lokales ISO-Datum (YYYY-MM-DD). 'en-CA'-Locale liefert das ISO-Format
 * unabhängig von der System-Locale. timeZone respektiert app.timezone.
 */
function localIsoDate(d = new Date(), tz = currentTz()) {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

/**
 * Lokales ISO-Datum n Tage in der Vergangenheit. Mittag-Anker statt Mitternacht
 * macht ±n*86_400_000 DST-Drift-sicher (an Umstellungs-Tagen kann ein 24-h-Step
 * sonst dieselbe Datums-Seite zweimal treffen).
 */
function localIsoDaysAgo(n, base = new Date(), tz = currentTz()) {
  const noon = new Date(base);
  noon.setHours(12, 0, 0, 0);
  noon.setDate(noon.getDate() - n);
  return localIsoDate(noon, tz);
}

module.exports = { localIsoDate, localIsoDaysAgo, currentTz };
