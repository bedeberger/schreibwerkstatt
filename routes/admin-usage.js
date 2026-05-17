'use strict';
// Phase 4d (BookStack-Exit, docs/bookstack-exit.md): Admin-Usage-Routen.
// Hinter requireAdmin (lib/admin-mw.js). Privacy-Boundary: Admin sieht
// Job-Typen, Modelle, Token-Counts, USD-Kosten und anonyme `book_id` —
// keine Prompt-Inhalte, keine Chat-Texte, keine Buchtitel.
//
// Jeder Read-Endpoint schreibt 'usage-viewed' ins user_sessions_audit
// (Subject = Admin selbst), damit die Privacy-Boundary nachvollziehbar ist.

const express = require('express');
const adminUsage = require('../db/admin-usage');
const appUsers = require('../db/app-users');
const { requireAdmin } = require('../lib/admin-mw');
const logger = require('../logger');

const router = express.Router();
router.use(requireAdmin);

function _clientIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null;
}

function _auditView(req, kind, meta = {}) {
  try {
    appUsers.recordAuditEvent(req.session.user.email, 'usage-viewed', {
      ip: _clientIp(req),
      userAgent: req.headers['user-agent'] || null,
      meta: { kind, ...meta },
    });
  } catch (e) {
    logger.warn(`[admin-usage] audit log failed: ${e.message}`);
  }
}

function _range(req) {
  const from = (req.query.from || '').trim() || undefined;
  const to   = (req.query.to   || '').trim() || undefined;
  return { from, to };
}

// GET /admin/usage/users?from=&to=
router.get('/users', (req, res) => {
  const range = _range(req);
  const rows = adminUsage.listUsersWithUsage(range);
  _auditView(req, 'users', { from: range.from, to: range.to });
  res.json({ users: rows, from: range.from || null, to: range.to || null });
});

// GET /admin/usage/jobs?user=&from=&to=&limit=&offset=
router.get('/jobs', (req, res) => {
  const email = (req.query.user || '').toString().toLowerCase().trim() || null;
  const range = _range(req);
  const limit = parseInt(req.query.limit, 10) || 50;
  const offset = parseInt(req.query.offset, 10) || 0;
  const result = adminUsage.getJobRuns({ email, ...range, limit, offset });
  _auditView(req, 'jobs', { target: email || '*all*', ...range });
  res.json(result);
});

// GET /admin/usage/chat?user=&from=&to=&limit=&offset=
router.get('/chat', (req, res) => {
  const email = (req.query.user || '').toString().toLowerCase().trim() || null;
  const range = _range(req);
  const limit = parseInt(req.query.limit, 10) || 50;
  const offset = parseInt(req.query.offset, 10) || 0;
  const result = adminUsage.getChatMessages({ email, ...range, limit, offset });
  _auditView(req, 'chat', { target: email || '*all*', ...range });
  res.json(result);
});

// GET /admin/usage/summary?from=&to=
router.get('/summary', (req, res) => {
  const range = _range(req);
  const summary = adminUsage.monthlyTotals(range);
  _auditView(req, 'summary', range);
  res.json(summary);
});

// GET /admin/usage/features?from=&to=
router.get('/features', (req, res) => {
  const range = _range(req);
  const items   = adminUsage.listFeatureUsage(range);
  const totals  = adminUsage.featureUsageTotals(range);
  _auditView(req, 'features', range);
  res.json({ items, totals, from: range.from || null, to: range.to || null });
});

// GET /admin/usage/time?from=&to=
router.get('/time', (req, res) => {
  const range = _range(req);
  const items = adminUsage.listTimeUsage(range);
  _auditView(req, 'time', range);
  res.json({ items, from: range.from || null, to: range.to || null });
});

// GET /admin/usage/time/:email/:bookId/series?from=&to=
router.get('/time/:email/:bookId/series', (req, res) => {
  const email = (req.params.email || '').toLowerCase();
  const bookId = parseInt(req.params.bookId, 10);
  if (!email || !Number.isFinite(bookId)) {
    return res.status(400).json({ error_code: 'PARAMS_INVALID' });
  }
  const range = _range(req);
  const series = adminUsage.dailyTimeSeries(email, bookId, range);
  _auditView(req, 'time-series', { target: email, bookId, ...range });
  res.json({ series, email, bookId, from: range.from || null, to: range.to || null });
});

module.exports = router;
