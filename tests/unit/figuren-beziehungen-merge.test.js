'use strict';
// Unit: mergeBeziehungenIntoFiguren – faltet die flachen Beziehungen des Claude-A2-Passes
// ({von,zu,…}) zurück in figuren[].beziehungen ({figur_id,…}), wie es der Downstream erwartet.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeBeziehungenIntoFiguren } = require('../../routes/jobs/komplett/figuren-merge');

test('faltet flache Beziehung unter die «von»-Figur', () => {
  const figuren = [{ id: 'fig_1', name: 'A' }, { id: 'fig_2', name: 'B' }];
  const out = mergeBeziehungenIntoFiguren(figuren, [
    { von: 'fig_1', zu: 'fig_2', typ: 'elternteil', machtverhaltnis: 2, beschreibung: 'x', belege: [{ kapitel: 'K' }] },
  ]);
  assert.equal(out[0].beziehungen.length, 1);
  assert.deepEqual(out[0].beziehungen[0], {
    figur_id: 'fig_2', typ: 'elternteil', machtverhaltnis: 2, beschreibung: 'x', belege: [{ kapitel: 'K' }],
  });
  assert.equal(out[1].beziehungen.length, 0);
});

test('filtert Selbst-Referenzen und unbekannte IDs', () => {
  const figuren = [{ id: 'fig_1', name: 'A' }, { id: 'fig_2', name: 'B' }];
  const out = mergeBeziehungenIntoFiguren(figuren, [
    { von: 'fig_1', zu: 'fig_1', typ: 'andere' },
    { von: 'fig_1', zu: 'fig_9', typ: 'feind' },
    { von: null, zu: 'fig_2', typ: 'freund' },
  ]);
  assert.equal(out[0].beziehungen.length, 0);
});

test('dedupliziert pro ungeordnetem Paar (auch Gegenrichtung)', () => {
  const figuren = [{ id: 'fig_1', name: 'A' }, { id: 'fig_2', name: 'B' }];
  const out = mergeBeziehungenIntoFiguren(figuren, [
    { von: 'fig_1', zu: 'fig_2', typ: 'freund' },
    { von: 'fig_2', zu: 'fig_1', typ: 'feind' },
  ]);
  assert.equal(out[0].beziehungen.length, 1);
  assert.equal(out[1].beziehungen.length, 0);
  assert.equal(out[0].beziehungen[0].typ, 'freund');
});

test('respektiert bereits vorhandene Beziehungen (kein Duplikat)', () => {
  const figuren = [
    { id: 'fig_1', name: 'A' },
    { id: 'fig_2', name: 'B', beziehungen: [{ figur_id: 'fig_1', typ: 'freund' }] },
  ];
  const out = mergeBeziehungenIntoFiguren(figuren, [
    { von: 'fig_1', zu: 'fig_2', typ: 'rivale' },
  ]);
  assert.equal(out[0].beziehungen.length, 0);
  assert.equal(out[1].beziehungen.length, 1);
  assert.equal(out[1].beziehungen[0].typ, 'freund');
});

test('lässt optionale Felder weg wenn nicht vorhanden', () => {
  const figuren = [{ id: 'fig_1', name: 'A' }, { id: 'fig_2', name: 'B' }];
  const out = mergeBeziehungenIntoFiguren(figuren, [{ von: 'fig_1', zu: 'fig_2', typ: 'freund' }]);
  assert.deepEqual(out[0].beziehungen[0], { figur_id: 'fig_2', typ: 'freund' });
});

test('mutiert die Eingabe nicht', () => {
  const figuren = [{ id: 'fig_1', name: 'A' }, { id: 'fig_2', name: 'B' }];
  mergeBeziehungenIntoFiguren(figuren, [{ von: 'fig_1', zu: 'fig_2', typ: 'freund' }]);
  assert.equal(figuren[0].beziehungen, undefined);
});

test('leere/fehlende Beziehungsliste → Figuren unverändert', () => {
  const figuren = [{ id: 'fig_1', name: 'A' }];
  assert.deepEqual(mergeBeziehungenIntoFiguren(figuren, []).map(f => f.id), ['fig_1']);
  assert.deepEqual(mergeBeziehungenIntoFiguren(figuren, null).map(f => f.id), ['fig_1']);
});
