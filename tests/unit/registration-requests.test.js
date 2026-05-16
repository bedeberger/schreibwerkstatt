'use strict';
// Phase 4a2 (BookStack-Exit, docs/bookstack-exit.md): registration_requests
// DB-Helper. Partial-UNIQUE blockt pending-Duplikate; expireStale schiebt
// alte pending-Requests auf 'expired'.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(os.tmpdir(), `reg-req-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;

require('../../db/migrations');
const { db } = require('../../db/connection');
const regRequests = require('../../db/registration-requests');

test.after(() => {
  try { db.close(); } catch {}
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
});

test('createRequest legt pending-Row an', () => {
  const r = regRequests.createRequest({ email: 'alice@example.com', displayName: 'Alice', message: 'hi', ip: '1.2.3.4', userAgent: 'ua' });
  assert.ok(r.id > 0);
  assert.equal(r.email, 'alice@example.com');
  assert.equal(r.status, 'pending');
  assert.equal(r.display_name, 'Alice');
  assert.equal(r.invite_id, null);
});

test('Partial-UNIQUE blockt zweite pending-Anfrage derselben Email', () => {
  // alice@example.com hat bereits pending aus vorigem Test.
  assert.throws(
    () => regRequests.createRequest({ email: 'alice@example.com' }),
    /UNIQUE/i,
  );
});

test('approveRequest setzt status + invite_id', () => {
  // Erstmal Invite-Row anlegen, damit FK SET NULL nicht greift.
  db.prepare(`INSERT INTO app_users (email, display_name, global_role, status) VALUES ('admin@example.com', 'Admin', 'admin', 'active')`).run();
  const inv = db.prepare(`
    INSERT INTO user_invites (email, global_role, invite_token, invited_by, expires_at)
    VALUES ('alice@example.com', 'user', 'tok-1', 'admin@example.com', datetime('now','+14 days'))
    RETURNING id
  `).get();
  const row = regRequests.listPending().find(r => r.email === 'alice@example.com');
  const updated = regRequests.approveRequest(row.id, { reviewer: 'admin@example.com', inviteId: inv.id });
  assert.equal(updated.status, 'approved');
  assert.equal(updated.invite_id, inv.id);
  assert.equal(updated.reviewed_by, 'admin@example.com');
});

test('Nach approve: zweite pending-Anfrage derselben Email funktioniert', () => {
  const r = regRequests.createRequest({ email: 'alice@example.com' });
  assert.equal(r.status, 'pending');
});

test('denyRequest setzt status + reason', () => {
  regRequests.createRequest({ email: 'bob@example.com', message: 'pls' });
  const row = regRequests.listPending().find(r => r.email === 'bob@example.com');
  const updated = regRequests.denyRequest(row.id, { reviewer: 'admin@example.com', reason: 'unrelated' });
  assert.equal(updated.status, 'denied');
  assert.equal(updated.review_reason, 'unrelated');
});

test('approve auf bereits behandelte Request liefert null (Race-Marker)', () => {
  const row = regRequests.listByStatus('denied').find(r => r.email === 'bob@example.com');
  const r = regRequests.approveRequest(row.id, { reviewer: 'admin@example.com', inviteId: null });
  assert.equal(r, null);
});

test('expireStale: pending-Row mit altem created_at -> expired', () => {
  regRequests.createRequest({ email: 'charlie@example.com' });
  // created_at manuell zurueckdatieren
  db.prepare(`UPDATE registration_requests SET created_at = datetime('now','-40 days') WHERE email = 'charlie@example.com' AND status='pending'`).run();
  const changed = regRequests.expireStale(30);
  assert.ok(changed >= 1);
  const row = regRequests.listByStatus('expired').find(r => r.email === 'charlie@example.com');
  assert.ok(row);
});

test('listByStatus("approved") liefert approved-Eintraege', () => {
  const approved = regRequests.listByStatus('approved');
  assert.ok(approved.length >= 1);
  assert.ok(approved.every(r => r.status === 'approved'));
});
