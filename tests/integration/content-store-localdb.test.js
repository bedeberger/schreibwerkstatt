'use strict';
// Phase 1: localdb-Backend der Content-Store-Facade. Verifiziert, dass
//   - der Vertrag (loadBook/listBooks/loadPage/savePage/createPage/bookTree/…)
//     gegen lokale SQLite-Tabellen funktioniert.
//   - Domain-Shape mit dem BookStack-Backend uebereinstimmt (id/name/html/
//     position/chapter_id/book_id).
//   - app.backend='localdb' den Dispatch aus dem Facade-index korrekt
//     umstellt.

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'integration-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
test.before(() => {
  ctx = bootstrap();
  ctx.contentStore = require('../../lib/content-store');
  ctx.appSettings = require('../../lib/app-settings');
  ctx.connection = require('../../db/connection');
  ctx.appSettings.set('app.backend', 'localdb', { updatedBy: 'test' });
});
test.after(() => { ctx.cleanup(); });

function _seedBook({ name = 'Test-Buch', description = 'Beschreibung' } = {}) {
  const now = new Date().toISOString();
  const r = ctx.connection.db.prepare(`
    INSERT INTO books (name, description, created_at, updated_at, owner_email)
    VALUES (?, ?, ?, ?, NULL)
  `).run(name, description, now, now);
  return r.lastInsertRowid;
}

function _seedChapter(bookId, { name = 'Kapitel 1', position = 0 } = {}) {
  const now = new Date().toISOString();
  const r = ctx.connection.db.prepare(`
    INSERT INTO chapters (book_id, chapter_name, position, priority, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(bookId, name, position, position, now);
  return r.lastInsertRowid;
}

function _seedPage(bookId, chapterId, { name = 'Seite 1', html = '<p>Inhalt</p>', position = 0 } = {}) {
  const now = new Date().toISOString();
  const r = ctx.connection.db.prepare(`
    INSERT INTO pages (book_id, chapter_id, page_name, body_html, position, priority, updated_at, local_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(bookId, chapterId, name, html, position, position, now, now);
  return r.lastInsertRowid;
}

test('currentBackend liefert localdb nach Setting-Switch', () => {
  assert.equal(ctx.contentStore.currentBackend(), 'localdb');
});

test('localdb: listBooks + loadBook (Domain-Shape)', async () => {
  const bookId = _seedBook({ name: 'Lib-Test-Buch' });
  const books = await ctx.contentStore.listBooks();
  const found = books.find(b => b.id === bookId);
  assert.ok(found, 'Buch in listBooks');
  assert.equal(found.name, 'Lib-Test-Buch');
  assert.equal(found.description, 'Beschreibung');
  assert.ok(found.created_at);

  const book = await ctx.contentStore.loadBook(bookId);
  assert.equal(book.id, bookId);
  assert.equal(book.name, 'Lib-Test-Buch');
});

test('localdb: loadPage liefert html + chapter_id + position', async () => {
  const bookId = _seedBook();
  const chapterId = _seedChapter(bookId);
  const pageId = _seedPage(bookId, chapterId, { name: 'P', html: '<p>X</p>', position: 7 });

  const p = await ctx.contentStore.loadPage(pageId);
  assert.equal(p.id, pageId);
  assert.equal(p.book_id, bookId);
  assert.equal(p.chapter_id, chapterId);
  assert.equal(p.name, 'P');
  assert.equal(p.html, '<p>X</p>');
  assert.equal(p.position, 7);
});

test('localdb: savePage updated body_html + local_updated_at, setzt dirty=0', async () => {
  const bookId = _seedBook();
  const chapterId = _seedChapter(bookId);
  const pageId = _seedPage(bookId, chapterId);

  ctx.connection.db.prepare('UPDATE pages SET dirty = 1 WHERE page_id = ?').run(pageId);

  const before = await ctx.contentStore.loadPage(pageId);
  await new Promise(r => setTimeout(r, 5)); // updated_at-Unterschied
  await ctx.contentStore.savePage(pageId, { html: '<p>Neu</p>' });
  const after = await ctx.contentStore.loadPage(pageId);

  assert.equal(after.html, '<p>Neu</p>');
  assert.notEqual(after.updated_at, before.updated_at);

  const row = ctx.connection.db.prepare('SELECT dirty FROM pages WHERE page_id = ?').get(pageId);
  assert.equal(row.dirty, 0, 'savePage setzt dirty zurueck');
});

test('localdb: createPage vergibt ID >= 1_000_001 (Phase-0-Wasserzeichen)', async () => {
  const bookId = _seedBook();
  const created = await ctx.contentStore.createPage({ book_id: bookId, name: 'Neue Seite', html: '<p>x</p>' });
  assert.ok(created.id >= 1_000_001, `id ${created.id} muss >= 1_000_001 sein`);
  assert.equal(created.book_id, bookId);
  assert.equal(created.html, '<p>x</p>');
});

test('localdb: bookTree gruppiert nach Kapitel + Top-Level', async () => {
  const bookId = _seedBook();
  const c1 = _seedChapter(bookId, { name: 'Kap A', position: 0 });
  const c2 = _seedChapter(bookId, { name: 'Kap B', position: 1 });
  _seedPage(bookId, c1, { name: 'A1', position: 0 });
  _seedPage(bookId, c2, { name: 'B1', position: 0 });
  _seedPage(bookId, null, { name: 'Top', position: 0 });

  const tree = await ctx.contentStore.bookTree(bookId);
  assert.equal(tree.chapters.length, 2);
  assert.equal(tree.chapters[0].name, 'Kap A');
  assert.equal(tree.chapters[0].pages.length, 1);
  assert.equal(tree.chapters[0].pages[0].name, 'A1');
  assert.equal(tree.chapters[1].pages.length, 1);
  assert.equal(tree.topPages.length, 1);
  assert.equal(tree.topPages[0].name, 'Top');
});

test('localdb: searchPages (LIKE-Fallback bis Phase 7)', async () => {
  const bookId = _seedBook();
  const chapterId = _seedChapter(bookId);
  _seedPage(bookId, chapterId, { name: 'Aldous Huxley', html: '<p>Schöne neue Welt</p>' });
  _seedPage(bookId, chapterId, { name: 'Orwell', html: '<p>1984</p>' });

  const hits = await ctx.contentStore.searchPages('Huxley', { bookId });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'Aldous Huxley');

  const bodyHits = await ctx.contentStore.searchPages('1984', { bookId });
  assert.equal(bodyHits.length, 1);
  assert.equal(bodyHits[0].name, 'Orwell');
});

test('localdb: deletePage entfernt Row + wirft NOT_FOUND auf Re-Delete', async () => {
  const bookId = _seedBook();
  const pageId = _seedPage(bookId, null);
  await ctx.contentStore.deletePage(pageId);
  await assert.rejects(() => ctx.contentStore.loadPage(pageId), { code: 'NOT_FOUND' });
  await assert.rejects(() => ctx.contentStore.deletePage(pageId), { code: 'NOT_FOUND' });
});

test('localdb: loadPagesBatch laeuft sequentiell ohne Token', async () => {
  const bookId = _seedBook();
  const chapterId = _seedChapter(bookId);
  const p1 = _seedPage(bookId, chapterId, { name: 'P1' });
  const p2 = _seedPage(bookId, chapterId, { name: 'P2' });
  const out = await ctx.contentStore.loadPagesBatch([{ id: p1 }, { id: p2 }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'P1');
  assert.equal(out[1].name, 'P2');
});
