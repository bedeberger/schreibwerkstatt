'use strict';

// Verdichtet einen Satz page_checks-Zeilen zu Fehler-Kennzahlen pro Modus
// (open/applied/all), aufgeschlüsselt nach Fehlertyp. Gemeinsame SSoT für den
// Snapshot-Capture (routes/snapshots.js), den Migrations-Backfill (db/migrations.js)
// und — implizit über den Fehlerdichte-Trend — die Fehler-Heatmap-Karte.
//
// Die Aggregationslogik spiegelt exakt die Live-Heatmap (routes/history.js
// #GET /fehler-heatmap): jüngster Check pro Seite liefert die offenen Findings,
// applied_errors_json wird über ALLE Checks der Seite vereinigt (angenommene
// Korrekturen sind kumulativ). Anders als die Heatmap aggregiert dieser Helper
// buchweit (kein user_email-Filter) — eine Fassung ist ein Buch-Meilenstein,
// nicht die Sicht eines einzelnen Users; in der Praxis (Einzelautor) deckt sich
// beides.
//
//   computeLektoratMetrics(pageCheckRows) → {
//     open:    { total, byTyp: { typ: count } },
//     applied: { total, byTyp },
//     all:     { total, byTyp },
//   }
//
// Erwartete Zeilen-Form: { page_id, checked_at, errors_json, applied_errors_json }.
// errors_json / applied_errors_json sind JSON-Strings (Array von Findings, jedes
// mit `typ` + `original`). Defekte/leere Felder werden als leer behandelt.

function _parseArr(s) {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

// Findings → { total, byTyp }. Nur Findings mit gesetztem `typ` zählen (wie die
// Heatmap-Totals); der Lektorat-Job filtert ohnehin auf VALID_TYPEN vor dem Write.
function _tally(findings) {
  const byTyp = {};
  let total = 0;
  for (const e of findings) {
    const typ = e?.typ;
    if (!typ) continue;
    byTyp[typ] = (byTyp[typ] || 0) + 1;
    total += 1;
  }
  return { total, byTyp };
}

function computeLektoratMetrics(pageCheckRows) {
  const rows = Array.isArray(pageCheckRows) ? pageCheckRows : [];

  // Jüngster Check pro Seite (checked_at ist ISO+Z → String-Vergleich ist chronologisch).
  const latestByPage = new Map();
  const appliedByPage = new Map(); // page_id → Map<original, finding>
  for (const r of rows) {
    const pid = r?.page_id;
    if (pid == null) continue;

    const prev = latestByPage.get(pid);
    if (!prev || String(r.checked_at || '') > String(prev.checked_at || '')) {
      latestByPage.set(pid, r);
    }

    let m = appliedByPage.get(pid);
    if (!m) { m = new Map(); appliedByPage.set(pid, m); }
    for (const e of _parseArr(r.applied_errors_json)) {
      if (e?.original && !m.has(e.original)) m.set(e.original, e);
    }
  }

  const openFindings = [];
  const appliedFindings = [];
  const allFindings = [];
  for (const [pid, latest] of latestByPage) {
    const errs = _parseArr(latest.errors_json);
    const appliedMap = appliedByPage.get(pid) || new Map();
    const appliedSet = new Set(appliedMap.keys());
    allFindings.push(...errs);
    appliedFindings.push(...appliedMap.values());
    for (const e of errs) {
      if (e?.original && appliedSet.has(e.original)) continue;
      openFindings.push(e);
    }
  }

  return {
    open: _tally(openFindings),
    applied: _tally(appliedFindings),
    all: _tally(allFindings),
  };
}

module.exports = { computeLektoratMetrics };
