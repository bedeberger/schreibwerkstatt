'use strict';
// Integration test: routes/research.js (HTTP-Layer des Recherche-Boards).
// Schwerpunkt Verknüpfungen + Multi-URL — die untestete, branch-reiche Logik:
//   - POST/DELETE /:id/links inkl. BOOK_MISMATCH, INVALID_TARGET, Idempotenz
//   - GET ?linked=<kind>:<id>-Filter + sort=link:<dimension>
//   - /page-counts + /chapter-counts (Link-Aggregation)
//   - POST/PATCH urls (http(s)-only, Dedup, Reihenfolge)
// Fährt den echten Router unter Express hoch (Fake-Session liefert den User);
// ACL via grantAccess.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
let sessionUser = 'autor@test.dev';

const NOW = '2026-01-01T00:00:00.000Z';

function startServer() {
  return new Promise((resolve, reject) => {
    const researchRouter = require('../../routes/research');
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: sessionUser } }; next(); });
    app.use('/research', researchRouter);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, opts);
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  await startServer();
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

test.beforeEach(() => {
  sessionUser = 'autor@test.dev';
  for (const t of ['research_item_links', 'research_item_urls', 'research_items',
    'figure_scenes', 'locations', 'figures', 'pages', 'chapters', 'book_access', 'books']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

// Buch + ACL + Kapitel/Seite/Figur/Ort. Gibt ids zurück.
function seedBook(bookId, user = 'autor@test.dev') {
  const grantAccess = require('../../db/book-access').grantAccess;
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Testbuch', ?, ?)").run(bookId, NOW, NOW);
  grantAccess(bookId, user, 'editor', user);
  const chapterId = db.prepare(
    `INSERT INTO chapters (book_id, chapter_name, position, updated_at) VALUES (?, 'Kapitel 1', 0, ?)`
  ).run(bookId, NOW).lastInsertRowid;
  const pageId = db.prepare(
    `INSERT INTO pages (book_id, page_name, chapter_id, position, updated_at) VALUES (?, 'Seite 1', ?, 0, ?)`
  ).run(bookId, chapterId, NOW).lastInsertRowid;
  const figureId = db.prepare(
    `INSERT INTO figures (book_id, user_email, fig_id, name, sort_order, updated_at) VALUES (?, ?, 'f1', 'Anna', 0, ?)`
  ).run(bookId, user, NOW).lastInsertRowid;
  const locationId = db.prepare(
    `INSERT INTO locations (book_id, user_email, loc_id, name, sort_order, updated_at) VALUES (?, ?, 'l1', 'Olten', 0, ?)`
  ).run(bookId, user, NOW).lastInsertRowid;
  return { chapterId, pageId, figureId, locationId };
}

async function createItem(bookId, fields = {}) {
  const { status, json } = await api('POST', '/research', { book_id: bookId, title: 'Notiz', ...fields });
  assert.equal(status, 200, JSON.stringify(json));
  return json;
}

// ── Verknüpfungen ───────────────────────────────────────────────────────────

test('POST /:id/links: gültige Figur-Verknüpfung landet am Item', async () => {
  const BOOK = 8301;
  const { figureId } = seedBook(BOOK);
  const item = await createItem(BOOK);

  const { status, json } = await api('POST', `/research/${item.id}/links`,
    { target_kind: 'figure', target_id: figureId });
  assert.equal(status, 200);
  assert.equal(json.links.length, 1);
  assert.equal(json.links[0].target_kind, 'figure');
  assert.equal(json.links[0].target_id, figureId);
  assert.equal(json.links[0].label, 'Anna');   // Label aus JOIN
});

test('POST /:id/links: erneut → idempotent (keine Dublette)', async () => {
  const BOOK = 8302;
  const { figureId } = seedBook(BOOK);
  const item = await createItem(BOOK);
  await api('POST', `/research/${item.id}/links`, { target_kind: 'figure', target_id: figureId });
  const second = await api('POST', `/research/${item.id}/links`, { target_kind: 'figure', target_id: figureId });
  assert.equal(second.status, 200);
  assert.equal(second.json.links.length, 1);
});

test('POST /:id/links: Ziel aus anderem Buch → BOOK_MISMATCH', async () => {
  const BOOK = 8303;
  seedBook(BOOK);
  const item = await createItem(BOOK);
  // Figur in einem zweiten Buch.
  const OTHER = 8399;
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Fremd', ?, ?)").run(OTHER, NOW, NOW);
  const foreignFig = db.prepare(
    `INSERT INTO figures (book_id, user_email, fig_id, name, sort_order, updated_at) VALUES (?, ?, 'x', 'Fremd', 0, ?)`
  ).run(OTHER, 'autor@test.dev', NOW).lastInsertRowid;

  const { status, json } = await api('POST', `/research/${item.id}/links`,
    { target_kind: 'figure', target_id: foreignFig });
  assert.equal(status, 400);
  assert.equal(json.error_code, 'BOOK_MISMATCH');
});

test('POST /:id/links: unbekannter target_kind → INVALID_TARGET', async () => {
  const BOOK = 8304;
  seedBook(BOOK);
  const item = await createItem(BOOK);
  const { status, json } = await api('POST', `/research/${item.id}/links`,
    { target_kind: 'banana', target_id: 1 });
  assert.equal(status, 400);
  assert.equal(json.error_code, 'INVALID_TARGET');
});

test('DELETE /:id/links/:linkId: entfernt die Verknüpfung', async () => {
  const BOOK = 8305;
  const { figureId } = seedBook(BOOK);
  const item = await createItem(BOOK);
  const linked = await api('POST', `/research/${item.id}/links`, { target_kind: 'figure', target_id: figureId });
  const linkId = linked.json.links[0].link_id;

  const { status, json } = await api('DELETE', `/research/${item.id}/links/${linkId}`);
  assert.equal(status, 200);
  assert.equal(json.links.length, 0);
});

// ── Filter + Sortierung nach Verknüpfung ─────────────────────────────────────

test('GET ?linked=figure:<id>: nur verknüpfte Items', async () => {
  const BOOK = 8306;
  const { figureId } = seedBook(BOOK);
  const linkedItem = await createItem(BOOK, { title: 'Verknüpft' });
  await createItem(BOOK, { title: 'Lose' });
  await api('POST', `/research/${linkedItem.id}/links`, { target_kind: 'figure', target_id: figureId });

  const { status, json } = await api('GET', `/research?book_id=${BOOK}&linked=figure:${figureId}`);
  assert.equal(status, 200);
  assert.equal(json.length, 1);
  assert.equal(json[0].title, 'Verknüpft');
});

test('GET ?sort=link:figure: Verknüpfte vor Unverknüpften', async () => {
  const BOOK = 8307;
  const { figureId } = seedBook(BOOK);
  await createItem(BOOK, { title: 'Lose' });
  const linkedItem = await createItem(BOOK, { title: 'Verknüpft' });
  await api('POST', `/research/${linkedItem.id}/links`, { target_kind: 'figure', target_id: figureId });

  const { json } = await api('GET', `/research?book_id=${BOOK}&sort=link:figure`);
  assert.equal(json.length, 2);
  assert.equal(json[0].title, 'Verknüpft');   // link_rank gesetzt → vor NULL
  assert.equal(json[1].title, 'Lose');
});

test('GET /page-counts + /chapter-counts: zählen verknüpfte, nicht-archivierte Items', async () => {
  const BOOK = 8308;
  const { pageId, chapterId } = seedBook(BOOK);
  const a = await createItem(BOOK);
  const b = await createItem(BOOK);
  await api('POST', `/research/${a.id}/links`, { target_kind: 'page', target_id: pageId });
  await api('POST', `/research/${b.id}/links`, { target_kind: 'page', target_id: pageId });
  await api('POST', `/research/${a.id}/links`, { target_kind: 'chapter', target_id: chapterId });

  const pc = await api('GET', `/research/page-counts?book_id=${BOOK}`);
  assert.equal(pc.json[pageId], 2);
  const cc = await api('GET', `/research/chapter-counts?book_id=${BOOK}`);
  assert.equal(cc.json[chapterId], 1);

  // Archivieren → fällt aus den Counts.
  await api('PATCH', `/research/${a.id}`, { archived: true });
  const pc2 = await api('GET', `/research/page-counts?book_id=${BOOK}`);
  assert.equal(pc2.json[pageId], 1);
});

// ── Multi-URL (frisch eingeführt) ────────────────────────────────────────────

test('POST /: urls — nur http(s), dedupliziert, Reihenfolge erhalten', async () => {
  const BOOK = 8309;
  seedBook(BOOK);
  const item = await createItem(BOOK, {
    kind: 'link',
    urls: [
      { url: 'https://a.example', label: 'A' },
      'http://b.example',
      'javascript:alert(1)',     // verworfen (kein http)
      'https://a.example',       // Dublette → verworfen
    ],
  });
  assert.equal(item.urls.length, 2);
  assert.equal(item.urls[0].url, 'https://a.example');
  assert.equal(item.urls[0].label, 'A');
  assert.equal(item.urls[1].url, 'http://b.example');
});

test('PATCH /:id: urls werden komplett ersetzt', async () => {
  const BOOK = 8310;
  seedBook(BOOK);
  const item = await createItem(BOOK, { kind: 'link', urls: ['https://old.example'] });
  const { status, json } = await api('PATCH', `/research/${item.id}`, { urls: ['https://new.example'] });
  assert.equal(status, 200);
  assert.equal(json.urls.length, 1);
  assert.equal(json.urls[0].url, 'https://new.example');
});

test('POST /: leeres Item (kein Titel/Body/URL) → EMPTY', async () => {
  const BOOK = 8311;
  seedBook(BOOK);
  const { status, json } = await api('POST', '/research', { book_id: BOOK, title: '', body: '' });
  assert.equal(status, 400);
  assert.equal(json.error_code, 'EMPTY');
});

// ── ACL ──────────────────────────────────────────────────────────────────────

test('GET /: ohne Buchzugriff → 403', async () => {
  const BOOK = 8312;
  seedBook(BOOK);               // Zugriff nur für autor@test.dev
  sessionUser = 'eindringling@test.dev';
  const { status } = await api('GET', `/research?book_id=${BOOK}`);
  assert.equal(status, 403);
});
