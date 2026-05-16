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
const bookOrder = require('../../db/book-order');
const logger = require('../../logger');

// Phase 7: searchIndex lazy laden — die Modul-Initialisierung praepariert
// Statements gegen FTS5-Tabellen, die im Test-Setup ohne volle Migrations-
// pipeline fehlen koennen. Lazy + try/catch macht den Save-Pfad robust.
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

function _backend() {
  const sel = String(appSettings.get('app.backend') || 'bookstack').toLowerCase();
  return sel === 'localdb' ? localdbBackend : bookstackBackend;
}

// Phase 8: Read-Only-Guard fuer Backend-Migration. Bevor der Migrate-Job pro
// Buch kopiert, setzt er `app.migrate.source_readonly = <currentBackend>` —
// jeder Write gegen das aktuell aktive Backend wird ab da mit 423 LOCKED
// abgelehnt. Reads bleiben erlaubt. Cutover (`app.backend = target`) hebt den
// Lock praktisch auf, weil currentBackend() dann nicht mehr matched; der
// Marker bleibt aber gesetzt — re-toggle auf den Source-Backend bleibt
// gesperrt, bis Admin den Marker explizit loescht (Rollback-Sicherung).
function _assertWritable() {
  const marker = String(appSettings.get('app.migrate.source_readonly') || '').toLowerCase();
  if (!marker) return;
  const current = String(appSettings.get('app.backend') || 'bookstack').toLowerCase();
  if (marker !== current) return;
  const err = new Error('content-store: backend is read-only during migration');
  err.code = 'BACKEND_READ_ONLY';
  err.status = 423;
  err.backend = current;
  throw err;
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
async function createBook(body, ctx) {
  _assertWritable();
  const created = await _backend().createBook(body, ctx);
  if (created?.id) _searchIndex()?.upsertBookMeta(created.id);
  return created;
}
async function deleteBook(bookId, ctx) {
  _assertWritable();
  const result = await _backend().deleteBook(bookId, ctx);
  _searchIndex()?.removeAllForBook(bookId);
  return result;
}

// ── Chapters ────────────────────────────────────────────────────────────────
async function listChapters(bookId, ctx)              { return _backend().listChapters(bookId, ctx); }
async function loadChapter(chapterId, ctx)            { return _backend().loadChapter(chapterId, ctx); }
async function createChapter(body, ctx) {
  _assertWritable();
  const created = await _backend().createChapter(body, ctx);
  if (created?.id) _searchIndex()?.upsertChapter(created.id);
  return created;
}
async function updateChapter(chapterId, body, ctx) {
  _assertWritable();
  const updated = await _backend().updateChapter(chapterId, body, ctx);
  _searchIndex()?.upsertChapter(chapterId);
  return updated;
}
async function deleteChapter(chapterId, ctx) {
  _assertWritable();
  const result = await _backend().deleteChapter(chapterId, ctx);
  _searchIndex()?.remove('chapter', chapterId);
  return result;
}

// ── Pages ────────────────────────────────────────────────────────────────────
async function listPages(bookId, ctx)         { return _backend().listPages(bookId, ctx); }
async function loadPage(pageId, ctx)          { return _backend().loadPage(pageId, ctx); }

const _SOURCE_FALLBACK = 'main';

async function savePage(pageId, body, ctx) {
  _assertWritable();
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

  // Phase 7: FTS-Index nach Body-/Name-/Chapter-Aenderung aktualisieren.
  // Reine Reorder-Saves (nur position) lesen aus saved trotzdem den aktuellen
  // Stand; idempotent.
  if (saved?.id) _searchIndex()?.upsertPage(saved.id);

  return saved;
}

async function createPage(body, ctx) {
  _assertWritable();
  const created = await _backend().createPage(body, ctx);
  if (created?.id) _searchIndex()?.upsertPage(created.id);
  return created;
}
async function deletePage(pageId, ctx) {
  _assertWritable();
  const result = await _backend().deletePage(pageId, ctx);
  _searchIndex()?.remove('page', pageId);
  return result;
}

// ── Higher-level helpers ────────────────────────────────────────────────────
// bookTree konsumiert raw-Daten beider Backends und ordnet sie nach
// book_order (Phase 3, SSoT). Fehlt die Row, wird sie aus dem aktuellen
// position/priority-Stand initialisiert (Auto-Init) — neue Items aus dem
// Sync-Pull oder Direkt-Inserts werden in ensureTree() ans Ende reconciled.
async function bookTree(bookId, ctx) {
  const raw = await _backend().bookTree(bookId, ctx);
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
