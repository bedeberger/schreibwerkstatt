'use strict';

// Persistenz fuer den Namens-/Konsistenz-Waechter: Ignore-Liste akzeptierter
// Schreibvarianten pro Buch + User. Die Erkennung selbst ist zustandslos
// (lib/name-guard.js); hier liegt nur, was der User bewusst durchgewunken hat,
// damit kuenftige Laeufe es nicht erneut melden.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const _stmtList = db.prepare(
  `SELECT canonical, variant, created_at FROM name_guard_ignores
   WHERE book_id = ? AND user_email IS ?
   ORDER BY created_at DESC`
);
const _stmtInsert = db.prepare(
  `INSERT OR IGNORE INTO name_guard_ignores (book_id, user_email, canonical, variant, created_at)
   VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})`
);
const _stmtDelete = db.prepare(
  `DELETE FROM name_guard_ignores WHERE book_id = ? AND user_email IS ? AND variant = ?`
);

function list(bookId, userEmail) {
  if (!bookId) return [];
  return _stmtList.all(bookId, userEmail || null);
}

function add(bookId, userEmail, { canonical, variant }) {
  if (!bookId || !variant || !variant.trim()) return false;
  _stmtInsert.run(bookId, userEmail || null, String(canonical || '').trim(), variant.trim());
  return true;
}

function remove(bookId, userEmail, variant) {
  if (!bookId || !variant) return 0;
  return _stmtDelete.run(bookId, userEmail || null, String(variant).trim()).changes;
}

module.exports = { list, add, remove };
