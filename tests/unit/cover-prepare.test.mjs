// lib/cover-prepare.js: Pixel-Deckel gegen Dekompressionsbomben.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { prepareCover, prepareCoverPortrait, MAX_INPUT_PIXELS } = require('../../lib/cover-prepare');

async function png(width, height) {
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer();
}

test('Bild ueber dem Pixel-Deckel → cover-too-many-pixels (klein in Bytes, gross in Pixeln)', async () => {
  const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 100;
  const bomb = await png(side, side);
  assert.ok(bomb.length < 2 * 1024 * 1024, 'Testbild soll in Bytes klein sein');
  await assert.rejects(prepareCover(bomb), (e) => e.message === 'cover-too-many-pixels' && e.code === 'cover-too-many-pixels');
  await assert.rejects(prepareCoverPortrait(bomb), { message: 'cover-too-many-pixels' });
});

test('normales Bild geht durch', async () => {
  const r = await prepareCover(await png(300, 200));
  assert.equal(r.mime, 'image/jpeg');
  assert.equal(r.width, 300);
});
