// Tests für die Tagebuch-Tiles (book-overview/diary.js): Lücken & Konsistenz
// + Wochentag-Rhythmus. Compute-Bodies sind pure (kein `this`, kein Alpine) —
// direkt gegen synthetische Datums-/tokEsts-Sets prüfbar.
import test from 'node:test';
import assert from 'node:assert/strict';

// diary.js liest window.__app?.uiLocale; minimal stubben vor Import.
globalThis.window = { __app: { uiLocale: 'de' } };

const { bookOverviewMethods: M } = await import('../../public/js/book-overview.js');

test('_diaryEntryDates: dedupliziert auf Tagesebene + sortiert', () => {
  const pages = [
    { id: 1, name: '2024-03-02' },
    { id: 2, name: '2024-03-01 Notiz' },
    { id: 3, name: '2024-03-02 zweiter Eintrag' }, // Tages-Duplikat
    { id: 4, name: 'Kapitel 1' },                  // nicht datiert
  ];
  assert.deepEqual(M._diaryEntryDates(pages), ['2024-03-01', '2024-03-02']);
});

test('_computeDiaryGapsConsistency: leeres Set', () => {
  const r = M._computeDiaryGapsConsistency([], '2024-03-10');
  assert.equal(r.daysSinceLast, null);
  assert.equal(r.longestGap, 0);
  assert.equal(r.currentStreak, 0);
  assert.equal(r.entriesThisMonth, 0);
  assert.equal(r.entriesPrevMonth, 0);
});

test('_computeDiaryGapsConsistency: einzelner Eintrag heute', () => {
  const r = M._computeDiaryGapsConsistency(['2024-03-10'], '2024-03-10');
  assert.equal(r.daysSinceLast, 0);
  assert.equal(r.currentStreak, 1);
  assert.equal(r.longestGap, 0);
  assert.equal(r.entriesThisMonth, 1);
});

test('_computeDiaryGapsConsistency: Streak über Monatsgrenze (Schaltjahr)', () => {
  const dates = ['2024-02-29', '2024-03-01', '2024-03-02'];
  const r = M._computeDiaryGapsConsistency(dates, '2024-03-02');
  assert.equal(r.currentStreak, 3);
  assert.equal(r.daysSinceLast, 0);
  assert.equal(r.longestGap, 1);
});

test('_computeDiaryGapsConsistency: Streak endet gestern (heute noch nichts)', () => {
  const r = M._computeDiaryGapsConsistency(['2024-03-08', '2024-03-09'], '2024-03-10');
  assert.equal(r.currentStreak, 2);
  assert.equal(r.daysSinceLast, 1);
});

test('_computeDiaryGapsConsistency: Lücke + this/prev-Month-Zählung', () => {
  const dates = ['2024-01-31', '2024-02-15', '2024-03-01', '2024-03-10'];
  const r = M._computeDiaryGapsConsistency(dates, '2024-03-10');
  assert.equal(r.longestGap, 15);       // Jan31 → Feb15
  assert.equal(r.entriesThisMonth, 2);  // 03-01, 03-10
  assert.equal(r.entriesPrevMonth, 1);  // 02-15
});

test('_computeDiaryGapsConsistency: Streak gebrochen (heute & gestern leer)', () => {
  const r = M._computeDiaryGapsConsistency(['2024-03-01', '2024-03-02'], '2024-03-10');
  assert.equal(r.currentStreak, 0);
});

test('_computeDiaryWeekdayRhythm: Wochentag-Zuordnung TZ-aware (kein Off-by-one)', () => {
  // 2024-01-01 ist ein Montag (jsDay 1), 01-07 ein Sonntag (jsDay 0).
  const entries = [
    { iso: '2024-01-01', chars: 100 }, // Mo
    { iso: '2024-01-02', chars: 50 },  // Di
    { iso: '2024-01-08', chars: 30 },  // Mo
    { iso: '2024-01-07', chars: 10 },  // So
  ];
  const rows = M._computeDiaryWeekdayRhythm(entries, true); // Mo-first
  assert.equal(rows[0].jsDay, 1);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].chars, 130);
  assert.equal(rows[6].jsDay, 0); // Sonntag als letzte Spalte
  assert.equal(rows[6].count, 1);
});

test('_computeDiaryWeekdayRhythm: Sun-first-Reihenfolge (en) + leeres Set', () => {
  const rows = M._computeDiaryWeekdayRhythm([], false);
  assert.equal(rows.length, 7);
  assert.equal(rows[0].jsDay, 0); // Sonntag zuerst
  assert.equal(rows[0].pct, 0);
});

test('_computeDiaryWeekdayRhythm: pct-Skalierung relativ zum Maximum', () => {
  const entries = [
    { iso: '2024-01-01', chars: 0 }, { iso: '2024-01-08', chars: 0 }, { iso: '2024-01-15', chars: 0 }, // 3× Mo
    { iso: '2024-01-02', chars: 0 }, // 1× Di
  ];
  const rows = M._computeDiaryWeekdayRhythm(entries, true);
  assert.equal(rows[0].count, 3);
  assert.equal(rows[0].pct, 100);
  assert.equal(rows[1].count, 1);
  assert.equal(rows[1].pct, 33);
});
