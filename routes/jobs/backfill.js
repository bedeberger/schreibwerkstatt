'use strict';
// Phase 0b (BookStack-Exit, docs/bookstack-exit.md): per-User-Backfill aller
// BookStack-Buecher/Kapitel/Seiten in die lokale DB. Pflicht-Vorgaenger fuer
// Phase 1 (localdb-Backend); ohne Backfill liesse der Backend-Switch die DB
// fuer einen Neu-User leer.
//
// Job-Pattern wie andere Hintergrund-Jobs: createJob → enqueueJob → runJob mit
// updateJob-Fortschritts-Meldungen. Dedup auf User-Ebene (genau ein
// Backfill-Job pro User gleichzeitig) — `entityKey = userEmail || 'anonymous'`.
//
// Optionaler Body `{ bookId }` schraenkt den Lauf auf ein einzelnes Buch ein
// (Smoke-Test, gezielter Restore, Lazy-Backfill beim ersten Page-Open).

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  createJob, enqueueJob, findActiveJobId,
  jsonBody,
} = require('./shared');
const contentStore = require('../../lib/content-store');
const { backfillBookTransactional } = require('../../db/backfill');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');

const backfillRouter = express.Router();

const _PAGE_BATCH_SIZE = 10;

async function runBackfillJob(jobId, userEmail, token, { bookIdFilter = null } = {}) {
  const log = makeJobLogger(jobId);
  try {
    log.info(`Start (filter=${bookIdFilter ?? 'alle'})`);
    updateJob(jobId, { statusText: 'job.phase.listingBooks', progress: 2 });

    const books = bookIdFilter
      ? [await contentStore.loadBook(bookIdFilter, token)]
      : await contentStore.listBooks(token);

    if (!books.length) {
      completeJob(jobId, { books: 0, chapters: 0, pages: 0 }, null, 'keine Buecher');
      return;
    }

    let totalChapters = 0;
    let totalPages = 0;
    const perBook = [];

    for (let i = 0; i < books.length; i++) {
      const book = books[i];
      if (!book?.id) continue;
      setContext({ book: book.id });

      const bookProgressBase = 5 + Math.floor((i / books.length) * 90);
      updateJob(jobId, {
        statusText: 'job.phase.backfillBook',
        statusParams: { bookId: book.id, bookName: book.name || `Buch ${book.id}` },
        progress: bookProgressBase,
      });

      // BookStack-Mapper liefert hier bereits Domain-Shape.
      const [chapters, pageMetas] = await Promise.all([
        contentStore.listChapters(book.id, token),
        contentStore.listPages(book.id, token),
      ]);

      // Volltexte (html + markdown) pro Seite. loadPagesBatch nutzt bsBatch
      // mit Concurrency-Cap; fehlende Seiten werden uebersprungen.
      const fullPages = await contentStore.loadPagesBatch(pageMetas, token, {
        batchSize: _PAGE_BATCH_SIZE,
        onError: (p, e) => {
          log.warn(`Buch ${book.id}: Seite ${p.id} uebersprungen (${e.message || e.code})`);
          return null;
        },
      });

      const { chapterCount, pageCount } = backfillBookTransactional({
        book,
        chapters,
        pages: fullPages,
        ownerEmail: userEmail,
      });
      totalChapters += chapterCount;
      totalPages += pageCount;
      perBook.push({ bookId: book.id, chapters: chapterCount, pages: pageCount });

      log.info(`Buch ${book.id} (${book.name || ''}): chapters=${chapterCount} pages=${pageCount}`);
    }

    completeJob(
      jobId,
      { books: books.length, chapters: totalChapters, pages: totalPages, perBook },
      null,
      `${books.length} Buecher, ${totalChapters} Kapitel, ${totalPages} Seiten`,
    );
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

backfillRouter.post('/backfill', jsonBody, (req, res) => {
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'AUTH_REQUIRED' });
  const token = req.session?.bookstackToken || null;
  if (!token) return res.status(400).json({ error_code: 'BOOKSTACK_TOKEN_REQUIRED' });

  // Optionaler Einzel-Buch-Backfill via Body. toIntId validiert positive INT.
  let bookIdFilter = null;
  if (req.body && req.body.bookId !== undefined && req.body.bookId !== null) {
    bookIdFilter = toIntId(req.body.bookId);
    if (!bookIdFilter) return res.status(400).json({ error_code: 'BOOK_ID_INVALID' });
    setContext({ book: bookIdFilter });
  }

  // Dedup auf User-Ebene — verhindert parallele Vollabzuege fuer denselben User.
  const entityKey = `user:${userEmail}` + (bookIdFilter ? `:book:${bookIdFilter}` : '');
  const existing = findActiveJobId('backfill', entityKey, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });

  const label = bookIdFilter ? 'job.label.backfillBook' : 'job.label.backfillAll';
  const labelParams = bookIdFilter ? { bookId: bookIdFilter } : null;
  const jobId = createJob('backfill', bookIdFilter || 0, userEmail, label, labelParams, entityKey);
  enqueueJob(jobId, () => runBackfillJob(jobId, userEmail, token, { bookIdFilter }));
  res.json({ jobId });
});

module.exports = { backfillRouter, runBackfillJob };
