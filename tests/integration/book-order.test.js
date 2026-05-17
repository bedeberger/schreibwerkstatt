'use strict';
// book_order — Validator, Materializer, Overlay,
// Reconcile. Integration-Test (echte SQLite, lokales Schema).

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'integration-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let bookOrder;
let contentStore;
let db;

test.before(() => {
  ctx = bootstrap();
  bookOrder = require('../../db/book-order');
  contentStore = require('../../lib/content-store');
  db = require('../../db/connection').db;
  require('../../lib/app-settings').set('app.backend', 'localdb', { updatedBy: 'test' });
});
test.after(() => { ctx.cleanup(); });

function seedBook(name = 'BO-Test') {
  const now = new Date().toISOString();
  return db.prepare(`
    INSERT INTO books (name, description, created_at, updated_at, owner_email)
    VALUES (?, '', ?, ?, NULL)
  `).run(name, now, now).lastInsertRowid;
}
function seedChapter(bookId, name, position = 0) {
  const now = new Date().toISOString();
  return db.prepare(`
    INSERT INTO chapters (book_id, chapter_name, position, priority, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(bookId, name, position, position, now).lastInsertRowid;
}
function seedPage(bookId, chapterId, name, position = 0) {
  const now = new Date().toISOString();
  return db.prepare(`
    INSERT INTO pages (book_id, chapter_id, page_name, body_html, position, priority, updated_at, local_updated_at)
    VALUES (?, ?, ?, '<p/>', ?, ?, ?, ?)
  `).run(bookId, chapterId, name, position, position, now, now).lastInsertRowid;
}

test('validateTree akzeptiert vollstaendigen, sauberen Baum', () => {
  const bookId = seedBook('valid-tree');
  const c1 = seedChapter(bookId, 'C1');
  const c2 = seedChapter(bookId, 'C2');
  const p1 = seedPage(bookId, c1, 'P1');
  const p2 = seedPage(bookId, c1, 'P2');
  const p3 = seedPage(bookId, null, 'Top');
  const tree = [
    { type: 'chapter', id: c1, children: [{ type: 'page', id: p1 }, { type: 'page', id: p2 }] },
    { type: 'page', id: p3 },
    { type: 'chapter', id: c2, children: [] },
  ];
  assert.doesNotThrow(() => bookOrder.validateTree(tree, bookId));
});

test('validateTree wirft auf doppelte Page', () => {
  const bookId = seedBook('dup');
  const c1 = seedChapter(bookId, 'C1');
  const p1 = seedPage(bookId, c1, 'P1');
  const tree = [
    { type: 'chapter', id: c1, children: [{ type: 'page', id: p1 }, { type: 'page', id: p1 }] },
  ];
  let err;
  try { bookOrder.validateTree(tree, bookId); } catch (e) { err = e; }
  assert.ok(err, 'erwarteter Fehler');
  assert.equal(err.code, 'DUPLICATE_PAGE');
});

test('validateTree wirft auf fehlende Page (Vollstaendigkeit)', () => {
  const bookId = seedBook('miss');
  const c1 = seedChapter(bookId, 'C1');
  seedPage(bookId, c1, 'P1'); // fehlt im Tree
  const tree = [{ type: 'chapter', id: c1, children: [] }];
  let err;
  try { bookOrder.validateTree(tree, bookId); } catch (e) { err = e; }
  assert.ok(err, 'erwarteter Fehler');
  assert.equal(err.code, 'MISSING_PAGE');
});

test('validateTree wirft auf unbekannte ID', () => {
  const bookId = seedBook('unknown');
  const tree = [{ type: 'chapter', id: 999_999_999, children: [] }];
  let err;
  try { bookOrder.validateTree(tree, bookId); } catch (e) { err = e; }
  assert.ok(err, 'erwarteter Fehler');
  assert.equal(err.code, 'UNKNOWN_CHAPTER');
});

test('validateTree wirft auf verschachteltes Kapitel', () => {
  const bookId = seedBook('nest');
  const c1 = seedChapter(bookId, 'C1');
  const c2 = seedChapter(bookId, 'C2');
  const tree = [
    { type: 'chapter', id: c1, children: [{ type: 'chapter', id: c2, children: [] }] },
  ];
  let err;
  try { bookOrder.validateTree(tree, bookId); } catch (e) { err = e; }
  assert.ok(err, 'erwarteter Fehler');
  assert.equal(err.code, 'NESTED_CHAPTER');
});

test('materializeTree setzt chapters.position, pages.position, pages.chapter_id', () => {
  const bookId = seedBook('materialize');
  const cA = seedChapter(bookId, 'A', 99);
  const cB = seedChapter(bookId, 'B', 99);
  const pA1 = seedPage(bookId, cA, 'A1', 99);
  const pA2 = seedPage(bookId, cA, 'A2', 99);
  const pTop = seedPage(bookId, null, 'Top', 99);
  const tree = [
    { type: 'chapter', id: cB, children: [] },
    { type: 'chapter', id: cA, children: [{ type: 'page', id: pA2 }, { type: 'page', id: pA1 }] },
    { type: 'page', id: pTop },
  ];
  bookOrder.putOrder(bookId, tree, 'test@example.com');

  const cAPos = db.prepare('SELECT position FROM chapters WHERE chapter_id = ?').get(cA).position;
  const cBPos = db.prepare('SELECT position FROM chapters WHERE chapter_id = ?').get(cB).position;
  assert.equal(cBPos, 0);
  assert.equal(cAPos, 1);
  const pA2Pos = db.prepare('SELECT position, chapter_id FROM pages WHERE page_id = ?').get(pA2);
  const pA1Pos = db.prepare('SELECT position, chapter_id FROM pages WHERE page_id = ?').get(pA1);
  assert.equal(pA2Pos.position, 0);
  assert.equal(pA1Pos.position, 1);
  assert.equal(pA2Pos.chapter_id, cA);
  const topRow = db.prepare('SELECT position, chapter_id FROM pages WHERE page_id = ?').get(pTop);
  assert.equal(topRow.position, 0);
  assert.equal(topRow.chapter_id, null);
});

test('putOrder persistiert order_json + updated_by', () => {
  const bookId = seedBook('persist');
  const c1 = seedChapter(bookId, 'C1');
  const p1 = seedPage(bookId, c1, 'P1');
  bookOrder.putOrder(bookId, [
    { type: 'chapter', id: c1, children: [{ type: 'page', id: p1 }] },
  ], 'alice@example.com');
  const r = bookOrder.getOrder(bookId);
  assert.deepEqual(r.tree, [
    { type: 'chapter', id: c1, children: [{ type: 'page', id: p1 }] },
  ]);
  assert.equal(r.updated_by, 'alice@example.com');
  assert.ok(r.updated_at);
});

test('ensureTree initialisiert aus position/priority, wenn keine Row existiert', () => {
  const bookId = seedBook('init');
  const c1 = seedChapter(bookId, 'C1', 0);
  const c2 = seedChapter(bookId, 'C2', 1);
  const p1 = seedPage(bookId, c1, 'P1', 0);
  const p2 = seedPage(bookId, c2, 'P2', 0);
  const pTop = seedPage(bookId, null, 'Top', 0);

  const r = bookOrder.ensureTree(bookId);
  assert.ok(r.tree);
  // C1 (pos 0), Top (pos 0, chapter-first heuristic), C2 (pos 1)
  // Aktuelles Heuristik-Verhalten: Chapter-first bei Gleichstand.
  const ids = r.tree.map(e => `${e.type}:${e.id}`);
  assert.ok(ids.includes(`chapter:${c1}`));
  assert.ok(ids.includes(`chapter:${c2}`));
  assert.ok(ids.includes(`page:${pTop}`));
  // P1 unter C1, P2 unter C2.
  const c1Entry = r.tree.find(e => e.type === 'chapter' && e.id === c1);
  assert.deepEqual(c1Entry.children, [{ type: 'page', id: p1 }]);
  const c2Entry = r.tree.find(e => e.type === 'chapter' && e.id === c2);
  assert.deepEqual(c2Entry.children, [{ type: 'page', id: p2 }]);
});

test('ensureTree reconciliert neue + geloeschte Items', () => {
  const bookId = seedBook('reconcile');
  const c1 = seedChapter(bookId, 'C1');
  const p1 = seedPage(bookId, c1, 'P1');
  bookOrder.putOrder(bookId, [
    { type: 'chapter', id: c1, children: [{ type: 'page', id: p1 }] },
  ], 'test');

  // Hinzu: neues Kapitel + neue Seite ohne PUT.
  const c2 = seedChapter(bookId, 'C2');
  const p2 = seedPage(bookId, c2, 'P2');
  const pNew = seedPage(bookId, null, 'TopNew');

  // Geloescht: P1 via DELETE (Cascade aus chapters bei FK ON DELETE SET NULL
  // greift nicht — pages.chapter_id ist ON DELETE SET NULL. Direkter Delete.)
  db.prepare('DELETE FROM pages WHERE page_id = ?').run(p1);

  const r = bookOrder.ensureTree(bookId);
  const idsTop = r.tree.map(e => `${e.type}:${e.id}`);
  assert.ok(idsTop.includes(`chapter:${c1}`), 'C1 bleibt');
  assert.ok(idsTop.includes(`chapter:${c2}`), 'C2 angehaengt');
  assert.ok(idsTop.includes(`page:${pNew}`), 'TopNew angehaengt');
  const c1Entry = r.tree.find(e => e.type === 'chapter' && e.id === c1);
  assert.equal(c1Entry.children.length, 0, 'P1 entfernt');
  const c2Entry = r.tree.find(e => e.type === 'chapter' && e.id === c2);
  assert.deepEqual(c2Entry.children, [{ type: 'page', id: p2 }]);
});

test('content-store bookTree liest order_json (Overlay)', async () => {
  const bookId = seedBook('overlay');
  const cA = seedChapter(bookId, 'A', 0);
  const cB = seedChapter(bookId, 'B', 1);
  const pA1 = seedPage(bookId, cA, 'A1', 0);
  const pA2 = seedPage(bookId, cA, 'A2', 1);
  // Stored order kehrt Kapitel + Seiten um.
  bookOrder.putOrder(bookId, [
    { type: 'chapter', id: cB, children: [] },
    { type: 'chapter', id: cA, children: [{ type: 'page', id: pA2 }, { type: 'page', id: pA1 }] },
  ], 'test');

  const tree = await contentStore.bookTree(bookId);
  assert.equal(tree.chapters[0].id, cB);
  assert.equal(tree.chapters[1].id, cA);
  assert.deepEqual(tree.chapters[1].pages.map(p => p.id), [pA2, pA1]);
});
