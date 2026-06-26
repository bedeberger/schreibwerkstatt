// Parser des latest-GitHub-Release fuer den Android-App-Download (/me).
// Deckt das reine _parseRelease ab (kein Netz) — Asset-Auswahl, Version-Normalisierung,
// graceful kein-.apk-Fall.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _parseRelease } = require('../../lib/androidclient-release.js');

test('_parseRelease: waehlt das .apk-Asset, strippt fuehrendes v', () => {
  const rel = _parseRelease({
    tag_name: 'v0.2.0',
    body: 'Notizen',
    published_at: '2026-06-26T10:00:00Z',
    assets: [
      { name: 'checksums.txt', size: 10, browser_download_url: 'https://x/checksums.txt' },
      { name: 'schreibwerkstatt-mobile-v0.2.0.apk', size: 12_582_912, browser_download_url: 'https://x/app.apk' },
    ],
  });
  assert.equal(rel.available, true);
  assert.equal(rel.version, '0.2.0');
  assert.equal(rel.notes, 'Notizen');
  assert.equal(rel.publishedAt, '2026-06-26T10:00:00Z');
  assert.deepEqual(rel.apk, { name: 'schreibwerkstatt-mobile-v0.2.0.apk', sizeBytes: 12_582_912, downloadUrl: 'https://x/app.apk' });
});

test('_parseRelease: kein .apk → { available:false }', () => {
  const rel = _parseRelease({ tag_name: 'v2.0', assets: [{ name: 'app.zip', size: 1, browser_download_url: 'https://x/app.zip' }] });
  assert.deepEqual(rel, { available: false });
});

test('_parseRelease: leeres/ungueltiges Release → { available:false }', () => {
  assert.deepEqual(_parseRelease(null), { available: false });
  assert.deepEqual(_parseRelease({}), { available: false });
});

test('_parseRelease: case-insensitive .APK-Endung', () => {
  const rel = _parseRelease({ tag_name: '0.3.0', assets: [{ name: 'App.APK', size: 5, browser_download_url: 'https://x/App.APK' }] });
  assert.equal(rel.available, true);
  assert.equal(rel.apk.name, 'App.APK');
});
