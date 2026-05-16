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
//
// Phase 2: Die Facade ist der Schreib-Chokepoint fuer Page-Bodies. Jeder
// erfolgreiche `savePage` mit body.html schreibt eine page_revisions-Row
// nach dem Backend-PUT — backend-agnostisch, damit alle Save-Pfade
// (Editor, Focus, Chat-Apply, Lektorat-Apply, History-Restore) eine
// Revision erzeugen, ohne dass jeder Caller das selbst tut.

const appSettings = require('../app-settings');
const bookstackBackend = require('./backends/bookstack');
const localdbBackend = require('./backends/localdb');
const pageRevisions = require('../../db/page-revisions');
const logger = require('../../logger');

function _backend() {
  const sel = String(appSettings.get('app.backend') || 'bookstack').toLowerCase();
  return sel === 'localdb' ? localdbBackend : bookstackBackend;
}

// Extrahiert User-Email aus ctx, wenn es ein Express-Request ist. Sonst null
// (Cron-Jobs, Worker mit Token-only-ctx).
function _userEmailFromCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  return ctx.session?.user?.email || null;
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

const _SOURCE_FALLBACK = 'main';

async function savePage(pageId, body, ctx) {
  // Meta-Felder fuer Revision-Schreiben aus dem Body ziehen, bevor er ans
  // Backend geht — backends ignorieren unbekannte Keys, aber wir wollen sie
  // erst gar nicht uebermitteln.
  const rawSource = body && typeof body === 'object' ? body.source : null;
  const source = pageRevisions.VALID_SOURCES.has(rawSource) ? rawSource : _SOURCE_FALLBACK;
  const summary = body && typeof body === 'object' && typeof body.summary === 'string'
    ? body.summary.slice(0, 500)
    : null;
  const cleanBody = { ...body };
  delete cleanBody.source;
  delete cleanBody.summary;

  const saved = await _backend().savePage(pageId, cleanBody, ctx);

  // Revision nur schreiben, wenn der Save den Body geaendert hat. Reine
  // Rename- oder Reorder-Saves erzeugen keinen page_revisions-Eintrag —
  // sonst quillt die Tabelle bei Drag-Reorder ueber.
  if (typeof body?.html === 'string' && saved) {
    try {
      pageRevisions.insert({
        pageId,
        bookId: saved.book_id,
        bodyHtml: saved.html || '',
        bodyMarkdown: typeof body.markdown === 'string' ? body.markdown : null,
        source,
        userEmail: _userEmailFromCtx(ctx),
        summary,
      });
    } catch (e) {
      // Revision-Failures duerfen den Save nicht abbrechen.
      logger.warn(`page_revisions insert fehlgeschlagen (page=${pageId}): ${e.message}`);
    }
  }

  return saved;
}

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
