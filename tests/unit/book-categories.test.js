'use strict';
// CRUD + FK-Verhalten fuer book_categories.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p6-cats-'));
const dbFile = path.join(tmpDir, `p6-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const { db } = require('../../db/connection');
require('../../db/migrations');
const { upsertBookByName } = require('../../db/books');
const categories = require('../../db/book-categories');

test.after(() => {
  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('categories: create + list + slug-uniqueness', () => {
  const a = categories.create({ name: 'Roman', createdBy: 'admin@x' });
  const b = categories.create({ name: 'Sachbuch' });
  assert.equal(a.slug, 'roman');
  assert.equal(b.slug, 'sachbuch');
  const all = categories.list();
  assert.ok(all.length >= 2);
  // Konflikt → -2 Suffix.
  const dup = categories.create({ name: 'Roman' });
  assert.equal(dup.slug, 'roman-2');
});

test('categories: update + delete', () => {
  const c = categories.create({ name: 'Lyrik' });
  const updated = categories.update(c.id, { name: 'Poesie' });
  assert.equal(updated.name, 'Poesie');
  assert.ok(categories.remove(c.id));
  assert.equal(categories.get(c.id), null);
});

test('categories: self-parent verboten', () => {
  const c = categories.create({ name: 'Self' });
  assert.throws(() => categories.update(c.id, { parentId: c.id }), /self-parent/);
});

test('categories: books.category_id FK SET NULL bei delete', () => {
  upsertBookByName(701, 'Buch P6 A');
  const c = categories.create({ name: 'TempCat' });
  assert.ok(categories.setForBook(701, c.id));
  const row1 = db.prepare('SELECT category_id FROM books WHERE book_id = ?').get(701);
  assert.equal(row1.category_id, c.id);
  categories.remove(c.id);
  const row2 = db.prepare('SELECT category_id FROM books WHERE book_id = ?').get(701);
  assert.equal(row2.category_id, null);
});
