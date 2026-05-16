'use strict';
// Server-Side Domain-Repository fuer Buecher/Kapitel/Seiten.
//
// Spiegelt das Frontend-Repository [public/js/repo/content.js](../public/js/repo/content.js):
// gleicher Vertrag, gleiche Domain-Shape (aus lib/content-mapper.js). Konsumenten
// (routes/content.js, routes/book-editor.js, routes/jobs/shared/loader.js und
// kuenftig Job-Handler) haengen damit nicht mehr an BookStack-Pfaden oder
// `bs*`-Aufrufen, und Token-Resolution bleibt eine einzige Stelle.
//
// Phase 1 des Exit-Plans tauscht hier intern auf lokale DB-Reads; Konsumenten
// aendern sich dabei nicht.
//
// **ctx**-Argument: entweder `req` (Express) oder `{ token, ... }`. Wenn `req`
// uebergeben wird, resolved `_resolveToken` ueber `getTokenForRequest(req)` mit
// Fallback auf `getAnyUserToken()` (fuer Cron-Jobs etc., die keine Session haben).

const { bsGet, bsGetAll, bsPost, bsPut, bsDelete, bsBatch } = require('./bookstack');
const { mapBook, mapChapter, mapPage, mapPageMeta } = require('./content-mapper');
const { cleanPageHtml } = require('./html-clean');
const { getTokenForRequest, getAnyUserToken } = require('../db/schema');
const { upsertBook } = require('../db/books');

const _PAGE_LOAD_TIMEOUT_MS = 30000;

function _isToken(o) {
  if (!o || typeof o !== 'object') return false;
  return ('id' in o && 'pw' in o) || ('token_id' in o && 'token_pw' in o);
}

function _isExpressReq(o) {
  return o && typeof o === 'object' && (o.session !== undefined || o.params !== undefined || o.headers !== undefined);
}

function _resolveToken(ctx) {
  if (!ctx) return null;
  if (_isToken(ctx)) return ctx;
  if (ctx.token && _isToken(ctx.token)) return ctx.token;
  if (_isExpressReq(ctx)) return getTokenForRequest(ctx) || getAnyUserToken();
  return null;
}

function _cleanHtmlSafe(html) {
  try { return cleanPageHtml(html); }
  catch { return html; }
}

// ── Books ────────────────────────────────────────────────────────────────────

async function listBooks(ctx) {
  const books = await bsGetAll('books', _resolveToken(ctx));
  return books.map(mapBook);
}

async function loadBook(bookId, ctx) {
  const book = await bsGet(`books/${bookId}`, _resolveToken(ctx));
  return mapBook(book);
}

async function createBook({ name, description }, ctx) {
  const payload = description ? { name, description } : { name };
  const created = await bsPost('books', payload, _resolveToken(ctx));
  // Lokale `books`-Row sofort upserten, damit FK-abhaengige Folgefeatures
  // (BookSettings, Ideen, …) ohne Wartezeit auf den naechsten Sync schreiben.
  upsertBook({ id: created.id, name: created.name, slug: created.slug });
  return mapBook(created);
}

async function deleteBook(bookId, ctx) {
  await bsDelete(`books/${bookId}`, _resolveToken(ctx));
  return { ok: true };
}

// ── Chapters ────────────────────────────────────────────────────────────────

async function listChapters(bookId, ctx) {
  const raw = await bsGetAll(`chapters?filter[book_id]=${bookId}`, _resolveToken(ctx));
  return raw
    .map(mapChapter)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

async function loadChapter(chapterId, ctx) {
  const ch = await bsGet(`chapters/${chapterId}`, _resolveToken(ctx));
  return mapChapter(ch);
}

async function createChapter({ book_id, name, position, description }, ctx) {
  const payload = { book_id, name };
  if (Number.isFinite(position)) payload.priority = position;
  if (typeof description === 'string') payload.description = description;
  const created = await bsPost('chapters', payload, _resolveToken(ctx));
  return mapChapter(created);
}

async function updateChapter(chapterId, body, ctx) {
  const payload = {};
  if (typeof body?.name === 'string') payload.name = body.name;
  if (Number.isFinite(body?.position)) payload.priority = body.position;
  if (typeof body?.description === 'string') payload.description = body.description;
  const updated = await bsPut(`chapters/${chapterId}`, payload, _resolveToken(ctx));
  return mapChapter(updated);
}

async function deleteChapter(chapterId, ctx) {
  await bsDelete(`chapters/${chapterId}`, _resolveToken(ctx));
  return { ok: true };
}

// ── Pages ────────────────────────────────────────────────────────────────────

async function listPages(bookId, ctx) {
  const raw = await bsGetAll(`pages?filter[book_id]=${bookId}`, _resolveToken(ctx));
  return raw.map(mapPageMeta);
}

async function loadPage(pageId, ctx) {
  const pd = await bsGet(`pages/${pageId}`, _resolveToken(ctx), { timeoutMs: _PAGE_LOAD_TIMEOUT_MS });
  return mapPage(pd);
}

async function savePage(pageId, body, ctx) {
  const payload = {};
  if (typeof body?.html === 'string') payload.html = _cleanHtmlSafe(body.html);
  if (typeof body?.name === 'string') payload.name = body.name;
  if (Number.isFinite(body?.position)) payload.priority = body.position;
  if (body?.chapter_id !== undefined) payload.chapter_id = body.chapter_id;
  if (!Object.keys(payload).length) {
    const err = new Error('savePage called without changes');
    err.code = 'EMPTY_BODY';
    throw err;
  }
  const updated = await bsPut(`pages/${pageId}`, payload, _resolveToken(ctx));
  return mapPage(updated);
}

async function createPage({ book_id, chapter_id, name, html }, ctx) {
  const payload = { name };
  if (book_id) payload.book_id = book_id;
  if (chapter_id) payload.chapter_id = chapter_id;
  // BookStack legt mit leerem html-Feld einen Draft an, der nicht in GET /pages
  // auftaucht. Default '<p></p>' erzwingt eine regulaere Seite.
  payload.html = _cleanHtmlSafe(typeof html === 'string' ? html : '<p></p>');
  const created = await bsPost('pages', payload, _resolveToken(ctx));
  return mapPage(created);
}

async function deletePage(pageId, ctx) {
  await bsDelete(`pages/${pageId}`, _resolveToken(ctx));
  return { ok: true };
}

// ── Higher-level helpers ────────────────────────────────────────────────────

/**
 * Liefert `{ chapters: [{...c, pages: [...]}], topPages: [...] }` mit
 * Domain-Shape und vorsortiert nach `position`.
 */
async function bookTree(bookId, ctx) {
  const token = _resolveToken(ctx);
  const [rawChapters, rawPages] = await Promise.all([
    bsGetAll(`chapters?filter[book_id]=${bookId}`, token),
    bsGetAll(`pages?filter[book_id]=${bookId}`, token),
  ]);
  const chapters = rawChapters
    .map(mapChapter)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const pages = rawPages
    .map(mapPageMeta)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const byChapter = new Map(chapters.map(c => [c.id, { ...c, pages: [] }]));
  const topPages = [];
  for (const p of pages) {
    const bucket = p.chapter_id ? byChapter.get(p.chapter_id) : null;
    if (bucket) bucket.pages.push(p);
    else topPages.push(p);
  }
  return { chapters: Array.from(byChapter.values()), topPages };
}

/**
 * Batch-Loader fuer Job-Pipelines: laedt fuer eine Liste von Page-Metas die
 * Volltexte parallel (bsBatch mit Concurrency-Cap + Abort-Signal). Liefert
 * Array von Page-Domain-Objekten (mapPage), `null` bei Mapper-Fail.
 *
 * opts:
 *   batchSize       — items pro Welle (Default 15)
 *   batchTimeoutMs  — max. Gesamt-Dauer eines Batches (Default 90s)
 *   onBatch(i,total) — Progress-Callback vor jedem Batch
 *   signal          — AbortSignal (Job-Cancel)
 *   onError(p,e)    — pro fehlgeschlagener Seite (defensiv, default: rethrow)
 */
async function loadPagesBatch(pageMetas, ctx, opts = {}) {
  const token = _resolveToken(ctx);
  const { onError = null, ...batchOpts } = opts;
  return bsBatch(pageMetas, async (p, batchSignal) => {
    try {
      const pd = await bsGet(`pages/${p.id}`, token, { timeoutMs: _PAGE_LOAD_TIMEOUT_MS });
      if (batchSignal?.aborted) return null;
      return mapPage(pd);
    } catch (e) {
      if (onError) return onError(p, e);
      throw e;
    }
  }, batchOpts);
}

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * Volltextsuche. Augmentiert Query mit `{type:page}` und (wenn bookId gesetzt)
 * `{in_book:N}` server-seitig, filtert nicht-Page-Hits aus und gibt Domain-
 * shape PageMeta-Array zurueck. `count` clamped auf 1..100.
 */
async function searchPages(query, { bookId, count = 20 } = {}, ctx) {
  const q = (query || '').toString().trim();
  if (q.length < 2) return [];
  const safeCount = Math.min(Math.max(parseInt(count, 10) || 20, 1), 100);
  const augmented = bookId
    ? `${q} {type:page} {in_book:${bookId}}`
    : `${q} {type:page}`;
  const data = await bsGet(
    `search?query=${encodeURIComponent(augmented)}&count=${safeCount}`,
    _resolveToken(ctx),
  );
  return (data.data || [])
    .filter(h => h.type === 'page' && (!bookId || h.book_id === bookId))
    .map(mapPageMeta);
}

module.exports = {
  // Books
  listBooks, loadBook, createBook, deleteBook,
  // Chapters
  listChapters, loadChapter, createChapter, updateChapter, deleteChapter,
  // Pages
  listPages, loadPage, savePage, createPage, deletePage,
  // Higher-level
  bookTree, loadPagesBatch, searchPages,
  // Internals (exported for testing)
  _resolveToken,
};
