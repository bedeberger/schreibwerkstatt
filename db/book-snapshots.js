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
//   setPublished(bookId, id, on)   → boolean (true = Zeile getroffen)
//   latestSignature(bookId)        → { chars, pages, chapters } | null (Auto-Capture-Dedup)

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
  contentJson, extrasJson = null, publicationJson = null,
  chars = 0, words = 0, pages = 0, chapters = 0,
  userEmail = null, lektoratMetrics = null,
}) {
  const seq = _nextSeq(bookId);
  const res = db.prepare(`
    INSERT INTO book_snapshots
      (book_id, seq, label, description, content_json, extras_json, publication_json,
       chars, words, pages, chapters, user_email, lektorat_metrics, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, ${NOW_ISO_SQL})
  `).run(
    bookId, seq, label, description, contentJson, extrasJson, publicationJson,
    chars, words, pages, chapters, userEmail, lektoratMetrics,
  );
  return { id: res.lastInsertRowid, seq };
}

// Liste fuer die Karte: bewusst OHNE content_json/extras_json (koennen MB gross
// sein). DESC nach created_at (juengste Fassung zuerst). `has_extras` als Flag.
function listSnapshots(bookId) {
  return db.prepare(`
    SELECT id, book_id, seq, label, description,
           chars, words, pages, chapters, user_email, created_at, published_at,
           (extras_json IS NOT NULL) AS has_extras,
           (publication_json IS NOT NULL) AS has_publication
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

// Fassung als veroeffentlicht markieren (published_at = jetzt) bzw. Markierung
// entfernen (NULL). Mehrere Fassungen duerfen gleichzeitig markiert sein — eine
// pro Auflage. Book-scoped. Liefert true, wenn eine Zeile getroffen wurde.
function setPublished(bookId, id, published) {
  const res = published
    ? db.prepare(`UPDATE book_snapshots SET published_at = ${NOW_ISO_SQL} WHERE id = ? AND book_id = ?`).run(id, bookId)
    : db.prepare('UPDATE book_snapshots SET published_at = NULL WHERE id = ? AND book_id = ?').run(id, bookId);
  return res.changes > 0;
}

// Content-Signatur der juengsten Fassung (fuer Auto-Capture-Dedup): identische
// (chars, pages, chapters) → der aktuelle Stand wurde bereits festgehalten.
function latestSignature(bookId) {
  const row = db.prepare(`
    SELECT chars, pages, chapters FROM book_snapshots
    WHERE book_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(bookId);
  return row || null;
}

// Fehlerdichte-Trend: die Fassungen des Buchs mit ihrer verdichteten Lektorat-
// Kennzahl (lektorat_metrics), aufsteigend nach seq (Meilenstein-Reihenfolge).
// Nur Meta + Wörter-Nenner + Metrics-JSON — kein content_json/extras_json.
function listLektoratTrend(bookId) {
  return db.prepare(`
    SELECT id, seq, label, words, created_at, published_at, lektorat_metrics
    FROM book_snapshots
    WHERE book_id = ?
    ORDER BY seq ASC
  `).all(bookId);
}

module.exports = {
  createSnapshot, listSnapshots, getSnapshot, deleteSnapshot, countSnapshots,
  setPublished, latestSignature, listLektoratTrend,
};
