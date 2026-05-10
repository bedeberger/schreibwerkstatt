'use strict';
// CRUD für draft_figures (Figuren-Werkstatt). Mindmap-Baum lebt als
// jsMind-JSON in mindmap_json; keine separate Knoten-Tabelle. Per-User-,
// per-Buch-skopiert; Owner-Check geschieht im Route-Handler.

const { db } = require('./connection');

const _SELECT_COLS = `id, book_id, user_email, name, archetype, mindmap_json, notes, created_at, updated_at`;

const _stmtList = db.prepare(
  `SELECT ${_SELECT_COLS} FROM draft_figures
    WHERE book_id = ? AND user_email = ?
    ORDER BY updated_at DESC, id DESC`
);
const _stmtGet = db.prepare(`SELECT ${_SELECT_COLS} FROM draft_figures WHERE id = ?`);
const _stmtInsert = db.prepare(
  `INSERT INTO draft_figures (book_id, user_email, name, archetype, mindmap_json, notes, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const _stmtUpdate = db.prepare(
  `UPDATE draft_figures SET name = ?, archetype = ?, mindmap_json = ?, notes = ?, updated_at = ? WHERE id = ?`
);
const _stmtDelete = db.prepare(`DELETE FROM draft_figures WHERE id = ?`);

function _row(r) {
  if (!r) return null;
  let mindmap = null;
  try { mindmap = JSON.parse(r.mindmap_json); } catch { mindmap = null; }
  return {
    id: r.id,
    book_id: r.book_id,
    user_email: r.user_email,
    name: r.name,
    archetype: r.archetype || null,
    mindmap,
    notes: r.notes || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function listDraftFigures(bookId, userEmail) {
  return _stmtList.all(parseInt(bookId), userEmail).map(_row);
}

function getDraftFigure(id) {
  return _row(_stmtGet.get(parseInt(id)));
}

function createDraftFigure(bookId, userEmail, { name, archetype = null, mindmap, notes = null }) {
  const now = new Date().toISOString();
  const info = _stmtInsert.run(
    parseInt(bookId), userEmail, name, archetype,
    JSON.stringify(mindmap), notes, now, now
  );
  return getDraftFigure(info.lastInsertRowid);
}

function updateDraftFigure(id, { name, archetype = null, mindmap, notes = null }) {
  const now = new Date().toISOString();
  _stmtUpdate.run(name, archetype, JSON.stringify(mindmap), notes, now, parseInt(id));
  return getDraftFigure(id);
}

function deleteDraftFigure(id) {
  _stmtDelete.run(parseInt(id));
}

module.exports = {
  listDraftFigures, getDraftFigure, createDraftFigure, updateDraftFigure, deleteDraftFigure,
};
