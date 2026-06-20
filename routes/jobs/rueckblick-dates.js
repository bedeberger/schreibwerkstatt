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

// Vorangegangener Zeitraum: Monats-Rückblick → Vor-Monat (Januar → Dezember des
// Vorjahres), Jahres-Rückblick → Vorjahr. Liefert denselben String-Typ wie der
// Input ('YYYY-MM' bzw. 'YYYY') oder null bei ungültigem Input.
function previousZeitraum(z) {
  const p = parseZeitraum(z);
  if (!p) return null;
  if (p.month != null) {
    let y = p.year, m = p.month - 1;
    if (m < 1) { m = 12; y -= 1; }
    return `${y}-${String(m).padStart(2, '0')}`;
  }
  return String(p.year - 1);
}

// Aggregiert datierte Seiten + vorhandene Rückblicke zu Monats-/Jahres-Buckets
// für die Overview-Heatmap. Pure (kein DB-State) — Datums-Parsing bleibt
// serverseitige SSoT, das Frontend bekommt fertige Buckets.
//   pages:  [{ page_name }]
//   rbRows: [{ zeitraum, id, created_at }]  (jüngster Rückblick je Zeitraum)
// minYear/maxYear spannen die Union aus Eintrags-Jahren UND Rückblick-Jahren,
// damit „verwaiste" Rückblicke (Einträge nachträglich gelöscht) sichtbar bleiben.
function buildRueckblickCoverage(pages, rbRows) {
  const months = {};
  const years = {};
  let minYear = null, maxYear = null;
  const ensureMonth = (k) => (months[k] || (months[k] = { entries: 0, rueckblick: null }));
  const ensureYear = (k) => (years[k] || (years[k] = { entries: 0, rueckblick: null }));
  const track = (y) => {
    if (minYear == null || y < minYear) minYear = y;
    if (maxYear == null || y > maxYear) maxYear = y;
  };
  for (const p of (pages || [])) {
    const ed = entryDate(p.page_name);
    if (!ed) continue;
    ensureYear(String(ed.year)).entries++;
    if (ed.monthKey) ensureMonth(ed.monthKey).entries++;
    track(ed.year);
  }
  for (const r of (rbRows || [])) {
    const z = String(r.zeitraum || '');
    const rb = { id: r.id, created_at: r.created_at };
    if (/^\d{4}-\d{2}$/.test(z)) {
      ensureMonth(z).rueckblick = rb;
      track(parseInt(z.slice(0, 4), 10));
    } else if (/^\d{4}$/.test(z)) {
      ensureYear(z).rueckblick = rb;
      track(parseInt(z, 10));
    }
  }
  return { months, years, minYear, maxYear };
}

module.exports = { parseZeitraum, entryDate, matchesZeitraum, previousZeitraum, buildRueckblickCoverage };
