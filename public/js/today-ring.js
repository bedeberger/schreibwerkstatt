// Shared Math fuer Tages-Schreibziel.
// Konsumenten:
//   - Buch-Overview-Karte: overviewTodayRing (r=28) + _charsTodayDelta
//   - Header-Donut links neben Avatar: headerTodayRing (r=14)
//
// Live-Delta = Σ-chars aus tokEsts − letzter Snapshot strikt vor heute.
// Negativ wird auf 0 geklemmt (Lösch-Edits zählen nicht zurück). Fehlt
// einer der beiden Werte (z.B. neues Buch ohne Vortagssnapshot), wird 0
// geliefert — Donut bleibt leer statt falsch optimistisch zu fuellen.
import { aggregateLiveBookStats, localIsoDate } from './utils.js';

// Reine Zahl: heute geschriebene Zeichen (Live-Σ minus Vortagssnapshot).
// Wird sowohl vom Donut als auch von 7-Tage-Bar/Total konsumiert, damit alle
// drei nie auseinander driften.
export function computeCharsTodayDelta(stats = [], tokEsts = {}) {
  const todayIso = localIsoDate();
  const liveChars = aggregateLiveBookStats(tokEsts).chars;
  let cronTodayChars = null;
  let prevChars = null;
  const a = Array.isArray(stats) ? stats : [];
  for (let i = a.length - 1; i >= 0; i--) {
    const row = a[i];
    if (!row?.recorded_at) continue;
    if (row.recorded_at === todayIso && cronTodayChars == null) {
      cronTodayChars = Number(row.chars) || 0;
      continue;
    }
    if (row.recorded_at < todayIso && prevChars == null) {
      prevChars = Number(row.chars) || 0;
      break;
    }
  }
  const curChars = liveChars > 0 ? liveChars : cronTodayChars;
  if (curChars == null || prevChars == null) return 0;
  return Math.max(0, curChars - prevChars);
}

// Donut-Geometrie + Flags. Caller waehlt Radius r (28 fuer Overview-Tile,
// 14 fuer Header-Donut).
export function computeTodayRing({ stats = [], tokEsts = {}, goalChars = 1500, r = 28 } = {}) {
  const goal = Math.max(1, Number(goalChars) || 1500);
  const chars = computeCharsTodayDelta(stats, tokEsts);
  const pct = Math.max(0, Math.min(100, Math.round((chars / goal) * 100)));
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  const gap = circ - dash;
  return {
    chars,
    goal,
    pct,
    r,
    c: circ,
    dash,
    gap,
    reached: chars >= goal,
    active: chars > 0,
  };
}
