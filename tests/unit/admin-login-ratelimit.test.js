'use strict';
// In-Memory-Rate-Limit fuer POST /auth/admin-login (5 Fehler/IP/15 min → 429).

const test = require('node:test');
const assert = require('node:assert/strict');

const rl = require('../../lib/admin-login-ratelimit');

test.beforeEach(() => rl._resetAll());

test('Fresh IP: getState blocked=false, failCount=0', () => {
  const s = rl.getState('10.0.0.1');
  assert.equal(s.blocked, false);
  assert.equal(s.failCount, 0);
});

test('Vier Fails: nicht geblockt', () => {
  for (let i = 0; i < 4; i++) rl.recordFailure('10.0.0.2');
  const s = rl.getState('10.0.0.2');
  assert.equal(s.blocked, false);
  assert.equal(s.failCount, 4);
});

test('Fuenf Fails: geblockt, retryAfterSec > 0', () => {
  for (let i = 0; i < 5; i++) rl.recordFailure('10.0.0.3');
  const s = rl.getState('10.0.0.3');
  assert.equal(s.blocked, true);
  assert.ok(s.retryAfterSec > 0);
  assert.ok(s.retryAfterSec <= 15 * 60);
});

test('recordSuccess raeumt Counter auch im Block-Zustand', () => {
  for (let i = 0; i < 5; i++) rl.recordFailure('10.0.0.4');
  assert.equal(rl.getState('10.0.0.4').blocked, true);
  rl.recordSuccess('10.0.0.4');
  assert.equal(rl.getState('10.0.0.4').blocked, false);
});

test('Mehrere IPs unabhaengig', () => {
  for (let i = 0; i < 5; i++) rl.recordFailure('10.0.0.5');
  rl.recordFailure('10.0.0.6');
  assert.equal(rl.getState('10.0.0.5').blocked, true);
  assert.equal(rl.getState('10.0.0.6').blocked, false);
});

test('null IP: silent no-op', () => {
  const s1 = rl.getState(null);
  assert.equal(s1.blocked, false);
  const s2 = rl.recordFailure(null);
  assert.equal(s2.blocked, false);
});

test('Konstanten exportiert', () => {
  assert.equal(rl.MAX_FAILS, 5);
  assert.equal(rl.WINDOW_MS, 15 * 60 * 1000);
});
