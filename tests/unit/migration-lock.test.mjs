// Migrations-Lock (db/migrations.js#_withMigrationLock): ein Lock, den ein
// abgestuerzter Prozess hinterlassen hat, darf den naechsten Boot nicht
// blockieren. Der Lock traegt die PID; gehoert er einem toten Prozess, wird er
// uebernommen. Ein Lock eines lebenden Prozesses bleibt respektiert.
//
// Lauf: `node --test tests/unit/migration-lock.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const dbFile = path.join(os.tmpdir(), `migration-lock-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
const { _withMigrationLock, _isStaleLock } = require('../../db/migrations');
const lockPath = `${dbFile}.migration-lock`;

function deadPid() {
  // PID eines Prozesses, der garantiert schon beendet ist.
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
}

test('verwaister Lock (toter Prozess) wird uebernommen statt bis zum Timeout zu warten', () => {
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), startedAt: '2020-01-01T00:00:00Z' }));
  const t0 = Date.now();
  const out = _withMigrationLock(() => {
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(info.pid, process.pid, 'Lock traegt die eigene PID');
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.ok(Date.now() - t0 < 5000, 'darf nicht bis zum Timeout warten');
  assert.equal(fs.existsSync(lockPath), false, 'Lock nach dem Lauf entfernt');
});

test('Lock eines lebenden Prozesses gilt nicht als verwaist', () => {
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try { assert.equal(_isStaleLock(lockPath), false); }
  finally { fs.unlinkSync(lockPath); }
});

test('frischer Lock ohne lesbaren Inhalt ist nicht verwaist, alter schon', () => {
  fs.writeFileSync(lockPath, '');
  try {
    assert.equal(_isStaleLock(lockPath), false);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    assert.equal(_isStaleLock(lockPath), '');
  } finally { try { fs.unlinkSync(lockPath); } catch {} }
});

test('Fehler in fn gibt den Lock trotzdem frei', () => {
  assert.throws(() => _withMigrationLock(() => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(lockPath), false);
});
