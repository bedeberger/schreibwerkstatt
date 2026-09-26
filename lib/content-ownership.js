'use strict';
// Buch-Zugehörigkeit einer Seite/eines Kapitels auflösen — geteilte SSoT für die
// vielen Route-/Job-Handler, die vor dem ACL-Guard (requireBookAccess) die book_id
// zu einer page_id/chapter_id brauchen. Synchron (better-sqlite3), weil die Guards
// synchron laufen.

const { db } = require('../db/connection');

// book_id einer Seite, oder null wenn die Seite nicht existiert.
function resolvePageBookId(pageId) {
  const r = db.prepare('SELECT book_id FROM pages WHERE page_id = ?').get(parseInt(pageId, 10));
  return r?.book_id || null;
}

// book_id eines Kapitels, oder null wenn das Kapitel nicht existiert.
function resolveChapterBookId(chapterId) {
  const r = db.prepare('SELECT book_id FROM chapters WHERE chapter_id = ?').get(parseInt(chapterId, 10));
  return r?.book_id || null;
}

// book_id je Seite fuer eine ganze Liste: Map page_id → book_id (fehlende Seiten
// fehlen in der Map). Fuer Batch-Routen, die pro Zeile gegen das Buch pruefen.
function resolvePageBookIds(pageIds) {
  const ids = [...new Set((pageIds || []).map(id => parseInt(id, 10)).filter(Number.isInteger))];
  if (!ids.length) return new Map();
  const rows = db.prepare(`SELECT page_id, book_id FROM pages WHERE page_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return new Map(rows.map(r => [r.page_id, r.book_id]));
}

module.exports = { resolvePageBookId, resolveChapterBookId, resolvePageBookIds };
