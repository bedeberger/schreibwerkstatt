// Schema-/Constraint-Regressionstest für das Recherche-Board (Migration 203).
// Validiert die FK-CASCADE-, CHECK- und UNIQUE-Garantien der drei Tabellen
// gegen das Squashed-Schema (Fresh-DB-Pfad).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { SQUASHED_SCHEMA } = require('../../db/squashed-schema.js');

const T = '2026-01-01T00:00:00.000Z';

function freshDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SQUASHED_SCHEMA);
  return db;
}

function seedBook(db) {
  const bookId = db.prepare('INSERT INTO books(name, created_at, updated_at) VALUES(?,?,?)')
    .run('Testbuch', T, T).lastInsertRowid;
  const chapterId = db.prepare('INSERT INTO chapters(book_id, chapter_name) VALUES(?,?)')
    .run(bookId, 'Kapitel 1').lastInsertRowid;
  const itemId = db.prepare(
    `INSERT INTO research_items(book_id, user_email, kind, title, body, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?)`
  ).run(bookId, 'a@b.c', 'note', 'Notiz', 'Inhalt', T, T).lastInsertRowid;
  return { bookId, chapterId, itemId };
}

test('research_item_links: CHECK erzwingt target_kind passend zum gesetzten *_id', () => {
  const db = freshDb();
  const { chapterId, itemId } = seedBook(db);
  // gültig
  db.prepare('INSERT INTO research_item_links(item_id, target_kind, chapter_id, created_at) VALUES(?,?,?,?)')
    .run(itemId, 'chapter', chapterId, T);
  // ungültig: target_kind=chapter aber page_id gesetzt
  assert.throws(() =>
    db.prepare('INSERT INTO research_item_links(item_id, target_kind, page_id, created_at) VALUES(?,?,?,?)')
      .run(itemId, 'chapter', 1, T),
  /CHECK|constraint/i);
  // ungültig: target_kind=chapter, KEIN *_id gesetzt
  assert.throws(() =>
    db.prepare('INSERT INTO research_item_links(item_id, target_kind, created_at) VALUES(?,?,?)')
      .run(itemId, 'chapter', T),
  /CHECK|constraint/i);
});

test('research_item_links: thread (Handlungsstrang) ist ein gültiges Verknüpfungsziel', () => {
  const db = freshDb();
  const { bookId, itemId } = seedBook(db);
  const threadId = db.prepare('INSERT INTO plot_threads(book_id, user_email, name) VALUES(?,?,?)')
    .run(bookId, 'a@b.c', 'Hauptstrang').lastInsertRowid;
  // gültig: target_kind=thread mit gesetztem thread_id
  db.prepare('INSERT INTO research_item_links(item_id, target_kind, thread_id, created_at) VALUES(?,?,?,?)')
    .run(itemId, 'thread', threadId, T);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM research_item_links WHERE target_kind='thread'").get().n, 1);
  // ungültig: target_kind=thread aber figure_id statt thread_id
  assert.throws(() =>
    db.prepare('INSERT INTO research_item_links(item_id, target_kind, figure_id, created_at) VALUES(?,?,?,?)')
      .run(itemId, 'thread', 1, T),
  /CHECK|constraint/i);
  // Strang-Löschung kaskadiert auf die Verknüpfung
  db.prepare('DELETE FROM plot_threads WHERE id = ?').run(threadId);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM research_item_links WHERE target_kind='thread'").get().n, 0);
});

test('research_item_links: UNIQUE verhindert doppelte Verknüpfung zum selben Ziel', () => {
  const db = freshDb();
  const { chapterId, itemId } = seedBook(db);
  db.prepare('INSERT INTO research_item_links(item_id, target_kind, chapter_id, created_at) VALUES(?,?,?,?)')
    .run(itemId, 'chapter', chapterId, T);
  assert.throws(() =>
    db.prepare('INSERT INTO research_item_links(item_id, target_kind, chapter_id, created_at) VALUES(?,?,?,?)')
      .run(itemId, 'chapter', chapterId, T),
  /UNIQUE|constraint/i);
});

test('research_items.kind: CHECK erlaubt nur die fünf Typen', () => {
  const db = freshDb();
  const { bookId } = seedBook(db);
  assert.throws(() =>
    db.prepare('INSERT INTO research_items(book_id, user_email, kind, created_at, updated_at) VALUES(?,?,?,?,?)')
      .run(bookId, 'a@b.c', 'bogus', T, T),
  /CHECK|constraint/i);
});

test('Buch-Löschung kaskadiert auf items, links und tags', () => {
  const db = freshDb();
  const { bookId, chapterId, itemId } = seedBook(db);
  db.prepare('INSERT INTO research_item_tags(item_id, tag) VALUES(?,?)').run(itemId, 'recherche');
  db.prepare('INSERT INTO research_item_links(item_id, target_kind, chapter_id, created_at) VALUES(?,?,?,?)')
    .run(itemId, 'chapter', chapterId, T);

  db.prepare('DELETE FROM books WHERE book_id = ?').run(bookId);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM research_items').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM research_item_links').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM research_item_tags').get().n, 0);
});

test('Tag-Löschung beim Item-Delete (item CASCADE)', () => {
  const db = freshDb();
  const { itemId } = seedBook(db);
  db.prepare('INSERT INTO research_item_tags(item_id, tag) VALUES(?,?)').run(itemId, 'x');
  db.prepare('DELETE FROM research_items WHERE id = ?').run(itemId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM research_item_tags').get().n, 0);
});

test('research_item_urls: Item-Löschung kaskadiert auf die URLs', () => {
  const db = freshDb();
  const { itemId } = seedBook(db);
  db.prepare('INSERT INTO research_item_urls(item_id, url, label, position, created_at) VALUES(?,?,?,?,?)')
    .run(itemId, 'https://example.org', 'Beispiel', 0, T);
  db.prepare('INSERT INTO research_item_urls(item_id, url, position, created_at) VALUES(?,?,?,?)')
    .run(itemId, 'https://example.org/2', 1, T);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM research_item_urls WHERE item_id = ?').get(itemId).n, 2);
  db.prepare('DELETE FROM research_items WHERE id = ?').run(itemId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM research_item_urls').get().n, 0);
});
