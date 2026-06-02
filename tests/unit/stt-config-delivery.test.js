'use strict';
// /config liefert den stt-Block: enabled + VAD-Schwellen, aber NIEMALS
// Host/Key/Model/Language (Secret-Leck-Schutz). Sprache loest der Proxy pro
// Request aus der Buch-Locale auf, nicht das Frontend.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const tmpDb = path.join(os.tmpdir(), `stt-config-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-crypto-derive';
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appSettings = require('../../lib/app-settings');

const express = require('express');
const { router: proxiesRouter } = require('../../routes/proxies');

const app = express();
app.use((req, _res, next) => { req.session = { user: { email: 'tester@test.dev' } }; next(); });
app.use(proxiesRouter);
const server = app.listen(0);
const port = server.address().port;

test.after(() => {
  server.close();
  try { db.close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + ext); } catch {} }
});

function getConfig() {
  return new Promise((resolve, reject) => {
    http.get({ port, path: '/config' }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    }).on('error', reject);
  });
}

test('stt disabled by default -> enabled=false, kein Secret-Feld', async () => {
  const { json } = await getConfig();
  assert.ok(json.stt, 'stt-Block vorhanden');
  assert.equal(json.stt.enabled, false);
  assert.equal(json.stt.provider, 'openai-compat');
  assert.deepEqual(Object.keys(json.stt.vad).sort(), ['maxSegmentS', 'silenceMs', 'threshold']);
});

test('enabled + host -> enabled=true; weder host/key/model/language im Block', async () => {
  appSettings.set('stt.enabled', true, { updatedBy: 'test' });
  appSettings.set('stt.host', 'http://whisper.lan:8000', { updatedBy: 'test' });
  appSettings.set('stt.model', 'whisper-large', { updatedBy: 'test' });
  appSettings.set('stt.language', 'en', { updatedBy: 'test' });
  appSettings.set('stt.api_key', 'sk-top-secret', { updatedBy: 'test' });
  appSettings.clearCache();

  const { json } = await getConfig();
  assert.equal(json.stt.enabled, true);

  const blob = JSON.stringify(json);
  assert.ok(!blob.includes('whisper.lan'), 'host leakt nicht');
  assert.ok(!blob.includes('sk-top-secret'), 'api_key leakt nicht');
  assert.ok(!blob.includes('whisper-large'), 'model leakt nicht');
  assert.equal(json.stt.host, undefined);
  assert.equal(json.stt.api_key, undefined);
  assert.equal(json.stt.model, undefined);
  assert.equal(json.stt.language, undefined);
});

test('enabled aber host leer -> enabled=false', async () => {
  appSettings.set('stt.enabled', true, { updatedBy: 'test' });
  appSettings.set('stt.host', '', { updatedBy: 'test' });
  appSettings.clearCache();
  const { json } = await getConfig();
  assert.equal(json.stt.enabled, false);
});

test('VAD-Schwellen kommen aus app_settings durch', async () => {
  appSettings.set('stt.vad.silence_ms', 1200, { updatedBy: 'test' });
  appSettings.set('stt.vad.threshold', 0.02, { updatedBy: 'test' });
  appSettings.set('stt.vad.max_segment_s', 45, { updatedBy: 'test' });
  appSettings.clearCache();
  const { json } = await getConfig();
  assert.equal(json.stt.vad.silenceMs, 1200);
  assert.equal(json.stt.vad.threshold, 0.02);
  assert.equal(json.stt.vad.maxSegmentS, 45);
});
