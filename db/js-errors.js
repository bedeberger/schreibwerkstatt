'use strict';
// Client-seitige JS-Fehler. Geschrieben vom /telemetry/js-error-Endpoint,
// gelesen von routes/admin-js-errors.js (Admin-View). Selbst-rotierend: beim
// Insert werden Zeilen oberhalb MAX_ROWS (aelteste zuerst) geloescht, damit die
// Tabelle nicht unbegrenzt waechst. Statements werden lazy in den Funktionen
// vorbereitet (kein Top-Level-prepare → keine Kopplung an Migrations-Reihenfolge).

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

// Harte Obergrenze. Aeltere Eintraege fallen beim naechsten Insert weg.
const MAX_ROWS = 1000;

// Einen Fehler persistieren. Erwartet bereits validierte/gekappte Felder.
function insertJsError({ user_email = null, kind = 'error', message, stack = null, source = null, line = null, col = null, page_url = null, user_agent = null }) {
  const row = {
    user_email,
    kind,
    message: String(message || '').slice(0, 2000),
    stack: stack == null ? null : String(stack).slice(0, 8000),
    source: source == null ? null : String(source).slice(0, 1000),
    line: Number.isInteger(line) ? line : null,
    col: Number.isInteger(col) ? col : null,
    page_url: page_url == null ? null : String(page_url).slice(0, 1000),
    user_agent: user_agent == null ? null : String(user_agent).slice(0, 500),
  };
  const tx = db.transaction((r) => {
    const info = db.prepare(`
      INSERT INTO js_errors (created_at, user_email, kind, message, stack, source, line, col, page_url, user_agent)
      VALUES (${NOW_ISO_SQL}, @user_email, @kind, @message, @stack, @source, @line, @col, @page_url, @user_agent)
    `).run(r);
    db.prepare(`
      DELETE FROM js_errors WHERE id NOT IN (
        SELECT id FROM js_errors ORDER BY id DESC LIMIT ${MAX_ROWS}
      )
    `).run();
    return info.lastInsertRowid;
  });
  return tx(row);
}

// Neueste zuerst. `limit` begrenzt die Rueckgabe.
function listJsErrors(limit = 500) {
  const n = Math.min(MAX_ROWS, Math.max(1, parseInt(limit, 10) || 500));
  return db.prepare(`
    SELECT id, created_at, user_email, kind, message, stack, source, line, col, page_url, user_agent
    FROM js_errors ORDER BY id DESC LIMIT ?
  `).all(n);
}

function deleteJsError(id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) return false;
  return db.prepare('DELETE FROM js_errors WHERE id = ?').run(n).changes > 0;
}

function clearJsErrors() {
  return db.prepare('DELETE FROM js_errors').run().changes;
}

module.exports = { insertJsError, listJsErrors, deleteJsError, clearJsErrors, MAX_ROWS };
