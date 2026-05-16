'use strict';
// Phase 1 (BookStack-Exit, docs/bookstack-exit.md): Content-Store-Facade.
// Dispatcht Vertrags-Calls (listBooks, loadPage, savePage, …) auf das durch
// app_settings.app.backend gewaehlte Backend (`bookstack` | `localdb`).
//
// Konsumenten importieren weiter `require('../lib/content-store')` — die
// Aufloesung trifft `lib/content-store/index.js` (Node-Folder-Resolution).
//
// Backend-Wahl ist per-Call aus app_settings.get('app.backend'). app-settings
// cached intern + emittiert `changed`-Event; Hot-Reload bei Switch ohne
// Server-Restart funktioniert. Default `bookstack` (kompatibel mit
// Bestandsdeployments vor Phase 1).

const appSettings = require('../app-settings');
const bookstackBackend = require('./backends/bookstack');
const localdbBackend = require('./backends/localdb');

function _backend() {
  const sel = String(appSettings.get('app.backend') || 'bookstack').toLowerCase();
  return sel === 'localdb' ? localdbBackend : bookstackBackend;
}

// ── Books ────────────────────────────────────────────────────────────────────
async function listBooks(ctx)                 { return _backend().listBooks(ctx); }
async function loadBook(bookId, ctx)          { return _backend().loadBook(bookId, ctx); }
async function createBook(body, ctx)          { return _backend().createBook(body, ctx); }
async function deleteBook(bookId, ctx)        { return _backend().deleteBook(bookId, ctx); }

// ── Chapters ────────────────────────────────────────────────────────────────
async function listChapters(bookId, ctx)              { return _backend().listChapters(bookId, ctx); }
async function loadChapter(chapterId, ctx)            { return _backend().loadChapter(chapterId, ctx); }
async function createChapter(body, ctx)               { return _backend().createChapter(body, ctx); }
async function updateChapter(chapterId, body, ctx)    { return _backend().updateChapter(chapterId, body, ctx); }
async function deleteChapter(chapterId, ctx)          { return _backend().deleteChapter(chapterId, ctx); }

// ── Pages ────────────────────────────────────────────────────────────────────
async function listPages(bookId, ctx)         { return _backend().listPages(bookId, ctx); }
async function loadPage(pageId, ctx)          { return _backend().loadPage(pageId, ctx); }
async function savePage(pageId, body, ctx)    { return _backend().savePage(pageId, body, ctx); }
async function createPage(body, ctx)          { return _backend().createPage(body, ctx); }
async function deletePage(pageId, ctx)        { return _backend().deletePage(pageId, ctx); }

// ── Higher-level helpers ────────────────────────────────────────────────────
async function bookTree(bookId, ctx)                  { return _backend().bookTree(bookId, ctx); }
async function loadPagesBatch(pageMetas, ctx, opts)   { return _backend().loadPagesBatch(pageMetas, ctx, opts); }
async function searchPages(query, opts, ctx)          { return _backend().searchPages(query, opts, ctx); }

// ── Backend-Introspection ───────────────────────────────────────────────────
function currentBackend() {
  return String(appSettings.get('app.backend') || 'bookstack').toLowerCase();
}

// Token-Resolver bleibt fuer Bookstack-Backend exportiert — Konsumenten, die
// explizit gegen die BookStack-API mit einem Token sprechen muessen (Backfill,
// Sync-Worker), brauchen die Resolution-Logik.
const { _resolveToken } = bookstackBackend;

module.exports = {
  listBooks, loadBook, createBook, deleteBook,
  listChapters, loadChapter, createChapter, updateChapter, deleteChapter,
  listPages, loadPage, savePage, createPage, deletePage,
  bookTree, loadPagesBatch, searchPages,
  currentBackend,
  _resolveToken,
};
