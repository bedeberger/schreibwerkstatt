'use strict';
// Unit: backfillFiguren – legt Figuren an, die in Szenen/Events referenziert
// werden, aber von der Phase-1-Figurenextraktion ausgelassen wurden. Ohne
// Backfill droppen remapSzenen/remapAssignments diese Namen und der Charakter
// existiert gar nicht (Symptom: «Szenen-Remap: N Figuren-Name(n) ohne ID»).

const test = require('node:test');
const assert = require('node:assert/strict');
const { backfillFiguren } = require('../../routes/jobs/komplett/figuren-merge');

const log = { info() {}, warn() {} };
const szene = (...namen) => ({ titel: 't', figuren_namen: namen });
const chSz = (...szenen) => [{ kapitel: 'K1', szenen }];

test('legt Figur an, die in ≥2 Szenen vorkommt aber fehlt', () => {
  const figuren = [{ id: 'fig_1', name: 'Dieter' }];
  const created = backfillFiguren(figuren, chSz(szene('Gerold'), szene('Gerold', 'Dieter')), [], log);
  assert.equal(created, 1);
  const g = figuren.find(f => f.name === 'Gerold');
  assert.ok(g);
  assert.equal(g.id, 'fig_2');
  assert.equal(g.typ, 'andere');
  assert.deepEqual(g.beziehungen, []);
});

test('Schwelle: ein einziges Vorkommen wird ignoriert', () => {
  const figuren = [{ id: 'fig_1', name: 'Dieter' }];
  const created = backfillFiguren(figuren, chSz(szene('Gerold')), [], log);
  assert.equal(created, 0);
  assert.equal(figuren.length, 1);
});

test('Szene + Assignment zählen zusammen (1+1 ≥ 2)', () => {
  const figuren = [{ id: 'fig_1', name: 'Dieter' }];
  const assignments = [{ kapitel: 'K1', assignments: [{ figur_name: 'Gerold', lebensereignisse: [] }] }];
  const created = backfillFiguren(figuren, chSz(szene('Gerold')), assignments, log);
  assert.equal(created, 1);
});

test('Token-Subset zu bestehender Figur → kein Backfill', () => {
  const figuren = [{ id: 'fig_1', name: 'Gerold Brunner' }];
  const created = backfillFiguren(figuren, chSz(szene('Gerold'), szene('Gerold')), [], log);
  assert.equal(created, 0, '«Gerold» ist Teilname von «Gerold Brunner» – Token-Fallback löst auf');
  assert.equal(figuren.length, 1);
});

test('exakter Treffer (auch case/whitespace) erzeugt kein Duplikat', () => {
  const figuren = [{ id: 'fig_1', name: 'Gerold' }];
  const created = backfillFiguren(figuren, chSz(szene(' gerold '), szene('GEROLD')), [], log);
  assert.equal(created, 0);
  assert.equal(figuren.length, 1);
});

test('kurzname zählt als aufgelöst', () => {
  const figuren = [{ id: 'fig_1', name: 'Gerold Brunner', kurzname: 'Gerold' }];
  const created = backfillFiguren(figuren, chSz(szene('Gerold'), szene('Gerold')), [], log);
  assert.equal(created, 0);
});

test('Junk-Namen (kein Buchstabe / zu kurz) werden gefiltert', () => {
  const figuren = [];
  const created = backfillFiguren(figuren, chSz(szene('???'), szene('???'), szene('X'), szene('X')), [], log);
  assert.equal(created, 0);
  assert.equal(figuren.length, 0);
});

test('Objekt-Referenzen werden via _refToString normalisiert', () => {
  const figuren = [];
  const created = backfillFiguren(
    figuren,
    chSz(szene({ name: 'Gerold' }), szene({ name: 'Gerold' })),
    [], log,
  );
  assert.equal(created, 1);
  assert.equal(figuren[0].name, 'Gerold');
});

test('IDs setzen über dem höchsten bestehenden fig_N fort', () => {
  const figuren = [{ id: 'fig_7', name: 'Dieter' }];
  backfillFiguren(figuren, chSz(szene('Gerold'), szene('Gerold')), [], log);
  assert.equal(figuren.find(f => f.name === 'Gerold').id, 'fig_8');
});

test('mehrere fehlende Namen werden alle angelegt', () => {
  const figuren = [];
  const created = backfillFiguren(
    figuren,
    chSz(szene('Gerold', 'Mario'), szene('Gerold', 'Mario')),
    [], log,
  );
  assert.equal(created, 2);
});
