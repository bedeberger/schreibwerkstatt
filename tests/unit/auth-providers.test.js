'use strict';
// Anmeldeverfahren: Registry-Vertrag + der lokale Weg von Ende zu Ende
// (Einladung → Passwort setzen → Anmeldung → Initialpasswort → Reset).
//
// Der Registry-Teil haelt die eine Sorte Drift fest, die man sonst erst in
// Produktion sieht: die `oneOf`-Liste von `auth.method` und die tatsaechlich
// vorhandenen Provider-Module sind zwei Listen ueber dieselbe Sache.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');

const { useTmpDb } = require('./_helpers/tmp-db');
const tmpDb = useTmpDb('auth-providers');
process.env.SESSION_SECRET = 'a'.repeat(32);
delete process.env.ADMIN_PASSWORD;
delete process.env.DEMO_PASSWORD;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appSettings = require('../../lib/app-settings');
const appUsers = require('../../db/app-users');
const creds = require('../../db/user-credentials');
const password = require('../../lib/password');
const providers = require('../../routes/auth/providers');
const { SETTINGS } = require('../../lib/app-settings/registry');
const rl = require('../../lib/admin-login-ratelimit');
const authRouter = require('../../routes/auth');

// Mailer stilllegen: die Tests pruefen den Link, nicht den Versand.
require('../../lib/mailer')._setTestTransportFactory(() => null);

const app = express();
app.use((req, res, next) => {
  if (!req.session) {
    req.session = { destroy: cb => { req.session = null; cb && cb(); }, save: cb => cb && cb() };
  }
  next();
});
app.use(authRouter);
const server = app.listen(0);
const port = server.address().port;

test.beforeEach(() => rl._resetAll());
test.after(() => {
  server.close();
});

function _req(method, urlPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { 'content-type': 'application/json', ...headers };
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: h }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: json, raw: buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const setMethod = (m) => appSettings.set('auth.method', m, { updatedBy: 'test' });

// ── Registry ───────────────────────────────────────────────────────────────

test('Registry und auth.method-oneOf beschreiben dieselbe Menge', () => {
  const oneOf = SETTINGS['auth.method'].validate.oneOf;
  assert.deepEqual([...providers.PROVIDER_IDS].sort(), [...oneOf].sort());
});

test('Jeder Provider erfüllt den Vertrag', () => {
  for (const p of providers.listProviders()) {
    assert.equal(typeof p.id, 'string', 'id');
    assert.ok(p.router, `${p.id}: router`);
    assert.equal(typeof p.isConfigured, 'function', `${p.id}: isConfigured`);
    assert.ok(Array.isArray(p.configKeys), `${p.id}: configKeys`);
    assert.equal(typeof p.inviteRedirect, 'function', `${p.id}: inviteRedirect`);
    assert.equal(typeof p.renderLoginBlock, 'function', `${p.id}: renderLoginBlock`);
    assert.equal(typeof p.loginScripts, 'function', `${p.id}: loginScripts`);
    // Jeder genannte Settings-Key muss die Registry kennen — sonst rendert das
    // Admin-UI ein Feld, das der PUT-Handler danach ablehnt.
    for (const k of p.configKeys) {
      assert.ok(Object.prototype.hasOwnProperty.call(SETTINGS, k), `${p.id}: unbekannter Key ${k}`);
    }
  }
});

test('activeProviderId liefert immer ein bekanntes Verfahren', () => {
  // Die Registry darf nie „kein Verfahren" melden: ein unbekannter Wert (etwa
  // nach einem Downgrade, das ein Verfahren nicht mehr kennt) faellt auf
  // google zurueck, statt die Instanz ohne Anmeldeweg zurueckzulassen.
  assert.equal(providers.getProvider('quantenlogin'), null);
  for (const m of ['google', 'local']) {
    setMethod(m);
    assert.equal(providers.activeProviderId(), m);
    assert.ok(providers.activeProvider(), `kein Provider fuer ${m}`);
    assert.ok(providers.PROVIDER_IDS.includes(providers.activeProviderId()));
  }
});

// ── Login-Seite je Verfahren ───────────────────────────────────────────────

test('GET /login zeigt genau den Block des aktiven Verfahrens', async () => {
  appSettings.set('auth.google.client_id', 'cid', { updatedBy: 'test' });
  appSettings.set('auth.google.client_secret', 'csec', { updatedBy: 'test' });

  setMethod('google');
  const g = await _req('GET', '/login');
  assert.match(g.raw, /Mit Google anmelden/);
  assert.doesNotMatch(g.raw, /local-form/);

  setMethod('local');
  const l = await _req('GET', '/login');
  assert.match(l.raw, /local-form/);
  assert.match(l.raw, /\/auth\/local-login/);
  assert.doesNotMatch(l.raw, /Mit Google anmelden/);
});

test('Einladungslink führt je Verfahren woandershin', async () => {
  const inv = appUsers.createInvite({ email: 'neu@example.com', invitedBy: 'admin@example.com' });
  appUsers.createUser({ email: 'admin@example.com', globalRole: 'admin', status: 'active' });

  setMethod('google');
  const g = await _req('GET', `/invite/${inv.invite_token}`);
  assert.equal(g.status, 302);
  assert.match(g.headers.location, /^\/login\?returnTo=/);

  setMethod('local');
  const l = await _req('GET', `/invite/${inv.invite_token}`);
  assert.equal(l.status, 302);
  assert.match(l.headers.location, /^\/auth\/password\?invite=/);
});

test('Provider-Routen des inaktiven Verfahrens sind nicht erreichbar', async () => {
  setMethod('google');
  const r = await _req('POST', '/auth/local-login', { body: { email: 'x@y.z', password: 'egal' } });
  assert.equal(r.status, 404, 'lokaler Login darf bei auth.method=google nicht antworten');
});

// ── Lokaler Weg von Ende zu Ende ───────────────────────────────────────────

test('Einladung → Passwort setzen legt das Konto an und meldet an', async () => {
  setMethod('local');
  const inv = appUsers.createInvite({ email: 'lokal@example.com', invitedBy: 'admin@example.com' });

  const page = await _req('GET', `/auth/password?invite=${inv.invite_token}`);
  assert.equal(page.status, 200);
  assert.match(page.raw, /password-form/);
  assert.match(page.raw, /lokal@example\.com/);

  const r = await _req('POST', '/auth/password', {
    body: { invite: inv.invite_token, password: 'ein-langes-passwort', displayName: 'Lokale Autorin' },
  });
  assert.ok([200, 500].includes(r.status), `unerwartet ${r.status}`); // 500 = session.save der Mini-App

  const u = appUsers.getUser('lokal@example.com');
  assert.ok(u, 'Konto fehlt');
  assert.equal(u.display_name, 'Lokale Autorin');
  assert.equal(u.status, 'active');
  assert.ok(creds.hasPassword('lokal@example.com'));
  assert.equal(appUsers.inviteStatus(appUsers.findInviteByToken(inv.invite_token)), 'accepted');
});

test('Einladungs-Token ist danach verbraucht', async () => {
  setMethod('local');
  const inv = appUsers.createInvite({ email: 'einmal@example.com', invitedBy: 'admin@example.com' });
  await _req('POST', '/auth/password', { body: { invite: inv.invite_token, password: 'ein-langes-passwort' } });
  const again = await _req('POST', '/auth/password', { body: { invite: inv.invite_token, password: 'anderes-langes-pw' } });
  assert.equal(again.status, 400);
  assert.equal(again.body.error_code, 'TOKEN_INVALID');
});

test('POST /auth/local-login: falsches Passwort → 401, richtiges → Sitzung', async () => {
  setMethod('local');
  const bad = await _req('POST', '/auth/local-login', {
    body: { email: 'lokal@example.com', password: 'daneben-daneben' },
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error_code, 'INVALID_CREDENTIALS');

  rl._resetAll();
  const good = await _req('POST', '/auth/local-login', {
    body: { email: 'lokal@example.com', password: 'ein-langes-passwort' },
  });
  assert.ok([200, 500].includes(good.status), `unerwartet ${good.status}`);
  assert.ok(appUsers.listAuditForUser('lokal@example.com')
    .some(e => e.event === 'login' && JSON.parse(e.meta_json || '{}').method === 'local'));
});

test('Unbekannte Adresse: 401 ohne Hinweis darauf, dass es sie nicht gibt', async () => {
  setMethod('local');
  const r = await _req('POST', '/auth/local-login', {
    body: { email: 'gibtsnicht@example.com', password: 'ein-langes-passwort' },
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.error_code, 'INVALID_CREDENTIALS');
});

test('Initialpasswort (must_change): Login öffnet keine Sitzung, sondern schickt auf die Setz-Seite', async () => {
  setMethod('local');
  appUsers.createUser({ email: 'initial@example.com', globalRole: 'user', status: 'active' });
  creds.setPassword('initial@example.com', await password.hashPassword('vom-admin-vergeben'), {
    mustChange: 1, updatedBy: 'admin@example.com',
  });

  const r = await _req('POST', '/auth/local-login', {
    body: { email: 'initial@example.com', password: 'vom-admin-vergeben' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.redirect, /^\/auth\/password\?token=/);
  // Kein login-Event: es ist keine Sitzung entstanden.
  assert.equal(
    appUsers.listAuditForUser('initial@example.com').filter(e => e.event === 'login').length, 0,
  );

  // Das mitgelieferte Token traegt den Wechsel.
  const token = new URL(r.body.redirect, 'http://x').searchParams.get('token');
  const set = await _req('POST', '/auth/password', { body: { token, password: 'jetzt-mein-eigenes' } });
  assert.ok([200, 500].includes(set.status), `unerwartet ${set.status}`);
  assert.equal(creds.getCredential('initial@example.com').must_change, 0);

  rl._resetAll();
  const login = await _req('POST', '/auth/local-login', {
    body: { email: 'initial@example.com', password: 'jetzt-mein-eigenes' },
  });
  assert.ok([200, 500].includes(login.status));
  assert.ok(!login.body?.redirect, 'nach dem Wechsel darf kein Redirect mehr kommen');
});

test('Zu kurzes Passwort wird abgewiesen', async () => {
  setMethod('local');
  appSettings.set('auth.local.min_password_length', 12, { updatedBy: 'test' });
  const inv = appUsers.createInvite({ email: 'kurz@example.com', invitedBy: 'admin@example.com' });
  const r = await _req('POST', '/auth/password', { body: { invite: inv.invite_token, password: 'kurz' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error_code, 'PASSWORD_WEAK');
  assert.equal(appUsers.getUser('kurz@example.com'), null, 'Konto darf nicht entstanden sein');
});

test('Gesperrtes Konto kommt nicht durch', async () => {
  setMethod('local');
  appUsers.setStatus('lokal@example.com', 'suspended');
  rl._resetAll();
  const r = await _req('POST', '/auth/local-login', {
    body: { email: 'lokal@example.com', password: 'ein-langes-passwort' },
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error_code, 'USER_NOT_ACTIVE');
  appUsers.setStatus('lokal@example.com', 'active');
});

test('POST /auth/forgot antwortet für bekannte wie unbekannte Adressen gleich', async () => {
  setMethod('local');
  appSettings.set('auth.local.allow_self_reset', true, { updatedBy: 'test' });
  const known = await _req('POST', '/auth/forgot', { body: { email: 'lokal@example.com' } });
  rl._resetAll();
  const unknown = await _req('POST', '/auth/forgot', { body: { email: 'niemand@example.com' } });
  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(known.body, unknown.body);
  // Nur fuer das echte Konto entsteht ein Token.
  assert.ok(appUsers.listAuditForUser('lokal@example.com').some(e => e.event === 'password-reset-requested'));
});

test('auth.local.allow_self_reset=false schaltet den Reset-Weg ab', async () => {
  setMethod('local');
  appSettings.set('auth.local.allow_self_reset', false, { updatedBy: 'test' });
  rl._resetAll();
  const post = await _req('POST', '/auth/forgot', { body: { email: 'lokal@example.com' } });
  assert.equal(post.status, 404);
  const page = await _req('GET', '/auth/forgot');
  assert.equal(page.status, 404);
  const login = await _req('GET', '/login');
  assert.doesNotMatch(login.raw, /\/auth\/forgot/, 'Link darf dann nicht auf der Login-Seite stehen');
  appSettings.set('auth.local.allow_self_reset', true, { updatedBy: 'test' });
});

test('Abgelaufenes Token wird abgewiesen', async () => {
  setMethod('local');
  const { token } = creds.createToken('lokal@example.com', { purpose: 'reset', ttlHours: 1 });
  db.prepare("UPDATE user_password_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_email = ?")
    .run('lokal@example.com');
  const r = await _req('POST', '/auth/password', { body: { token, password: 'ein-langes-passwort' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error_code, 'TOKEN_INVALID');
});

test('Ein neuer Link entwertet den vorherigen', async () => {
  setMethod('local');
  const first = creds.createToken('lokal@example.com', { purpose: 'reset' });
  const second = creds.createToken('lokal@example.com', { purpose: 'reset' });
  assert.equal(creds.findValidToken(first.token), null, 'alter Link muss tot sein');
  assert.ok(creds.findValidToken(second.token), 'neuer Link muss gelten');
});
