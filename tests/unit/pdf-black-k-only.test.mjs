import { test } from 'node:test';
import assert from 'node:assert';
import { _rgbToKOnly, _patchBlackToK } from '../../lib/pdf-render/color.js';

test('reines Schwarz → K 100 (DeviceCMYK)', () => {
  assert.deepEqual(_rgbToKOnly('#000000'), [0, 0, 0, 100]);
  assert.deepEqual(_rgbToKOnly('black'), [0, 0, 0, 100]);
  assert.deepEqual(_rgbToKOnly('#000'), [0, 0, 0, 100]);
});

test('nahezu-schwarzer Fliesstext (#1a1a1a) bleibt K-only mit erhaltenem Grauwert', () => {
  const c = _rgbToKOnly('#1a1a1a'); // 26/255 → ~90 % K
  assert.equal(c.length, 4);
  assert.deepEqual(c.slice(0, 3), [0, 0, 0]);
  assert.equal(c[3], 90);
});

test('graue Kolumnentitel (#666666 / #999999) werden als K-only mit ihrem Ton ausgegeben', () => {
  assert.deepEqual(_rgbToKOnly('#666666'), [0, 0, 0, 60]);
  assert.deepEqual(_rgbToKOnly('#999999'), [0, 0, 0, 40]);
});

test('weiss → K 0 (kein Ink, Papierweiss/Knockout)', () => {
  assert.deepEqual(_rgbToKOnly('#ffffff'), [0, 0, 0, 0]);
  assert.deepEqual(_rgbToKOnly('white'), [0, 0, 0, 0]);
});

test('chromatische Farben (Link-Blau) bleiben unangetastet → null', () => {
  assert.equal(_rgbToKOnly('#1a4d8f'), null); // Link
  assert.equal(_rgbToKOnly('#4d7a2e'), null); // Grün
});

test('idempotent: bereits konvertierte CMYK-K-Farbe wird nicht erneut angefasst', () => {
  // Länge-4-Arrays (DeviceCMYK) und andere Nicht-RGB-Werte → null (Passthrough).
  assert.equal(_rgbToKOnly([0, 0, 0, 100]), null);
  assert.equal(_rgbToKOnly({}), null);
  assert.equal(_rgbToKOnly(null), null);
});

test('_patchBlackToK leitet Fill-Farben durch die K-only-Konvertierung', () => {
  const calls = [];
  const doc = { fillColor(color) { calls.push(color); return this; } };
  _patchBlackToK(doc);
  doc.fillColor('#1a1a1a');   // achromatisch → K-only
  doc.fillColor('#1a4d8f');   // chromatisch → unverändert
  assert.deepEqual(calls[0], [0, 0, 0, 90]);
  assert.equal(calls[1], '#1a4d8f');
});
