'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const tmp = path.join('/tmp', `sync-delta-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const schema = require('../../db/schema');
const { db } = require('../../db/connection');
const contentStore = require('../../lib/content-store');

const BOOK = 5001;
const OTHER_BOOK = 5002;

function insertPage(id, bookId, name, updatedAt) {
  db.prepare(`
    INSERT INTO pages (page_id, book_id, page_name, body_html, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, bookId, name, `<p>${name}</p>`, updatedAt);
}

test('pagesChangedSince: Voll-Pull liefert alle Seiten in (updated_at, id)-Ordnung', () => {
  schema.upsertBookByName(BOOK, 'Sync-Buch');
  schema.upsertBookByName(OTHER_BOOK, 'Fremd-Buch');

  insertPage(1, BOOK, 'A', '2026-01-01T10:00:00.000Z');
  insertPage(2, BOOK, 'B', '2026-01-01T11:00:00.000Z');
  insertPage(3, BOOK, 'C', '2026-01-02T09:00:00.000Z');
  // Fremdes Buch darf nie auftauchen.
  insertPage(99, OTHER_BOOK, 'X', '2026-01-03T00:00:00.000Z');

  const all = contentStore.pagesChangedSince(BOOK, { since: null, sinceId: 0 }, 200);
  assert.deepEqual(all.map(r => r.id), [1, 2, 3]);
});

test('pagesChangedSince: Cursor liefert nur Seiten nach dem Cursor', () => {
  const delta = contentStore.pagesChangedSince(
    BOOK, { since: '2026-01-01T11:00:00.000Z', sinceId: 2 }, 200
  );
  assert.deepEqual(delta.map(r => r.id), [3]); // nur C ist neuer
});

test('pagesChangedSince: Keyset verliert keine Seite bei identischem Timestamp', () => {
  // Zwei Seiten mit EXAKT gleichem updated_at.
  const ts = '2026-02-01T12:00:00.000Z';
  insertPage(10, BOOK, 'D', ts);
  insertPage(11, BOOK, 'E', ts);

  // Cursor genau auf der ersten der beiden → die zweite MUSS noch kommen.
  const after = contentStore.pagesChangedSince(BOOK, { since: ts, sinceId: 10 }, 200);
  assert.ok(after.map(r => r.id).includes(11), 'Seite mit gleichem Timestamp aber groesserer id darf nicht verloren gehen');
  assert.ok(!after.map(r => r.id).includes(10), 'die Cursor-Seite selbst wird nicht erneut geliefert');
});

test('pagesChangedSince: limit wird respektiert', () => {
  const page = contentStore.pagesChangedSince(BOOK, { since: null, sinceId: 0 }, 2);
  assert.equal(page.length, 2);
  assert.deepEqual(page.map(r => r.id), [1, 2]); // aelteste zuerst
});

test('pagesChangedSince: Re-Save (neuer Timestamp) taucht wieder im Delta auf', () => {
  // Cursor steht hinter allem.
  const cursor = { since: '2026-12-31T23:59:59.999Z', since_id: 99999 };
  const before = contentStore.pagesChangedSince(BOOK, { since: cursor.since, sinceId: cursor.since_id }, 200);
  assert.equal(before.length, 0);

  // Seite A neu speichern → updated_at in die Zukunft.
  db.prepare('UPDATE pages SET updated_at = ? WHERE page_id = 1').run('2027-01-01T00:00:00.000Z');
  const after = contentStore.pagesChangedSince(BOOK, { since: cursor.since, sinceId: cursor.since_id }, 200);
  assert.deepEqual(after.map(r => r.id), [1]);
});

test('pagesChangedSince: Seite ohne updated_at liefert Nicht-NULL-Cursor (kein Baseline-Loop)', () => {
  const NULL_BOOK = 5003;
  schema.upsertBookByName(NULL_BOOK, 'Null-Stamp-Buch');
  // Legacy-/Seed-Seite ganz ohne Timestamp (weder updated_at noch local_updated_at).
  db.prepare(`
    INSERT INTO pages (page_id, book_id, page_name, body_html, updated_at, local_updated_at)
    VALUES (?, ?, ?, ?, NULL, NULL)
  `).run(200, NULL_BOOK, 'Legacy', '<p>Legacy</p>');
  db.prepare(`
    INSERT INTO pages (page_id, book_id, page_name, body_html, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(201, NULL_BOOK, 'Frisch', '<p>Frisch</p>', '2026-05-01T08:00:00.000Z');

  // Baseline-Pull: alle Seiten, NULL-Row sortiert ans Anfangsende.
  const baseline = contentStore.pagesChangedSince(NULL_BOOK, { since: null, sinceId: 0 }, 200);
  assert.deepEqual(baseline.map(r => r.id), [200, 201]);
  for (const r of baseline) {
    assert.ok(r.updated_at != null, 'kein Eintrag darf einen NULL-Cursor-Wert tragen');
  }

  // Cursor aus der letzten gelieferten Zeile bauen (wie GET /sync). Darf nie NULL sein.
  const last = baseline[baseline.length - 1];
  assert.ok(last.updated_at != null, 'Antwort-Cursor `since` darf nie NULL werden');

  // Mit diesem Cursor weiterpollen → keine Seite wird erneut geliefert (kein Loop).
  const next = contentStore.pagesChangedSince(
    NULL_BOOK, { since: last.updated_at, sinceId: last.id }, 200
  );
  assert.equal(next.length, 0, 'Cursor rueckt monoton vor — keine Endlos-Baseline');
});

test('pagesChangedSince: Cursor rueckt auch ueber die NULL-Row hinweg vor', () => {
  const NULL_BOOK = 5003;
  // Page-by-page mit limit=1 durchpagen: jede Seite genau einmal, monoton.
  const seen = [];
  let cursor = { since: null, sinceId: 0 };
  for (let i = 0; i < 10; i++) {
    const batch = contentStore.pagesChangedSince(NULL_BOOK, cursor, 1);
    if (!batch.length) break;
    const row = batch[0];
    assert.ok(row.updated_at != null);
    seen.push(row.id);
    cursor = { since: row.updated_at, sinceId: row.id };
  }
  assert.deepEqual(seen, [200, 201], 'jede Seite genau einmal, in Cursor-Ordnung');
});
