'use strict';
// Content-Store-Facade über das localdb-Backend. Dünner Wrapper, der Schreib-
// Chokepoint für Page-Revisions und FTS-Index-Hooks bleibt und Tree-Overlay
// aus book_order anwendet.
//
// Konsumenten importieren `require('../lib/content-store')` — die Auflösung
// trifft `lib/content-store/index.js` (Node-Folder-Resolution).

const localdbBackend = require('./backends/localdb');
const pageRevisions = require('../../db/page-revisions');
const bookOrder = require('../../db/book-order');
const logger = require('../../logger');

let _searchIndexCached = null;
function _searchIndex() {
  if (_searchIndexCached !== null) return _searchIndexCached;
  try { _searchIndexCached = require('../search'); }
  catch (e) {
    logger.warn(`[content-store] searchIndex nicht verfuegbar: ${e.message}`);
    _searchIndexCached = false;
  }
  return _searchIndexCached || null;
}

// Extrahiert User-Email aus ctx, wenn es ein Express-Request ist. Sonst null
// (Cron-Jobs, Worker mit Token-only-ctx).
function _userEmailFromCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  return ctx.session?.user?.email || null;
}

// ── Books ────────────────────────────────────────────────────────────────────
async function listBooks(ctx)                 { return localdbBackend.listBooks(ctx); }
async function loadBook(bookId, ctx)          { return localdbBackend.loadBook(bookId, ctx); }
async function createBook(body, ctx) {
  const created = await localdbBackend.createBook(body, ctx);
  if (created?.id) _searchIndex()?.upsertBookMeta(created.id);
  return created;
}
async function deleteBook(bookId, ctx) {
  const result = await localdbBackend.deleteBook(bookId, ctx);
  _searchIndex()?.removeAllForBook(bookId);
  return result;
}

// ── Chapters ────────────────────────────────────────────────────────────────
async function listChapters(bookId, ctx)              { return localdbBackend.listChapters(bookId, ctx); }
async function loadChapter(chapterId, ctx)            { return localdbBackend.loadChapter(chapterId, ctx); }
async function createChapter(body, ctx) {
  const created = await localdbBackend.createChapter(body, ctx);
  if (created?.id) _searchIndex()?.upsertChapter(created.id);
  return created;
}
async function updateChapter(chapterId, body, ctx) {
  const updated = await localdbBackend.updateChapter(chapterId, body, ctx);
  _searchIndex()?.upsertChapter(chapterId);
  return updated;
}
async function deleteChapter(chapterId, ctx) {
  const result = await localdbBackend.deleteChapter(chapterId, ctx);
  _searchIndex()?.remove('chapter', chapterId);
  return result;
}

// ── Pages ────────────────────────────────────────────────────────────────────
async function listPages(bookId, ctx)         { return localdbBackend.listPages(bookId, ctx); }
async function loadPage(pageId, ctx)          { return localdbBackend.loadPage(pageId, ctx); }

const _SOURCE_FALLBACK = 'main';

async function savePage(pageId, body, ctx) {
  // Meta-Felder fuer Revision-Schreiben aus dem Body ziehen, bevor er ans
  // Backend geht — Backend ignoriert unbekannte Keys, aber wir wollen sie
  // erst gar nicht uebermitteln.
  const rawSource = body && typeof body === 'object' ? body.source : null;
  const source = pageRevisions.VALID_SOURCES.has(rawSource) ? rawSource : _SOURCE_FALLBACK;
  const summary = body && typeof body === 'object' && typeof body.summary === 'string'
    ? body.summary.slice(0, 500)
    : null;
  const cleanBody = { ...body };
  delete cleanBody.source;
  delete cleanBody.summary;

  const saved = await localdbBackend.savePage(pageId, cleanBody, ctx);

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

  if (saved?.id) _searchIndex()?.upsertPage(saved.id);

  return saved;
}

async function createPage(body, ctx) {
  const created = await localdbBackend.createPage(body, ctx);
  if (created?.id) _searchIndex()?.upsertPage(created.id);
  return created;
}
async function deletePage(pageId, ctx) {
  const result = await localdbBackend.deletePage(pageId, ctx);
  _searchIndex()?.remove('page', pageId);
  return result;
}

// ── Higher-level helpers ────────────────────────────────────────────────────
// bookTree konsumiert raw-Daten und ordnet sie nach book_order (SSoT).
// Fehlt die Row, wird sie aus dem aktuellen position/priority-Stand
// initialisiert (Auto-Init).
async function bookTree(bookId, ctx) {
  const raw = await localdbBackend.bookTree(bookId, ctx);
  const ordered = bookOrder.ensureTree(bookId);
  if (!ordered?.tree?.length) return raw;
  return _applyOrder(raw, ordered.tree);
}

function _applyOrder(raw, tree) {
  const chaptersById = new Map((raw.chapters || []).map(c => [c.id, { ...c, pages: [...(c.pages || [])] }]));
  const pagesById = new Map();
  for (const c of (raw.chapters || [])) for (const p of (c.pages || [])) pagesById.set(p.id, p);
  for (const p of (raw.topPages || [])) pagesById.set(p.id, p);

  const chaptersOut = [];
  const topPages = [];
  for (const entry of tree) {
    if (entry.type === 'chapter') {
      const ch = chaptersById.get(entry.id);
      if (!ch) continue;
      const orderedPages = [];
      for (const child of (entry.children || [])) {
        const p = pagesById.get(child.id);
        if (p) orderedPages.push({ ...p, chapter_id: ch.id });
      }
      chaptersOut.push({ ...ch, pages: orderedPages });
    } else if (entry.type === 'page') {
      const p = pagesById.get(entry.id);
      if (p) topPages.push({ ...p, chapter_id: null });
    }
  }
  return { chapters: chaptersOut, topPages };
}

async function loadPagesBatch(pageMetas, ctx, opts)   { return localdbBackend.loadPagesBatch(pageMetas, ctx, opts); }
async function searchPages(query, opts, ctx)          { return localdbBackend.searchPages(query, opts, ctx); }

module.exports = {
  listBooks, loadBook, createBook, deleteBook,
  listChapters, loadChapter, createChapter, updateChapter, deleteChapter,
  listPages, loadPage, savePage, createPage, deletePage,
  bookTree, loadPagesBatch, searchPages,
};
