'use strict';
// Zuletzt gewaehlter Lauf-Umfang der Komplettanalyse, pro Buch + User.
// Katalog und Normalisierung liegen in lib/komplett-scope.js (SSoT); hier nur
// Lesen/Schreiben. Gelesen wird IMMER normalisiert — eine Zeile aus der Zeit vor
// einem neuen Schritt soll diesen laufen lassen, nicht still ueberspringen.
require('./migrations');
const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { normalizeKomplettScope } = require('../lib/komplett-scope');
const { requireUserEmail } = require('./write-helpers');

const _get = db.prepare(
  'SELECT scope_json FROM komplett_scope WHERE book_id = ? AND user_email = ?'
);
const _set = db.prepare(
  `INSERT INTO komplett_scope (book_id, user_email, scope_json, updated_at)
   VALUES (?, ?, ?, ${NOW_ISO_SQL})
   ON CONFLICT(book_id, user_email) DO UPDATE
     SET scope_json = excluded.scope_json, updated_at = excluded.updated_at`
);

/** Gespeicherter Umfang oder – ohne Zeile – der vollstaendige Lauf. */
function getKomplettScope(bookId, userEmail) {
  const row = _get.get(parseInt(bookId), userEmail || '');
  if (!row) return normalizeKomplettScope(null);
  try {
    return normalizeKomplettScope(JSON.parse(row.scope_json));
  } catch {
    // Unlesbare Zeile ist kein Grund, den Lauf zu blockieren: der vollstaendige
    // Umfang ist die sichere Vorbelegung (er laesst nichts aus).
    return normalizeKomplettScope(null);
  }
}

function saveKomplettScope(bookId, userEmail, scope) {
  const email = requireUserEmail(userEmail, 'saveKomplettScope');
  const normalized = normalizeKomplettScope(scope);
  _set.run(parseInt(bookId), email, JSON.stringify(normalized));
  return normalized;
}

module.exports = { getKomplettScope, saveKomplettScope };
