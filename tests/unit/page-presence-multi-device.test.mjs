// page_presence Multi-Device: zwei device_id desselben Users belegen zwei Rows
// auf derselben Seite; leave nimmt nur das adressierte Device weg.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDb = path.join(os.tmpdir(), `page-presence-mdev-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const appUsersDevices = require('../../db/app-users-devices');
const pagePresence = require('../../db/page-presence');

test.after(() => {
  try { db.close(); } catch {}
  const fs = require('fs');
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + ext); } catch {}
  }
});

function seed() {
  appUsers.createUser({ email: 'alice@x.ch', displayName: 'Alice' });
  const now = new Date().toISOString();
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(2001, 'Buch A', now, now, 'alice@x.ch');
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (?, ?, ?, ?)')
    .run(3001, 2001, 'Seite 1', now);
}

const DID1 = '11111111-1111-4111-8111-111111111111';
const DID2 = '22222222-2222-4222-8222-222222222222';

test('zwei Geräte desselben Users belegen zwei Rows auf derselben Seite', () => {
  seed();
  const ua1 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0';
  const ua2 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';

  appUsersDevices.upsertDevice(DID1, 'alice@x.ch', ua1);
  appUsersDevices.upsertDevice(DID2, 'alice@x.ch', ua2);
  pagePresence.ping(3001, 'alice@x.ch', 2001, DID1);
  pagePresence.ping(3001, 'alice@x.ch', 2001, DID2);

  const rows = pagePresence.listForBook(2001);
  assert.equal(rows.length, 2);
  const devices = new Set(rows.map(r => r.device_id));
  assert.ok(devices.has(DID1));
  assert.ok(devices.has(DID2));
  const labels = rows.map(r => r.device_label).sort();
  assert.deepEqual(labels, ['Chrome · macOS', 'Safari · iOS']);
});

test('leave entfernt nur das adressierte Device, das andere bleibt aktiv', () => {
  const r = pagePresence.leave(3001, 'alice@x.ch', DID1);
  assert.equal(r, true);
  const rows = pagePresence.listForBook(2001);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].device_id, DID2);
});

test('upsertDevice idempotent: zweite Insert aktualisiert Label aus aktueller UA', () => {
  const did = '33333333-3333-4333-8333-333333333333';
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/121.0';
  appUsersDevices.upsertDevice(did, 'alice@x.ch', ua);
  const first = appUsersDevices.getDevice(did);
  appUsersDevices.upsertDevice(did, 'alice@x.ch', ua);
  const second = appUsersDevices.getDevice(did);
  assert.equal(first.device_id, second.device_id);
  assert.equal(second.label, 'Firefox · Windows');
});

test('Self-Filter-Logic: Filter dropt nur (selfEmail, selfDeviceId)-Kombination', () => {
  // Spiegel der routes/content.js Filter-Klausel.
  const rows = [
    { user_email: 'alice@x.ch', device_id: 'd1' },
    { user_email: 'alice@x.ch', device_id: 'd2' },
    { user_email: 'bob@x.ch',   device_id: 'd3' },
  ];
  const selfEmail = 'alice@x.ch';
  const selfDevice = 'd1';
  const visible = rows.filter(r => !(
    r.user_email.toLowerCase() === selfEmail.toLowerCase() &&
    r.device_id === selfDevice
  ));
  assert.equal(visible.length, 2);
  assert.ok(visible.some(r => r.device_id === 'd2'));
  assert.ok(visible.some(r => r.device_id === 'd3'));
});
