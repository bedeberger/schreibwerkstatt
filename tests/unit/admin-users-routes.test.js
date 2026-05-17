'use strict';
// /admin/users + /me/invite Endpoints.
//
// Test mountet die Router auf einer Mini-Express-Instanz und ruft sie
// via http direkt auf (kein Playwright / Supertest noetig). Session wird
// per Middleware vorgegaukelt.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const tmpDb = path.join(os.tmpdir(), `admin-users-routes-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');

const express = require('express');
const adminUsersRouter = require('../../routes/admin-users');
const userSettingsRouter = require('../../routes/usersettings');

// Mini-App: Middleware setzt session.user aus X-Test-User-Header.
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
app.use('/admin/users', adminUsersRouter);
app.use('/me', userSettingsRouter);

const server = app.listen(0);
const port = server.address().port;

test.after(() => {
  server.close();
  try { db.close(); } catch {}
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
});

// Seed: alice=admin, bob=user mit invite-Recht, carol=user ohne Invite-Recht.
appUsers.createUser({ email: 'alice@example.com', displayName: 'Alice', globalRole: 'admin' });
appUsers.createUser({ email: 'bob@example.com',   displayName: 'Bob',   globalRole: 'user', canInviteUsers: 1 });
appUsers.createUser({ email: 'carol@example.com', displayName: 'Carol', globalRole: 'user', canInviteUsers: 0 });
// users-Settings-Row, damit /me/settings nicht 404 liefert.
db.prepare(`INSERT INTO users (email, name, created_at) VALUES ('alice@example.com','Alice',datetime('now'))`).run();
db.prepare(`INSERT INTO users (email, name, created_at) VALUES ('bob@example.com',  'Bob',  datetime('now'))`).run();
db.prepare(`INSERT INTO users (email, name, created_at) VALUES ('carol@example.com','Carol',datetime('now'))`).run();

function _request(method, urlPath, { user = null, role = 'user', body = null } = {}) {
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
        resolve({ status: res.statusCode, body: json, raw: buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('GET /admin/users ohne Login → 401', async () => {
  const r = await _request('GET', '/admin/users');
  assert.equal(r.status, 401);
  assert.equal(r.body.error_code, 'NOT_LOGGED_IN');
});

test('GET /admin/users als User → 403', async () => {
  const r = await _request('GET', '/admin/users', { user: 'bob@example.com' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error_code, 'ADMIN_REQUIRED');
});

test('GET /admin/users als Admin → 200 + Liste', async () => {
  const r = await _request('GET', '/admin/users', { user: 'alice@example.com', role: 'admin' });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.users));
  assert.ok(r.body.users.length >= 3);
});

test('POST /admin/users/invite als Admin → 200 + Token', async () => {
  const r = await _request('POST', '/admin/users/invite', {
    user: 'alice@example.com', role: 'admin',
    body: { email: 'newcomer@example.com', role: 'user' },
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.invite.invite_token);
  assert.equal(r.body.invite.email, 'newcomer@example.com');
});

test('POST /admin/users/invite mit role=admin als Admin', async () => {
  const r = await _request('POST', '/admin/users/invite', {
    user: 'alice@example.com', role: 'admin',
    body: { email: 'newadmin@example.com', role: 'admin' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.invite.global_role, 'admin');
});

test('PUT /admin/users/:email status=suspended → audit event', async () => {
  // Vorher: bob ist active
  const r = await _request('PUT', '/admin/users/bob@example.com', {
    user: 'alice@example.com', role: 'admin',
    body: { status: 'suspended' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.status, 'suspended');
  const events = appUsers.listAuditForUser('bob@example.com');
  assert.ok(events.some(e => e.event === 'suspended'));
});

test('PUT /admin/users/:email role-changed → audit event', async () => {
  const r = await _request('PUT', '/admin/users/bob@example.com', {
    user: 'alice@example.com', role: 'admin',
    body: { global_role: 'admin' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.global_role, 'admin');
  const events = appUsers.listAuditForUser('bob@example.com');
  assert.ok(events.some(e => e.event === 'role-changed'));
  // zuruecksetzen fuer naechste Tests
  await _request('PUT', '/admin/users/bob@example.com', {
    user: 'alice@example.com', role: 'admin', body: { global_role: 'user', status: 'active' },
  });
});

test('PUT /admin/users/:email mit invalidem status → 400', async () => {
  const r = await _request('PUT', '/admin/users/bob@example.com', {
    user: 'alice@example.com', role: 'admin',
    body: { status: 'banane' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error_code, 'STATUS_INVALID');
});

test('DELETE /admin/users/:email self-delete blockiert', async () => {
  const r = await _request('DELETE', '/admin/users/alice@example.com', {
    user: 'alice@example.com', role: 'admin',
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error_code, 'CANNOT_DELETE_SELF');
});

test('DELETE /admin/users/:email soft-delete', async () => {
  appUsers.createUser({ email: 'tobedeleted@example.com', displayName: 'Bye' });
  const r = await _request('DELETE', '/admin/users/tobedeleted@example.com', {
    user: 'alice@example.com', role: 'admin',
  });
  assert.equal(r.status, 200);
  const u = appUsers.getUser('tobedeleted@example.com');
  assert.equal(u.status, 'deleted');
  assert.notEqual(u.display_name, 'Bye');
});

test('POST /me/invite mit can_invite_users=1 → 200', async () => {
  const r = await _request('POST', '/me/invite', {
    user: 'bob@example.com',
    body: { email: 'fresh1@example.com' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.invite.global_role, 'user');
});

test('POST /me/invite ohne can_invite_users → 403', async () => {
  const r = await _request('POST', '/me/invite', {
    user: 'carol@example.com',
    body: { email: 'fresh2@example.com' },
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error_code, 'INVITE_FORBIDDEN');
});

test('GET /me/settings liefert role + can_invite_users mit', async () => {
  const r = await _request('GET', '/me/settings', { user: 'bob@example.com' });
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'user');
  assert.equal(r.body.can_invite_users, 1);
});
