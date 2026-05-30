'use strict';
// Admin-Routen fuer client-seitige JS-Fehler (db/js-errors). Browser meldet via
// /telemetry/js-error, hier liest/loescht der Admin. Hinter requireAdmin. Keine
// Privacy-Boundary — Admin sieht alle Fehler. Audit-Log auf Loeschen. Tabelle
// ist selbst-rotierend (Cap in db/js-errors.js#MAX_ROWS).

const express = require('express');
const { requireAdmin } = require('../lib/admin-mw');
const { setContext } = require('../lib/log-context');
const { listJsErrors, deleteJsError, clearJsErrors } = require('../db/js-errors');
const appUsers = require('../db/app-users');
const logger = require('../logger');

const router = express.Router();
router.use(requireAdmin);
router.use((req, _res, next) => {
  setContext({ book: null });
  next();
});

function _clientIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null;
}

// ── GET /admin/js-errors/list ─────────────────────────────────────────────────
router.get('/list', (_req, res) => {
  try {
    res.json({ errors: listJsErrors() });
  } catch (e) {
    logger.error('[admin-js-errors] list failed: ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

// ── DELETE /admin/js-errors/:id ───────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const ok = deleteJsError(req.params.id);
  if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
  try {
    appUsers.recordAuditEvent(req.session.user.email, 'admin.js_errors.delete', {
      ip: _clientIp(req),
      userAgent: req.headers['user-agent'] || null,
      meta: { id: parseInt(req.params.id, 10) },
    });
  } catch (e) {
    logger.warn(`[admin-js-errors] audit log failed: ${e.message}`);
  }
  res.json({ ok: true });
});

// ── DELETE /admin/js-errors ───────────────────────────────────────────────────
router.delete('/', (req, res) => {
  let deleted = 0;
  try {
    deleted = clearJsErrors();
  } catch (e) {
    logger.error('[admin-js-errors] clear failed: ' + e.message);
    return res.status(500).json({ error_code: 'DB_ERROR' });
  }
  try {
    appUsers.recordAuditEvent(req.session.user.email, 'admin.js_errors.clear', {
      ip: _clientIp(req),
      userAgent: req.headers['user-agent'] || null,
      meta: { deleted },
    });
  } catch (e) {
    logger.warn(`[admin-js-errors] audit log failed: ${e.message}`);
  }
  res.json({ ok: true, deleted });
});

module.exports = router;
