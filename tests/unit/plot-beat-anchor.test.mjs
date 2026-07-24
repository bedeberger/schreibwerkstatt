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

test('geplant + Fundstellen → promote (offenbar schon geschrieben — Vorschlag „im Buch")', () => {
  assert.equal(classifyBeatAnchor('geplant', 2, 0), 'promote');
  assert.equal(classifyBeatAnchor('geplant', 1, 0), 'promote');
});

test('geplant ohne Fundstellen → kein Badge (keine Promotion, keine Drift)', () => {
  assert.equal(classifyBeatAnchor('geplant', 0, 0), 'none');
  assert.equal(classifyBeatAnchor('geplant', null, 0), 'none');
  assert.equal(classifyBeatAnchor('geplant', undefined, 0), 'none');
});

test('verworfene Beats werden nie klassifiziert (kein Badge), unabhängig von Status/Fund', () => {
  assert.equal(classifyBeatAnchor('im_buch', 5, 1), 'none');   // sonst confirmed
  assert.equal(classifyBeatAnchor('im_buch', 0, 1), 'none');   // sonst drift
  assert.equal(classifyBeatAnchor('geplant', 3, 1), 'none');   // sonst promote
});

test('unbekannter/leerer Status trägt nie ein Badge', () => {
  assert.equal(classifyBeatAnchor('', 0, 0), 'none');
  assert.equal(classifyBeatAnchor(undefined, 4, 0), 'none');
  assert.equal(classifyBeatAnchor(null, 0, 0), 'none');
});
