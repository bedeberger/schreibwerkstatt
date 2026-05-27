// book_presence: page-scoped Geraete-Heartbeat fuer Multi-Device-Erkennung.
// countSelfDevicesOnPage zaehlt aktive (nicht-stale) eigene Geraete auf DERSELBEN
// Seite inkl. des pingenden — >1 schaltet beim Client den vollen Collab-Poll
// frei. Zwei Geraete auf verschiedenen Seiten desselben Buchs zaehlen NICHT.
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
const PAGE_A = 5001;
const PAGE_B = 5002;

function seed() {
  appUsers.createUser({ email: 'alice@x.ch', displayName: 'Alice' });
  const now = new Date().toISOString();
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(4001, 'Buch A', now, now, 'alice@x.ch');
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (?, ?, ?, ?)')
    .run(PAGE_A, 4001, 'Seite A', now);
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (?, ?, ?, ?)')
    .run(PAGE_B, 4001, 'Seite B', now);
  appUsersDevices.upsertDevice(DID1, 'alice@x.ch', 'UA1');
  appUsersDevices.upsertDevice(DID2, 'alice@x.ch', 'UA2');
}

test('ein Geraet auf Seite A → countSelfDevicesOnPage(A) = 1', () => {
  seed();
  bookPresence.ping(4001, 'alice@x.ch', DID1, PAGE_A);
  assert.equal(bookPresence.countSelfDevicesOnPage(PAGE_A, 'alice@x.ch'), 1);
});

test('zweites Geraet auf DERSELBEN Seite → countSelfDevicesOnPage(A) = 2', () => {
  bookPresence.ping(4001, 'alice@x.ch', DID2, PAGE_A);
  assert.equal(bookPresence.countSelfDevicesOnPage(PAGE_A, 'alice@x.ch'), 2);
});

test('zweites Geraet wechselt auf Seite B → kein Seitenkonflikt mehr (je 1)', () => {
  // Upsert bewegt DID2 auf Seite B; A behaelt nur DID1.
  bookPresence.ping(4001, 'alice@x.ch', DID2, PAGE_B);
  assert.equal(bookPresence.countSelfDevicesOnPage(PAGE_A, 'alice@x.ch'), 1);
  assert.equal(bookPresence.countSelfDevicesOnPage(PAGE_B, 'alice@x.ch'), 1);
});

test('Geraet ohne offene Seite (page_id null) zaehlt auf keiner Seite', () => {
  bookPresence.ping(4001, 'alice@x.ch', DID2, null);
  assert.equal(bookPresence.countSelfDevicesOnPage(PAGE_A, 'alice@x.ch'), 1);
  assert.equal(bookPresence.countSelfDevicesOnPage(PAGE_B, 'alice@x.ch'), 0);
});

test('stale Geraet (>90s) zaehlt nicht mehr mit', () => {
  bookPresence.ping(4001, 'alice@x.ch', DID2, PAGE_A); // wieder auf A → 2
  assert.equal(bookPresence.countSelfDevicesOnPage(PAGE_A, 'alice@x.ch'), 2);
  const old = new Date(Date.now() - 2 * bookPresence.STALE_AFTER_MS).toISOString();
  db.prepare('UPDATE book_presence SET last_ping_at = ? WHERE device_id = ?').run(old, DID1);
  assert.equal(bookPresence.countSelfDevicesOnPage(PAGE_A, 'alice@x.ch'), 1);
});

test('leave entfernt nur das adressierte Geraet', () => {
  const ok = bookPresence.leave(4001, 'alice@x.ch', DID2);
  assert.equal(ok, true);
  assert.equal(bookPresence.countSelfDevicesOnPage(PAGE_A, 'alice@x.ch'), 0);
});

test('page_id FK ON DELETE SET NULL: Seite weg → Geraet bleibt praesent, ohne Seite', () => {
  bookPresence.ping(4001, 'alice@x.ch', DID1, PAGE_B);
  db.prepare('DELETE FROM pages WHERE page_id = ?').run(PAGE_B);
  const row = db.prepare('SELECT page_id FROM book_presence WHERE device_id = ?').get(DID1);
  assert.equal(row.page_id, null);
});
