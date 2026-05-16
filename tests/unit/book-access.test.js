'use strict';
// Phase 4b (BookStack-Exit, docs/bookstack-exit.md): db/book-access.js Helper,
// Rollen-Hierarchie, Migration-109 Backfill, Page-Lock-Lifecycle.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(os.tmpdir(), `book-access-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const bookAccess = require('../../db/book-access');

test.after(() => {
  try { db.close(); } catch {}
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
});

function _seed() {
  // Drei User + zwei Bücher. Owner-Mapping über books.owner_email.
  appUsers.createUser({ email: 'alice@x.ch', displayName: 'Alice' });
  appUsers.createUser({ email: 'bob@x.ch',   displayName: 'Bob' });
  appUsers.createUser({ email: 'eve@x.ch',   displayName: 'Eve' });
  const now = new Date().toISOString();
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(1001, 'Buch A', now, now, 'alice@x.ch');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(1002, 'Buch B', now, now, 'bob@x.ch');
}

test('Migration 109 Owner-Backfill: books.owner_email → book_access', () => {
  _seed();
  // Migration 109 hat beim require oben gelaufen, aber `books` waren leer.
  // Wir testen den Insert-Selectstatement aus der Migration nach.
  db.prepare(`
    INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_by)
    SELECT b.book_id, b.owner_email, 'owner', 'migration-test'
      FROM books b
     WHERE b.owner_email IS NOT NULL
       AND b.owner_email <> ''
       AND EXISTS (SELECT 1 FROM app_users u WHERE u.email = b.owner_email)
  `).run();
  assert.equal(bookAccess.getBookRole(1001, 'alice@x.ch'), 'owner');
  assert.equal(bookAccess.getBookRole(1002, 'bob@x.ch'),   'owner');
  assert.equal(bookAccess.getBookRole(1001, 'bob@x.ch'),   null);
});

test('hasMinRole: Hierarchie owner > editor > lektor > viewer', () => {
  assert.equal(bookAccess.hasMinRole('owner',  'editor'), true);
  assert.equal(bookAccess.hasMinRole('editor', 'editor'), true);
  assert.equal(bookAccess.hasMinRole('lektor', 'editor'), false);
  assert.equal(bookAccess.hasMinRole('viewer', 'lektor'), false);
  assert.equal(bookAccess.hasMinRole('lektor', 'viewer'), true);
  assert.equal(bookAccess.hasMinRole(null,     'viewer'), false);
});

test('grantAccess + listBookAccess + revokeAccess', () => {
  bookAccess.grantAccess(1001, 'bob@x.ch', 'editor', 'alice@x.ch');
  bookAccess.grantAccess(1001, 'eve@x.ch', 'viewer', 'alice@x.ch');
  const list = bookAccess.listBookAccess(1001);
  assert.equal(list.length, 3);
  // Sortierung: owner zuerst.
  assert.equal(list[0].role, 'owner');
  assert.equal(list[0].user_email, 'alice@x.ch');
  // Revoke
  bookAccess.revokeAccess(1001, 'eve@x.ch');
  assert.equal(bookAccess.getBookRole(1001, 'eve@x.ch'), null);
});

test('listBookIdsForUser: nur Bücher mit Access-Row', () => {
  const aliceBooks = bookAccess.listBookIdsForUser('alice@x.ch').map(r => r.book_id).sort();
  assert.deepEqual(aliceBooks, [1001]);
  const bobBooks = bookAccess.listBookIdsForUser('bob@x.ch').map(r => r.book_id).sort();
  assert.deepEqual(bobBooks, [1001, 1002]);
});

test('transferOwnership: alter Owner wird editor, books.owner_email folgt', () => {
  bookAccess.transferOwnership(1001, 'bob@x.ch', 'alice@x.ch');
  assert.equal(bookAccess.getBookRole(1001, 'alice@x.ch'), 'editor');
  assert.equal(bookAccess.getBookRole(1001, 'bob@x.ch'),   'owner');
  const row = db.prepare('SELECT owner_email FROM books WHERE book_id = ?').get(1001);
  assert.equal(row.owner_email, 'bob@x.ch');
});

test('transferOwnership: target ohne Access → Fehler', () => {
  assert.throws(
    () => bookAccess.transferOwnership(1001, 'unknown@x.ch', 'bob@x.ch'),
    /not in book_access/
  );
});

test('Page-Lock: acquire → heartbeat → release', () => {
  // pages-Row für FK
  const now = new Date().toISOString();
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (?, ?, ?, ?)')
    .run(5001, 1001, 'Seite 1', now);
  const lock = bookAccess.acquireLock(5001, 1001, 'bob@x.ch');
  assert.equal(lock.locked_by_email, 'bob@x.ch');
  assert.equal(lock.book_id, 1001);
  // Selber User darf erneut acquire (extend, idempotent).
  bookAccess.acquireLock(5001, 1001, 'bob@x.ch');
  // Fremder User → PAGE_LOCKED
  assert.throws(
    () => bookAccess.acquireLock(5001, 1001, 'eve@x.ch'),
    /PAGE_LOCKED/
  );
  // getBlockingLockFor: eigener User sieht keinen Lock.
  assert.equal(bookAccess.getBlockingLockFor(5001, 'bob@x.ch'), null);
  assert.equal(bookAccess.getBlockingLockFor(5001, 'eve@x.ch')?.locked_by_email, 'bob@x.ch');
  // Heartbeat verlängert.
  bookAccess.heartbeatLock(5001, 'bob@x.ch');
  // Release durch eigenen User.
  assert.equal(bookAccess.releaseLock(5001, 'bob@x.ch'), true);
  assert.equal(bookAccess.getPageLock(5001), null);
});

test('Page-Lock: expired Lock wird beim Read gepurged', () => {
  // Direkt INSERT mit expires_at in der Vergangenheit.
  db.prepare(`
    INSERT INTO page_locks (page_id, book_id, locked_by_email, reason, expires_at)
    VALUES (?, ?, ?, 'lektorat', ?)
  `).run(5001, 1001, 'bob@x.ch', new Date(Date.now() - 60_000).toISOString());
  assert.equal(bookAccess.getPageLock(5001), null);
  // INSERT-Side-Effect: getPageLock hat die abgelaufene Row gelöscht.
  const left = db.prepare('SELECT 1 FROM page_locks WHERE page_id = ?').get(5001);
  assert.equal(left, undefined);
});

test('purgeExpiredLocks: löscht abgelaufene Rows', () => {
  db.prepare(`
    INSERT INTO page_locks (page_id, book_id, locked_by_email, reason, expires_at)
    VALUES (?, ?, ?, 'lektorat', ?)
  `).run(5001, 1001, 'bob@x.ch', new Date(Date.now() - 60_000).toISOString());
  const removed = bookAccess.purgeExpiredLocks();
  assert.equal(removed >= 1, true);
});

test('FK-Integrität: book_access cascade bei book delete', () => {
  // book_id 1002 löschen → bob's access-Row weg.
  db.prepare('DELETE FROM books WHERE book_id = ?').run(1002);
  assert.equal(bookAccess.getBookRole(1002, 'bob@x.ch'), null);
});

test('Schema-Version 109 erreicht', () => {
  const row = db.prepare('SELECT version FROM schema_version').get();
  assert.equal(row.version >= 109, true);
});
