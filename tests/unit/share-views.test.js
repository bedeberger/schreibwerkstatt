'use strict';
// Share-Link-Zugriffsstatistik: share_views (Migration 237) — Aufruf-Log,
// eindeutige Besucher (COUNT DISTINCT ip_hash) + Ø-Lesedauer (Beacon → MAX-Merge).
// Eigene Test-DB pro Lauf.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const tmp = path.join('/tmp', `share-views-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const { db } = require('../../db/connection');
require('../../db/migrations').runMigrations();
const appUsers = require('../../db/app-users');
const schema = require('../../db/schema');
const sl = require('../../db/share-links');

const OWNER = 'views-owner@share.test';

let _pid = 100;
function seedLink() {
  if (!appUsers.getUser(OWNER)) appUsers.createUser({ email: OWNER, displayName: 'Owner' });
  schema.upsertBookByName(1, 'Testbuch');
  const pageId = _pid++;
  db.prepare('INSERT OR IGNORE INTO pages (page_id, book_id, page_name) VALUES (?, 1, ?)').run(pageId, `Seite ${pageId}`);
  return sl.createShareLink({ kind: 'page', pageId, bookId: 1, ownerEmail: OWNER });
}

test('recordShareView erhöht view_count UND legt eine share_views-Zeile an', () => {
  const link = seedLink();
  const id1 = sl.recordShareView(link.token, 'ipA');
  const id2 = sl.recordShareView(link.token, 'ipB');
  assert.ok(id1 > 0 && id2 > id1, 'liefert aufsteigende view_ids');
  const row = sl.listSharesByOwnerAndBook(OWNER, 1).find(r => r.token === link.token);
  assert.equal(row.view_count, 2, 'Gesamtzähler = 2 Aufrufe');
  assert.equal(row.unique_views, 2, 'zwei verschiedene IP-Hashes = 2 eindeutige');
});

test('eindeutige Besucher entdoppeln über ip_hash; NULL zählt nicht', () => {
  const link = seedLink();
  sl.recordShareView(link.token, 'sameIp');
  sl.recordShareView(link.token, 'sameIp');
  sl.recordShareView(link.token, 'sameIp');
  sl.recordShareView(link.token, null); // z.B. IP nicht ermittelbar
  const row = sl.listSharesByOwnerAndBook(OWNER, 1).find(r => r.token === link.token);
  assert.equal(row.view_count, 4, 'vier Aufrufe gesamt');
  assert.equal(row.unique_views, 1, 'nur ein eindeutiger Besucher (NULL fällt raus)');
});

test('setViewDuration nimmt den größten Wert (MAX-Merge), avg über gesetzte Dauern', () => {
  const link = seedLink();
  const a = sl.recordShareView(link.token, 'ip1');
  const b = sl.recordShareView(link.token, 'ip2');

  // Beacon-Muster: erst kurze sichtbare Zeit, dann längere nachgemeldet.
  assert.equal(sl.setViewDuration(a, link.token, 20000), true);
  assert.equal(sl.setViewDuration(a, link.token, 5000), true, 'Update greift immer …');
  // … aber der kleinere Wert überschreibt nicht:
  assert.equal(sl.setViewDuration(b, link.token, 40000), true);

  const row = sl.listSharesByOwnerAndBook(OWNER, 1).find(r => r.token === link.token);
  assert.equal(row.avg_duration_ms, 30000, 'AVG(20000, 40000) = 30000 (MAX-Merge behielt 20000)');
});

test('setViewDuration greift nicht über fremden Token', () => {
  const link = seedLink();
  const other = seedLink();
  const id = sl.recordShareView(link.token, 'ip1');
  assert.equal(sl.setViewDuration(id, other.token, 9999), false, 'falscher Token → kein Treffer');
  const row = sl.listSharesByOwnerAndBook(OWNER, 1).find(r => r.token === link.token);
  assert.equal(row.avg_duration_ms, null, 'keine Dauer gesetzt');
});

test('CASCADE: Link-Löschung räumt share_views mit ab', () => {
  const link = seedLink();
  sl.recordShareView(link.token, 'ip1');
  sl.recordShareView(link.token, 'ip2');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM share_views WHERE share_token = ?').get(link.token).n, 2);
  db.prepare('DELETE FROM share_links WHERE token = ?').run(link.token);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM share_views WHERE share_token = ?').get(link.token).n, 0,
    'FK ON DELETE CASCADE entfernt die View-Zeilen');
});
