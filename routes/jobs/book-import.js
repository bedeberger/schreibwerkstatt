'use strict';

// Book-Import-Job. Empfaengt ein `.swbook`-Bundle (ZIP mit manifest.json +
// book.json, siehe lib/book-bundle.js), validiert das Manifest, legt ein NEUES
// Buch (Owner = importierender User) an und schreibt Kapitel + Seiten in
// Tree-Reihenfolge via Content-Store-Facade. Gegenstueck zum Sync-Export in
// routes/book-migration.js. Spiegelt das Buffer-Map-Pattern von folder-import.

const express = require('express');
const JSZip = require('jszip');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  jobs, createJob, enqueueJob, findActiveJobId,
} = require('./shared');
const contentStore = require('../../lib/content-store');
const { validateManifest, validateBookJson, planFromNodes } = require('../../lib/book-bundle');
const { saveBookSettings, setBookEntitiesEnabled } = require('../../db/schema');
const { setContext } = require('../../lib/log-context');
const bookAccess = require('../../db/book-access');
const { db } = require('../../db/connection');
const logger = require('../../logger');

const router = express.Router();

const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const BUFFER_TTL_MS = 30 * 60 * 1000;

// jobId -> { buffer }
const importBuffers = new Map();

function _scheduleBufferCleanup(jobId) {
  const t = setTimeout(() => importBuffers.delete(jobId), BUFFER_TTL_MS);
  t.unref?.();
}

async function _readJsonEntry(zip, name) {
  const entry = zip.file(name);
  if (!entry) return null;
  const text = await entry.async('string');
  try { return JSON.parse(text); }
  catch { throw i18nError('job.error.badManifest'); }
}

async function runBookImportJob(jobId, { userEmail }) {
  const log = makeJobLogger(jobId);
  const ctx = { session: { user: { email: userEmail } } };
  try {
    const entry = importBuffers.get(jobId);
    if (!entry) throw i18nError('job.error.importBufferMissing');

    updateJob(jobId, { progress: 5, statusText: 'job.book-import.unpacking' });
    const zip = await JSZip.loadAsync(entry.buffer);

    updateJob(jobId, { progress: 10, statusText: 'job.book-import.validating' });
    const manifest = await _readJsonEntry(zip, 'manifest.json');
    if (!manifest) throw i18nError('job.error.badManifest');
    try { validateManifest(manifest); }
    catch (e) {
      throw i18nError(e.code === 'UNSUPPORTED_VERSION' ? 'job.error.unsupportedVersion' : 'job.error.badManifest');
    }

    const bookJson = await _readJsonEntry(zip, 'book.json');
    try { validateBookJson(bookJson); }
    catch { throw i18nError('job.error.swbookEmpty'); }

    const { ops, cappedChapters } = planFromNodes(bookJson.tree);
    if (cappedChapters) log.warn(`book-import: ${cappedChapters} Kapitel jenseits Tiefe 3 gekappt`);

    // Buch anlegen + Owner-Grant.
    updateJob(jobId, { progress: 20, statusText: 'job.book-import.creatingBook' });
    const created = await contentStore.createBook(
      { name: bookJson.book.name, description: bookJson.book.description || '', owner_email: userEmail },
      ctx,
    );
    const bookId = created.id;
    setContext({ book: bookId });
    try {
      db.prepare('UPDATE books SET owner_email = COALESCE(owner_email, ?) WHERE book_id = ?').run(userEmail, bookId);
      bookAccess.grantAccess(bookId, userEmail, 'owner', userEmail);
    } catch (gErr) {
      logger.warn(`Auto-Owner-Grant fuer book=${bookId} fehlgeschlagen: ${gErr.message}`);
    }
    log.info(`book-import: Buch «${bookJson.book.name}» angelegt (id=${bookId})`);

    // Buch-Konfig (authored). allow_lektor_book_chat bewusst auf 0 — ACL-relevant,
    // instanzspezifisch.
    const s = bookJson.book.settings;
    if (s && typeof s === 'object') {
      try {
        saveBookSettings(
          bookId, s.language || 'de', s.region || 'CH', s.buchtyp || null, s.buch_kontext || null,
          s.erzaehlperspektive || null, s.erzaehlzeit || null, s.is_finished ? 1 : 0, 0,
          Number.isFinite(s.daily_goal_chars) ? s.daily_goal_chars : null,
          s.orte_real ? 1 : 0, s.schauplatz_land || null,
        );
        if (s.entities_enabled) setBookEntitiesEnabled(bookId, 1);
      } catch (e) { log.warn(`book-import: Settings-Uebernahme fehlgeschlagen: ${e.message}`); }
    }

    // Kapitel + Seiten in Op-Reihenfolge anlegen. tempId -> echte chapter_id.
    const chapterIdByTemp = new Map();
    const total = ops.length;
    let done = 0;
    let pagesCreated = 0;
    let chaptersCreated = 0;

    for (const o of ops) {
      done += 1;
      if (done % 10 === 0 || done === total) {
        updateJob(jobId, {
          progress: 25 + Math.round(70 * (done / total)),
          statusText: 'job.book-import.creatingPages',
          statusParams: { current: done, total },
        });
      }
      const parentChapterId = o.parentTempId == null ? null : (chapterIdByTemp.get(o.parentTempId) ?? null);
      if (o.op === 'chapter') {
        try {
          const ch = await contentStore.createChapter(
            { book_id: bookId, name: o.name || '', description: o.description || '', parent_chapter_id: parentChapterId },
            ctx,
          );
          chapterIdByTemp.set(o.tempId, ch.id);
          chaptersCreated += 1;
        } catch (e) { log.warn(`book-import: createChapter «${o.name}» fail: ${e.message}`); }
      } else if (o.op === 'page') {
        try {
          await contentStore.createPage(
            { book_id: bookId, chapter_id: parentChapterId, name: o.name || '', html: o.html || '' },
            ctx,
          );
          pagesCreated += 1;
        } catch (e) { log.warn(`book-import: createPage «${o.name}» fail: ${e.message}`); }
      }
    }

    log.info(`book-import abgeschlossen: ${pagesCreated} Seiten, ${chaptersCreated} Kapitel`);

    // Stats syncen + Vortags-Baseline (analog folder-import: Tages-Donut braucht
    // einen prevChars-Snapshot vor heute).
    if (pagesCreated > 0) {
      try {
        const { syncBook } = require('../sync');
        const { localIsoDate, localIsoDaysAgo } = require('../../lib/local-date');
        await syncBook(bookId, ctx);
        const yesterday = localIsoDaysAgo(1);
        const today = localIsoDate();
        db.prepare(`
          INSERT INTO book_stats_history (book_id, recorded_at, page_count, words, chars, tok, unique_words, chapter_count, avg_sentence_len, avg_lix, avg_flesch_de)
          SELECT book_id, ?, page_count, words, chars, tok, unique_words, chapter_count, avg_sentence_len, avg_lix, avg_flesch_de
            FROM book_stats_history WHERE book_id = ? AND recorded_at = ?
          ON CONFLICT(book_id, recorded_at) DO UPDATE SET
            page_count=excluded.page_count, words=excluded.words, chars=excluded.chars, tok=excluded.tok,
            unique_words=excluded.unique_words, chapter_count=excluded.chapter_count,
            avg_sentence_len=excluded.avg_sentence_len, avg_lix=excluded.avg_lix, avg_flesch_de=excluded.avg_flesch_de
        `).run(yesterday, bookId, today);
      } catch (e) { log.warn(`book-import: Baseline-Snapshot fail: ${e.message}`); }
    }

    completeJob(jobId, { bookId, bookName: bookJson.book.name, pagesCreated, chaptersCreated, cappedChapters });
  } catch (e) {
    if (e?.name !== 'AbortError') log.error(`book-import job ${jobId}: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  } finally {
    importBuffers.delete(jobId);
  }
}

const rawZipBody = express.raw({
  type: ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'],
  limit: MAX_ZIP_BYTES + 1,
});

router.post('/book-import', rawZipBody, async (req, res) => {
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'UNAUTHENTICATED' });

  if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error_code: 'EMPTY_BODY' });
  }
  if (req.body.length > MAX_ZIP_BYTES) {
    return res.status(413).json({ error_code: 'ZIP_TOO_LARGE' });
  }

  // Dedup ueber Buffer-Groesse + User: zwei identische Uploads parallel sind der
  // einzige praktisch deckbare Fall; bewusst grob.
  const dedupKey = `swbook:${req.body.length}`;
  const existing = findActiveJobId('book-import', dedupKey, userEmail);
  if (existing) return res.json({ jobId: existing, deduplicated: true });

  const jobId = createJob('book-import', 0, userEmail, 'job.label.bookImport', {}, dedupKey);
  importBuffers.set(jobId, { buffer: req.body });
  _scheduleBufferCleanup(jobId);

  enqueueJob(jobId, () => runBookImportJob(jobId, { userEmail }));
  res.status(202).json({ jobId });
});

module.exports = { bookImportRouter: router, runBookImportJob, importBuffers };
