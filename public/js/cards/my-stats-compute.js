// Pure Compute-Funktionen fuer „Meine Statistik" (my-stats-card.js).
// Bewusst frei von Alpine/DOM → unit-testbar (tests/unit/my-stats-compute.test.mjs).
// Quelle ist die Schreibzeit-Zeitreihe `writing` aus /me/profile-stats-history:
// Rows { book_id, date (YYYY-MM-DD), seconds }, ggf. mehrere Buecher pro Tag.

import { localIsoDate, localIsoDaysAgo } from '../utils.js';

const WEEKS = 52;

// Schreib-Sekunden pro Tag ueber alle Buecher summieren → Map(date → seconds).
export function secondsByDate(writingRows) {
  const m = new Map();
  for (const r of (writingRows || [])) {
    const d = r.date;
    if (!d) continue;
    m.set(d, (m.get(d) || 0) + (Number(r.seconds) || 0));
  }
  return m;
}

// Streak-Heatmap (52 Wochen × 7 Tage, GitHub-Stil) auf Basis aktiver Schreibtage
// (seconds > 0). Aktueller Streak: konsekutive aktive Tage endend HEUTE oder
// GESTERN (heute ohne Eintrag bricht NICHT — noch nicht geschrieben).
export function computeWritingStreak(writingRows, todayLocal = new Date()) {
  const secByDate = secondsByDate(writingRows);

  const today = new Date(todayLocal);
  today.setHours(12, 0, 0, 0); // Mittag → DST-Drift-sicher beim ±n*86_400_000
  const todayDow = today.getDay();        // 0 = So ... 6 = Sa
  const dowMon = (todayDow + 6) % 7;      // Mo=0 ... So=6
  const startOffset = (WEEKS - 1) * 7 + dowMon;
  const isoToday = localIsoDate(today);

  const grid = [];                        // weeks[col][row], Mo oben
  for (let w = 0; w < WEEKS; w++) grid.push([null, null, null, null, null, null, null]);

  const positive = [];
  for (let i = 0; i < WEEKS * 7; i++) {
    const col = Math.floor(i / 7);
    const row = i % 7;
    const offsetDays = ((WEEKS - 1) - col) * 7 + (dowMon - row);
    if (offsetDays < 0) {
      grid[col][row] = { iso: null, seconds: null, minutes: null, level: 0, future: true };
      continue;
    }
    const iso = localIsoDaysAgo(offsetDays, today);
    const sec = secByDate.get(iso) || 0;
    const cell = {
      iso,
      seconds: sec,
      minutes: Math.round(sec / 60),
      level: 0,
      future: false,
      active: sec > 0,
    };
    if (sec > 0) positive.push(sec);
    grid[col][row] = cell;
  }

  // Quartil-Bucketing Level 1..4 auf positiven Sekunden.
  const sorted = [...positive].sort((a, b) => a - b);
  const q = (p) => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  for (let w = 0; w < WEEKS; w++) {
    for (let r = 0; r < 7; r++) {
      const c = grid[w][r];
      if (!c || !c.active) continue;
      if (c.seconds <= t1) c.level = 1;
      else if (c.seconds <= t2) c.level = 2;
      else if (c.seconds <= t3) c.level = 3;
      else c.level = 4;
    }
  }

  // Lineare Tagesreihe (aelteste links) fuer Streak-Zaehlung.
  const linear = [];
  for (let off = startOffset; off >= 0; off--) {
    const iso = localIsoDaysAgo(off, today);
    linear.push({ iso, active: (secByDate.get(iso) || 0) > 0 });
  }

  let longest = 0, run = 0;
  for (const x of linear) {
    if (x.active) { run++; if (run > longest) longest = run; }
    else run = 0;
  }
  let current = 0;
  for (let i = linear.length - 1; i >= 0; i--) {
    const x = linear[i];
    if (i === linear.length - 1 && !x.active && x.iso === isoToday) continue; // heute noch offen
    if (x.active) current++;
    else break;
  }
  const totalActiveDays = linear.filter(x => x.active).length;

  return { weeks: grid, weeksCount: WEEKS, currentStreak: current, longestStreak: longest, totalActiveDays };
}

// Wochentags-Muster: Summe Schreibminuten je Wochentag (Mo..So).
// pct = Anteil am Maximum (fuer Balkenhoehe). days = Anzahl aktiver Tage je Dow.
export function computeWeekdayPattern(writingRows) {
  const secByDate = secondsByDate(writingRows);
  const sec = [0, 0, 0, 0, 0, 0, 0];   // Index 0 = Mo ... 6 = So
  const days = [0, 0, 0, 0, 0, 0, 0];
  for (const [iso, s] of secByDate) {
    if (s <= 0) continue;
    const dow = new Date(iso + 'T12:00:00').getDay(); // 0=So..6=Sa
    const idx = (dow + 6) % 7;                          // → Mo=0..So=6
    sec[idx] += s;
    days[idx] += 1;
  }
  const minutes = sec.map(s => Math.round(s / 60));
  const max = Math.max(1, ...minutes);
  return minutes.map((m, i) => ({
    dow: i,
    minutes: m,
    days: days[i],
    pct: Math.round((m / max) * 100),
  }));
}

// Abgeleitete Kennzahlen: Tagesschnitt, bester Tag, Schreibtempo.
export function computeDerived(data, writingRows) {
  const secByDate = secondsByDate(writingRows);
  let activeDays = 0, bestSec = 0, bestDate = null, totalSec = 0;
  for (const [iso, s] of secByDate) {
    if (s <= 0) continue;
    activeDays += 1;
    totalSec += s;
    if (s > bestSec) { bestSec = s; bestDate = iso; }
  }
  const writingSeconds = Number(data?.writing_seconds) || 0;
  const chars = Number(data?.chars) || 0;
  return {
    activeDays,
    dailyAvgMin: activeDays > 0 ? Math.round((totalSec / 60) / activeDays) : 0,
    bestDayMin:  Math.round(bestSec / 60),
    bestDayDate: bestDate,
    // Schreibtempo: Zeichen pro Stunde reiner Schreibzeit (gesamt, nicht pro Tag).
    paceCharsPerHour: writingSeconds > 0 ? Math.round(chars / (writingSeconds / 3600)) : 0,
  };
}

// Meilenstein-Stufen pro Kategorie. Achieved = hoechste erreichte Stufe je
// Kategorie (ein Badge). Next = die naechste unerreichte Stufe insgesamt mit
// kleinstem relativem Abstand (Fortschrittsbalken).
const MILESTONE_TIERS = {
  chars:      [50000, 100000, 250000, 500000, 1000000],
  words:      [10000, 25000, 50000, 100000, 250000],
  activeDays: [10, 30, 100, 365],
  books:      [1, 3, 5, 10],
};

export function computeMilestones(data, derived) {
  const values = {
    chars:      Number(data?.chars) || 0,
    words:      Number(data?.words) || 0,
    activeDays: Number(derived?.activeDays) || 0,
    books:      Number(data?.books) || 0,
  };
  const achieved = [];
  let next = null; // { category, target, value, progress }
  for (const [cat, tiers] of Object.entries(MILESTONE_TIERS)) {
    const v = values[cat];
    let top = null, upcoming = null;
    for (const t of tiers) {
      if (v >= t) top = t;
      else { upcoming = t; break; }
    }
    if (top != null) achieved.push({ category: cat, target: top });
    if (upcoming != null) {
      const progress = Math.min(100, Math.round((v / upcoming) * 100));
      if (!next || progress > next.progress) next = { category: cat, target: upcoming, value: v, progress };
    }
  }
  return { achieved, next };
}
