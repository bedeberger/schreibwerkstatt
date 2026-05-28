// Strukturierte Event-Sortierung: COALESCE-Logik in JS-Mirror der
// ORDER-BY-Klausel (routes/figures.js#GET /zeitstrahl). Events ohne Jahr ans
// Ende ("unbekannt"-Bucket), Tiebreaker via sort_order. Pure-Function-Test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function _sortKey(ev) {
  return [
    ev.datum_year  ?? 9999,
    ev.datum_month ?? 99,
    ev.datum_day   ?? 99,
    ev.story_tag   ?? 99999,
    ev.sort_order  ?? 0,
  ];
}
function _cmp(a, b) {
  const ka = _sortKey(a), kb = _sortKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
}
function sortEvents(arr) {
  return [...arr].sort(_cmp);
}

test('sortiert nach Jahr aufsteigend', () => {
  const events = [
    { ereignis: 'b', datum_year: 1900 },
    { ereignis: 'a', datum_year: 1850 },
    { ereignis: 'c', datum_year: 2000 },
  ];
  const sorted = sortEvents(events);
  assert.deepEqual(sorted.map(e => e.ereignis), ['a', 'b', 'c']);
});

test('sortiert nach Jahr → Monat → Tag', () => {
  const events = [
    { ereignis: 'b', datum_year: 1850, datum_month: 5, datum_day: 10 },
    { ereignis: 'a', datum_year: 1850, datum_month: 3, datum_day: 1 },
    { ereignis: 'c', datum_year: 1850, datum_month: 5, datum_day: 12 },
    { ereignis: 'aa', datum_year: 1850, datum_month: 3, datum_day: 15 },
  ];
  const sorted = sortEvents(events);
  assert.deepEqual(sorted.map(e => e.ereignis), ['a', 'aa', 'b', 'c']);
});

test('Events ohne Jahr landen am Ende', () => {
  const events = [
    { ereignis: 'unknown', datum_label: 'vor der Reise' },
    { ereignis: '1850', datum_year: 1850 },
    { ereignis: '2000', datum_year: 2000 },
  ];
  const sorted = sortEvents(events);
  assert.deepEqual(sorted.map(e => e.ereignis), ['1850', '2000', 'unknown']);
});

test('story_tag-Bucket nach Year-Bucket, vor unbekannt', () => {
  const events = [
    { ereignis: 'unknown' },
    { ereignis: 'tag5', story_tag: 5 },
    { ereignis: 'tag1', story_tag: 1 },
    { ereignis: '1850', datum_year: 1850 },
  ];
  const sorted = sortEvents(events);
  // datum_year-Events zuerst, dann story_tag-Events (datum_year fehlt → 9999,
  // gemeinsamer Bucket mit unknown; story_tag-Tiebreaker macht den Rest).
  assert.equal(sorted[0].ereignis, '1850');
  assert.equal(sorted[1].ereignis, 'tag1');
  assert.equal(sorted[2].ereignis, 'tag5');
  assert.equal(sorted[3].ereignis, 'unknown');
});

test('sort_order ist Tiebreaker bei Datums-Gleichstand', () => {
  const events = [
    { ereignis: 'B', datum_year: 1850, sort_order: 2 },
    { ereignis: 'A', datum_year: 1850, sort_order: 0 },
    { ereignis: 'C', datum_year: 1850, sort_order: 5 },
  ];
  const sorted = sortEvents(events);
  assert.deepEqual(sorted.map(e => e.ereignis), ['A', 'B', 'C']);
});

test('Punkt-Event vor Spannen-Event im selben Jahr', () => {
  // datum_ende_* spielt für Sortierung keine Rolle — Start-Datum ist Anchor.
  const events = [
    { ereignis: 'span', datum_year: 1850, datum_month: 5, datum_ende_year: 1860 },
    { ereignis: 'point', datum_year: 1850, datum_month: 3 },
  ];
  const sorted = sortEvents(events);
  assert.deepEqual(sorted.map(e => e.ereignis), ['point', 'span']);
});

test('null vs. undefined sind beide „unbekannt“', () => {
  const events = [
    { ereignis: 'has-year', datum_year: 1900, datum_month: null },
    { ereignis: 'null-year', datum_year: null },
    { ereignis: 'undef-year' },
  ];
  const sorted = sortEvents(events);
  assert.equal(sorted[0].ereignis, 'has-year');
});
