'use strict';
// /config liefert den tts-Block: nur `enabled`, aber NIEMALS Host/Key/Model/
// Voice/Speed/Format (Secret-Leck-Schutz). Die Synthese laeuft komplett ueber
// den /tts/speak-Proxy.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const tmpDb = path.join(os.tmpdir(), `tts-config-${process.pid}-${Date.now()}.db`);
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

test('tts disabled by default -> enabled=false, kein Secret-Feld', async () => {
  const { json } = await getConfig();
  assert.ok(json.tts, 'tts-Block vorhanden');
  assert.equal(json.tts.enabled, false);
  // Erlaubt sind nur nicht-geheime Felder: enabled + die browserseitigen
  // Atempausen (analog STT-VAD-Schwellen). Host/Key/Model/Voice/Speed/Format
  // bleiben serverseitig (eigene Asserts unten).
  assert.deepEqual(Object.keys(json.tts).sort(), ['enabled', 'pause']);
  assert.equal(typeof json.tts.pause.fragmentMs, 'number');
  assert.equal(typeof json.tts.pause.paragraphMs, 'number');
});

test('enabled + host -> enabled=true; weder host/key/model/voice im Block', async () => {
  appSettings.set('tts.enabled', true, { updatedBy: 'test' });
  appSettings.set('tts.host', 'http://tts.lan:8880', { updatedBy: 'test' });
  appSettings.set('tts.model', 'tts-1-hd', { updatedBy: 'test' });
  appSettings.set('tts.voice', 'af_secret_voice', { updatedBy: 'test' });
  appSettings.set('tts.api_key', 'sk-top-secret', { updatedBy: 'test' });
  appSettings.clearCache();

  const { json } = await getConfig();
  assert.equal(json.tts.enabled, true);

  const blob = JSON.stringify(json);
  assert.ok(!blob.includes('tts.lan'), 'host leakt nicht');
  assert.ok(!blob.includes('sk-top-secret'), 'api_key leakt nicht');
  assert.ok(!blob.includes('tts-1-hd'), 'model leakt nicht');
  assert.ok(!blob.includes('af_secret_voice'), 'voice leakt nicht');
  assert.equal(json.tts.host, undefined);
  assert.equal(json.tts.api_key, undefined);
  assert.equal(json.tts.model, undefined);
  assert.equal(json.tts.voice, undefined);
});

test('enabled aber host leer -> enabled=false', async () => {
  appSettings.set('tts.enabled', true, { updatedBy: 'test' });
  appSettings.set('tts.host', '', { updatedBy: 'test' });
  appSettings.clearCache();
  const { json } = await getConfig();
  assert.equal(json.tts.enabled, false);
});
