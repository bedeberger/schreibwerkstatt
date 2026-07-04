// Upload-Normalisierung für Manuskript-Bilder (lib/page-image-prepare): sichere
// Ausgabe (JPEG bzw. PNG bei Transparenz), Downscale auf max. Längsseite,
// Reject bei Nicht-Bild. Vorbild/Muster: cover-prepare.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { preparePageImage } from '../../lib/page-image-prepare.js';

test('PNG mit Alpha bleibt PNG (Transparenz erhalten)', async () => {
  const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
  const out = await preparePageImage(png);
  assert.equal(out.mime, 'image/png');
  assert.equal(out.width, 10);
  assert.equal(out.height, 10);
  assert.ok(out.buffer.length > 0);
});

test('opakes JPEG bleibt JPEG', async () => {
  const jpg = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
  const out = await preparePageImage(jpg);
  assert.equal(out.mime, 'image/jpeg');
});

test('übergroßes Bild wird auf max. Längsseite (2000px) verkleinert', async () => {
  const big = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: { r: 0, g: 128, b: 255 } } }).jpeg().toBuffer();
  const out = await preparePageImage(big);
  assert.equal(out.width, 2000);
  assert.equal(out.height, 1000);
});

test('Nicht-Bild wird abgewiesen', async () => {
  await assert.rejects(() => preparePageImage(Buffer.from('not an image at all')), /image-unsupported-format/);
});

test('leerer/nicht-Buffer wird abgewiesen', async () => {
  await assert.rejects(() => preparePageImage(Buffer.alloc(0)), /image-empty/);
  await assert.rejects(() => preparePageImage('nope'), /image-not-buffer/);
});
