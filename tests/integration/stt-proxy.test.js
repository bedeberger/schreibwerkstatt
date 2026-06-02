'use strict';
// Integration-Test fuer /stt/transcribe. Mockt den OpenAI-kompatiblen Whisper-
// Upstream via globalem fetch-Stub und prueft: disabled->404, kein/falsches
// Audio->400/415, enabled->Forward+{text}, Upstream-Fehler->502, Timeout->408,
// Buch-Locale gewinnt als Sprache, Secret bleibt server-seitig.

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
    const sttRouter = require('../../routes/stt');
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: 'tester@test.dev' } }; next(); });
    app.use('/stt', sttRouter);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

test.before(async () => {
  // Encrypted-Key (stt.api_key) braucht SESSION_SECRET fuer crypto.
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-stt';
  ctx = bootstrap();
  originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (fetchHandler && String(url).includes('/v1/audio/transcriptions')) {
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

function setStt({ enabled, host, model = 'whisper-1', apiKey = '', language = 'de' }) {
  const appSettings = require('../../lib/app-settings');
  appSettings.set('stt.enabled', enabled, { updatedBy: 'test' });
  appSettings.set('stt.host', host, { updatedBy: 'test' });
  appSettings.set('stt.model', model, { updatedBy: 'test' });
  appSettings.set('stt.language', language, { updatedBy: 'test' });
  if (apiKey) appSettings.set('stt.api_key', apiKey, { updatedBy: 'test' });
  appSettings.clearCache();
}

function postAudio(body, { contentType = 'audio/webm;codecs=opus', query = '' } = {}) {
  return originalFetch(`${baseUrl}/stt/transcribe${query}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
}

test('disabled -> 404 stt_disabled', async () => {
  setStt({ enabled: false, host: 'http://whisper.lan:8000' });
  fetchHandler = null;
  const r = await postAudio(Buffer.from('AAAA'));
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'stt_disabled');
});

test('enabled but no host -> 404 disabled', async () => {
  setStt({ enabled: true, host: '' });
  const r = await postAudio(Buffer.from('AAAA'));
  assert.equal(r.status, 404);
});

test('empty body -> 400 stt_no_audio', async () => {
  setStt({ enabled: true, host: 'http://whisper.lan:8000' });
  const r = await postAudio(Buffer.alloc(0));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'stt_no_audio');
});

test('unsupported mime -> 415', async () => {
  setStt({ enabled: true, host: 'http://whisper.lan:8000' });
  const r = await postAudio(Buffer.from('xxxx'), { contentType: 'audio/flac' });
  assert.equal(r.status, 415);
  assert.equal((await r.json()).error, 'stt_unsupported_audio');
});

test('upstream OK -> { text } passed through, secret bleibt server-seitig', async () => {
  setStt({ enabled: true, host: 'http://whisper.lan:8000', apiKey: 'sk-secret-123' });
  let sawAuth = null;
  let sawUrl = '';
  fetchHandler = async (url, opts) => {
    sawUrl = String(url);
    sawAuth = opts.headers?.Authorization || opts.headers?.authorization || null;
    return new Response(JSON.stringify({ text: 'Hallo Welt.' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const r = await postAudio(Buffer.from('webmdata'));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).text, 'Hallo Welt.');
  assert.equal(sawUrl, 'http://whisper.lan:8000/v1/audio/transcriptions');
  assert.equal(sawAuth, 'Bearer sk-secret-123');
});

test('host mit /v1-Suffix wird gestrippt', async () => {
  setStt({ enabled: true, host: 'http://whisper.lan:8000/v1' });
  let sawUrl = '';
  fetchHandler = async (url) => {
    sawUrl = String(url);
    return new Response(JSON.stringify({ text: 'x' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const r = await postAudio(Buffer.from('d'));
  assert.equal(r.status, 200);
  assert.equal(sawUrl, 'http://whisper.lan:8000/v1/audio/transcriptions');
});

test('Buch-Locale gewinnt als Sprache (de-CH -> de)', async () => {
  setStt({ enabled: true, host: 'http://whisper.lan:8000', language: 'en' });
  const { db } = require('../../db/connection');
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ${now}, ${now})`)
    .run(910001, 'stt-locale-book');
  db.prepare(`INSERT INTO book_settings (book_id, language, region, updated_at) VALUES (?, ?, ?, ${now})`)
    .run(910001, 'de', 'CH');
  let sawLang = null;
  fetchHandler = async (_url, opts) => {
    const form = opts.body;
    sawLang = form.get('language');
    return new Response(JSON.stringify({ text: 'x' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const r = await postAudio(Buffer.from('d'), { query: '?bookId=910001' });
  assert.equal(r.status, 200);
  assert.equal(sawLang, 'de');
  db.prepare('DELETE FROM book_settings WHERE book_id = ?').run(910001);
  db.prepare('DELETE FROM books WHERE book_id = ?').run(910001);
});

test('temperature aus App-Setting wird forwarded (Default 0)', async () => {
  const appSettings = require('../../lib/app-settings');
  setStt({ enabled: true, host: 'http://whisper.lan:8000' });
  let sawTemp = null;
  fetchHandler = async (_url, opts) => {
    sawTemp = opts.body.get('temperature');
    return new Response(JSON.stringify({ text: 'x' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  let r = await postAudio(Buffer.from('d'));
  assert.equal(r.status, 200);
  assert.equal(sawTemp, '0');

  appSettings.set('stt.temperature', 0.3, { updatedBy: 'test' });
  appSettings.clearCache();
  r = await postAudio(Buffer.from('d'));
  assert.equal(r.status, 200);
  assert.equal(sawTemp, '0.3');
  appSettings.set('stt.temperature', 0, { updatedBy: 'test' });
  appSettings.clearCache();
});

test('upstream 500 -> 502 stt_upstream', async () => {
  setStt({ enabled: true, host: 'http://whisper.lan:8000' });
  fetchHandler = async () => new Response('boom', { status: 500 });
  const r = await postAudio(Buffer.from('d'));
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.error, 'stt_upstream');
  assert.equal(j.upstream_status, 500);
});

test('upstream abort -> 408 stt_timeout', async () => {
  setStt({ enabled: true, host: 'http://whisper.lan:8000' });
  fetchHandler = async (_url, opts) => new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener('abort', () => {
      const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
    });
    const err = new Error('aborted'); err.name = 'AbortError';
    setTimeout(() => reject(err), 5);
  });
  const r = await postAudio(Buffer.from('d'));
  assert.equal(r.status, 408);
  assert.equal((await r.json()).error, 'stt_timeout');
});
