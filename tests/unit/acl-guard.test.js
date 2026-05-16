'use strict';
// Phase 4b: lib/acl.js Guard-Middleware. Smoke-Tests gegen einen minimalen
// Express-Mock, damit Verhalten reproduzierbar bleibt.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(os.tmpdir(), `acl-guard-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const bookAccess = require('../../db/book-access');
const { runWithContext } = require('../../lib/log-context');
const acl = require('../../lib/acl');

test.after(() => {
  try { db.close(); } catch {}
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
});

function _setup() {
  appUsers.createUser({ email: 'alice@x.ch' });
  appUsers.createUser({ email: 'bob@x.ch' });
  const now = new Date().toISOString();
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(2001, 'Buch X', now, now, 'alice@x.ch');
  bookAccess.grantAccess(2001, 'alice@x.ch', 'owner', 'system');
  bookAccess.grantAccess(2001, 'bob@x.ch',   'viewer', 'alice@x.ch');
}
_setup();

function reqFor(email) {
  return { session: { user: { email } }, params: {}, body: {}, query: {} };
}

test('requireBookAccess: Owner darf editor + lektor + viewer', () => {
  const req = reqFor('alice@x.ch');
  runWithContext({}, () => {
    assert.equal(acl.requireBookAccess(req, 2001, 'editor'), 'owner');
    assert.equal(acl.requireBookAccess(req, 2001, 'lektor'), 'owner');
    assert.equal(acl.requireBookAccess(req, 2001, 'viewer'), 'owner');
  });
});

test('requireBookAccess: Viewer wirft 403 bei editor', () => {
  const req = reqFor('bob@x.ch');
  runWithContext({}, () => {
    assert.equal(acl.requireBookAccess(req, 2001, 'viewer'), 'viewer');
    assert.throws(() => acl.requireBookAccess(req, 2001, 'editor'), e => {
      return e instanceof acl.ACLError && e.code === 'INSUFFICIENT_ROLE' && e.status === 403;
    });
  });
});

test('requireBookAccess: Unbekannter User → NO_BOOK_ACCESS', () => {
  appUsers.createUser({ email: 'stranger@x.ch' });
  const req = reqFor('stranger@x.ch');
  runWithContext({}, () => {
    assert.throws(() => acl.requireBookAccess(req, 2001, 'viewer'), e => {
      return e instanceof acl.ACLError && e.code === 'NO_BOOK_ACCESS';
    });
  });
});

test('requireBookAccess: Nicht-eingeloggt → NOT_LOGGED_IN/401', () => {
  const req = { session: {}, params: {}, body: {} };
  runWithContext({}, () => {
    assert.throws(() => acl.requireBookAccess(req, 2001, 'viewer'), e => {
      return e instanceof acl.ACLError && e.code === 'NOT_LOGGED_IN' && e.status === 401;
    });
  });
});

test('requireBookAccess: ungültige Book-ID → 400', () => {
  const req = reqFor('alice@x.ch');
  runWithContext({}, () => {
    assert.throws(() => acl.requireBookAccess(req, 'abc', 'viewer'), e => {
      return e instanceof acl.ACLError && e.code === 'INVALID_BOOK_ID' && e.status === 400;
    });
  });
});

test('aclParamGuard: setzt req.bookId + req.bookRole bei erfolg', () => {
  const guard = acl.aclParamGuard('viewer');
  const req = reqFor('bob@x.ch');
  let called = false;
  const res = { status: () => res, json: () => { called = true; } };
  runWithContext({}, () => guard(req, res, () => { called = true; }, '2001'));
  assert.equal(called, true);
  assert.equal(req.bookId, 2001);
  assert.equal(req.bookRole, 'viewer');
});

test('aclParamGuard: 403 bei zu niedriger Rolle', () => {
  const guard = acl.aclParamGuard('editor');
  const req = reqFor('bob@x.ch');
  let status = null;
  let body = null;
  const res = { status: (s) => { status = s; return res; }, json: (b) => { body = b; } };
  runWithContext({}, () => guard(req, res, () => {}, '2001'));
  assert.equal(status, 403);
  assert.equal(body.error_code, 'INSUFFICIENT_ROLE');
});
