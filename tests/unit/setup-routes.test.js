'use strict';
// Phase 4c1 (BookStack-Exit): /setup-Wizard-Endpoints.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const tmpDb = path.join(os.tmpdir(), `setup-routes-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-crypto-derive';
process.env.ADMIN_EMAIL = 'alice@example.com';

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const appSettings = require('../../lib/app-settings');
appUsers.createUser({ email: 'alice@example.com', displayName: 'Alice', globalRole: 'admin' });
appUsers.createUser({ email: 'bob@example.com',   displayName: 'Bob',   globalRole: 'user' });

const express = require('express');
const setupRouter = require('../../routes/setup');

const app = express();
app.use((req, res, next) => {
  const email = req.headers['x-test-user-email'];
  if (email) {
    req.session = { user: { email, name: email, role: req.headers['x-test-user-role'] || 'user' } };
  } else {
    req.session = {};
  }
  next();
});
app.use('/setup', setupRouter);

const server = app.listen(0);
const port = server.address().port;

test.after(() => {
  server.close();
  try { db.close(); } catch {}
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
});

function _req(method, urlPath, { user = null, role = 'user', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (user) {
      headers['x-test-user-email'] = user;
      headers['x-test-user-role'] = role;
    }
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('GET /setup → HTML wird ausgeliefert (auch unauth, Auth-Guard sitzt ausserhalb)', async () => {
  // Direkt am Router: kein Auth-Guard davor. setup.html wird per sendFile geliefert.
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/setup', method: 'GET' }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'], body: buf }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(r.status, 200);
  assert.match(r.ct || '', /text\/html/);
  assert.match(r.body, /setup-shell/);
});

test('GET /setup/state ohne Login → 401', async () => {
  const r = await _req('GET', '/setup/state');
  assert.equal(r.status, 401);
});

test('GET /setup/state als User → 403', async () => {
  const r = await _req('GET', '/setup/state', { user: 'bob@example.com' });
  assert.equal(r.status, 403);
});

test('GET /setup/state als Admin → 200, liefert Steps/Values/Masked', async () => {
  const r = await _req('GET', '/setup/state', { user: 'alice@example.com', role: 'admin' });
  assert.equal(r.status, 200);
  assert.equal(r.body.admin_email, 'alice@example.com');
  assert.equal(typeof r.body.setup_completed, 'boolean');
  assert.ok(r.body.steps);
  assert.ok(r.body.values);
  assert.ok(r.body.masked);
  // Default-only (kein DB-Row) zaehlt nicht als ausgefuellt.
  assert.equal(r.body.steps.publicUrl, false);
});

test('POST /setup/public-url leerer Wert → 400', async () => {
  const r = await _req('POST', '/setup/public-url', {
    user: 'alice@example.com', role: 'admin',
    body: { publicUrl: '' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error_code, 'PUBLIC_URL_REQUIRED');
});

test('POST /setup/public-url ungueltige URL → 400', async () => {
  const r = await _req('POST', '/setup/public-url', {
    user: 'alice@example.com', role: 'admin',
    body: { publicUrl: 'not a url' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error_code, 'PUBLIC_URL_INVALID');
});

test('POST /setup/public-url ok → trailing-slash gestrippt + persistiert', async () => {
  const r = await _req('POST', '/setup/public-url', {
    user: 'alice@example.com', role: 'admin',
    body: { publicUrl: 'https://app.example.com/' },
  });
  assert.equal(r.status, 200);
  assert.equal(appSettings.get('app.public_url'), 'https://app.example.com');
});

test('POST /setup/oauth (encrypted) → persistiert, leerer secret bleibt ungespeichert', async () => {
  const r = await _req('POST', '/setup/oauth', {
    user: 'alice@example.com', role: 'admin',
    body: { clientId: 'goog-client-id-9000', clientSecret: 'goog-secret' },
  });
  assert.equal(r.status, 200);
  assert.equal(appSettings.get('auth.google.client_id'), 'goog-client-id-9000');
  assert.equal(appSettings.get('auth.google.client_secret'), 'goog-secret');

  // Erneut mit leerem Secret → nicht ueberschrieben
  const r2 = await _req('POST', '/setup/oauth', {
    user: 'alice@example.com', role: 'admin',
    body: { clientId: 'goog-client-id-new', clientSecret: '' },
  });
  assert.equal(r2.status, 200);
  assert.equal(appSettings.get('auth.google.client_id'), 'goog-client-id-new');
  assert.equal(appSettings.get('auth.google.client_secret'), 'goog-secret');
});

test('POST /setup/ai validiert Provider', async () => {
  const r = await _req('POST', '/setup/ai', {
    user: 'alice@example.com', role: 'admin',
    body: { provider: 'gpt4' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error_code, 'PROVIDER_INVALID');
});

test('POST /setup/ai claude mit Key → persistiert', async () => {
  const r = await _req('POST', '/setup/ai', {
    user: 'alice@example.com', role: 'admin',
    body: { provider: 'claude', claudeApiKey: 'sk-ant-test', claudeModel: 'claude-haiku' },
  });
  assert.equal(r.status, 200);
  assert.equal(appSettings.get('ai.provider'), 'claude');
  assert.equal(appSettings.get('ai.claude.api_key'), 'sk-ant-test');
  assert.equal(appSettings.get('ai.claude.model'), 'claude-haiku');
});

test('POST /setup/backend localdb → persistiert', async () => {
  const r = await _req('POST', '/setup/backend', {
    user: 'alice@example.com', role: 'admin',
    body: { backend: 'localdb' },
  });
  assert.equal(r.status, 200);
  assert.equal(appSettings.get('app.backend'), 'localdb');
});

test('POST /setup/backend ungueltig → 400', async () => {
  const r = await _req('POST', '/setup/backend', {
    user: 'alice@example.com', role: 'admin',
    body: { backend: 'mysql' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error_code, 'BACKEND_INVALID');
});

test('POST /setup/emails leer ok', async () => {
  const r = await _req('POST', '/setup/emails', {
    user: 'alice@example.com', role: 'admin',
    body: { allowedEmails: 'a@x.com, b@y.com' },
  });
  assert.equal(r.status, 200);
  assert.equal(appSettings.get('auth.allowed_emails'), 'a@x.com, b@y.com');
});

test('POST /setup/smtp disabled → mode persistiert', async () => {
  const r = await _req('POST', '/setup/smtp', {
    user: 'alice@example.com', role: 'admin',
    body: { mode: 'disabled' },
  });
  assert.equal(r.status, 200);
  assert.equal(appSettings.get('smtp.mode'), 'disabled');
});

test('POST /setup/smtp ungueltiger mode → 400', async () => {
  const r = await _req('POST', '/setup/smtp', {
    user: 'alice@example.com', role: 'admin',
    body: { mode: 'sendgrid' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error_code, 'SMTP_MODE_INVALID');
});

test('POST /setup/unknown-step → 404', async () => {
  const r = await _req('POST', '/setup/foo-bar', {
    user: 'alice@example.com', role: 'admin',
    body: {},
  });
  assert.equal(r.status, 404);
});

test('POST /setup/complete → setup_completed=true + admin_email gespiegelt', async () => {
  const r = await _req('POST', '/setup/complete', {
    user: 'alice@example.com', role: 'admin',
  });
  assert.equal(r.status, 200);
  assert.equal(appSettings.get('app.setup_completed'), true);
  assert.equal(appSettings.get('auth.admin_email'), 'alice@example.com');
});

test('POST /setup/test/smtp ohne Mailer → MAILER_NOT_AVAILABLE', async () => {
  const r = await _req('POST', '/setup/test/smtp', {
    user: 'alice@example.com', role: 'admin',
    body: { to: 'alice@example.com' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error, 'MAILER_NOT_AVAILABLE');
});
