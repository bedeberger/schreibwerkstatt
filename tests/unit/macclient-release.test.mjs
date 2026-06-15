// Parser des latest-GitHub-Release fuer den macOS-App-Download (/me).
// Deckt das reine _parseRelease ab (kein Netz) — Asset-Auswahl, Version-Normalisierung,
// graceful kein-.dmg-Fall.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _parseRelease } = require('../../lib/macclient-release.js');

test('_parseRelease: waehlt das .dmg-Asset, strippt fuehrendes v', () => {
  const rel = _parseRelease({
    tag_name: 'v1.4.0',
    body: 'Notizen',
    published_at: '2026-06-01T10:00:00Z',
    assets: [
      { name: 'checksums.txt', size: 10, browser_download_url: 'https://x/checksums.txt' },
      { name: 'Focuseditor-1.4.0.dmg', size: 12_582_912, browser_download_url: 'https://x/app.dmg' },
    ],
  });
  assert.equal(rel.available, true);
  assert.equal(rel.version, '1.4.0');
  assert.equal(rel.notes, 'Notizen');
  assert.equal(rel.publishedAt, '2026-06-01T10:00:00Z');
  assert.deepEqual(rel.dmg, { name: 'Focuseditor-1.4.0.dmg', sizeBytes: 12_582_912, downloadUrl: 'https://x/app.dmg' });
});

test('_parseRelease: kein .dmg → { available:false }', () => {
  const rel = _parseRelease({ tag_name: 'v2.0', assets: [{ name: 'app.zip', size: 1, browser_download_url: 'https://x/app.zip' }] });
  assert.deepEqual(rel, { available: false });
});

test('_parseRelease: leeres/ungueltiges Release → { available:false }', () => {
  assert.deepEqual(_parseRelease(null), { available: false });
  assert.deepEqual(_parseRelease({}), { available: false });
});

test('_parseRelease: case-insensitive .DMG-Endung', () => {
  const rel = _parseRelease({ tag_name: '3.1.0', assets: [{ name: 'App.DMG', size: 5, browser_download_url: 'https://x/App.DMG' }] });
  assert.equal(rel.available, true);
  assert.equal(rel.dmg.name, 'App.DMG');
});
