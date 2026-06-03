// Unit-Tests für die Diary-Rückblick-Logik („An diesem Tag" + Zeitraum-Suche).
// Reine Match-/Range-Funktionen über eine diaryCalendarPagesMap-artige Map,
// testbar ohne Alpine.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { _computeAnniversary, _computeRange } = await import('../../public/js/book/diary-calendar.js');

// Map<'YYYY-MM-DD', page>; page hier minimal als { id }.
function mapOf(...keys) {
  const m = new Map();
  for (const k of keys) m.set(k, { id: k });
  return m;
}

test('anniversary: gleicher MM-DD aus Vorjahren, absteigend nach Jahr', () => {
  const map = mapOf('2025-06-03', '2024-06-03', '2022-06-03', '2024-06-04', '2023-01-01');
  const out = _computeAnniversary(map, '06-03', 2026);
  assert.deepEqual(out.map(e => e.year), [2025, 2024, 2022]);
  assert.deepEqual(out.map(e => e.yearsAgo), [1, 2, 4]);
  assert.equal(out[0].page.id, '2025-06-03');
});

test('anniversary: aktuelles und zukünftiges Jahr ausgeschlossen', () => {
  const map = mapOf('2026-06-03', '2027-06-03', '2025-06-03');
  const out = _computeAnniversary(map, '06-03', 2026);
  assert.deepEqual(out.map(e => e.year), [2025]);
});

test('anniversary: kein Treffer → leeres Array', () => {
  const map = mapOf('2025-06-04', '2024-12-31');
  assert.deepEqual(_computeAnniversary(map, '06-03', 2026), []);
});

test('anniversary: 29.02. matcht strikt nur echte 29.02.-Einträge', () => {
  const map = mapOf('2024-02-29', '2023-02-28', '2022-02-28');
  const out = _computeAnniversary(map, '02-29', 2028);
  assert.deepEqual(out.map(e => e.key), ['2024-02-29']);
});

test('range: inklusive Grenztage, absteigend nach Datum', () => {
  const map = mapOf('2024-01-01', '2024-03-15', '2024-06-30', '2024-07-01', '2023-12-31');
  const out = _computeRange(map, '2024-01-01', '2024-06-30');
  assert.deepEqual(out.map(e => e.key), ['2024-06-30', '2024-03-15', '2024-01-01']);
});

test('range: from > bis → Grenzen getauscht, gleiches Ergebnis', () => {
  const map = mapOf('2024-02-01', '2024-05-01', '2024-08-01');
  const a = _computeRange(map, '2024-01-01', '2024-06-01');
  const b = _computeRange(map, '2024-06-01', '2024-01-01');
  assert.deepEqual(a.map(e => e.key), b.map(e => e.key));
  assert.deepEqual(a.map(e => e.key), ['2024-05-01', '2024-02-01']);
});

test('range: leere Grenzen → leeres Array', () => {
  const map = mapOf('2024-02-01');
  assert.deepEqual(_computeRange(map, '', '2024-06-01'), []);
  assert.deepEqual(_computeRange(map, '2024-01-01', ''), []);
});
