'use strict';
// Link-Check des Recherche-Boards: prueft die URLs der Fundstuecke eines Buchs
// (oder eines einzelnen Fundstuecks) auf Erreichbarkeit und schreibt das Ergebnis
// an die URL-Zeile (research_item_urls.checked_at/check_ok/check_code/check_error).
// Kein KI-Call — Job statt Route, weil ein Buch hunderte Links tragen kann und
// jeder bis zu 10 s braucht: das muss pollbar und abbrechbar sein.
// Ausgehende Requests ausschliesslich ueber lib/url-check.js → safeFetch.

const express = require('express');
const { db } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers,
} = require('./shared');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { guardBook, sessionEmail } = require('../../lib/acl');
const { checkUrl } = require('../../lib/url-check');
const { NOW_ISO_SQL } = require('../../db/now');

const router = express.Router();
// Parallel offene Requests. Klein: die Ziele sind fremde Server, und ein Buch
// mit vielen Links derselben Domain soll dort nicht wie ein Scan aussehen.
const CONCURRENCY = 4;
const MAX_URLS = 1000;

function _urlsToCheck(bookId, itemId) {
  const where = itemId ? 'ri.book_id = ? AND ri.id = ?' : 'ri.book_id = ? AND ri.archived = 0';
  const args = itemId ? [bookId, itemId] : [bookId];
  return db.prepare(
    `SELECT u.id, u.url FROM research_item_urls u
       JOIN research_items ri ON ri.id = u.item_id
      WHERE ${where}
      ORDER BY u.checked_at IS NOT NULL, u.checked_at, u.id
      LIMIT ${MAX_URLS}`
  ).all(...args);
}

async function runResearchLinkCheckJob(jobId, bookId, itemId) {
  const logger = makeJobLogger(jobId);
  const signal = jobAbortControllers.get(jobId)?.signal;
  try {
    const rows = _urlsToCheck(bookId, itemId);
    if (!rows.length) {
      completeJob(jobId, { checked: 0, dead: 0 }, null, '0 Links');
      return;
    }
    const save = db.prepare(
      `UPDATE research_item_urls
          SET checked_at = ${NOW_ISO_SQL}, check_ok = ?, check_code = ?, check_error = ?
        WHERE id = ?`
    );
    let next = 0;
    let done = 0;
    let dead = 0;
    const worker = async () => {
      while (next < rows.length) {
        if (signal?.aborted) return;
        const row = rows[next++];
        const r = await checkUrl(row.url, { signal });
        save.run(r.ok ? 1 : 0, r.code, r.error, row.id);
        if (!r.ok) dead += 1;
        done += 1;
        updateJob(jobId, {
          progress: Math.round((done / rows.length) * 100),
          statusText: 'job.phase.researchLinkCheck',
          statusParams: { done, total: rows.length },
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
    if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    logger.info(`Link-Check: ${done} geprueft, ${dead} nicht erreichbar`);
    completeJob(jobId, { checked: done, dead }, null, `${done} Links, ${dead} tot`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Link-Check Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

router.post('/research-link-check', jsonBody, (req, res) => {
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!guardBook(req, res, bookId, 'editor')) return;
  setContext({ book: bookId });
  const itemId = req.body?.item_id != null ? toIntId(req.body.item_id) : null;
  if (req.body?.item_id != null && !itemId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = sessionEmail(req);
  const entityKey = itemId ? `${bookId}|${itemId}` : String(bookId);
  const existing = findActiveJobId('research-link-check', entityKey, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('research-link-check', bookId, userEmail, 'job.label.researchLinkCheck', null, entityKey);
  enqueueJob(jobId, () => runResearchLinkCheckJob(jobId, bookId, itemId));
  res.json({ jobId });
});

module.exports = { researchLinkCheckRouter: router, runResearchLinkCheckJob };
