// lib/font-fetch.js: Timeout, Byte-Deckel, In-flight-Dedup, i18n-Fehler,
// Stale-Cache-Fallback, Whitelist-Pruefung der Profil-Rollen.
// Netz wird nie beruehrt — fetchFont nimmt einen fetchImpl-Test-Hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

useTmpDb('font-fetch');
const require = createRequire(import.meta.url);
require('../../db/migrations');
const { fetchFont, findDisallowedFont } = require('../../lib/font-fetch');
const { cacheFont } = require('../../db/fonts');
const { db } = require('../../db/connection');
const { defaultConfig } = require('../../lib/pdf-export-defaults');

const CSS = "@font-face { src: url(https://fonts.gstatic.com/s/x/v1/abc.ttf) format('truetype'); }";
const TTF = Buffer.from([0, 1, 0, 0, 9, 9]);

function okRes(body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => buf };
}

function clearCache() { db.prepare('DELETE FROM font_cache').run(); }

test('laedt CSS + TTF und cached das Ergebnis', async () => {
  clearCache();
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return okRes(url.includes('googleapis') ? CSS : TTF); };
  const buf = await fetchFont('Lora', 400, 'normal', { fetchImpl });
  assert.deepEqual(buf, TTF);
  assert.equal(calls.length, 2);
  // Zweiter Aufruf kommt aus dem Cache.
  const again = await fetchFont('Lora', 400, 'normal', { fetchImpl: async () => { throw new Error('no net'); } });
  assert.deepEqual(Buffer.from(again), TTF);
});

test('parallele Aufrufe derselben Variante teilen sich EINEN Request', async () => {
  clearCache();
  let cssCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('googleapis')) { cssCalls++; await new Promise(r => setTimeout(r, 20)); return okRes(CSS); }
    return okRes(TTF);
  };
  const results = await Promise.all([1, 2, 3, 4].map(() => fetchFont('Lato', 700, 'normal', { fetchImpl })));
  assert.equal(cssCalls, 1);
  for (const r of results) assert.deepEqual(r, TTF);
});

test('Timeout → i18n-Fehler job.error.fontUnavailable mit {family}', async () => {
  clearCache();
  // Haengender Server: resolved nie, reagiert nur auf das Abort-Signal.
  const fetchImpl = (_url, opts) => new Promise((_res, rej) => {
    opts.signal.addEventListener('abort', () => rej(opts.signal.reason), { once: true });
  });
  const t0 = Date.now();
  await assert.rejects(
    fetchFont('Roboto', 400, 'normal', { fetchImpl, timeoutMs: 30 }),
    (e) => {
      assert.equal(e.message, 'job.error.fontUnavailable');
      assert.deepEqual(e.i18nParams, { family: 'Roboto' });
      assert.equal(e.cause?.code, 'FETCH_TIMEOUT');
      return true;
    },
  );
  assert.ok(Date.now() - t0 < 2000, 'Timeout greift nicht');
});

test('HTTP-Fehler ohne Cache → i18n-Key statt "google-fonts-css 503"', async () => {
  clearCache();
  const fetchImpl = async () => ({ ok: false, status: 503, headers: new Headers() });
  await assert.rejects(fetchFont('Inter', 400, 'normal', { fetchImpl }), { message: 'job.error.fontUnavailable' });
});

test('Netzfehler mit stale Cache → stale Buffer', async () => {
  clearCache();
  cacheFont('Bitter', 400, 'normal', TTF);
  db.prepare('UPDATE font_cache SET fetched_at = 0').run();
  const buf = await fetchFont('Bitter', 400, 'normal', { fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(Buffer.from(buf), TTF);
});

test('unerwarteter TTF-Host wird nicht geladen', async () => {
  clearCache();
  const fetchImpl = async (url) => okRes(url.includes('googleapis')
    ? "src: url(http://169.254.169.254/x.ttf) format('truetype');" : TTF);
  await assert.rejects(fetchFont('Nunito', 400, 'normal', { fetchImpl }), { message: 'job.error.fontUnavailable' });
});

test('nicht freigegebene Variante → job.error.fontNotAllowed', async () => {
  await assert.rejects(fetchFont('Comic Sans', 400, 'normal'), { message: 'job.error.fontNotAllowed' });
  await assert.rejects(fetchFont('Inter', 400, 'italic'), { message: 'job.error.fontNotAllowed' });
});

test('findDisallowedFont: nur unbekannte Familien fallen, fehlendes Gewicht/Kursiv nicht', () => {
  const font = defaultConfig().font;
  assert.equal(findDisallowedFont(font), null);
  // Inter hat keinen Kursivschnitt, Playfair kein 800 — beides akzeptiert
  // (Renderer faellt zurueck und meldet fontFallbacks).
  assert.equal(findDisallowedFont({ ...font, imprint: { ...font.imprint, family: 'Inter', italic: true } }), null);
  assert.equal(findDisallowedFont({ ...font, heading: { ...font.heading, weight: 800 } }), null);
  assert.deepEqual(
    findDisallowedFont({ ...font, footer: { ...font.footer, family: 'Papyrus' } }),
    { role: 'footer', family: 'Papyrus', weight: font.footer.weight },
  );
});
