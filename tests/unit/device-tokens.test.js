'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Eigene Test-DB pro Lauf (Statement-Cache-Kollision bei paralleler Suite).
const tmp = path.join('/tmp', `device-tokens-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;

require('../../db/schema'); // triggert Connection + Migrationen (inkl. Mig 188)
const appUsers = require('../../db/app-users');
const deviceTokens = require('../../db/device-tokens');
const { tryDeviceAuth } = require('../../lib/device-auth');

function fakeReq(authHeader) {
  return { headers: authHeader ? { authorization: authHeader } : {}, ip: '127.0.0.1' };
}

test('createDeviceToken liefert swd_-Klartext genau einmal + speichert nur Hash', () => {
  const email = 'writer@x.test';
  appUsers.createUser({ email, displayName: 'Writer', globalRole: 'user', status: 'active' });

  const tok = deviceTokens.createDeviceToken({ userEmail: email, deviceName: 'MacBook', platform: 'macos' });
  assert.ok(tok.id);
  assert.match(tok.plain_token, /^swd_[0-9a-f]{64}$/);
  assert.equal(tok.device_name, 'MacBook');
  assert.equal(tok.platform, 'macos');
  assert.equal(tok.scopes, 'content:read,content:write');

  // Liste enthaelt KEINEN Klartext.
  const list = deviceTokens.listDeviceTokens(email);
  assert.equal(list.length, 1);
  assert.equal(list[0].plain_token, undefined);
});

test('findActiveTokenByPlain: gueltig / falscher Prefix / unbekannt', () => {
  const email = 'finder@x.test';
  appUsers.createUser({ email, displayName: 'Finder', globalRole: 'user', status: 'active' });
  const tok = deviceTokens.createDeviceToken({ userEmail: email, deviceName: 'Dev' });

  const found = deviceTokens.findActiveTokenByPlain(tok.plain_token);
  assert.equal(found.user_email, email);

  assert.equal(deviceTokens.findActiveTokenByPlain('sw_abc'), null);        // api_tokens-Prefix
  assert.equal(deviceTokens.findActiveTokenByPlain('swd_unknown'), null);   // existiert nicht
  assert.equal(deviceTokens.findActiveTokenByPlain(null), null);
});

test('tryDeviceAuth: gueltiger Token → echter User + Rolle', () => {
  const email = 'auth@x.test';
  appUsers.createUser({ email, displayName: 'Auth User', globalRole: 'admin', status: 'active' });
  const tok = deviceTokens.createDeviceToken({ userEmail: email, deviceName: 'Mac' });

  const u = tryDeviceAuth(fakeReq(`Bearer ${tok.plain_token}`));
  assert.equal(u.email, email);
  assert.equal(u.role, 'admin');          // echte Rolle, nicht hartkodiert
  assert.equal(u.via, 'device_token');
  assert.equal(u.name, 'Auth User');

  // last_used_at wird gesetzt.
  const row = deviceTokens.listDeviceTokens(email)[0];
  assert.ok(row.last_used_at);
});

test('tryDeviceAuth: kein/falscher Header → null', () => {
  assert.equal(tryDeviceAuth(fakeReq(null)), null);
  assert.equal(tryDeviceAuth(fakeReq('Bearer sw_metricstoken')), null); // api_token, kein device
  assert.equal(tryDeviceAuth(fakeReq('Basic xyz')), null);
});

test('tryDeviceAuth: suspended/deleted User → null', () => {
  const email = 'banned@x.test';
  appUsers.createUser({ email, displayName: 'Banned', globalRole: 'user', status: 'active' });
  const tok = deviceTokens.createDeviceToken({ userEmail: email, deviceName: 'Mac' });

  appUsers.setStatus(email, 'suspended');
  assert.equal(tryDeviceAuth(fakeReq(`Bearer ${tok.plain_token}`)), null);

  appUsers.setStatus(email, 'deleted');
  assert.equal(tryDeviceAuth(fakeReq(`Bearer ${tok.plain_token}`)), null);
});

test('revoke + expired → Token nicht mehr aktiv', () => {
  const email = 'revoke@x.test';
  appUsers.createUser({ email, displayName: 'Rev', globalRole: 'user', status: 'active' });

  const tok = deviceTokens.createDeviceToken({ userEmail: email, deviceName: 'A' });
  assert.ok(deviceTokens.revokeDeviceToken(tok.id, email));
  assert.equal(deviceTokens.findActiveTokenByPlain(tok.plain_token), null);
  // Revoke fremder Tokens schlaegt fehl.
  assert.equal(deviceTokens.revokeDeviceToken(tok.id, 'other@x.test'), false);

  const past = '2000-01-01T00:00:00.000Z';
  const expired = deviceTokens.createDeviceToken({ userEmail: email, deviceName: 'B', expiresAt: past });
  assert.equal(deviceTokens.findActiveTokenByPlain(expired.plain_token), null);
});

test('deleteDeviceToken entfernt endgueltig', () => {
  const email = 'del@x.test';
  appUsers.createUser({ email, displayName: 'Del', globalRole: 'user', status: 'active' });
  const tok = deviceTokens.createDeviceToken({ userEmail: email, deviceName: 'X' });

  assert.ok(deviceTokens.deleteDeviceToken(tok.id, email));
  assert.equal(deviceTokens.listDeviceTokens(email).length, 0);
});
