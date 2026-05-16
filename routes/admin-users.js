'use strict';
// Phase 4a (BookStack-Exit, docs/bookstack-exit.md): Admin-Routen fuer
// User-Verwaltung. Alle hinter requireAdmin (Mittelweg über lib/admin-mw.js).
//
// Endpoints:
//   GET    /admin/users                — Liste aller User (kein Audit-Spam)
//   GET    /admin/users/:email/audit   — Audit-Drawer (letzte 50 Events)
//   POST   /admin/users/invite         — Token-Invite + Audit
//   PUT    /admin/users/:email         — global_role / status / can_invite_users
//   DELETE /admin/users/:email         — Soft-Delete (status='deleted')
//
// Privacy: Admin sieht hier nur User-Identitaet/Rolle/Status, keine Buecher.
// Buchsichtbarkeit kommt mit Phase 4b ueber book_access.

const express = require('express');
const appUsers = require('../db/app-users');
const { requireAdmin } = require('../lib/admin-mw');
const { setContext } = require('../lib/log-context');
const logger = require('../logger');

const router = express.Router();
router.use(requireAdmin);

function _clientIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null;
}

// Router-Mount: app.use('/admin/users', router) — Pfade hier sind relativ.
router.get('/', (req, res) => {
  const users = appUsers.listUsers();
  res.json({ users });
});

router.get('/:email/audit', (req, res) => {
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
  const events = appUsers.listAuditForUser(req.params.email, limit);
  res.json({ events });
});

router.post('/invite', express.json(), (req, res) => {
  const { email, role = 'user' } = req.body || {};
  if (!email) return res.status(400).json({ error_code: 'EMAIL_REQUIRED' });
  if (role !== 'admin' && role !== 'user') return res.status(400).json({ error_code: 'ROLE_INVALID' });
  const invitedBy = req.session.user.email;
  try {
    const invite = appUsers.createInvite({ email, globalRole: role, invitedBy });
    logger.info(`Admin-Invite ausgestellt: ${email} (${role})`, { user: invitedBy });
    res.json({ invite });
  } catch (e) {
    logger.error(`createInvite: ${e.message}`, { user: invitedBy });
    res.status(500).json({ error_code: 'INVITE_FAILED', detail: e.message });
  }
});

router.put('/:email', express.json(), (req, res) => {
  const target = (req.params.email || '').toLowerCase();
  if (!target) return res.status(400).json({ error_code: 'EMAIL_REQUIRED' });
  const user = appUsers.getUser(target);
  if (!user) return res.status(404).json({ error_code: 'USER_NOT_FOUND' });

  const { global_role, status, can_invite_users } = req.body || {};
  const ip = _clientIp(req);
  const userAgent = req.headers['user-agent'] || null;
  const actor = req.session.user.email;

  if (global_role !== undefined) {
    if (global_role !== 'admin' && global_role !== 'user') {
      return res.status(400).json({ error_code: 'ROLE_INVALID' });
    }
    if (global_role !== user.global_role) {
      appUsers.setGlobalRole(target, global_role);
      appUsers.recordAuditEvent(target, 'role-changed', { ip, userAgent, meta: { from: user.global_role, to: global_role, by: actor } });
    }
  }
  if (status !== undefined) {
    if (!['active', 'suspended', 'invited', 'deleted'].includes(status)) {
      return res.status(400).json({ error_code: 'STATUS_INVALID' });
    }
    if (status !== user.status) {
      appUsers.setStatus(target, status);
      const event = status === 'suspended' ? 'suspended' : (status === 'active' ? 'reactivated' : status === 'deleted' ? 'deleted' : null);
      if (event) appUsers.recordAuditEvent(target, event, { ip, userAgent, meta: { from: user.status, to: status, by: actor } });
    }
  }
  if (can_invite_users !== undefined) {
    appUsers.setCanInviteUsers(target, !!can_invite_users);
  }

  res.json({ user: appUsers.getUser(target) });
});

router.delete('/:email', (req, res) => {
  const target = (req.params.email || '').toLowerCase();
  const user = appUsers.getUser(target);
  if (!user) return res.status(404).json({ error_code: 'USER_NOT_FOUND' });
  // Selbst-Loeschung blockieren — sonst lockt sich Admin selbst aus.
  if (target === req.session.user.email.toLowerCase()) {
    return res.status(400).json({ error_code: 'CANNOT_DELETE_SELF' });
  }
  appUsers.softDeleteUser(target);
  appUsers.recordAuditEvent(target, 'deleted', {
    ip: _clientIp(req),
    userAgent: req.headers['user-agent'] || null,
    meta: { by: req.session.user.email },
  });
  res.json({ ok: true });
});

module.exports = router;
