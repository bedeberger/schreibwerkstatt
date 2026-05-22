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

test('chunking: >50KB text is split, matches merged with absolute offsets', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  // Bau zwei 30KB-Paragraphen mit unterschiedlichem Inhalt; Chunker macht 2 Calls.
  const p1 = 'a'.repeat(30_000);
  const p2 = 'b'.repeat(30_000);
  const text = `${p1}\n\n${p2}`;
  let callCount = 0;
  const seenTexts = [];
  fetchHandler = async (_url, opts) => {
    callCount++;
    const params = new URLSearchParams(opts.body);
    const chunkText = params.get('text');
    seenTexts.push(chunkText.slice(0, 10));
    // Match-Offset 5 in jedem Chunk -> nach Adjust: 0 + 5 = 5, dann (30_000+2) + 5 fuer den 2. Chunk.
    return new Response(JSON.stringify({
      matches: [
        { message: 'm', offset: 5, length: 3, rule: { id: 'X' }, replacements: [] },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language: 'de-DE' }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(callCount, 2);
  assert.equal(j.chunks, 2);
  assert.equal(j.matches.length, 2);
  // Erster match bei offset 5, zweiter offset 5 + Position des 2. Chunks im Original.
  assert.equal(j.matches[0].offset, 5);
  assert.ok(j.matches[1].offset >= 30_000);
});

test('per-page-cache: hit serves without upstream call', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  // Seed Page in DB damit FK aufgeht.
  const { db } = require('../../db/connection');
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ${now}, ${now})`).run(900001, 'lt-test-book');
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, body_html, updated_at) VALUES (?, ?, ?, ?, ${now})`)
    .run(900001, 900001, 'p', '<p>h</p>');

  let calls = 0;
  fetchHandler = async () => {
    calls++;
    return new Response(JSON.stringify({
      matches: [{ offset: 0, length: 5, rule: { id: 'X' }, replacements: [] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const body = { text: 'hallo welt', language: 'de-DE', pageId: 900001 };

  const r1 = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.equal(j1.cached, undefined);
  assert.equal(calls, 1);

  const r2 = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(r2.status, 200);
  const j2 = await r2.json();
  assert.equal(j2.cached, true);
  assert.equal(calls, 1, 'no second upstream call');
  assert.equal(j2.matches.length, 1);

  // Cleanup
  db.prepare('DELETE FROM pages WHERE page_id = ?').run(900001);
  db.prepare('DELETE FROM books WHERE book_id = ?').run(900001);
});

test('text >TEXT_MAX (500KB) -> 413', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  fetchHandler = async () => new Response('{}', { status: 200 });
  // 600KB text.
  const text = 'x'.repeat(600_000);
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  assert.equal(r.status, 413);
  const j = await r.json();
  assert.equal(j.error, 'text_too_large');
});
