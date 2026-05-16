'use strict';
// Phase 4b (BookStack-Exit, docs/bookstack-exit.md): Sharing- und Page-Lock-
// Routen. Mount-Punkt: /books — die Router-Pfade enthalten alle :book_id und
// laufen durch aclParamGuard fuer Logging-Context + Mindestrolle.

const express = require('express');
const appUsers = require('../db/app-users');
const bookAccess = require('../db/book-access');
const { aclParamGuard, requireBookAccess, ACLError, sendACLError } = require('../lib/acl');
const { db } = require('../db/connection');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json({ limit: '64kb' });

const VALID_SHARE_ROLES = ['editor', 'lektor', 'viewer'];

function _normEmail(e) { return (e || '').toString().trim().toLowerCase(); }
function _userEmail(req) { return req.session?.user?.email || null; }

// ── Access-Liste pro Buch ───────────────────────────────────────────────────

router.get('/:book_id/access', aclParamGuard('viewer'), (req, res) => {
  const list = bookAccess.listBookAccess(req.bookId);
  res.json({ access: list, my_role: req.bookRole });
});

// ── Share/Invite ────────────────────────────────────────────────────────────
//
// POST /books/:book_id/share { email, role }
// - Nur Owner darf sharen.
// - Ziel-User muss in app_users existieren (status='active' oder 'invited').
// - Auto-Accept: book_access-Row sofort + book_share_invites mit accepted_at.

router.post('/:book_id/share', aclParamGuard('owner'), jsonBody, (req, res) => {
  const target = _normEmail(req.body?.email);
  const role = req.body?.role;
  if (!target) return res.status(400).json({ error_code: 'EMAIL_REQUIRED' });
  if (!VALID_SHARE_ROLES.includes(role)) {
    return res.status(400).json({ error_code: 'ROLE_INVALID', detail: { allowed: VALID_SHARE_ROLES } });
  }
  const user = appUsers.getUser(target);
  if (!user) return res.status(404).json({ error_code: 'USER_NOT_FOUND' });
  if (user.status !== 'active' && user.status !== 'invited') {
    return res.status(400).json({ error_code: 'USER_NOT_USABLE', detail: { status: user.status } });
  }
  // Owner-Slot ist via Transfer-Route geschuetzt, nicht via Share — Share darf
  // einen Eintrag zu owner nicht hochstufen.
  const currentRole = bookAccess.getBookRole(req.bookId, target);
  if (currentRole === 'owner') {
    return res.status(409).json({ error_code: 'CANNOT_DOWNGRADE_OWNER' });
  }
  const granter = _userEmail(req);
  try {
    db.transaction(() => {
      bookAccess.grantAccess(req.bookId, target, role, granter);
      db.prepare(`
        INSERT INTO book_share_invites (book_id, invitee_email, role, invited_by, accepted_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(book_id, invitee_email) DO UPDATE SET
          role        = excluded.role,
          invited_by  = excluded.invited_by,
          invited_at  = datetime('now'),
          accepted_at = datetime('now'),
          revoked_at  = NULL
      `).run(req.bookId, target, role, granter);
    })();
    appUsers.recordAuditEvent(target, 'role-changed', {
      ip: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
      meta: { event: 'book-shared', book_id: req.bookId, role, by: granter },
    });
    logger.info(`Buch geteilt: book=${req.bookId} ${target} role=${role} by ${granter}`);
    res.json({ ok: true, email: target, role });
  } catch (e) {
    logger.error(`POST /books/:id/share fehlgeschlagen: ${e.message}`);
    res.status(500).json({ error_code: 'SHARE_FAILED', detail: e.message });
  }
});

// PUT /books/:book_id/access/:email { role }
// Owner kann Rolle aendern — nicht fuer sich selbst und nicht zu 'owner'.
router.put('/:book_id/access/:email', aclParamGuard('owner'), jsonBody, (req, res) => {
  const target = _normEmail(req.params.email);
  const role = req.body?.role;
  if (!target) return res.status(400).json({ error_code: 'EMAIL_REQUIRED' });
  if (!VALID_SHARE_ROLES.includes(role)) {
    return res.status(400).json({ error_code: 'ROLE_INVALID', detail: { allowed: VALID_SHARE_ROLES } });
  }
  const current = bookAccess.getBookRole(req.bookId, target);
  if (!current) return res.status(404).json({ error_code: 'NOT_SHARED' });
  if (current === 'owner') {
    return res.status(409).json({ error_code: 'OWNER_NOT_DOWNGRADABLE', detail: 'Use /transfer-ownership instead' });
  }
  bookAccess.grantAccess(req.bookId, target, role, _userEmail(req));
  logger.info(`Buch-Rolle geaendert: book=${req.bookId} ${target} ${current}→${role} by ${_userEmail(req)}`);
  res.json({ ok: true, email: target, role });
});

// DELETE /books/:book_id/access/:email
// Owner darf revoken — nicht sich selbst (Transfer noetig).
router.delete('/:book_id/access/:email', aclParamGuard('owner'), (req, res) => {
  const target = _normEmail(req.params.email);
  if (!target) return res.status(400).json({ error_code: 'EMAIL_REQUIRED' });
  const current = bookAccess.getBookRole(req.bookId, target);
  if (!current) return res.status(404).json({ error_code: 'NOT_SHARED' });
  if (current === 'owner') {
    return res.status(409).json({ error_code: 'CANNOT_REVOKE_OWNER' });
  }
  bookAccess.revokeAccess(req.bookId, target);
  logger.info(`Buch-Zugriff entzogen: book=${req.bookId} ${target} (was ${current}) by ${_userEmail(req)}`);
  res.json({ ok: true });
});

// POST /books/:book_id/transfer-ownership { email }
// Neuer Owner muss bereits in book_access sein (= sehen das Buch schon).
router.post('/:book_id/transfer-ownership', aclParamGuard('owner'), jsonBody, (req, res) => {
  const target = _normEmail(req.body?.email);
  if (!target) return res.status(400).json({ error_code: 'EMAIL_REQUIRED' });
  if (target === _normEmail(_userEmail(req))) {
    return res.status(400).json({ error_code: 'CANNOT_TRANSFER_TO_SELF' });
  }
  try {
    const { previousOwner, newOwner } = bookAccess.transferOwnership(req.bookId, target, _userEmail(req));
    logger.info(`Ownership-Transfer: book=${req.bookId} ${previousOwner}→${newOwner}`);
    res.json({ ok: true, previous_owner: previousOwner, new_owner: newOwner });
  } catch (e) {
    if (e.message === 'transferOwnership: target not in book_access') {
      return res.status(404).json({ error_code: 'TARGET_NOT_IN_ACCESS' });
    }
    logger.error(`Transfer fehlgeschlagen: ${e.message}`);
    res.status(500).json({ error_code: 'TRANSFER_FAILED', detail: e.message });
  }
});

// ── Page-Locks ──────────────────────────────────────────────────────────────
//
// Lock-Routen sind page-scoped — Mindestrolle 'lektor' (Lektor darf locken
// um Findings sicher anzuwenden; Editor/Owner ebenfalls). Buch-ID wird per
// Page-ID nachgeladen.

function _pageOwnerBookId(pageId) {
  const row = db.prepare('SELECT book_id FROM pages WHERE page_id = ?').get(parseInt(pageId, 10));
  return row?.book_id || null;
}

function _resolvePageRole(req, pageId, minRole) {
  const bookId = _pageOwnerBookId(pageId);
  if (!bookId) throw new ACLError('PAGE_NOT_FOUND', 404);
  const role = requireBookAccess(req, bookId, minRole);
  return { bookId, role };
}

router.get('/pages/:page_id/lock', (req, res) => {
  const pageId = parseInt(req.params.page_id, 10);
  if (!Number.isInteger(pageId) || pageId <= 0) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  try {
    _resolvePageRole(req, pageId, 'viewer');
  } catch (e) {
    const sent = sendACLError(res, e); if (sent) return; throw e;
  }
  const lock = bookAccess.getPageLock(pageId);
  res.json({ lock: lock || null });
});

router.post('/pages/:page_id/lock', jsonBody, (req, res) => {
  const pageId = parseInt(req.params.page_id, 10);
  if (!Number.isInteger(pageId) || pageId <= 0) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  const email = _userEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  let bookId;
  try {
    ({ bookId } = _resolvePageRole(req, pageId, 'lektor'));
  } catch (e) {
    const sent = sendACLError(res, e); if (sent) return; throw e;
  }
  try {
    const lock = bookAccess.acquireLock(pageId, bookId, email, 'lektorat');
    res.json({ lock });
  } catch (e) {
    if (e.code === 'PAGE_LOCKED') {
      return res.status(423).json({
        error_code: 'PAGE_LOCKED',
        locked_by_email: e.lock.locked_by_email,
        expires_at: e.lock.expires_at,
      });
    }
    logger.error(`acquireLock fehlgeschlagen: ${e.message}`);
    res.status(500).json({ error_code: 'LOCK_FAILED', detail: e.message });
  }
});

router.post('/pages/:page_id/lock/heartbeat', (req, res) => {
  const pageId = parseInt(req.params.page_id, 10);
  if (!Number.isInteger(pageId) || pageId <= 0) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  const email = _userEmail(req);
  try {
    const lock = bookAccess.heartbeatLock(pageId, email);
    if (!lock) return res.status(404).json({ error_code: 'LOCK_NOT_FOUND' });
    res.json({ lock });
  } catch (e) {
    if (e.code === 'PAGE_LOCKED') {
      return res.status(423).json({
        error_code: 'PAGE_LOCKED',
        locked_by_email: e.lock.locked_by_email,
        expires_at: e.lock.expires_at,
      });
    }
    throw e;
  }
});

router.delete('/pages/:page_id/lock', (req, res) => {
  const pageId = parseInt(req.params.page_id, 10);
  if (!Number.isInteger(pageId) || pageId <= 0) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  const email = _userEmail(req);
  const force = req.query?.force === 'true' || req.query?.force === '1';
  let bookId, role;
  try {
    ({ bookId, role } = _resolvePageRole(req, pageId, force ? 'owner' : 'lektor'));
  } catch (e) {
    const sent = sendACLError(res, e); if (sent) return; throw e;
  }
  if (force) {
    const lock = bookAccess.getPageLock(pageId);
    const released = bookAccess.releaseLock(pageId, email, { force: true });
    if (released && lock) {
      appUsers.recordAuditEvent(lock.locked_by_email, 'role-changed', {
        ip: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
        meta: { event: 'lock-broken', book_id: bookId, page_id: pageId, broken_by: email },
      });
      logger.warn(`Lock gebrochen: page=${pageId} broken_by=${email} original=${lock.locked_by_email}`);
    }
    return res.json({ ok: true, released });
  }
  const released = bookAccess.releaseLock(pageId, email);
  res.json({ ok: true, released });
});

module.exports = router;
