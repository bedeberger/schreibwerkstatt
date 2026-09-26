// fmtBytes (utils/format.js): SSoT der Dateigrössen-Anzeige (Admin-Backup,
// Admin-Bücher, Parse-Fails, Client-Downloads im Profil).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtBytes, configureLocaleRegion } from '../../public/js/utils/format.js';

configureLocaleRegion('');

test('Einheiten-Stufen in 1024er-Schritten', () => {
  assert.equal(fmtBytes(0, 'en'), '0 B');
  assert.equal(fmtBytes(512, 'en'), '512 B');
  assert.equal(fmtBytes(1536, 'en'), '1.5 KB');
  assert.equal(fmtBytes(5 * 1024 * 1024, 'en'), '5 MB');
  assert.equal(fmtBytes(2.25 * 1024 ** 3, 'en'), '2.3 GB');
});

test('locale-formatiert: de-CH Punkt-Dezimal + Apostroph, de-DE Komma', () => {
  assert.equal(fmtBytes(1536, 'de'), '1.5 KB');
  assert.match(fmtBytes(1023, 'de'), /^1['’]023 B$/);
  try {
    configureLocaleRegion('DE');
    assert.equal(fmtBytes(1536, 'de'), '1,5 KB');
  } finally {
    configureLocaleRegion('');
  }
});

test('null/NaN → Gedankenstrich, negative Werte → 0', () => {
  assert.equal(fmtBytes(null, 'de'), '—');
  assert.equal(fmtBytes(undefined, 'de'), '—');
  assert.equal(fmtBytes('abc', 'de'), '—');
  assert.equal(fmtBytes(-5, 'en'), '0 B');
});
