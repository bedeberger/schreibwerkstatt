import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toEan13, checkDigit, isValidEan13, encodeModules, measureEan13, normalizeDigits } = require('../../lib/pdf-barcode.js');

const MM_TO_PT = 72 / 25.4;

test('checkDigit: kanonisches EAN-13-Beispiel 590123412345 → 7', () => {
  assert.equal(checkDigit('590123412345'), 7);
});

test('checkDigit: ISBN 978-3-16-148410 → 0', () => {
  assert.equal(checkDigit('978316148410'), 0);
});

test('toEan13: 12 Ziffern ergänzt die Prüfziffer', () => {
  assert.equal(toEan13('590123412345'), '5901234123457');
});

test('toEan13: 13 Ziffern mit korrekter Prüfziffer bleiben', () => {
  assert.equal(toEan13('5901234123457'), '5901234123457');
});

test('toEan13: ISBN-Schreibweise mit Bindestrichen wird normalisiert', () => {
  assert.equal(toEan13('978-3-16-148410-0'), '9783161484100');
});

test('toEan13: falsche Prüfziffer wirft', () => {
  assert.throws(() => toEan13('5901234123458'), /Prüfziffer/);
});

test('toEan13: falsche Länge wirft', () => {
  assert.throws(() => toEan13('12345'), /12 oder 13 Ziffern/);
});

test('isValidEan13: gültig/ungültig', () => {
  assert.equal(isValidEan13('978-3-16-148410-0'), true);
  assert.equal(isValidEan13('5901234123457'), true);
  assert.equal(isValidEan13('5901234123458'), false);
  assert.equal(isValidEan13(''), false);
  assert.equal(isValidEan13('abc'), false);
});

test('normalizeDigits strippt Nicht-Ziffern', () => {
  assert.equal(normalizeDigits('978-3 16.148410/0'), '9783161484100');
});

test('encodeModules: 95 Module, korrekte Guards', () => {
  const bits = encodeModules('5901234123457');
  assert.equal(bits.length, 95);
  assert.equal(bits.slice(0, 3), '101', 'Start-Guard');
  assert.equal(bits.slice(92, 95), '101', 'End-Guard');
  assert.equal(bits.slice(45, 50), '01010', 'Center-Guard');
});

test('measureEan13: SC2/100 % passt in die BISG-Barcode-Fläche 2" × 1.2"', () => {
  const { width, height } = measureEan13();
  // 113 Module (11 links + 95 + 7 rechts) × 0.33 mm = 37.29 mm breit.
  assert.ok(Math.abs(width / MM_TO_PT - 37.29) < 0.01, `Breite ${width / MM_TO_PT}`);
  // Symbol muss in die reservierte weisse Fläche (50.8 × 30.48 mm) passen,
  // sonst kollidiert es beim Zentrieren im Cover mit dem Rand.
  assert.ok(width  <= 50.8  * MM_TO_PT, 'Breite ≤ 2"');
  assert.ok(height <= 30.48 * MM_TO_PT, 'Höhe ≤ 1.2"');
});

test('measureEan13: skaliert linear mit opts.scale', () => {
  const a = measureEan13({ scale: 1 });
  const b = measureEan13({ scale: 2 });
  assert.ok(b.width > a.width && b.height > a.height);
});

test('encodeModules: deterministisch für ein bekanntes Symbol', () => {
  // Erste Ziffer 5 → linkes Paritätsmuster LGGLLG. Snapshot gegen Regression.
  const bits = encodeModules('5901234123457');
  // linke Gruppe = Module 3..44 (42 Bits)
  const left = bits.slice(3, 45);
  // 9(L)=0001011, 0(G)=0100111, 1(G)=0110011, 2(L)=0010011, 3(L)=0111101, 4(G)=0011101
  assert.equal(left, '000101101001110110011001001101111010011101');
});
