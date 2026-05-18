'use strict';
// CRUD fuer book_tags + book_tag_assignments. Tag-Pool global, jeder Auth-User darf neue Tags
// anlegen. Loeschen ist admin-only (via Route-Guard).

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { slugify, uniqueSlug } = require('../lib/slug');

const _stmtList = db.prepare(`
  SELECT t.id, t.name, t.slug, t.color, t.created_by, t.created_at,
         (SELECT COUNT(*) FROM book_tag_assignments a WHERE a.tag_id = t.id) AS book_count
    FROM book_tags t
   ORDER BY t.name
`);

function list() {
  return _stmtList.all();
}

const _stmtGet = db.prepare(`
  SELECT id, name, slug, color, created_by, created_at FROM book_tags WHERE id = ?
`);

function get(id) {
  return _stmtGet.get(parseInt(id, 10)) || null;
}

const _stmtGetByName = db.prepare('SELECT id, name, slug, color FROM book_tags WHERE name = ?');
function getByName(name) {
  return _stmtGetByName.get(String(name || '').trim()) || null;
}

const _stmtGetBySlug = db.prepare('SELECT id, name, slug, color FROM book_tags WHERE slug = ?');
function _slugExists(slug) {
  return !!_stmtGetBySlug.get(slug);
}

const _stmtInsert = db.prepare(`
  INSERT INTO book_tags (name, slug, color, created_by, created_at) VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})
`);

function create({ name, color = null, createdBy = null }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('book-tags.create: name required');
  if (trimmed.length > 80) throw new Error('book-tags.create: name too long (>80)');
  const existing = getByName(trimmed);
  if (existing) return get(existing.id);
  const baseSlug = slugify(trimmed) || 'tag';
  const slug = uniqueSlug(baseSlug, _slugExists);
  const result = _stmtInsert.run(trimmed, slug, color || null, createdBy || null);
  return get(result.lastInsertRowid);
}

const _stmtUpdate = db.prepare('UPDATE book_tags SET name = ?, color = ? WHERE id = ?');
function update(id, { name, color }) {
  const numId = parseInt(id, 10);
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('book-tags.update: invalid id');
  const cur = get(numId);
  if (!cur) return null;
  const nextName = name === undefined ? cur.name : String(name || '').trim();
  if (!nextName) throw new Error('book-tags.update: name required');
  if (nextName.length > 80) throw new Error('book-tags.update: name too long (>80)');
  _stmtUpdate.run(nextName, color === undefined ? cur.color : (color || null), numId);
  return get(numId);
}

const _stmtDelete = db.prepare('DELETE FROM book_tags WHERE id = ?');
function remove(id) {
  return _stmtDelete.run(parseInt(id, 10)).changes > 0;
}

// ── Assignments ─────────────────────────────────────────────────────────────

const _stmtListForBook = db.prepare(`
  SELECT t.id, t.name, t.slug, t.color
    FROM book_tag_assignments a
    JOIN book_tags t ON t.id = a.tag_id
   WHERE a.book_id = ?
   ORDER BY t.name
`);

function listForBook(bookId) {
  return _stmtListForBook.all(parseInt(bookId, 10));
}

const _stmtAssign = db.prepare(`
  INSERT INTO book_tag_assignments (book_id, tag_id, assigned_by, assigned_at)
  VALUES (?, ?, ?, ${NOW_ISO_SQL})
  ON CONFLICT(book_id, tag_id) DO NOTHING
`);
const _stmtUnassign = db.prepare(
  'DELETE FROM book_tag_assignments WHERE book_id = ? AND tag_id = ?'
);
const _stmtClearForBook = db.prepare('DELETE FROM book_tag_assignments WHERE book_id = ?');

function assign(bookId, tagId, assignedBy = null) {
  const bid = parseInt(bookId, 10);
  const tid = parseInt(tagId, 10);
  if (!Number.isInteger(bid) || bid <= 0) throw new Error('book-tags.assign: invalid bookId');
  if (!Number.isInteger(tid) || tid <= 0) throw new Error('book-tags.assign: invalid tagId');
  if (!get(tid)) throw new Error('TAG_NOT_FOUND');
  _stmtAssign.run(bid, tid, assignedBy || null);
}

function unassign(bookId, tagId) {
  return _stmtUnassign.run(parseInt(bookId, 10), parseInt(tagId, 10)).changes > 0;
}

// Atomic Replace: alle Assignments des Buchs auf gegebene Tag-IDs setzen.
// Unbekannte tagIds → Error (kein Silent-Drop).
function setForBook(bookId, tagIds, assignedBy = null) {
  const bid = parseInt(bookId, 10);
  if (!Number.isInteger(bid) || bid <= 0) throw new Error('book-tags.setForBook: invalid bookId');
  const ids = (Array.isArray(tagIds) ? tagIds : []).map(x => parseInt(x, 10)).filter(n => Number.isInteger(n) && n > 0);
  for (const tid of ids) {
    if (!get(tid)) throw new Error('TAG_NOT_FOUND');
  }
  db.transaction(() => {
    _stmtClearForBook.run(bid);
    for (const tid of ids) {
      _stmtAssign.run(bid, tid, assignedBy || null);
    }
  })();
  return listForBook(bid);
}

// Map: bookId → [tag, tag, …] fuer Listen-Endpoint.
function listAssignmentsForBooks(bookIds) {
  const ids = (bookIds || []).map(x => parseInt(x, 10)).filter(n => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT a.book_id, t.id, t.name, t.slug, t.color
      FROM book_tag_assignments a
      JOIN book_tags t ON t.id = a.tag_id
     WHERE a.book_id IN (${placeholders})
     ORDER BY t.name
  `).all(...ids);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.book_id)) map.set(r.book_id, []);
    map.get(r.book_id).push({ id: r.id, name: r.name, slug: r.slug, color: r.color });
  }
  return map;
}

module.exports = {
  list, get, getByName, create, update, remove,
  listForBook, assign, unassign, setForBook, listAssignmentsForBooks,
};
