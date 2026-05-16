'use strict';
// Phase 6 (BookStack-Exit): CRUD + FK-Verhalten fuer book_categories,
// book_tags, book_tag_assignments.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p6-cats-tags-'));
const dbFile = path.join(tmpDir, `p6-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const { db } = require('../../db/connection');
require('../../db/migrations');
const { upsertBookByName } = require('../../db/books');
const categories = require('../../db/book-categories');
const tags = require('../../db/book-tags');

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

test('tags: create dedupt nach name', () => {
  const t1 = tags.create({ name: 'Krimi' });
  const t2 = tags.create({ name: 'Krimi' });
  assert.equal(t1.id, t2.id);
});

test('tags: assign + setForBook + listForBook', () => {
  upsertBookByName(702, 'Buch P6 B');
  const a = tags.create({ name: 'Mystery' });
  const b = tags.create({ name: 'Thriller' });
  const c = tags.create({ name: 'Romance' });

  tags.setForBook(702, [a.id, b.id], 'user@x');
  const list1 = tags.listForBook(702);
  assert.equal(list1.length, 2);
  assert.deepEqual(list1.map(t => t.id).sort((x, y) => x - y), [a.id, b.id].sort((x, y) => x - y));

  // Replace: nur b + c.
  tags.setForBook(702, [b.id, c.id], 'user@x');
  const list2 = tags.listForBook(702);
  assert.equal(list2.length, 2);
  assert.deepEqual(list2.map(t => t.id).sort((x, y) => x - y), [b.id, c.id].sort((x, y) => x - y));
});

test('tags: unknown tagId in setForBook wirft', () => {
  upsertBookByName(703, 'Buch P6 C');
  assert.throws(() => tags.setForBook(703, [999999], 'user@x'), /TAG_NOT_FOUND/);
});

test('tags: delete CASCADE auf book_tag_assignments', () => {
  upsertBookByName(704, 'Buch P6 D');
  const t = tags.create({ name: 'ToDelete' });
  tags.setForBook(704, [t.id]);
  assert.equal(tags.listForBook(704).length, 1);
  tags.remove(t.id);
  assert.equal(tags.listForBook(704).length, 0);
});

test('tags: book delete CASCADE auf assignments', () => {
  upsertBookByName(705, 'Buch P6 E');
  const t = tags.create({ name: 'CascadeTag' });
  tags.setForBook(705, [t.id]);
  db.prepare('DELETE FROM books WHERE book_id = ?').run(705);
  const orphans = db.prepare('SELECT COUNT(*) AS n FROM book_tag_assignments WHERE book_id = ?').get(705);
  assert.equal(orphans.n, 0);
});

test('tags: listAssignmentsForBooks gruppiert nach book_id', () => {
  upsertBookByName(706, 'Buch P6 F');
  upsertBookByName(707, 'Buch P6 G');
  const t1 = tags.create({ name: 'Map1' });
  const t2 = tags.create({ name: 'Map2' });
  tags.setForBook(706, [t1.id, t2.id]);
  tags.setForBook(707, [t1.id]);
  const map = tags.listAssignmentsForBooks([706, 707, 9999]);
  assert.equal(map.get(706).length, 2);
  assert.equal(map.get(707).length, 1);
  assert.equal(map.has(9999), false);
});
