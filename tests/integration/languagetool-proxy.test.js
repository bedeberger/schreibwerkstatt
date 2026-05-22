'use strict';
// Integration-Test fuer /languagetool/check. Mockt das Upstream-LT-API via
// globalem fetch-Stub und prueft alle 4 Wege: enabled-OK, disabled, upstream-Fehler,
// Timeout-Pfad. Keine echte LT-Instanz noetig.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let server;
let baseUrl;
let originalFetch;
let fetchHandler = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const appSettings = require('../../lib/app-settings');
    const ltRouter = require('../../routes/languagetool');
    const app = express();
    // Fake-Session-Middleware: liefert immer einen User, damit Session-Guard
    // in der Route durchgeht (Route hat selbst keinen Guard — Express-Mount in
    // server.js bringt ihn, hier mocken wir einen User-Eintrag fuer Logging).
    app.use((req, _res, next) => { req.session = { user: { email: 'tester@test.dev' } }; next(); });
    app.use('/languagetool', ltRouter);
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
    server.on('error', reject);
    // Sanity export
    void appSettings;
  });
}

test.before(async () => {
  ctx = bootstrap();
  originalFetch = global.fetch;
  // global fetch wird vom Proxy fuer den LT-Upstream-Call genutzt; im Test
  // ueber `fetchHandler` umlenken. fetchHandler === null -> Original durchreichen.
  global.fetch = async (url, opts) => {
    if (fetchHandler && String(url).includes('/v2/check')) {
      return fetchHandler(url, opts);
    }
    return originalFetch(url, opts);
  };
  await startServer();
});

test.after(async () => {
  global.fetch = originalFetch;
  if (server) await new Promise(r => server.close(r));
  ctx.cleanup();
});

function setLT({ enabled, url, picky = false }) {
  const { db } = require('../../db/connection');
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value_json, encrypted, updated_at, updated_by)
    VALUES (?, ?, 0, datetime('now'), 'test')
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `);
  upsert.run('languagetool.enabled', JSON.stringify(enabled));
  upsert.run('languagetool.url',     JSON.stringify(url));
  upsert.run('languagetool.picky',   JSON.stringify(picky));
  const appSettings = require('../../lib/app-settings');
  appSettings.clearCache();
}

test('disabled -> 404 languagetool_disabled', async () => {
  setLT({ enabled: false, url: 'http://lt.lan:8010' });
  fetchHandler = null;
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hallo' }),
  });
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.equal(j.error, 'languagetool_disabled');
});

test('enabled but no URL -> 404 disabled', async () => {
  setLT({ enabled: true, url: '' });
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hallo' }),
  });
  assert.equal(r.status, 404);
});

test('upstream OK -> matches passed through', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  fetchHandler = async () => new Response(JSON.stringify({
    language: { code: 'de-CH' },
    matches: [
      { message: 'Tippfehler', offset: 0, length: 5, rule: { id: 'GERMAN_SPELLER', category: { id: 'TYPOS', name: 'Rechtschreibung' } }, replacements: [{ value: 'hallo' }] },
    ],
    software: { name: 'LanguageTool', version: '6.0' },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hallo welt', language: 'de-CH' }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(Array.isArray(j.matches), true);
  assert.equal(j.matches.length, 1);
  assert.equal(j.matches[0].rule.id, 'GERMAN_SPELLER');
});

test('upstream 500 -> 502 languagetool_upstream', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  fetchHandler = async () => new Response('boom', { status: 500 });
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hallo' }),
  });
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.error, 'languagetool_upstream');
  assert.equal(j.upstream_status, 500);
});

test('upstream abort -> 408 timeout', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  fetchHandler = async (_url, opts) => {
    // Signal-respektierender Abort: AbortError werfen.
    return new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
      // Triggern: bewusst abort werfen statt warten (vermeidet 10s-Wait).
      const err = new Error('aborted');
      err.name = 'AbortError';
      setTimeout(() => reject(err), 5);
    });
  };
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hallo' }),
  });
  assert.equal(r.status, 408);
});

test('empty text -> empty matches without upstream call', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  let called = false;
  fetchHandler = async () => { called = true; return new Response('{}', { status: 200 }); };
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '' }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j, { matches: [] });
  assert.equal(called, false);
});

test('URL with /v2 suffix is stripped before forwarding', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010/v2' });
  let capturedUrl = '';
  fetchHandler = async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ matches: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.equal(r.status, 200);
  assert.equal(capturedUrl, 'http://lt.lan:8010/v2/check');
});
