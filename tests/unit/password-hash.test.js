'use strict';
// lib/password.js — Hash-Format, Verifikation, Rehash-Erkennung, Policy.
//
// Der Test haelt vor allem eine Eigenschaft fest, die man beim Anheben der
// Kostenparameter leicht verliert: ein mit ALTEN Parametern gerechneter Hash
// muss weiter verifizieren. Faellt das um, sperrt ein Parameter-Wechsel jedes
// bestehende Konto aus, und zwar erst in Produktion.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const tmpDb = path.join(os.tmpdir(), `password-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = 'a'.repeat(32);

const password = require('../../lib/password');
const appSettings = require('../../lib/app-settings');
const { db } = require('../../db/connection');

test.after(() => {
  try { db.close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch {}
  }
});

test('hashPassword: scrypt-Format mit Parametern im String', async () => {
  const h = await password.hashPassword('correct horse battery staple');
  const parts = h.split('$');
  assert.equal(parts.length, 6);
  assert.equal(parts[0], 'scrypt');
  assert.equal(Number(parts[1]), password.PARAMS.N);
  assert.ok(parts[4].length > 10, 'Salt fehlt');
  assert.ok(parts[5].length > 10, 'Hash fehlt');
});

test('hashPassword: zweimal dasselbe Passwort → verschiedene Hashes (Salt)', async () => {
  const a = await password.hashPassword('same-password');
  const b = await password.hashPassword('same-password');
  assert.notEqual(a, b);
  assert.ok(await password.verifyPassword('same-password', a));
  assert.ok(await password.verifyPassword('same-password', b));
});

test('verifyPassword: falsches Passwort → false', async () => {
  const h = await password.hashPassword('right-password-123');
  assert.equal(await password.verifyPassword('wrong-password-123', h), false);
  assert.equal(await password.verifyPassword('', h), false);
  assert.equal(await password.verifyPassword(null, h), false);
});

test('verifyPassword: kaputter/fremder Hash wirft nicht, sondern liefert false', async () => {
  for (const broken of ['', 'nonsense', 'scrypt$1$2', 'bcrypt$x$y$z$a$b', null, undefined, 42]) {
    assert.equal(await password.verifyPassword('irgendwas', broken), false, String(broken));
  }
});

test('verifyPassword: Hash mit AELTEREN Parametern verifiziert weiter', async () => {
  // Von Hand mit schwaecheren Parametern gerechnet — so sah ein Hash aus, bevor
  // jemand die Kosten anhob.
  const salt = crypto.randomBytes(16);
  const legacy = { N: 16384, r: 8, p: 1, keylen: 64 };
  const key = crypto.scryptSync('legacy-secret-value', salt, legacy.keylen, {
    N: legacy.N, r: legacy.r, p: legacy.p, maxmem: 256 * 1024 * 1024,
  });
  const stored = `scrypt$${legacy.N}$${legacy.r}$${legacy.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;

  assert.ok(await password.verifyPassword('legacy-secret-value', stored), 'alter Hash muss weiter gelten');
  assert.equal(await password.verifyPassword('falsch', stored), false);
  assert.equal(password.needsRehash(stored), true, 'alter Hash gehoert neu gerechnet');
});

test('needsRehash: frischer Hash ist aktuell', async () => {
  assert.equal(password.needsRehash(await password.hashPassword('frisch-und-lang-genug')), false);
  assert.equal(password.needsRehash('kaputt'), true);
});

test('validatePassword: Laenge aus auth.local.min_password_length', () => {
  appSettings.set('auth.local.min_password_length', 12, { updatedBy: 'test' });
  assert.equal(password.minLength(), 12);
  assert.equal(password.validatePassword(''), 'auth.password.errRequired');
  assert.equal(password.validatePassword('kurz'), 'auth.password.errTooShort');
  assert.equal(password.validatePassword('a'.repeat(12)), null);
  assert.equal(password.validatePassword('a'.repeat(2000)), 'auth.password.errTooLong');

  appSettings.set('auth.local.min_password_length', 20, { updatedBy: 'test' });
  assert.equal(password.validatePassword('a'.repeat(12)), 'auth.password.errTooShort');
  assert.equal(password.validatePassword('a'.repeat(20)), null);
  appSettings.set('auth.local.min_password_length', 12, { updatedBy: 'test' });
});
