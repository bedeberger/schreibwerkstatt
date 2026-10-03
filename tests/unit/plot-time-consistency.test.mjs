// Zeit-Messung der Plot-Werkstatt (lib/plot-time-consistency.js) — pure Rechnung.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeTimeFindings } = require('../../lib/plot-time-consistency.js');

const FIGS = new Map([
  ['f1', { name: 'Mara', geburtsjahr: 1979 }],
  ['f2', { name: 'Jonas', geburtsjahr: null }],
]);

function beat(over = {}) {
  return { id: 1, titel: 'Beat', zeit: '1990', jahr: 1990, verworfen: 0, fig_ids: [], ordnung: 0, ...over };
}
const codes = f => f.map(x => x.code);

test('undatiert ist ungeprueft: ohne jahr keine Befunde', () => {
  const b = beat({ jahr: null, zeit: null, fig_ids: ['f1'] });
  assert.deepEqual(computeTimeFindings({ beats: [b], figures: FIGS }), []);
});

test('verworfene Beats zaehlen nicht (sie sollen nicht ins Buch)', () => {
  const b = beat({ jahr: 1970, fig_ids: ['f1'], verworfen: 1 });
  assert.deepEqual(computeTimeFindings({ beats: [b], figures: FIGS }), []);
});

test('beatVorGeburt: Beat spielt vor der Geburt einer beteiligten Figur', () => {
  const b = beat({ jahr: 1970, fig_ids: ['f1'] });
  const f = computeTimeFindings({ beats: [b], figures: FIGS });
  assert.deepEqual(codes(f), ['beatVorGeburt']);
  assert.equal(f[0].schwere, 'kritisch');
  assert.equal(f[0].params.figur, 'Mara');
  assert.equal(f[0].params.geburtsjahr, 1979);
});

test('Figur ohne Geburtsjahr erzeugt keinen Alters-Befund', () => {
  const b = beat({ jahr: 1900, fig_ids: ['f2'] });
  assert.deepEqual(computeTimeFindings({ beats: [b], figures: FIGS }), []);
});

test('figurKindImBeat nennt die Zahl, wenn die Figur unter zwoelf ist', () => {
  const b = beat({ jahr: 1985, fig_ids: ['f1'] });     // 1985 − 1979 = 6
  const f = computeTimeFindings({ beats: [b], figures: FIGS });
  assert.deepEqual(codes(f), ['figurKindImBeat']);
  assert.equal(f[0].params.alter, 6);

  // Gegenprobe: erwachsen → kein Befund.
  const b2 = beat({ jahr: 2005, fig_ids: ['f1'] });
  assert.deepEqual(computeTimeFindings({ beats: [b2], figures: FIGS }), []);
});

test('chronologieBruch misst gegen das bisherige Maximum, nicht den Vorgaenger', () => {
  // Eine einzelne Ruecklende darf keine Kette von Folgefehlern erzeugen.
  const beats = [
    beat({ id: 1, titel: 'A', jahr: 2000, ordnung: 0 }),
    beat({ id: 2, titel: 'B', jahr: 1990, ordnung: 1 }),   // Rueckblende
    beat({ id: 3, titel: 'C', jahr: 2001, ordnung: 2 }),   // wieder vorwaerts
  ];
  const f = computeTimeFindings({ beats, figures: FIGS });
  assert.deepEqual(codes(f), ['chronologieBruch']);
  assert.equal(f[0].beat_id, 2);
  assert.equal(f[0].params.vorBeat, 'A');
});

test('aufsteigende Jahre erzeugen keinen Bruch', () => {
  const beats = [
    beat({ id: 1, jahr: 1990, ordnung: 0 }),
    beat({ id: 2, jahr: 1990, ordnung: 1 }),   // Gleichstand ist kein Bruch
    beat({ id: 3, jahr: 1995, ordnung: 2 }),
  ];
  assert.deepEqual(computeTimeFindings({ beats, figures: FIGS }), []);
});

test('Board-Reihenfolge entscheidet, nicht die Array-Reihenfolge', () => {
  const beats = [
    beat({ id: 3, titel: 'C', jahr: 1990, ordnung: 2 }),
    beat({ id: 1, titel: 'A', jahr: 2000, ordnung: 0 }),
  ];
  const f = computeTimeFindings({ beats, figures: FIGS });
  assert.deepEqual(codes(f), ['chronologieBruch']);
  assert.equal(f[0].beat_id, 3, 'der spaeter gelesene Beat traegt den Befund');
});

test('zeitAusserhalbBuch nur mit bekannter Buchspanne', () => {
  const b = beat({ jahr: 1800 });
  assert.deepEqual(computeTimeFindings({ beats: [b], figures: FIGS, bookSpan: null }), []);
  const f = computeTimeFindings({ beats: [b], figures: FIGS, bookSpan: { minYear: 1980, maxYear: 2000 } });
  assert.deepEqual(codes(f), ['zeitAusserhalbBuch']);
  assert.equal(f[0].schwere, 'schwach');
});

test('Befunde sind nach Schwere sortiert', () => {
  const beats = [
    beat({ id: 1, titel: 'A', jahr: 2000, ordnung: 0 }),
    beat({ id: 2, titel: 'B', jahr: 1970, ordnung: 1, fig_ids: ['f1'] }),
  ];
  const f = computeTimeFindings({ beats, figures: FIGS, bookSpan: { minYear: 1980, maxYear: 2010 } });
  assert.deepEqual(codes(f), ['beatVorGeburt', 'chronologieBruch', 'zeitAusserhalbBuch']);
  assert.ok(f.every(x => x.quelle === 'messung'));
});

// ── Lesereihenfolge pro Lane (lib/plot-reading-order.js) ─────────────────────
const { laneReadingOrder, beatsInReadingOrder } = require('../../lib/plot-reading-order.js');

test('chronologieBruch nur innerhalb einer Lane — parallele Stränge sind kein Rückschritt', () => {
  const beats = [
    beat({ id: 1, titel: 'A1', jahr: 1987, lane: 't1', ordnung: 0 }),
    beat({ id: 2, titel: 'B1', jahr: 1950, lane: 't2', ordnung: 0 }),
    beat({ id: 3, titel: 'B2', jahr: 1955, lane: 't2', ordnung: 1 }),
  ];
  assert.deepEqual(computeTimeFindings({ beats, figures: FIGS }), []);
  const back = [...beats, beat({ id: 4, titel: 'A2', jahr: 1980, lane: 't1', ordnung: 1 })];
  const f = computeTimeFindings({ beats: back, figures: FIGS });
  assert.deepEqual(codes(f), ['chronologieBruch']);
  assert.equal(f[0].beat_id, 4);
  assert.equal(f[0].params.vorBeat, 'A1');
});

test('laneReadingOrder: geforkter Strang liest seine eigenen Akte, andere die geteilten', () => {
  const acts = [
    { id: 10, thread_id: null, position: 1 }, { id: 11, thread_id: null, position: 0 },
    { id: 20, thread_id: 2, position: 1 }, { id: 21, thread_id: 2, position: 0 },
  ];
  const threads = [{ id: 2, position: 1 }, { id: 1, position: 0 }];
  const beats = [
    { id: 100, act_id: 10, thread_id: 1, sort_order: 0 },
    { id: 101, act_id: 11, thread_id: 1, sort_order: 1 },
    { id: 102, act_id: 11, thread_id: 1, sort_order: 0 },
    { id: 200, act_id: 20, thread_id: 2, sort_order: 0 },
    { id: 201, act_id: 21, thread_id: 2, sort_order: 0 },
    { id: 300, act_id: 10, thread_id: null, sort_order: 0 },
  ];
  const lanes = laneReadingOrder({ acts, threads, beats });
  assert.deepEqual(lanes.map(l => l.key), ['t1', 't2', 'none']);
  assert.deepEqual(lanes[0].acts.map(a => a.id), [11, 10]);
  assert.deepEqual(lanes[0].beats.map(b => b.id), [102, 101, 100]);
  assert.deepEqual(lanes[1].acts.map(a => a.id), [21, 20]);
  assert.deepEqual(lanes[1].beats.map(b => b.id), [201, 200]);
  assert.deepEqual(lanes[2].beats.map(b => b.id), [300]);
  const flat = beatsInReadingOrder({ acts, threads, beats });
  assert.deepEqual(flat.map(b => [b.id, b.lane, b.ordnung]),
    [[102, 't1', 0], [101, 't1', 1], [100, 't1', 2], [201, 't2', 0], [200, 't2', 1], [300, 'none', 0]]);
});

test('laneReadingOrder: Beat auf lane-fremdem Akt (Altdaten) landet am Lane-Ende statt zu verschwinden', () => {
  const acts = [{ id: 10, thread_id: null, position: 0 }, { id: 20, thread_id: 2, position: 0 }];
  const beats = [
    { id: 1, act_id: 10, thread_id: 2, sort_order: 0 },
    { id: 2, act_id: 20, thread_id: 2, sort_order: 5 },
  ];
  const lanes = laneReadingOrder({ acts, threads: [{ id: 2, position: 0 }], beats });
  assert.deepEqual(lanes[0].beats.map(b => b.id), [2, 1]);
});
