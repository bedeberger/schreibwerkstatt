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

module.exports = { resolvePageBookId, resolveChapterBookId };
