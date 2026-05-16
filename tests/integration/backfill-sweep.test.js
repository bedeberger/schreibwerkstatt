'use strict';
// Phase 0b: runBackfillSweep + app-settings:changed-Hook auf `app.backend`.
//   - listet aktive User × gespeicherte BookStack-Tokens
//   - queued pro User einen Backfill-Job (idempotent via findActiveJobId)
//   - suspended/deleted User werden gefiltert
//   - app.backend-Setting-Wechsel triggert Sweep automatisch
//   - GET /jobs/backfill/sweep liefert aktuellen Stand

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'integration-test-secret';

const { bootstrap } = require('./_helpers/setup');

let ctx;
test.before(() => {
  ctx = bootstrap();
  ctx.backfill = require('../../routes/jobs/backfill');
  ctx.appSettings = require('../../lib/app-settings');
  ctx.appUsers = require('../../db/app-users');
  ctx.tokens = require('../../db/tokens');
  ctx.connection = require('../../db/connection');
});
test.after(() => { ctx.cleanup(); });

function _seedUserWithToken(email, status = 'active') {
  // FK-Kette: user_tokens.email → users.email → app_users.email.
  ctx.appUsers.createUser({ email, status });
  ctx.connection.db.prepare(
    `INSERT OR IGNORE INTO users (email, created_at) VALUES (?, datetime('now'))`
  ).run(email);
  ctx.tokens.setUserToken(email, `id-${email}`, `pw-${email}`);
}

function _resetUserState() {
  const { db } = ctx.connection;
  db.prepare('DELETE FROM user_tokens').run();
  db.prepare('DELETE FROM app_users').run();
  db.prepare('DELETE FROM users').run();
  ctx.shared.jobs.clear();
  ctx.shared.runningJobs.clear();
}

test('runBackfillSweep: queued pro aktivem User mit Token', () => {
  _resetUserState();
  _seedUserWithToken('alice@example.com', 'active');
  _seedUserWithToken('bob@example.com', 'active');
  _seedUserWithToken('carol@example.com', 'suspended');

  const r = ctx.backfill.runBackfillSweep({
    triggeredBy: 'admin@example.com',
    fromBackend: 'bookstack',
    toBackend: 'localdb',
  });

  assert.equal(r.total, 2, 'suspended User wird gefiltert');
  assert.equal(r.enqueued, 2);
  assert.equal(r.skipped, 0);
  assert.equal(r.jobIds.length, 2);
  assert.equal(r.fromBackend, 'bookstack');
  assert.equal(r.toBackend, 'localdb');
  assert.equal(r.triggeredBy, 'admin@example.com');
});

test('runBackfillSweep: Re-Run mit aktivem Job pro User → skipped', () => {
  _resetUserState();
  _seedUserWithToken('alice@example.com', 'active');

  const r1 = ctx.backfill.runBackfillSweep({ triggeredBy: 'admin' });
  assert.equal(r1.enqueued, 1);

  // Aktive Jobs stehen noch in der Queue (mock-bookstack laeuft synchron, aber
  // Worker laeuft async). findActiveJobId trifft → skipped.
  const r2 = ctx.backfill.runBackfillSweep({ triggeredBy: 'admin' });
  assert.equal(r2.total, 1);
  assert.equal(r2.enqueued, 0);
  assert.equal(r2.skipped, 1);
});

test('runBackfillSweep: leere User-Liste → no-op', () => {
  _resetUserState();
  const r = ctx.backfill.runBackfillSweep({ triggeredBy: 'admin' });
  assert.equal(r.total, 0);
  assert.equal(r.enqueued, 0);
});

test('app.backend-Wechsel triggert Sweep automatisch', async () => {
  _resetUserState();
  _seedUserWithToken('alice@example.com', 'active');

  const before = ctx.backfill.getSweepState();
  const beforeStartedAt = before.startedAt;

  // Wechsel von default → expliziter neuer Wert. _lastBackend lebt im Modul-
  // Scope; um sicher einen Wechsel zu sehen, setzen wir zwei Schritte.
  ctx.appSettings.set('app.backend', 'bookstack', { updatedBy: 'admin@x' });
  await new Promise(r => setTimeout(r, 30));
  ctx.appSettings.set('app.backend', 'localdb', { updatedBy: 'admin@x' });
  await new Promise(r => setTimeout(r, 30));

  const after = ctx.backfill.getSweepState();
  assert.notEqual(after.startedAt, beforeStartedAt, 'Sweep wurde getriggert');
  assert.equal(after.toBackend, 'localdb');
  assert.ok(after.total >= 1);
});
