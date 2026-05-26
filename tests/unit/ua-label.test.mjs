import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { uaLabel } from '../../lib/ua-label.js';

test('uaLabel: leerer/missing UA → Unbekanntes Gerät', () => {
  assert.equal(uaLabel(''), 'Unbekanntes Gerät');
  assert.equal(uaLabel(null), 'Unbekanntes Gerät');
  assert.equal(uaLabel(undefined), 'Unbekanntes Gerät');
});

test('uaLabel: Chrome auf macOS', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  assert.equal(uaLabel(ua), 'Chrome · macOS');
});

test('uaLabel: Safari auf macOS (Version+Safari, kein Chrome)', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  assert.equal(uaLabel(ua), 'Safari · macOS');
});

test('uaLabel: Safari auf iOS', () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  assert.equal(uaLabel(ua), 'Safari · iOS');
});

test('uaLabel: Chrome auf Android', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  assert.equal(uaLabel(ua), 'Chrome · Android');
});

test('uaLabel: Firefox auf Windows', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0';
  assert.equal(uaLabel(ua), 'Firefox · Windows');
});

test('uaLabel: Edge wird vor Chrome erkannt', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
  assert.equal(uaLabel(ua), 'Edge · Windows');
});

test('uaLabel: Firefox auf Linux', () => {
  const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';
  assert.equal(uaLabel(ua), 'Firefox · Linux');
});

test('uaLabel: kompletter Unsinn → Unbekanntes Gerät', () => {
  assert.equal(uaLabel('CURL/8.0'), 'Unbekanntes Gerät');
});
