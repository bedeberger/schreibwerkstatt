// book_presence: Buch-Level-Geraete-Heartbeat fuer Multi-Device-Erkennung.
// countSelfDevices zaehlt aktive (nicht-stale) eigene Geraete am Buch inkl. des
// pingenden — >1 schaltet beim Client den vollen Collab-Poll frei.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDb = path.join(os.tmpdir(), `book-presence-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const appUsersDevices = require('../../db/app-users-devices');
const bookPresence = require('../../db/book-presence');

test.after(() => {
  try { db.close(); } catch {}
  const fs = require('fs');
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + ext); } catch {}
  }
});

const DID1 = '11111111-1111-4111-8111-111111111111';
const DID2 = '22222222-2222-4222-8222-222222222222';

function seed() {
  appUsers.createUser({ email: 'alice@x.ch', displayName: 'Alice' });
  const now = new Date().toISOString();
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(4001, 'Buch A', now, now, 'alice@x.ch');
  appUsersDevices.upsertDevice(DID1, 'alice@x.ch', 'UA1');
  appUsersDevices.upsertDevice(DID2, 'alice@x.ch', 'UA2');
}

test('ein Geraet am Buch → countSelfDevices = 1', () => {
  seed();
  bookPresence.ping(4001, 'alice@x.ch', DID1);
  assert.equal(bookPresence.countSelfDevices(4001, 'alice@x.ch'), 1);
});

test('zweites Geraet desselben Users → countSelfDevices = 2 (Multi-Device erkannt)', () => {
  bookPresence.ping(4001, 'alice@x.ch', DID2);
  assert.equal(bookPresence.countSelfDevices(4001, 'alice@x.ch'), 2);
});

test('leave entfernt nur das adressierte Geraet → wieder 1', () => {
  const ok = bookPresence.leave(4001, 'alice@x.ch', DID2);
  assert.equal(ok, true);
  assert.equal(bookPresence.countSelfDevices(4001, 'alice@x.ch'), 1);
});

test('stale Geraet (>90s) zaehlt nicht mehr mit', () => {
  // Beide Geraete pingen, dann device1 kuenstlich altern lassen.
  bookPresence.ping(4001, 'alice@x.ch', DID2);
  const old = new Date(Date.now() - 2 * bookPresence.STALE_AFTER_MS).toISOString();
  db.prepare('UPDATE book_presence SET last_ping_at = ? WHERE book_id = ? AND device_id = ?')
    .run(old, 4001, DID1);
  assert.equal(bookPresence.countSelfDevices(4001, 'alice@x.ch'), 1);
});

test('Upsert idempotent: erneuter ping desselben Geraets bleibt eine Row', () => {
  bookPresence.ping(4001, 'alice@x.ch', DID2);
  bookPresence.ping(4001, 'alice@x.ch', DID2);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM book_presence WHERE book_id = ? AND device_id = ?')
    .get(4001, DID2);
  assert.equal(rows.n, 1);
});
