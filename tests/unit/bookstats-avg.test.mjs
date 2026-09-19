// Ø-Auswertung der Buchentwicklungs-Kurve (public/js/book/bookstats-avg.js).
// Die Kennzahlen unter dem Diagramm und die Overlay-Serien haengen an diesen
// Funktionen; ein stiller Rechenfehler faellt im UI nicht auf, weil jede Zahl
// plausibel aussieht.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CLASSIFIED_METRICS, computeAvgSummary, metricKind, rollingSeries,
  rollingWindowForRange, trendSeries,
} from '../../public/js/book/bookstats-avg.js';

const near = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: ${actual} != ${expected}`);

test('jede Chart-Metrik ist einer Art zugeordnet (Drift-Guard)', () => {
  const src = readFileSync(new URL('../../public/js/book/bookstats.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const METRIC_KEYS = {'), src.indexOf('};', src.indexOf('const METRIC_KEYS = {')));
  const keys = [...block.matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]);
  assert.ok(keys.length >= 19, `METRIC_KEYS nicht gefunden (${keys.length})`);
  for (const k of keys) {
    assert.ok(CLASSIFIED_METRICS.has(k), `Metrik "${k}" ist in bookstats-avg.js nicht eingeordnet`);
  }
});

test('metricKind trennt Bestand, Tagesmenge und Verhaeltniszahl', () => {
  assert.equal(metricKind('chars'), 'stock');
  assert.equal(metricKind('writing_cumulative'), 'stock');
  assert.equal(metricKind('delta_words'), 'flow');
  assert.equal(metricKind('stt_minutes'), 'flow');
  assert.equal(metricKind('avg_lix'), 'rate');
});

test('Tagesmenge: Ø pro KALENDERTAG, nicht pro Messpunkt', () => {
  // 01., 03., 08. September — 8 Kalendertage Spanne, 3 aktive Tage.
  const s = computeAvgSummary({
    metric: 'delta_chars',
    dates: ['2026-09-01', '2026-09-03', '2026-09-08'],
    values: [10, 20, 30],
  });
  assert.equal(s.kind, 'flow');
  assert.equal(s.spanDays, 8);
  assert.equal(s.activeDays, 3);
  assert.equal(s.total, 60);
  near(s.perDay, 7.5, 'perDay');
  near(s.perWeek, 52.5, 'perWeek');
  near(s.perMonth, 225, 'perMonth');
  near(s.mean, 20, 'mean (je aktivem Tag)');
});

test('Bestandsgroesse: Ø-ZUWACHS pro Tag/Woche/Monat', () => {
  const s = computeAvgSummary({
    metric: 'chars',
    dates: ['2026-09-01', '2026-09-11'],
    values: [1000, 3000],
  });
  assert.equal(s.kind, 'stock');
  assert.equal(s.delta, 2000);
  assert.equal(s.elapsedDays, 10);
  near(s.perDay, 200, 'perDay');
  near(s.perWeek, 1400, 'perWeek');
  near(s.perMonth, 6000, 'perMonth');
  assert.equal(s.level, 3000);
});

test('Bestandsgroesse mit nur einem Messpunkt: kein Zuwachs, kein NaN', () => {
  const s = computeAvgSummary({ metric: 'words', dates: ['2026-09-01'], values: [500] });
  assert.equal(s.perDay, 0);
  assert.equal(s.spanDays, 1);
});

test('Verhaeltniszahl: Ø-Wert der Messpunkte', () => {
  const s = computeAvgSummary({
    metric: 'avg_sentence_len',
    dates: ['2026-09-01', '2026-09-02', '2026-09-03'],
    values: [3, 5, 7],
  });
  assert.equal(s.kind, 'rate');
  near(s.perDay, 5, 'Ø-Niveau');
});

test('fuehrende Luecken zaehlen nicht zur Spanne', () => {
  const s = computeAvgSummary({
    metric: 'delta_words',
    dates: ['2026-09-01', '2026-09-02', '2026-09-03'],
    values: [null, 10, 20],
  });
  assert.equal(s.from, '2026-09-02');
  assert.equal(s.spanDays, 2);
  near(s.perDay, 15, 'perDay ab erstem echten Punkt');
});

test('leere Serie liefert null statt NaN-Badges', () => {
  assert.equal(computeAvgSummary({ metric: 'chars', dates: ['2026-09-01'], values: [null] }), null);
});

test('gleitender Ø rechnet ueber Kalendertage, nicht ueber Punkte', () => {
  const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-05'];
  const values = [6, 0, 3, 9];
  // perDay: Summe des 3-Tage-Fensters / abgedeckte Kalendertage.
  assert.deepEqual(rollingSeries(dates, values, 3, { perDay: true }), [6, 3, 3, 4]);
  // ohne perDay: Mittel der Punkte im Fenster (05.09. sieht nur 03. und 05.).
  assert.deepEqual(rollingSeries(dates, values, 3), [6, 3, 3, 6]);
});

test('gleitender Ø bleibt vor dem ersten Messpunkt leer', () => {
  const out = rollingSeries(['2026-09-01', '2026-09-02'], [null, 4], 3, { perDay: true });
  assert.equal(out[0], null);
  near(out[1], 4, 'erster echter Punkt');
});

test('Ø-Entwicklung interpoliert nach Datum, nicht nach Index', () => {
  const out = trendSeries(['2026-09-01', '2026-09-03', '2026-09-06'], [10, 99, 40]);
  assert.deepEqual(out, [10, 22, 40]);
});

test('Ø-Entwicklung braucht zwei Messpunkte', () => {
  assert.deepEqual(trendSeries(['2026-09-01'], [10]), [null]);
});

test('Fensterbreite folgt dem gewaehlten Zeitraum', () => {
  assert.equal(rollingWindowForRange(7), 3);
  assert.equal(rollingWindowForRange(30), 7);
  assert.equal(rollingWindowForRange(90), 7);
  assert.equal(rollingWindowForRange(365), 30);
  assert.equal(rollingWindowForRange(0), 30);
});
