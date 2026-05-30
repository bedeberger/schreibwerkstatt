'use strict';
const express = require('express');
const {
  deleteChapterExtractCache,
  getLatestContinuityCheck,
  getContinuityIssueBookId,
  setContinuityIssueResolved,
  } = require('../../../db/schema');
const { toIntId } = require('../../../lib/validate');
const { setContext } = require('../../../lib/log-context');
const { aclParamGuard, requireBookAccess, sendACLError } = require('../../../lib/acl');
const { jsonBody, createJob, enqueueJob, findActiveJobId } = require('../shared');
const { runKomplettAnalyseJob, runKontinuitaetJob, runKomplettAnalyseAll } = require('./job');

const komplettRouter = express.Router();
// :book_id-Routes (GET kontinuitaet, DELETE chapter-cache) sind viewer+ resp. editor+.
komplettRouter.param('book_id', aclParamGuard('viewer'));

// ── Routen ────────────────────────────────────────────────────────────────────
komplettRouter.post('/komplett-analyse', jsonBody, (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = req.session?.user?.email || null;
  const userToken = null;
  const existing = findActiveJobId('komplett-analyse', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.komplettBook' : 'job.label.komplett';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('komplett-analyse', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runKomplettAnalyseJob(jobId, book_id, book_name || '', userEmail, userToken));
  res.json({ jobId });
});

komplettRouter.post('/kontinuitaet', jsonBody, (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = req.session?.user?.email || null;
  const userToken = null;
  const existing = findActiveJobId('kontinuitaet', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.kontinuitaetBook' : 'job.label.kontinuitaet';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('kontinuitaet', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runKontinuitaetJob(jobId, book_id, book_name || '', userEmail, userToken));
  res.json({ jobId });
});

komplettRouter.get('/kontinuitaet/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const userEmail = req.session?.user?.email || null;
  const result = getLatestContinuityCheck(bookId, userEmail);
  res.json(result);
});

// Issue als erledigt/offen markieren (editor+). book_id wird aus dem Issue
// aufgeloest, da kein :book_id-Param vorliegt -> manuelle ACL statt aclParamGuard.
komplettRouter.post('/kontinuitaet/issue/:issue_id/resolved', jsonBody, (req, res) => {
  const issueId = toIntId(req.params.issue_id);
  if (!issueId) return res.status(400).json({ error_code: 'INVALID_ISSUE_ID' });
  const bookId = getContinuityIssueBookId(issueId);
  if (!bookId) return res.status(404).json({ error_code: 'ISSUE_NOT_FOUND' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const resolved = !!req.body?.resolved;
  setContinuityIssueResolved(issueId, resolved);
  res.json({ ok: true, resolved });
});

komplettRouter.delete('/chapter-cache/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const userEmail = req.session?.user?.email || '';
  const deleted = deleteChapterExtractCache(bookId, userEmail);
  res.json({ ok: true, deleted });
});

module.exports = { komplettRouter, runKomplettAnalyseAll, runKomplettAnalyseJob, runKontinuitaetJob };
