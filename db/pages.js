const path = require('path');
const fs = require('fs');
const { db } = require('./connection');
const logger = require('../logger');
require('./migrations');
const { saveFigurenToDb } = require('./figures');

// Einmalige Migration von lektorat-history.json

function migrateFromJson() {
  const HISTORY_FILE = path.join(__dirname, '..', 'lektorat-history.json');
  if (!fs.existsSync(HISTORY_FILE)) return;

  const existing = db.prepare('SELECT COUNT(*) as c FROM page_checks').get();
  if (existing.c > 0) {
    logger.info('lektorat-history.json vorhanden, aber DB hat bereits Daten – Migration übersprungen.');
    return;
  }

  let h;
  try { h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch (e) { logger.error('Migration: JSON lesen fehlgeschlagen: ' + e.message); return; }

  const insCheck = db.prepare(`
    INSERT INTO page_checks (page_id, book_id, checked_at, error_count, errors_json, stilanalyse, fazit, model, saved, saved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insReview = db.prepare(`
    INSERT INTO book_reviews (book_id, reviewed_at, review_json, model)
    VALUES (?, ?, ?, ?)`);
  const { upsertBookByName } = require('./books');

  db.transaction(() => {
    for (const r of (h.page_checks || [])) {
      insCheck.run(r.page_id, r.book_id, r.checked_at,
        r.error_count || 0, JSON.stringify(r.errors_json || []),
        r.stilanalyse || null, r.fazit || null, r.model || null,
        r.saved ? 1 : 0, r.saved_at || null);
    }
    for (const r of (h.book_reviews || [])) {
      if (r.book_name) upsertBookByName(r.book_id, r.book_name);
      insReview.run(r.book_id, r.reviewed_at,
        JSON.stringify(r.review_json || null), r.model || null);
    }
    for (const [bookId, entry] of Object.entries(h.book_figures || {})) {
      if (entry?.figuren?.length) {
        saveFigurenToDb(parseInt(bookId), entry.figuren);
      }
    }
  })();

  fs.renameSync(HISTORY_FILE, HISTORY_FILE + '.migrated');
  logger.info('Migration von lektorat-history.json abgeschlossen (Datei umbenannt zu .migrated).');
}
migrateFromJson();

// Heilt nur noch locations.erste_erwaehnung_page_id (Freitext-Snapshot → page_id).
// Snapshot-Spalten (chapter_name/kapitel/seite) wurden entfernt — Display-Werte
// werden zur Lese-Zeit aus chapters/pages JOIN'd.
//
// `bookId` (optional, Number): scoped das UPDATE auf das angegebene Buch.
function reconcilePageIds(bookId = null) {
  db.prepare(`
    UPDATE locations
    SET erste_erwaehnung_page_id = (
      SELECT p.page_id FROM pages p
      WHERE p.book_id = locations.book_id
        AND p.page_name = locations.erste_erwaehnung
      LIMIT 1
    )
    WHERE erste_erwaehnung IS NOT NULL
      ${bookId != null ? `AND locations.book_id = ${Number(bookId)}` : ''}
  `).run();
}

module.exports = {
  migrateFromJson,
  reconcilePageIds,
};
