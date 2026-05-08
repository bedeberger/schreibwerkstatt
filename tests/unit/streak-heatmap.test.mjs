// Tests für Streak-Heatmap und Heute-Ring (book-overview.js).
// Methoden lesen this.overviewStats; wir bauen ein synthetisches Stats-Array
// mit definierten Tages-Snapshots (recorded_at = ISO-Datum, chars = kumuliert).
import test from 'node:test';
import assert from 'node:assert/strict';

// book-overview.js liest window.__app?.uiLocale für Wochentag-Labels.
// In Node ohne DOM stubben wir window minimal vor dem Import.
globalThis.window = { __app: { uiLocale: 'de' } };

const { bookOverviewMethods } = await import('../../public/js/book-overview.js');

function isoDaysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function makeCtx(stats = [], tokEsts = null) {
  // tokEsts auf window.__app spiegeln, damit overviewTodayRing den Live-Pfad sieht
  if (tokEsts !== null) globalThis.window.__app.tokEsts = tokEsts;
  else globalThis.window.__app.tokEsts = {};
  return {
    overviewStats: stats,
    _memos: {},
    _memo: bookOverviewMethods._memo,
    _memoN: bookOverviewMethods._memoN,
    overviewStreakHeatmap: bookOverviewMethods.overviewStreakHeatmap,
    overviewTodayRing: bookOverviewMethods.overviewTodayRing,
  };
}

test('overviewStreakHeatmap: leere Daten → Streak 0', () => {
  const ctx = makeCtx([]);
  const out = ctx.overviewStreakHeatmap();
  assert.equal(out.currentStreak, 0);
  assert.equal(out.longestStreak, 0);
  assert.equal(out.totalActiveDays, 0);
  assert.equal(out.weeks.length, 53);
});

test('overviewStreakHeatmap: drei aufeinanderfolgende Tage mit Wachstum → currentStreak 3', () => {
  // gestern, vorgestern, vor-vorgestern jeweils +500 Zeichen vs Vortag
  const stats = [
    { recorded_at: isoDaysAgo(4), chars: 1000 },
    { recorded_at: isoDaysAgo(3), chars: 1500 },
    { recorded_at: isoDaysAgo(2), chars: 2000 },
    { recorded_at: isoDaysAgo(1), chars: 2500 },
  ];
  const ctx = makeCtx(stats);
  const out = ctx.overviewStreakHeatmap();
  assert.ok(out.currentStreak >= 3, `currentStreak = ${out.currentStreak}`);
  assert.ok(out.totalActiveDays >= 3);
});

test('overviewStreakHeatmap: Lücke zwischen Schreibtagen bricht aktuellen Streak', () => {
  // Vor 5 Tagen, vor 4 Tagen geschrieben; vor 3 + 2 + 1 nichts mehr.
  const stats = [
    { recorded_at: isoDaysAgo(6), chars: 1000 },
    { recorded_at: isoDaysAgo(5), chars: 1500 },
    { recorded_at: isoDaysAgo(4), chars: 2000 },
    { recorded_at: isoDaysAgo(3), chars: 2000 },
    { recorded_at: isoDaysAgo(2), chars: 2000 },
    { recorded_at: isoDaysAgo(1), chars: 2000 },
  ];
  const ctx = makeCtx(stats);
  const out = ctx.overviewStreakHeatmap();
  assert.equal(out.currentStreak, 0, 'aktueller Streak gebrochen');
  assert.ok(out.longestStreak >= 2, 'longest dokumentiert die früheren 2 Tage');
});

test('overviewStreakHeatmap: Levels 1..4 nach Quartilen', () => {
  // Sechs Tage mit unterschiedlich grossen Deltas
  const stats = [
    { recorded_at: isoDaysAgo(7), chars: 0 },
    { recorded_at: isoDaysAgo(6), chars: 100 },
    { recorded_at: isoDaysAgo(5), chars: 300 },
    { recorded_at: isoDaysAgo(4), chars: 700 },
    { recorded_at: isoDaysAgo(3), chars: 1500 },
    { recorded_at: isoDaysAgo(2), chars: 3000 },
    { recorded_at: isoDaysAgo(1), chars: 6000 },
  ];
  const ctx = makeCtx(stats);
  const out = ctx.overviewStreakHeatmap();
  // Mindestens drei verschiedene Levels in den Cells
  const levels = new Set();
  for (const w of out.weeks) for (const c of w) if (c && c.level > 0) levels.add(c.level);
  assert.ok(levels.size >= 3, `nur ${levels.size} Levels gefunden: ${[...levels]}`);
});

test('overviewTodayRing: kein Snapshot, keine tokEsts → 0 chars, 0 pct', () => {
  const ctx = makeCtx([], {});
  const r = ctx.overviewTodayRing(1500);
  assert.equal(r.chars, 0);
  assert.equal(r.pct, 0);
  assert.equal(r.active, false);
});

test('overviewTodayRing: heute +500 (cron-Snapshot) / Ziel 1500 → ~33%', () => {
  // tokEsts leer → fallback auf Cron-Snapshot
  const stats = [
    { recorded_at: isoDaysAgo(1), chars: 1000 },
    { recorded_at: isoDaysAgo(0), chars: 1500 },
  ];
  const ctx = makeCtx(stats, {});
  const r = ctx.overviewTodayRing(1500);
  assert.equal(r.chars, 500);
  assert.equal(r.pct, 33);
  assert.equal(r.active, true);
  assert.equal(r.reached, false);
});

test('overviewTodayRing: Ziel überschritten → pct gekappt auf 100, reached=true', () => {
  const stats = [
    { recorded_at: isoDaysAgo(1), chars: 1000 },
    { recorded_at: isoDaysAgo(0), chars: 5000 },
  ];
  const ctx = makeCtx(stats, {});
  const r = ctx.overviewTodayRing(1500);
  assert.equal(r.pct, 100);
  assert.equal(r.reached, true);
});

test('overviewTodayRing: Lösch-Edits (negative Delta) → 0 chars, nicht aktiv', () => {
  const stats = [
    { recorded_at: isoDaysAgo(1), chars: 5000 },
    { recorded_at: isoDaysAgo(0), chars: 4000 },
  ];
  const ctx = makeCtx(stats, {});
  const r = ctx.overviewTodayRing(1500);
  assert.equal(r.chars, 0);
  assert.equal(r.active, false);
});

test('overviewTodayRing: Lücke (gestern fehlt) → Fallback auf vor-vorgestern', () => {
  // Bug-Fix-Sentinel: User schrieb gestern nicht, heute synced → vor-2-Tagen
  // ist jüngster prior Snapshot. Vorher zählte das als „erste Messung" → 0.
  const stats = [
    { recorded_at: isoDaysAgo(2), chars: 1000 },
    { recorded_at: isoDaysAgo(0), chars: 1750 },
  ];
  const ctx = makeCtx(stats, {});
  const r = ctx.overviewTodayRing(1500);
  assert.equal(r.chars, 750);
  assert.equal(r.active, true);
});

test('overviewTodayRing: Live-tokEsts überschreiben Cron-Snapshot', () => {
  // Cron-Snapshot heute = 1500, Live-tokEsts addieren 800 mehr drauf →
  // Frontend zeigt sofort Delta vom prior Snapshot zu Live-Stand.
  const stats = [
    { recorded_at: isoDaysAgo(1), chars: 1000 },
    { recorded_at: isoDaysAgo(0), chars: 1500 },
  ];
  const tokEsts = { 1: { chars: 1500 }, 2: { chars: 800 } };
  const ctx = makeCtx(stats, tokEsts);
  const r = ctx.overviewTodayRing(1500);
  assert.equal(r.chars, 1300); // 2300 (live) - 1000 (gestern)
  assert.equal(r.active, true);
});

test('overviewTodayRing: nur Live-tokEsts, kein Snapshot → 0 (kein Vergleich möglich)', () => {
  // Erstaufruf vor erstem Sync: tokEsts vorhanden, history leer.
  // Cumulative-Stand wäre falsche Anzeige, daher 0.
  const tokEsts = { 1: { chars: 5000 } };
  const ctx = makeCtx([], tokEsts);
  const r = ctx.overviewTodayRing(1500);
  assert.equal(r.chars, 0);
  assert.equal(r.active, false);
});

test('overviewTodayRing: nur prior Snapshot, kein heute, kein Live → 0', () => {
  const stats = [{ recorded_at: isoDaysAgo(3), chars: 1000 }];
  const ctx = makeCtx(stats, {});
  const r = ctx.overviewTodayRing(1500);
  assert.equal(r.chars, 0);
  assert.equal(r.active, false);
});

test('overviewTodayRing: SVG-Math konsistent (dash + gap = circumference)', () => {
  const ctx = makeCtx([]);
  const r = ctx.overviewTodayRing(1500);
  const sum = r.dash + r.gap;
  assert.ok(Math.abs(sum - r.c) < 0.001, `dash+gap=${sum}, c=${r.c}`);
});
