'use strict';
// CRUD fuer book_categories.
// Admin-only Pool (global sichtbar). Bucher referenzieren via books.category_id;
// FK ON DELETE SET NULL — Loeschen einer Kategorie loescht keine Buecher.
// Hierarchie via parent_id (max 2 Ebenen empfohlen, nicht erzwungen).

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { slugify, uniqueSlug } = require('../lib/slug');

const _stmtList = db.prepare(`
  SELECT id, parent_id, name, slug, color, position, created_by, created_at
    FROM book_categories
   ORDER BY position, name
`);

function list() {
  return _stmtList.all();
}

const _stmtGet = db.prepare(`
  SELECT id, parent_id, name, slug, color, position, created_by, created_at
    FROM book_categories WHERE id = ?
`);

function get(id) {
  return _stmtGet.get(parseInt(id, 10)) || null;
}

const _stmtSlugExists = db.prepare('SELECT 1 FROM book_categories WHERE slug = ?');
function _slugExists(slug) {
  return !!_stmtSlugExists.get(slug);
}

const _stmtInsert = db.prepare(`
  INSERT INTO book_categories (parent_id, name, slug, color, position, created_by, created_at)
  VALUES (@parent_id, @name, @slug, @color, @position, @created_by, ${NOW_ISO_SQL})
`);

function create({ name, parentId = null, color = null, position = 0, createdBy = null }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('book-categories.create: name required');
  if (trimmed.length > 120) throw new Error('book-categories.create: name too long (>120)');
  const baseSlug = slugify(trimmed) || 'kategorie';
  const slug = uniqueSlug(baseSlug, _slugExists);
  const result = _stmtInsert.run({
    parent_id: parentId == null ? null : parseInt(parentId, 10),
    name: trimmed,
    slug,
    color: color || null,
    position: Number.isInteger(position) ? position : 0,
    created_by: createdBy || null,
  });
  return get(result.lastInsertRowid);
}

const _stmtUpdate = db.prepare(`
  UPDATE book_categories
     SET name      = @name,
         parent_id = @parent_id,
         color     = @color,
         position  = @position
   WHERE id = @id
`);

function update(id, { name, parentId, color, position }) {
  const numId = parseInt(id, 10);
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('book-categories.update: invalid id');
  const cur = get(numId);
  if (!cur) return null;
  const nextName = name === undefined ? cur.name : String(name || '').trim();
  if (!nextName) throw new Error('book-categories.update: name required');
  if (nextName.length > 120) throw new Error('book-categories.update: name too long (>120)');
  let nextParent = parentId === undefined ? cur.parent_id : (parentId == null ? null : parseInt(parentId, 10));
  if (nextParent === numId) throw new Error('book-categories.update: self-parent not allowed');
  _stmtUpdate.run({
    id: numId,
    name: nextName,
    parent_id: nextParent,
    color: color === undefined ? cur.color : (color || null),
    position: position === undefined ? cur.position : (Number.isInteger(position) ? position : 0),
  });
  return get(numId);
}

const _stmtDelete = db.prepare('DELETE FROM book_categories WHERE id = ?');
function remove(id) {
  return _stmtDelete.run(parseInt(id, 10)).changes > 0;
}

// Kategorie je Buch fuer eine Buch-Menge (Map book_id → { id, name, color,
// parent_id }). Buecher ohne Zuordnung fehlen in der Map. JOIN haelt die
// books.category_id-Lese im Kategorie-Domaenen-File (analog setForBook).
function getForBooks(bookIds) {
  const ids = (bookIds || []).map(n => parseInt(n, 10)).filter(Number.isInteger);
  if (!ids.length) return new Map();
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT b.book_id, c.id, c.name, c.color, c.parent_id
      FROM books b
      JOIN book_categories c ON c.id = b.category_id
     WHERE b.book_id IN (${ph})
  `).all(...ids);
  const m = new Map();
  for (const r of rows) m.set(r.book_id, { id: r.id, name: r.name, color: r.color, parent_id: r.parent_id });
  return m;
}

const _stmtSetForBook = db.prepare('UPDATE books SET category_id = ? WHERE book_id = ?');
function setForBook(bookId, categoryId) {
  const bid = parseInt(bookId, 10);
  if (!Number.isInteger(bid) || bid <= 0) throw new Error('book-categories.setForBook: invalid bookId');
  const cid = categoryId == null ? null : parseInt(categoryId, 10);
  if (cid != null && !get(cid)) throw new Error('CATEGORY_NOT_FOUND');
  return _stmtSetForBook.run(cid, bid).changes > 0;
}

module.exports = { list, get, create, update, remove, setForBook, getForBooks };
