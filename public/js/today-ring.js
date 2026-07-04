// Shared Math fuer Tages-Schreibziel.
// Konsumenten:
//   - Buch-Overview-Karte: overviewTodayRing (r=28) + _charsTodayDelta
//   - Header-Donut links neben Avatar: headerTodayRing (r=14)
//
// Live-Delta = Σ-chars aus tokEsts − letzter Snapshot strikt vor heute.
// Negativ wird auf 0 geklemmt (Lösch-Edits zählen nicht zurück). Fehlt
// einer der beiden Werte (z.B. neues Buch ohne Vortagssnapshot), wird 0
// geliefert — Donut bleibt leer statt falsch optimistisch zu fuellen.
import { aggregateLiveBookStats, localIsoDate, CHARS_PER_NORMSEITE } from './utils.js';

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

// Kalendertag `n` Tage vor `iso` — reine Kalenderarithmetik ueber einen
// UTC-Mittag-Anker, damit kein DST-/TZ-Drift entsteht. Der `iso`-Startpunkt
// kommt TZ-korrekt aus localIsoDate().
function isoMinusDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Kumulativ-Zeichen am letzten Snapshot <= iso (Snapshots sind kumulative
// Tagesstaende; fehlt ein Tag, gilt der letzte davor).
function cumOnOrBefore(sortedIsos, cumByIso, iso) {
  let val = null;
  for (const k of sortedIsos) { if (k <= iso) val = cumByIso.get(k); else break; }
  return val;
}

// Zeichen, die an einem Kalendertag geschrieben wurden: heute live (gleiche
// Quelle wie der Donut), sonst Snapshot-Delta gegen den Vortag.
function dayChars(iso, todayIso, sortedIsos, cumByIso, stats, tokEsts) {
  if (iso === todayIso) return computeCharsTodayDelta(stats, tokEsts);
  const cur = cumOnOrBefore(sortedIsos, cumByIso, iso);
  const prev = cumOnOrBefore(sortedIsos, cumByIso, isoMinusDays(iso, 1));
  if (cur == null || prev == null) return 0;
  return Math.max(0, cur - prev);
}

function buildCumMap(stats) {
  const cumByIso = new Map();
  for (const r of (Array.isArray(stats) ? stats : [])) {
    if (r?.recorded_at) cumByIso.set(r.recorded_at, Number(r.chars) || 0);
  }
  return { cumByIso, sortedIsos: [...cumByIso.keys()].sort() };
}

// Letzte `days` Kalendertage (aeltester zuerst) als Balken-Daten fuer das
// Header-Popover. Heute-Balken = Live-Delta, deckt sich mit dem Donut.
export function computeWeekBars({ stats = [], tokEsts = {}, days = 7, goalChars = CHARS_PER_NORMSEITE, todayIso = localIsoDate() } = {}) {
  const goal = Math.max(1, Number(goalChars) || CHARS_PER_NORMSEITE);
  const { cumByIso, sortedIsos } = buildCumMap(stats);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const iso = isoMinusDays(todayIso, i);
    const chars = dayChars(iso, todayIso, sortedIsos, cumByIso, stats, tokEsts);
    out.push({
      iso,
      chars,
      pct: Math.max(0, Math.min(100, Math.round((chars / goal) * 100))),
      reached: chars >= goal,
      isToday: iso === todayIso,
    });
  }
  return out;
}

// Aktuelle Schreib-Serie: aufeinanderfolgende Tage mit Zeichen > 0, rueckwaerts
// ab heute. Ist heute noch 0 geschrieben, bricht das die Serie nicht sofort
// (Kulanz) — gezaehlt wird dann ab gestern.
export function computeWritingStreak({ stats = [], tokEsts = {}, maxLookback = 400, todayIso = localIsoDate() } = {}) {
  const { cumByIso, sortedIsos } = buildCumMap(stats);
  const todayChars = dayChars(todayIso, todayIso, sortedIsos, cumByIso, stats, tokEsts);
  let streak = 0;
  for (let i = (todayChars === 0 ? 1 : 0); i < maxLookback; i++) {
    const iso = isoMinusDays(todayIso, i);
    if (dayChars(iso, todayIso, sortedIsos, cumByIso, stats, tokEsts) > 0) streak++;
    else break;
  }
  return streak;
}

// Donut-Geometrie + Flags. Caller waehlt Radius r (28 fuer Overview-Tile,
// 14 fuer Header-Donut).
export function computeTodayRing({ stats = [], tokEsts = {}, goalChars = CHARS_PER_NORMSEITE, r = 28 } = {}) {
  const goal = Math.max(1, Number(goalChars) || CHARS_PER_NORMSEITE);
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
