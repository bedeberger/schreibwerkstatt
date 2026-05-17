'use strict';
const appSettings = require('../lib/app-settings');
// Admin-Routen fuer User-Verwaltung. Alle hinter requireAdmin (lib/admin-mw.js).
//
// Endpoints:
//   GET    /admin/users                — Liste aller User (kein Audit-Spam)
//   GET    /admin/users/:email/audit   — Audit-Drawer (letzte 50 Events)
//   POST   /admin/users/invite         — Token-Invite + Audit
//   PUT    /admin/users/:email         — global_role / status / can_invite_users
//   DELETE /admin/users/:email         — Soft-Delete (status='deleted')
//
// Privacy: Admin sieht hier nur User-Identitaet/Rolle/Status, keine Buecher.
// Buchsichtbarkeit laeuft ueber book_access.

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

  const { global_role, status, can_invite_users, monthly_budget_usd, budget_mode, ai_provider_override } = req.body || {};
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
  // Budget-Felder. Beide muessen zusammen kommen — Mode + USD bilden
  // eine Einheit, sonst sind Defaults missverstaendlich.
  if (monthly_budget_usd !== undefined || budget_mode !== undefined) {
    const nextMode = budget_mode !== undefined ? budget_mode : (user.budget_mode || 'none');
    const nextUsd = monthly_budget_usd === undefined ? user.monthly_budget_usd : monthly_budget_usd;
    try {
      appUsers.setBudget(target, { usd: nextUsd, mode: nextMode });
      if (nextMode !== (user.budget_mode || 'none') || nextUsd !== user.monthly_budget_usd) {
        appUsers.recordAuditEvent(target, 'budget-changed', {
          ip, userAgent,
          meta: { from: { mode: user.budget_mode || 'none', usd: user.monthly_budget_usd }, to: { mode: nextMode, usd: nextUsd }, by: actor },
        });
      }
    } catch (e) {
      return res.status(400).json({ error_code: 'BUDGET_INVALID', detail: e.message });
    }
  }
  // AI-Provider-Override. NULL/'' = follows global ai.provider.
  // Validierung: Provider muss konfiguriert sein. Ollama/Llama brauchen host.
  if (ai_provider_override !== undefined) {
    const next = (ai_provider_override === null || ai_provider_override === '') ? null : String(ai_provider_override).toLowerCase();
    if (next !== null && !['claude','ollama','llama'].includes(next)) {
      return res.status(400).json({ error_code: 'AI_PROVIDER_INVALID' });
    }
    if (next === 'ollama' && !appSettings.get('ai.ollama.host')) {
      return res.status(400).json({ error_code: 'AI_PROVIDER_NOT_CONFIGURED', detail: 'ollama' });
    }
    if (next === 'llama' && !appSettings.get('ai.llama.host')) {
      return res.status(400).json({ error_code: 'AI_PROVIDER_NOT_CONFIGURED', detail: 'llama' });
    }
    if (next === 'claude' && !appSettings.get('ai.claude.api_key')) {
      return res.status(400).json({ error_code: 'AI_PROVIDER_NOT_CONFIGURED', detail: 'claude' });
    }
    if (next !== (user.ai_provider_override || null)) {
      try { appUsers.setAiProviderOverride(target, next); }
      catch (e) { return res.status(400).json({ error_code: 'AI_PROVIDER_INVALID', detail: e.message }); }
      appUsers.recordAuditEvent(target, 'ai-provider-changed', {
        ip, userAgent,
        meta: { from: user.ai_provider_override || null, to: next, by: actor },
      });
    }
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
