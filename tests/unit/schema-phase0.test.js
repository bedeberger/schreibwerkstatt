'use strict';
// Phase 0 (BookStack-Exit) Schema-Skelett: Migration 105 (additive Spalten)
// und Migration 106 (AUTOINCREMENT-Recreate + sqlite_sequence-Wasserzeichen).
//
// Test laesst die volle Migrations-Pipeline auf eine leere Tmp-DB laufen
// und prueft anschliessend:
//   - alle Phase-0-Spalten existieren auf books/chapters/pages
//   - books/chapters/pages haben AUTOINCREMENT (sqlite_sequence-Row)
//   - sqlite_sequence-Wasserzeichen >= 1_000_000
//   - frische Inserts vergeben IDs ab Wasserzeichen+1
//   - Bestandsrows behalten ihre BookStack-IDs unter dem Wasserzeichen
//   - Indexe (owner_email, dirty partial) sind angelegt
//   - foreign_key_check ist leer
//
// Plan-Referenz: docs/bookstack-exit.md#phase-0.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(os.tmpdir(), `schema-phase0-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;

require('../../db/migrations');
const { db } = require('../../db/connection');

// Bestandsrows mit BookStack-Range-IDs (< 100k typisch) seeden, bevor die
// Wasserzeichen-Pruefung gemacht wird. Migration 106 lief beim require oben
// schon — das Wasserzeichen ist also `MAX(1_000_000, MAX(existing_id))`,
// und existing_id ist hier 0. -> Wasserzeichen == 1_000_000.
db.prepare(`
  INSERT INTO books (book_id, name, slug, created_at, updated_at)
  VALUES (42, 'BS-Buch', 'bs-buch', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
`).run();
db.prepare(`
  INSERT INTO chapters (chapter_id, book_id, chapter_name, updated_at)
  VALUES (4200, 42, 'Kapitel 1', '2024-01-01T00:00:00Z')
`).run();
db.prepare(`
  INSERT INTO pages (page_id, book_id, page_name, chapter_id, updated_at)
  VALUES (42000, 42, 'Seite 1', 4200, '2024-01-01T00:00:00Z')
`).run();

test.after(() => {
  try { db.close(); } catch {}
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
});

function colNames(table) {
  return db.pragma(`table_info(${table})`).map(c => c.name);
}

test('schema_version >= 106', () => {
  const v = db.prepare('SELECT version FROM schema_version').get().version;
  assert.ok(v >= 106, `schema_version=${v} < 106`);
});

test('pages: alle Phase-0-Spalten existieren', () => {
  const cols = colNames('pages');
  for (const c of ['body_html','body_markdown','position','priority','slug','local_updated_at','remote_updated_at','dirty']) {
    assert.ok(cols.includes(c), `pages.${c} fehlt`);
  }
});

test('chapters: alle Phase-0-Spalten existieren', () => {
  const cols = colNames('chapters');
  for (const c of ['position','priority','slug','description']) {
    assert.ok(cols.includes(c), `chapters.${c} fehlt`);
  }
});

test('books: alle Phase-0-Spalten existieren', () => {
  const cols = colNames('books');
  for (const c of ['description','cover_image','owner_email']) {
    assert.ok(cols.includes(c), `books.${c} fehlt`);
  }
});

test('books: AUTOINCREMENT aktiv (sqlite_sequence-Row, seq >= 1_000_000)', () => {
  const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='books'").get();
  assert.ok(row, 'sqlite_sequence-Row fuer books fehlt');
  assert.ok(row.seq >= 1_000_000, `seq=${row.seq} < 1_000_000`);
});

test('chapters: AUTOINCREMENT aktiv (sqlite_sequence-Row, seq >= 1_000_000)', () => {
  const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='chapters'").get();
  assert.ok(row, 'sqlite_sequence-Row fuer chapters fehlt');
  assert.ok(row.seq >= 1_000_000, `seq=${row.seq} < 1_000_000`);
});

test('pages: AUTOINCREMENT aktiv (sqlite_sequence-Row, seq >= 1_000_000)', () => {
  const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='pages'").get();
  assert.ok(row, 'sqlite_sequence-Row fuer pages fehlt');
  assert.ok(row.seq >= 1_000_000, `seq=${row.seq} < 1_000_000`);
});

test('Bestandsrows mit BookStack-IDs (< 100k) ueberleben Migration 106', () => {
  const b = db.prepare('SELECT book_id FROM books WHERE book_id = 42').get();
  const c = db.prepare('SELECT chapter_id FROM chapters WHERE chapter_id = 4200').get();
  const p = db.prepare('SELECT page_id FROM pages WHERE page_id = 42000').get();
  assert.equal(b && b.book_id, 42);
  assert.equal(c && c.chapter_id, 4200);
  assert.equal(p && p.page_id, 42000);
});

test('Neuer Insert in books vergibt ID >= 1_000_001 (Wasserzeichen)', () => {
  const r = db.prepare(`
    INSERT INTO books (name, slug, created_at, updated_at)
    VALUES ('Neu', 'neu', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `).run();
  assert.ok(r.lastInsertRowid >= 1_000_001, `lastInsertRowid=${r.lastInsertRowid} < 1_000_001`);
});

test('Neuer Insert in chapters vergibt ID >= 1_000_001', () => {
  const r = db.prepare(`
    INSERT INTO chapters (book_id, chapter_name, updated_at)
    VALUES (42, 'Kap Neu', '2026-01-01T00:00:00Z')
  `).run();
  assert.ok(r.lastInsertRowid >= 1_000_001, `lastInsertRowid=${r.lastInsertRowid} < 1_000_001`);
});

test('Neuer Insert in pages vergibt ID >= 1_000_001', () => {
  const r = db.prepare(`
    INSERT INTO pages (book_id, page_name, chapter_id, updated_at)
    VALUES (42, 'Seite Neu', 4200, '2026-01-01T00:00:00Z')
  `).run();
  assert.ok(r.lastInsertRowid >= 1_000_001, `lastInsertRowid=${r.lastInsertRowid} < 1_000_001`);
});

test('Indexe vorhanden: idx_books_owner_email, idx_pages_dirty (partial)', () => {
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
  assert.ok(indexes.includes('idx_books_owner_email'), 'idx_books_owner_email fehlt');
  assert.ok(indexes.includes('idx_pages_dirty'), 'idx_pages_dirty fehlt');
});

test('pages.dirty default = 0', () => {
  // Frisch eingefuegte Page traegt dirty=0 ohne explizite Angabe.
  const r = db.prepare(`
    INSERT INTO pages (book_id, page_name, updated_at)
    VALUES (42, 'DirtyDefault', '2026-01-01T00:00:00Z')
  `).run();
  const row = db.prepare('SELECT dirty FROM pages WHERE page_id = ?').get(r.lastInsertRowid);
  assert.equal(row.dirty, 0);
});

test('FK chapters.book_id ON DELETE CASCADE: book loeschen kaskadiert chapters', () => {
  // Eigenes Buch + Kapitel, damit CASCADE-Effekt testbar isoliert ist.
  const bRes = db.prepare(`INSERT INTO books (name, slug, created_at, updated_at) VALUES ('Tmp','tmp','2026-01-01','2026-01-01')`).run();
  const bId = bRes.lastInsertRowid;
  const cRes = db.prepare(`INSERT INTO chapters (book_id, chapter_name, updated_at) VALUES (?, 'TmpCh','2026-01-01')`).run(bId);
  const cId = cRes.lastInsertRowid;
  db.prepare('DELETE FROM books WHERE book_id = ?').run(bId);
  const c = db.prepare('SELECT chapter_id FROM chapters WHERE chapter_id = ?').get(cId);
  assert.equal(c, undefined, 'chapters-Row wurde nicht cascadiert geloescht');
});

test('FK pages.chapter_id ON DELETE SET NULL: chapter loeschen nullt pages.chapter_id', () => {
  const bRes = db.prepare(`INSERT INTO books (name, slug, created_at, updated_at) VALUES ('Tmp2','tmp2','2026-01-01','2026-01-01')`).run();
  const bId = bRes.lastInsertRowid;
  const cRes = db.prepare(`INSERT INTO chapters (book_id, chapter_name, updated_at) VALUES (?, 'TmpCh2','2026-01-01')`).run(bId);
  const cId = cRes.lastInsertRowid;
  const pRes = db.prepare(`INSERT INTO pages (book_id, chapter_id, page_name, updated_at) VALUES (?, ?, 'TmpPg2','2026-01-01')`).run(bId, cId);
  const pId = pRes.lastInsertRowid;
  db.prepare('DELETE FROM chapters WHERE chapter_id = ?').run(cId);
  const p = db.prepare('SELECT chapter_id FROM pages WHERE page_id = ?').get(pId);
  assert.equal(p.chapter_id, null, 'pages.chapter_id wurde nicht auf NULL gesetzt');
});

test('foreign_key_check nach Migration 106 leer', () => {
  const errs = db.pragma('foreign_key_check');
  assert.equal(errs.length, 0, `foreign_key_check meldet ${errs.length} Verstoesse: ${JSON.stringify(errs)}`);
});

test('foreign_keys-PRAGMA = 1 (nach Migration wieder an)', () => {
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});
