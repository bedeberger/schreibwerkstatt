'use strict';
// Server-Helper für lokale Datums-Strings (YYYY-MM-DD).
// `new Date().toISOString().slice(0,10)` ist UTC und kann in CEST/CET um 1
// Tag verschoben sein (lokal Mitternacht = UTC vor-22:00). Bug-Symptom:
// heutige Schreibzeichen landen im Streak-Grid auf dem Vortag, weil Server
// und Frontend auf unterschiedliche Datums-Strings mappen.
//
// TZ wird aus process.env.TZ gelesen (Docker setzt das via compose-env).
// Fallback Europe/Zurich passt zum primären User-Setup. Bei Multi-User-TZ
// müsste pro Request konfiguriert werden — aktuell single-TZ.

const DEFAULT_TZ = process.env.TZ || 'Europe/Zurich';

/**
 * Lokales ISO-Datum (YYYY-MM-DD). 'en-CA'-Locale liefert das ISO-Format
 * unabhängig von der System-Locale. timeZone respektiert process.env.TZ.
 */
function localIsoDate(d = new Date(), tz = DEFAULT_TZ) {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

/**
 * Lokales ISO-Datum n Tage in der Vergangenheit. Mittag-Anker statt Mitternacht
 * macht ±n*86_400_000 DST-Drift-sicher (an Umstellungs-Tagen kann ein 24-h-Step
 * sonst dieselbe Datums-Seite zweimal treffen).
 */
function localIsoDaysAgo(n, base = new Date(), tz = DEFAULT_TZ) {
  const noon = new Date(base);
  noon.setHours(12, 0, 0, 0);
  noon.setDate(noon.getDate() - n);
  return localIsoDate(noon, tz);
}

module.exports = { localIsoDate, localIsoDaysAgo, DEFAULT_TZ };
