'use strict';
// Pure Datums-Helfer für den Tagebuch-Rückblick. Hängt nur an lib/datum-parse
// (kein DB-/AI-State) — separat für Unit-Tests ohne Bootstrap.

const { parseDatum } = require('../../lib/datum-parse');

// Zeitraum 'YYYY' oder 'YYYY-MM' → { year, month|null }. Ungültig → null.
function parseZeitraum(z) {
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(String(z || '').trim());
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = m[2] ? parseInt(m[2], 10) : null;
  if (month != null && (month < 1 || month > 12)) return null;
  return { year, month };
}

// Datiert eine Seite anhand ihres Namens (page_name = 'YYYY-MM-DD' bei
// Tagebüchern, parseDatum als Fallback). Liefert { iso, year, month, monthKey }
// oder null, wenn kein Jahr ableitbar.
function entryDate(name) {
  const d = parseDatum(name);
  if (!d || d.year == null) return null;
  const year = d.year;
  const month = d.month || null;
  const day = d.day || null;
  const mm = month != null ? String(month).padStart(2, '0') : null;
  const dd = day != null ? String(day).padStart(2, '0') : null;
  const iso = dd ? `${year}-${mm}-${dd}` : (mm ? `${year}-${mm}` : String(year));
  return { iso, year, month, monthKey: mm ? `${year}-${mm}` : null };
}

// Trifft ein datierter Eintrag den Zeitraum? Bei Monats-Zeitraum muss der Monat
// passen; bei Jahres-Zeitraum genügt das Jahr.
function matchesZeitraum(ed, z) {
  if (!ed || !z) return false;
  if (ed.year !== z.year) return false;
  if (z.month != null) return ed.month === z.month;
  return true;
}

module.exports = { parseZeitraum, entryDate, matchesZeitraum };
