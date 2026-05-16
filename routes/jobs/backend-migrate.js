'use strict';
// Phase 8 (BookStack-Exit, docs/bookstack-exit.md): Backend-Migrate-Job.
// Aktueller Scope: gerichteter Bulk-Copy `bookstack` → `localdb`. ID-erhaltend
// (localdb uebernimmt BookStack-PKs 1:1 via Phase-0b-Wasserzeichen). Damit
// entfaellt der FK-Repair-Pfad — alle ~40 FK-Spalten zeigen weiter auf
// dieselben Integer-IDs.
//
// Ablauf:
//  1. Vor erstem Buch: Source-Read-Only-Marker setzen (currentBackend ist
//     `bookstack`; ab da blockiert die Content-Store-Facade Edits gegen BS).
//  2. Pro Buch: aus dem Bookstack-Backend lesen (Books / Chapters / Pages mit
//     Volltext) und via `backfillBookTransactional` ID-erhaltend nach localdb
//     kopieren. Transaktion + `foreign_key_check` sind dort schon enthalten.
//  3. FTS-Reindex (Phase 7): Buch komplett reindexen, damit Suche unter
//     localdb-Backend sofort konsistent ist.
//  4. Nach Erfolg aller Buecher: Cutover via `app.backend = 'localdb'`. Marker
//     bleibt gesetzt, damit ein versehentlicher Re-Switch auf `bookstack`
//     dort weiterhin als Source read-only behandelt wird — Rollback-Sicherung
//     liegt damit beim Admin (explizites Loeschen des Markers).
//
// Idempotent: `backfillBookTransactional` ist Upsert; Re-Run schreibt die
// gleichen Rows neu. Dedup-Key auf Job-Ebene: pro Job-Lauf nur ein aktiver
// Migrate-Job (entityKey `migrate:global`).

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob,
  createJob, enqueueJob, findActiveJobId,
  jsonBody,
} = require('./shared');
const appSettings = require('../../lib/app-settings');
const bookstackBackend = require('../../lib/content-store/backends/bookstack');
const { backfillBookTransactional } = require('../../db/backfill');
const { db } = require('../../db/connection');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireAdmin } = require('../../lib/admin-mw');
const { getAnyUserToken } = require('../../db/tokens');
const logger = require('../../logger');

const backendMigrateRouter = express.Router();

const _PAGE_BATCH_SIZE = 10;
const _ENTITY_KEY = 'migrate:global';
const _SUPPORTED_SOURCES = new Set(['bookstack']);
const _SUPPORTED_TARGETS = new Set(['localdb']);

let _searchIndexCached = null;
function _searchIndex() {
  if (_searchIndexCached !== null) return _searchIndexCached;
  try { _searchIndexCached = require('../../lib/search'); }
  catch (e) {
    logger.warn(`[backend-migrate] searchIndex nicht verfuegbar: ${e.message}`);
    _searchIndexCached = false;
  }
  return _searchIndexCached || null;
}

// Per-Buch-Reindex: search.js exponiert nur Per-Entity-Upserts, kein
// `reindexBook`. Wir iterieren also book/chapters/pages und stossen pro Row
// den Upsert an. `removeAllForBook` vorher entfernt veraltete Eintraege aus
// frueheren Migrate-Runs (falls Pages geloescht wurden).
function _reindexBook(bookId) {
  const idx = _searchIndex();
  if (!idx) return;
  try {
    idx.removeAllForBook?.(bookId);
    idx.upsertBookMeta(bookId);
    const chapters = db.prepare('SELECT chapter_id FROM chapters WHERE book_id = ?').all(bookId);
    for (const c of chapters) idx.upsertChapter(c.chapter_id);
    const pages = db.prepare('SELECT page_id FROM pages WHERE book_id = ?').all(bookId);
    for (const p of pages) idx.upsertPage(p.page_id);
  } catch (e) {
    logger.warn(`[backend-migrate] reindexBook(${bookId}) fehlgeschlagen: ${e.message}`);
  }
}

async function runBackendMigrateJob(jobId, {
  userEmail,
  token,
  source,
  target,
  bookIdFilter = null,
  setSourceReadOnly = true,
  cutover = true,
}) {
  const log = makeJobLogger(jobId);
  try {
    log.info(
      `Start backend-migrate ${source} → ${target} (filter=${bookIdFilter ?? 'alle'}, ` +
      `readonly=${setSourceReadOnly}, cutover=${cutover})`,
    );

    // 1. Read-Only-Marker (vor allen Schreibvorgaengen). Greift sofort: der
    //    Content-Store-Facade-Guard wirft 423 fuer jeden Edit gegen `source`,
    //    solange `app.backend === source`.
    if (setSourceReadOnly) {
      appSettings.set('app.migrate.source_readonly', source, { updatedBy: userEmail });
      updateJob(jobId, { statusText: 'job.phase.migrateMarkerSet', progress: 2 });
    }

    // 2. Bucher listen. Reads gehen direkt am Bookstack-Backend vorbei an der
    //    Facade — der Read-Only-Marker betrifft nur Writes, aber wir wollen
    //    den Marker robust gegen einen versehentlichen Switch von app.backend
    //    waehrend des Laufs machen.
    updateJob(jobId, { statusText: 'job.phase.listingBooks', progress: 5 });
    const allBooks = await bookstackBackend.listBooks(token);
    const books = bookIdFilter
      ? allBooks.filter(b => b.id === bookIdFilter)
      : allBooks;

    if (!books.length) {
      completeJob(
        jobId,
        { books: 0, chapters: 0, pages: 0, source, target, cutoverDone: false },
        null,
        'job.label.migrateNoBooks',
      );
      return;
    }

    let totalChapters = 0;
    let totalPages = 0;
    const perBook = [];

    for (let i = 0; i < books.length; i++) {
      const book = books[i];
      if (!book?.id) continue;
      setContext({ book: book.id });

      const bookProgressBase = 5 + Math.floor((i / books.length) * 85);
      updateJob(jobId, {
        statusText: 'job.phase.migrateBook',
        statusParams: { bookId: book.id, bookName: book.name || `Buch ${book.id}` },
        progress: bookProgressBase,
      });

      const [chapters, pageMetas] = await Promise.all([
        bookstackBackend.listChapters(book.id, token),
        bookstackBackend.listPages(book.id, token),
      ]);

      const fullPages = await bookstackBackend.loadPagesBatch(pageMetas, token, {
        batchSize: _PAGE_BATCH_SIZE,
        onError: (p, e) => {
          log.warn(`Migrate Buch ${book.id}: Seite ${p.id} uebersprungen (${e.message || e.code})`);
          return null;
        },
      });

      const { chapterCount, pageCount } = backfillBookTransactional({
        book,
        chapters,
        pages: fullPages.filter(Boolean),
        ownerEmail: userEmail,
      });

      _reindexBook(book.id);

      totalChapters += chapterCount;
      totalPages += pageCount;
      perBook.push({ bookId: book.id, chapters: chapterCount, pages: pageCount });

      log.info(`Migrate Buch ${book.id} (${book.name || ''}): chapters=${chapterCount} pages=${pageCount}`);
    }

    // 3. Cutover. Atomar via app_settings.set — `app-settings:changed`-Event
    //    feuert; offene Caches im Content-Store lesen ab dem naechsten Call
    //    den neuen Wert.
    let cutoverDone = false;
    if (cutover) {
      updateJob(jobId, { statusText: 'job.phase.migrateCutover', progress: 95 });
      appSettings.set('app.backend', target, { updatedBy: userEmail });
      cutoverDone = true;
      log.info(`Cutover: app.backend = ${target}`);
    }

    completeJob(
      jobId,
      {
        books: books.length,
        chapters: totalChapters,
        pages: totalPages,
        perBook,
        source,
        target,
        cutoverDone,
        sourceReadOnly: setSourceReadOnly,
      },
      null,
      'job.label.migrateDone',
    );
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Backend-migrate fehlgeschlagen: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// POST /jobs/backend-migrate
// Admin-only. Body:
//   { source: 'bookstack', target: 'localdb',
//     bookId?: <int>|null, setSourceReadOnly?: bool, cutover?: bool }
backendMigrateRouter.post('/backend-migrate', requireAdmin, jsonBody, (req, res) => {
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'AUTH_REQUIRED' });

  const body = req.body || {};
  const source = String(body.source || '').toLowerCase();
  const target = String(body.target || '').toLowerCase();
  if (!_SUPPORTED_SOURCES.has(source)) return res.status(400).json({ error_code: 'SOURCE_NOT_SUPPORTED' });
  if (!_SUPPORTED_TARGETS.has(target)) return res.status(400).json({ error_code: 'TARGET_NOT_SUPPORTED' });
  if (source === target) return res.status(400).json({ error_code: 'SOURCE_EQUALS_TARGET' });

  const currentBackend = String(appSettings.get('app.backend') || 'bookstack').toLowerCase();
  if (currentBackend !== source) {
    return res.status(409).json({ error_code: 'CURRENT_BACKEND_MISMATCH', detail: `current=${currentBackend}` });
  }

  // BookStack-Token Pflicht (Source-Reads). Bevorzugt Session-Token; Fallback
  // auf irgendein gespeichertes User-Token, damit Admin ohne eigenes BS-Konto
  // den Job dennoch starten kann.
  const token = req.session?.bookstackToken || getAnyUserToken();
  if (!token) return res.status(400).json({ error_code: 'BOOKSTACK_TOKEN_REQUIRED' });

  let bookIdFilter = null;
  if (body.bookId !== undefined && body.bookId !== null && body.bookId !== '') {
    bookIdFilter = toIntId(body.bookId);
    if (!bookIdFilter) return res.status(400).json({ error_code: 'BOOK_ID_INVALID' });
    setContext({ book: bookIdFilter });
  }

  const setSourceReadOnly = body.setSourceReadOnly !== false;
  const cutover = body.cutover !== false;

  const existing = findActiveJobId('backend-migrate', _ENTITY_KEY, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });

  const label = bookIdFilter ? 'job.label.migrateBook' : 'job.label.migrateAll';
  const labelParams = bookIdFilter ? { bookId: bookIdFilter } : null;
  const jobId = createJob('backend-migrate', bookIdFilter || 0, userEmail, label, labelParams, _ENTITY_KEY);
  enqueueJob(jobId, () => runBackendMigrateJob(jobId, {
    userEmail, token, source, target, bookIdFilter, setSourceReadOnly, cutover,
  }));
  res.json({ jobId });
});

// POST /jobs/backend-migrate/clear-readonly — Marker zuruecksetzen.
// Admin-only Rollback-Helfer: entfernt `app.migrate.source_readonly`, sobald
// der Admin entschieden hat, dass das Quell-Backend wieder regulaere Writes
// akzeptieren darf (z.B. nach gewolltem Re-Switch von localdb zurueck auf
// bookstack ohne Re-Migration).
backendMigrateRouter.post('/backend-migrate/clear-readonly', requireAdmin, (req, res) => {
  const userEmail = req.session?.user?.email || null;
  appSettings.set('app.migrate.source_readonly', '', { updatedBy: userEmail || 'admin' });
  res.json({ ok: true });
});

// GET /jobs/backend-migrate/status — Liefert aktuellen Backend + Marker fuer
// die Admin-UI ohne sie ueber das `/admin/settings`-Endpoint zu fuettern.
backendMigrateRouter.get('/backend-migrate/status', requireAdmin, (req, res) => {
  res.json({
    currentBackend: String(appSettings.get('app.backend') || 'bookstack').toLowerCase(),
    sourceReadOnly: String(appSettings.get('app.migrate.source_readonly') || '').toLowerCase() || null,
  });
});

module.exports = { backendMigrateRouter, runBackendMigrateJob };
