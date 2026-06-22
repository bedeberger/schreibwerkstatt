'use strict';
// CRUD für docx_export_profile (mehrere Word-Export-Profile pro Buch+User).
// Pendant zu db/pdf-export.js, aber ohne Cover-/Druck-BLOBs — DOCX ist
// reflowbar. JSON-Config als String persistiert.
//
// scope = (kind, book_id) analog PDF:
//   kind='book'         + book_id NOT NULL → buch-spezifisches Profil
//   kind='user_default' + book_id NULL     → buchunabhaengige Vorlage
// bookId<=0 / null / undefined → user_default-Scope.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { validateConfig } = require('../lib/docx-export-defaults');

function _scope(bookId) {
  const id = parseInt(bookId);
  if (!Number.isInteger(id) || id <= 0) return { kind: 'user_default', bookId: null };
  return { kind: 'book', bookId: id };
}

const _COLS = 'id, book_id, kind, user_email, name, config_json, is_default, created_at, updated_at';

const _stmtListBook = db.prepare(
  `SELECT ${_COLS} FROM docx_export_profile
    WHERE kind = 'book' AND book_id = ? AND user_email = ?
    ORDER BY is_default DESC, name COLLATE NOCASE ASC`
);
const _stmtListUserDefault = db.prepare(
  `SELECT ${_COLS} FROM docx_export_profile
    WHERE kind = 'user_default' AND user_email = ?
    ORDER BY is_default DESC, name COLLATE NOCASE ASC`
);
const _stmtGet = db.prepare(`SELECT ${_COLS} FROM docx_export_profile WHERE id = ?`);
const _stmtInsert = db.prepare(
  `INSERT INTO docx_export_profile (book_id, kind, user_email, name, config_json, is_default, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, 0, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})`
);
const _stmtUpdate = db.prepare(
  `UPDATE docx_export_profile SET name = ?, config_json = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?`
);
const _stmtDelete = db.prepare('DELETE FROM docx_export_profile WHERE id = ?');
const _stmtClearDefaultsBook = db.prepare(
  `UPDATE docx_export_profile SET is_default = 0 WHERE kind = 'book' AND book_id = ? AND user_email = ?`
);
const _stmtClearDefaultsUserDefault = db.prepare(
  `UPDATE docx_export_profile SET is_default = 0 WHERE kind = 'user_default' AND user_email = ?`
);
const _stmtSetDefaultForId = db.prepare(
  `UPDATE docx_export_profile SET is_default = 1, updated_at = ${NOW_ISO_SQL} WHERE id = ?`
);

function _row(r) {
  if (!r) return null;
  return {
    id: r.id,
    book_id: r.book_id,
    kind: r.kind,
    user_email: r.user_email,
    name: r.name,
    config: validateConfig(JSON.parse(r.config_json)),
    is_default: !!r.is_default,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function listProfiles(bookId, userEmail) {
  const s = _scope(bookId);
  const rows = s.kind === 'book'
    ? _stmtListBook.all(s.bookId, userEmail)
    : _stmtListUserDefault.all(userEmail);
  return rows.map(_row);
}

function getProfile(id) {
  return _row(_stmtGet.get(parseInt(id)));
}

function createProfile(bookId, userEmail, name, config) {
  const s = _scope(bookId);
  const info = _stmtInsert.run(s.bookId, s.kind, userEmail, name, JSON.stringify(config));
  return getProfile(info.lastInsertRowid);
}

function updateProfile(id, name, config) {
  _stmtUpdate.run(name, JSON.stringify(config), parseInt(id));
  return getProfile(id);
}

function deleteProfile(id) {
  _stmtDelete.run(parseInt(id));
}

const _setDefaultTx = db.transaction((bookId, userEmail, id) => {
  const s = _scope(bookId);
  if (s.kind === 'book') _stmtClearDefaultsBook.run(s.bookId, userEmail);
  else                   _stmtClearDefaultsUserDefault.run(userEmail);
  _stmtSetDefaultForId.run(parseInt(id));
});

function setDefault(bookId, userEmail, id) {
  _setDefaultTx(bookId, userEmail, id);
  return getProfile(id);
}

module.exports = {
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile, setDefault,
};
