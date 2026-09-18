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
