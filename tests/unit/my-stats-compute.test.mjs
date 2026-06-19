// Tests fuer die pure Compute-Funktionen von „Meine Statistik".
// Quelle ist die writing-Zeitreihe (Rows { book_id, date, seconds }).
import test from 'node:test';
import assert from 'node:assert/strict';

// utils/date.js liest window.__app fuer Timezone — minimal stubben.
globalThis.window = { __app: { uiLocale: 'de' } };

const { computeWritingStreak, computeWeekdayPattern, computeDerived, computeMilestones, secondsByDate } =
  await import('../../public/js/cards/my-stats-compute.js');

import { localIsoDaysAgo } from '../../public/js/utils.js';
const isoDaysAgo = (n) => localIsoDaysAgo(n);

test('secondsByDate summiert mehrere Buecher pro Tag', () => {
  const rows = [
    { book_id: 1, date: '2026-06-01', seconds: 600 },
    { book_id: 2, date: '2026-06-01', seconds: 300 },
    { book_id: 1, date: '2026-06-02', seconds: 120 },
  ];
  const m = secondsByDate(rows);
  assert.equal(m.get('2026-06-01'), 900);
  assert.equal(m.get('2026-06-02'), 120);
});

test('computeWritingStreak: aktuelle Serie endet heute', () => {
  const rows = [
    { book_id: 1, date: isoDaysAgo(0), seconds: 600 },
    { book_id: 1, date: isoDaysAgo(1), seconds: 600 },
    { book_id: 1, date: isoDaysAgo(2), seconds: 600 },
  ];
  const r = computeWritingStreak(rows);
  assert.equal(r.currentStreak, 3);
  assert.equal(r.longestStreak, 3);
  assert.equal(r.totalActiveDays, 3);
  assert.equal(r.weeksCount, 52);
  assert.equal(r.weeks.length, 52);
});

test('computeWritingStreak: heute offen bricht die Serie nicht', () => {
  const rows = [
    { book_id: 1, date: isoDaysAgo(1), seconds: 600 },
    { book_id: 1, date: isoDaysAgo(2), seconds: 600 },
  ];
  const r = computeWritingStreak(rows);
  assert.equal(r.currentStreak, 2, 'gestern + vorgestern zaehlen, heute leer unschaedlich');
});

test('computeWritingStreak: Luecke bricht die aktuelle Serie', () => {
  const rows = [
    { book_id: 1, date: isoDaysAgo(0), seconds: 600 },
    // Luecke bei isoDaysAgo(1)
    { book_id: 1, date: isoDaysAgo(2), seconds: 600 },
    { book_id: 1, date: isoDaysAgo(3), seconds: 600 },
  ];
  const r = computeWritingStreak(rows);
  assert.equal(r.currentStreak, 1);
  assert.equal(r.longestStreak, 2);
  assert.equal(r.totalActiveDays, 3);
});

test('computeWritingStreak: leere Eingabe → alles 0', () => {
  const r = computeWritingStreak([]);
  assert.equal(r.currentStreak, 0);
  assert.equal(r.longestStreak, 0);
  assert.equal(r.totalActiveDays, 0);
});

test('computeWeekdayPattern: 7 Eintraege Mo..So, pct relativ zum Max', () => {
  // 2026-06-01 ist ein Montag.
  const rows = [
    { book_id: 1, date: '2026-06-01', seconds: 3600 }, // Mo
    { book_id: 1, date: '2026-06-03', seconds: 1800 }, // Mi
  ];
  const wd = computeWeekdayPattern(rows);
  assert.equal(wd.length, 7);
  assert.equal(wd[0].minutes, 60, 'Mo = 60 min');
  assert.equal(wd[0].pct, 100, 'Mo ist Maximum');
  assert.equal(wd[2].minutes, 30, 'Mi = 30 min');
  assert.equal(wd[2].pct, 50);
  assert.equal(wd[1].minutes, 0, 'Di leer');
});

test('computeDerived: Tagesschnitt, bester Tag, Tempo', () => {
  const data = { chars: 36000, writing_seconds: 7200 }; // 2 h reine Schreibzeit
  const rows = [
    { book_id: 1, date: '2026-06-01', seconds: 5400 }, // 90 min — bester Tag
    { book_id: 1, date: '2026-06-02', seconds: 1800 }, // 30 min
  ];
  const d = computeDerived(data, rows);
  assert.equal(d.activeDays, 2);
  assert.equal(d.dailyAvgMin, 60, '(90+30)/2');
  assert.equal(d.bestDayMin, 90);
  assert.equal(d.bestDayDate, '2026-06-01');
  assert.equal(d.paceCharsPerHour, 18000, '36000 / 2h');
});

test('computeDerived: ohne Schreibzeit kein Tempo (keine Division durch 0)', () => {
  const d = computeDerived({ chars: 1000, writing_seconds: 0 }, []);
  assert.equal(d.paceCharsPerHour, 0);
  assert.equal(d.dailyAvgMin, 0);
});

test('computeMilestones: hoechste erreichte Stufe je Kategorie + naechstes Ziel', () => {
  const data = { chars: 120000, words: 12000, books: 2 };
  const derived = { activeDays: 35 };
  const m = computeMilestones(data, derived);
  const byCat = Object.fromEntries(m.achieved.map(a => [a.category, a.target]));
  assert.equal(byCat.chars, 100000);
  assert.equal(byCat.words, 10000);
  assert.equal(byCat.activeDays, 30);
  assert.equal(byCat.books, 1);
  assert.ok(m.next, 'es gibt ein naechstes Ziel');
  assert.ok(m.next.progress >= 0 && m.next.progress <= 100);
});

test('computeMilestones: nichts erreicht → leere Badges, aber naechstes Ziel', () => {
  const m = computeMilestones({ chars: 0, words: 0, books: 0 }, { activeDays: 0 });
  assert.equal(m.achieved.length, 0);
  assert.ok(m.next);
});
