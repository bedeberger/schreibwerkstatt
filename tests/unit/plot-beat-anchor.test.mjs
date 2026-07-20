// Plot-Werkstatt: Drift-Klassifikation der Beat-Verankerung (Soll status vs. Ist-
// Fundstellen). Reine Funktion — hier ohne Alpine/DOM getestet.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyBeatAnchor } from '../../public/js/book/plot/constants.js';

test('im_buch + Fundstellen → confirmed', () => {
  assert.equal(classifyBeatAnchor('im_buch', 3, 0), 'confirmed');
  assert.equal(classifyBeatAnchor('im_buch', 1, 0), 'confirmed');
});

test('im_buch + 0 Fundstellen → drift (als eingearbeitet markiert, aber nicht im Text)', () => {
  assert.equal(classifyBeatAnchor('im_buch', 0, 0), 'drift');
  assert.equal(classifyBeatAnchor('im_buch', null, 0), 'drift');
  assert.equal(classifyBeatAnchor('im_buch', undefined, 0), 'drift');
});

test('geplant wird nie verankert → nie ein Badge, egal ob Fundstellen (Stale) vorliegen', () => {
  assert.equal(classifyBeatAnchor('geplant', 2, 0), 'none');
  assert.equal(classifyBeatAnchor('geplant', 0, 0), 'none');
  assert.equal(classifyBeatAnchor('geplant', null, 0), 'none');
});

test('verworfene Beats werden nie klassifiziert (kein Badge), unabhängig von Status/Fund', () => {
  assert.equal(classifyBeatAnchor('im_buch', 5, 1), 'none');   // sonst confirmed
  assert.equal(classifyBeatAnchor('im_buch', 0, 1), 'none');   // sonst drift
  assert.equal(classifyBeatAnchor('geplant', 3, 1), 'none');
});

test('unbekannter/leerer Status trägt nie ein Badge (nur im_buch wird verankert)', () => {
  assert.equal(classifyBeatAnchor('', 0, 0), 'none');
  assert.equal(classifyBeatAnchor(undefined, 4, 0), 'none');
  assert.equal(classifyBeatAnchor(null, 0, 0), 'none');
});
