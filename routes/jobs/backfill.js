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
// Auto-Sweep beim Backend-Switch: `app-settings:changed` mit Key `app.backend`
// queued pro aktivem User mit gespeichertem BookStack-Token einen Backfill-Job
// — sequentiell durch die Job-Queue, idempotent ueber findActiveJobId.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  createJob, enqueueJob, findActiveJobId,
  jsonBody,
} = require('./shared');
const contentStore = require('../../lib/content-store');
const { backfillBookTransactional } = require('../../db/backfill');
const { db } = require('../../db/connection');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { getAllUserTokens } = require('../../db/tokens');
const { listUsers } = require('../../db/app-users');
const appSettings = require('../../lib/app-settings');
const { requireAdmin } = require('../../lib/admin-mw');
const logger = require('../../logger');

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

// Auto-Trigger nach erfolgreichem Login: wenn pages.body_html global noch
// nirgends gefuellt ist, startet automatisch ein Full-Backfill fuer den
// gerade eingeloggten User. Verhindert „leerer Editor"-Effekt nach
// Phase-1-Deploy.
//
// Heuristik (global statt per-User), weil pro-User-Tracking erst mit Phase 4a
// (app_users) kommt. Sobald irgendein Body in der DB liegt, schaltet der
// Auto-Trigger ab — manueller Re-Run bleibt jederzeit moeglich.
//
// Idempotent: doppelte Auto-Trigger werden via findActiveJobId verhindert.
// Fehler in der DB-Heuristik oder beim Enqueue werden geschluckt — Login
// darf an einem fehlgeschlagenen Auto-Trigger nicht scheitern.
function maybeAutoBackfillOnLogin(userEmail, token) {
  if (!userEmail || !token) return null;
  try {
    const row = db.prepare('SELECT 1 AS x FROM pages WHERE body_html IS NOT NULL LIMIT 1').get();
    if (row) return null; // schon mal gebackfilled
    const entityKey = `user:${userEmail}`;
    if (findActiveJobId('backfill', entityKey, userEmail)) return null;
    const jobId = createJob('backfill', 0, userEmail, 'job.label.backfillAll', null, entityKey);
    enqueueJob(jobId, () => runBackfillJob(jobId, userEmail, token));
    logger.info('Auto-Backfill nach Login angestossen.', { job: 'backfill', user: userEmail });
    return jobId;
  } catch (e) {
    logger.warn(`maybeAutoBackfillOnLogin: ${e.message}`);
    return null;
  }
}

// Auto-Sweep beim Backend-Switch
// ─────────────────────────────────────────────────────────────────────────────
// Trigger: `app-settings:changed`-Event mit Key `app.backend`. Bei tatsaechlich
// veraendertem Wert (vorher != nachher) wird pro aktivem User mit gespeichertem
// BookStack-Token ein Backfill-Job in die Queue gelegt. Sequentiell durch die
// Queue-Concurrency-Limits; idempotent ueber findActiveJobId.
//
// Status persistiert im Modul-Scope; GET /jobs/backfill/sweep liefert den
// aktuellen Stand fuer das AdminSettingsCard.

const _sweep = {
  active: false,
  startedAt: null,
  endedAt: null,
  triggeredBy: null,
  fromBackend: null,
  toBackend: null,
  total: 0,
  enqueued: 0,
  skipped: 0,
  jobIds: [],
};

let _lastBackend = null;
try { _lastBackend = appSettings.get('app.backend'); } catch (_) { _lastBackend = null; }

function getSweepState() { return { ..._sweep }; }

function runBackfillSweep({ triggeredBy = null, fromBackend = null, toBackend = null } = {}) {
  // Active-Users: status='active' + vorhandenes Token. Tokens ohne app_users-
  // Eintrag werden ebenfalls beruecksichtigt (Legacy-User vor Phase 4a).
  const activeEmails = new Set(
    listUsers().filter(u => u.status === 'active').map(u => u.email),
  );
  const haveAppUsers = activeEmails.size > 0;
  const tokens = getAllUserTokens()
    .filter(t => !haveAppUsers || activeEmails.has(t.email));

  Object.assign(_sweep, {
    active: true,
    startedAt: new Date().toISOString(),
    endedAt: null,
    triggeredBy,
    fromBackend,
    toBackend,
    total: tokens.length,
    enqueued: 0,
    skipped: 0,
    jobIds: [],
  });

  logger.info(
    `Backfill-Sweep gestartet: ${tokens.length} User (${fromBackend || '?'} → ${toBackend || '?'}, by ${triggeredBy || 'system'}).`,
    { job: 'backfill-sweep', user: triggeredBy },
  );

  for (const t of tokens) {
    const userEmail = t.email;
    const token = { id: t.token_id, pw: t.token_pw };
    const entityKey = `user:${userEmail}`;
    if (findActiveJobId('backfill', entityKey, userEmail)) {
      _sweep.skipped += 1;
      continue;
    }
    try {
      const jobId = createJob('backfill', 0, userEmail, 'job.label.backfillAll', null, entityKey);
      enqueueJob(jobId, () => runBackfillJob(jobId, userEmail, token));
      _sweep.enqueued += 1;
      _sweep.jobIds.push(jobId);
    } catch (e) {
      logger.warn(`Backfill-Sweep: enqueue fuer ${userEmail} fehlgeschlagen: ${e.message}`);
      _sweep.skipped += 1;
    }
  }

  _sweep.endedAt = new Date().toISOString();
  _sweep.active = false;

  logger.info(
    `Backfill-Sweep enqueued: ${_sweep.enqueued}/${_sweep.total} (skipped=${_sweep.skipped}).`,
    { job: 'backfill-sweep', user: triggeredBy },
  );

  return getSweepState();
}

appSettings.on('changed', ({ key, updatedBy }) => {
  if (key !== 'app.backend') return;
  const current = appSettings.get('app.backend');
  if (current === _lastBackend) return;
  const previous = _lastBackend;
  _lastBackend = current;
  try {
    runBackfillSweep({ triggeredBy: updatedBy || null, fromBackend: previous, toBackend: current });
  } catch (e) {
    logger.error(`Backfill-Sweep: Trigger fehlgeschlagen: ${e.message}`, { stack: e.stack });
  }
});

// GET /jobs/backfill/sweep — Admin-only Status-Endpoint fuer das
// AdminSettingsCard Backend-Tab. Liefert letzten Sweep-Stand + Live-Counts
// laufender/queued/done Jobs aus der Job-Map (Frontend pollt waehrend Sweep
// laeuft).
backfillRouter.get('/backfill/sweep', requireAdmin, (req, res) => {
  const { jobs } = require('./shared/state');
  let running = 0, queued = 0, done = 0, failed = 0;
  for (const jobId of _sweep.jobIds) {
    const j = jobs.get(jobId);
    if (!j) { done += 1; continue; } // bereits aus Map evicted
    if (j.status === 'running') running += 1;
    else if (j.status === 'queued') queued += 1;
    else if (j.status === 'done') done += 1;
    else if (j.status === 'error' || j.status === 'cancelled') failed += 1;
  }
  res.json({ sweep: getSweepState(), counts: { running, queued, done, failed } });
});

module.exports = { backfillRouter, runBackfillJob, maybeAutoBackfillOnLogin, runBackfillSweep, getSweepState };
