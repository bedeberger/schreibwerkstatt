'use strict';

// Manuskript-Meilensteine: ganze-Buch-Snapshots („Fassung 1/2/3").
// Selbsttragende Momentaufnahme eines Buchs — content_json haelt Tree + Seiten-
// HTML inline (buildBookJson-Format), extras_json optional Analyse/Lektorat.
// Sparse + user-initiiert + ohne Pruning (Gegenstueck zu page_revisions).
//
//   createSnapshot(payload)        → { id, seq }
//   listSnapshots(bookId)          → Meta-Zeilen (ohne content_json/extras_json)
//   getSnapshot(bookId, id)        → Vollzeile inkl. content_json/extras_json
//   deleteSnapshot(bookId, id)     → boolean (true = geloescht)
//   countSnapshots(bookId)         → number

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

// Naechste fortlaufende Fassungsnummer pro Buch (1-basiert, monoton — Loeschungen
// recyceln keine Nummer, damit „Fassung 3" stabil bleibt).
function _nextSeq(bookId) {
  const row = db.prepare('SELECT MAX(seq) AS maxSeq FROM book_snapshots WHERE book_id = ?').get(bookId);
  return (row && row.maxSeq ? row.maxSeq : 0) + 1;
}

function createSnapshot({
  bookId, label = null, description = null,
  contentJson, extrasJson = null,
  chars = 0, words = 0, pages = 0, chapters = 0,
  userEmail = null,
}) {
  const seq = _nextSeq(bookId);
  const res = db.prepare(`
    INSERT INTO book_snapshots
      (book_id, seq, label, description, content_json, extras_json,
       chars, words, pages, chapters, user_email, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, ${NOW_ISO_SQL})
  `).run(
    bookId, seq, label, description, contentJson, extrasJson,
    chars, words, pages, chapters, userEmail,
  );
  return { id: res.lastInsertRowid, seq };
}

// Liste fuer die Karte: bewusst OHNE content_json/extras_json (koennen MB gross
// sein). DESC nach created_at (juengste Fassung zuerst). `has_extras` als Flag.
function listSnapshots(bookId) {
  return db.prepare(`
    SELECT id, book_id, seq, label, description,
           chars, words, pages, chapters, user_email, created_at,
           (extras_json IS NOT NULL) AS has_extras
    FROM book_snapshots
    WHERE book_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(bookId);
}

// Vollzeile inkl. content_json (+ extras_json). Book-scoped, damit ein Snapshot
// nie ueber Buchgrenzen hinweg gelesen wird.
function getSnapshot(bookId, id) {
  return db.prepare('SELECT * FROM book_snapshots WHERE id = ? AND book_id = ?').get(id, bookId) || null;
}

function deleteSnapshot(bookId, id) {
  const res = db.prepare('DELETE FROM book_snapshots WHERE id = ? AND book_id = ?').run(id, bookId);
  return res.changes > 0;
}

function countSnapshots(bookId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM book_snapshots WHERE book_id = ?').get(bookId);
  return row ? row.n : 0;
}

module.exports = {
  createSnapshot, listSnapshots, getSnapshot, deleteSnapshot, countSnapshots,
};
