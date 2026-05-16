'use strict';
// Phase 4a (BookStack-Exit, docs/bookstack-exit.md): Helper-API ueber app_users,
// user_invites, user_sessions_audit. Keine direkte SQL aus Konsumenten.
//
// Identity-Trennung:
//   - `app_users`            — wer darf einloggen + global_role + status
//   - `users`                — Profil/Settings (locale, theme, ...) (Migration 41)
//   - `user_sessions_audit`  — Login/Logout/Role-Change-Events
//   - `user_invites`         — Token-basierte Einladungen (Phase 4a)
//
// `users.email` ist FK auf `app_users.email` ON DELETE CASCADE — Hard-Delete
// raeumt Profil mit weg. Default ist Soft-Delete via `status='deleted'`,
// dabei bleibt das Profil zur Anonymisierung erhalten.

const crypto = require('crypto');
const { db } = require('./connection');

const _stmtFindByEmail = db.prepare(`
  SELECT id, email, display_name, avatar_url, global_role, status, language,
         model_override, can_invite_users, first_seen_at, last_seen_at,
         invited_by, invited_at, created_at,
         monthly_budget_usd, budget_mode
    FROM app_users
   WHERE email = ?
`);

const _stmtInsertUser = db.prepare(`
  INSERT INTO app_users (email, display_name, global_role, status, language,
                         can_invite_users, first_seen_at, invited_by, invited_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const _stmtTouchLogin = db.prepare(`
  UPDATE app_users
     SET last_seen_at  = datetime('now'),
         first_seen_at = COALESCE(first_seen_at, datetime('now')),
         display_name  = COALESCE(?, display_name)
   WHERE email = ?
`);

const _stmtSetStatus = db.prepare(`
  UPDATE app_users SET status = ? WHERE email = ?
`);

const _stmtSetRole = db.prepare(`
  UPDATE app_users SET global_role = ? WHERE email = ?
`);

const _stmtSetInviteFlag = db.prepare(`
  UPDATE app_users SET can_invite_users = ? WHERE email = ?
`);

const _stmtListUsers = db.prepare(`
  SELECT id, email, display_name, global_role, status, language,
         can_invite_users, first_seen_at, last_seen_at, created_at,
         monthly_budget_usd, budget_mode
    FROM app_users
   ORDER BY created_at DESC, email
`);

const _stmtSetBudget = db.prepare(`
  UPDATE app_users SET monthly_budget_usd = ?, budget_mode = ? WHERE email = ?
`);

const _stmtInsertAudit = db.prepare(`
  INSERT INTO user_sessions_audit (user_email, event, ip, user_agent, meta_json)
  VALUES (?, ?, ?, ?, ?)
`);

const _stmtListAudit = db.prepare(`
  SELECT id, event, ip, user_agent, meta_json, created_at
    FROM user_sessions_audit
   WHERE user_email = ?
   ORDER BY created_at DESC, id DESC
   LIMIT ?
`);

const _stmtInviteFind = db.prepare(`
  SELECT id, email, global_role, invite_token, invited_by, invited_at,
         expires_at, accepted_at, revoked_at
    FROM user_invites
   WHERE invite_token = ?
`);

const _stmtInviteFindActiveByEmail = db.prepare(`
  SELECT id, invite_token, expires_at FROM user_invites
   WHERE email = ? AND revoked_at IS NULL AND accepted_at IS NULL
`);

const _stmtInviteInsert = db.prepare(`
  INSERT INTO user_invites (email, global_role, invite_token, invited_by, expires_at)
  VALUES (?, ?, ?, ?, ?)
`);

const _stmtInviteAccept = db.prepare(`
  UPDATE user_invites SET accepted_at = datetime('now') WHERE id = ?
`);

const _stmtInviteRevoke = db.prepare(`
  UPDATE user_invites SET revoked_at = datetime('now') WHERE id = ? AND accepted_at IS NULL
`);

function _normEmail(email) {
  return (email || '').trim().toLowerCase();
}

function getUser(email) {
  const e = _normEmail(email);
  if (!e) return null;
  return _stmtFindByEmail.get(e) || null;
}

function listUsers() {
  return _stmtListUsers.all();
}

function createUser({ email, displayName = null, globalRole = 'user', status = 'active', language = 'de', canInviteUsers = 1, invitedBy = null }) {
  const e = _normEmail(email);
  if (!e) throw new Error('createUser: email required');
  const nowIso = new Date().toISOString();
  _stmtInsertUser.run(
    e,
    displayName,
    globalRole,
    status,
    language,
    canInviteUsers ? 1 : 0,
    status === 'active' ? nowIso : null,
    invitedBy ? _normEmail(invitedBy) : null,
    invitedBy ? nowIso : null,
  );
  return getUser(e);
}

function touchLogin(email, displayName = null) {
  const e = _normEmail(email);
  if (!e) return;
  _stmtTouchLogin.run(displayName, e);
}

function setStatus(email, status) {
  _stmtSetStatus.run(status, _normEmail(email));
}

function setGlobalRole(email, role) {
  _stmtSetRole.run(role, _normEmail(email));
}

function setCanInviteUsers(email, flag) {
  _stmtSetInviteFlag.run(flag ? 1 : 0, _normEmail(email));
}

// Phase 4d: Admin setzt Monats-Budget. `usd=null` entfernt das numerische
// Limit; `mode='none'` deaktiviert Pruefung komplett.
function setBudget(email, { usd, mode }) {
  const e = _normEmail(email);
  if (!e) throw new Error('setBudget: email required');
  if (mode !== 'none' && mode !== 'soft' && mode !== 'hard') {
    throw new Error("setBudget: mode must be 'none'|'soft'|'hard'");
  }
  const usdVal = (usd === null || usd === undefined || usd === '') ? null : Number(usd);
  if (usdVal !== null && (!Number.isFinite(usdVal) || usdVal < 0)) {
    throw new Error('setBudget: usd must be null or a non-negative number');
  }
  _stmtSetBudget.run(usdVal, mode, e);
}

// Soft-Delete: status='deleted' + anonymize display_name. Email bleibt
// blockiert (UNIQUE-Index verhindert Wiederverwendung).
function softDeleteUser(email) {
  const e = _normEmail(email);
  if (!e) return;
  db.prepare(`
    UPDATE app_users
       SET status        = 'deleted',
           display_name  = 'gelöscht'
     WHERE email = ?
  `).run(e);
}

function recordAuditEvent(email, event, { ip = null, userAgent = null, meta = null } = {}) {
  const e = _normEmail(email);
  if (!e) return;
  const metaJson = meta ? JSON.stringify(meta) : null;
  _stmtInsertAudit.run(e, event, ip || null, userAgent || null, metaJson);
}

function listAuditForUser(email, limit = 50) {
  const e = _normEmail(email);
  if (!e) return [];
  return _stmtListAudit.all(e, Math.max(1, Math.min(500, limit)));
}

// ── Invites ────────────────────────────────────────────────────────────────

function _newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function createInvite({ email, globalRole = 'user', invitedBy, expiresInDays = 14 }) {
  const e = _normEmail(email);
  if (!e) throw new Error('createInvite: email required');
  if (!invitedBy) throw new Error('createInvite: invitedBy required');
  if (globalRole !== 'admin' && globalRole !== 'user') {
    throw new Error('createInvite: globalRole must be admin|user');
  }
  // Bestehende aktive Invite fuer dieselbe Email zuerst revoken — Partial UNIQUE
  // erlaubt sonst keinen zweiten Eintrag.
  const existing = _stmtInviteFindActiveByEmail.get(e);
  if (existing) {
    db.prepare(`UPDATE user_invites SET revoked_at = datetime('now') WHERE id = ?`).run(existing.id);
  }
  const token = _newToken();
  const expiresAt = new Date(Date.now() + Math.max(1, expiresInDays) * 86400_000).toISOString();
  _stmtInviteInsert.run(e, globalRole, token, _normEmail(invitedBy), expiresAt);
  return findInviteByToken(token);
}

function findInviteByToken(token) {
  if (!token || typeof token !== 'string') return null;
  return _stmtInviteFind.get(token) || null;
}

// Status-Auflösung: 'active' (verwendbar), 'expired', 'revoked', 'accepted'.
function inviteStatus(invite) {
  if (!invite) return null;
  if (invite.revoked_at)  return 'revoked';
  if (invite.accepted_at) return 'accepted';
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) return 'expired';
  return 'active';
}

function acceptInvite(inviteId) {
  _stmtInviteAccept.run(inviteId);
}

function revokeInvite(inviteId) {
  _stmtInviteRevoke.run(inviteId);
}

function listActiveInvites() {
  return db.prepare(`
    SELECT id, email, global_role, invite_token, invited_by, invited_at, expires_at
      FROM user_invites
     WHERE revoked_at IS NULL AND accepted_at IS NULL
     ORDER BY invited_at DESC
  `).all();
}

// ── Admin-Bootstrap: ENV-getriebener Admin ────────────────────────────────
//
// Beim Server-Start: ADMIN_EMAIL aus ENV liest → wenn vorhanden, app_users-Row
// sicherstellen mit global_role='admin', status='active'. Re-Run-tauglich:
// existiert die Row mit anderer Rolle, wird auf 'admin' upgegradet (ENV ist
// SSoT fuer Admin-Identitaet). Status bleibt unangetastet, falls 'suspended'
// gewuenscht (Admin kann sich selbst sperren).
function ensureAdminFromEnv() {
  const envEmail = _normEmail(process.env.ADMIN_EMAIL);
  if (!envEmail) return null;
  const existing = getUser(envEmail);
  if (!existing) {
    createUser({
      email: envEmail,
      displayName: 'Admin',
      globalRole: 'admin',
      status: 'active',
      canInviteUsers: 1,
    });
    return { email: envEmail, action: 'created' };
  }
  if (existing.global_role !== 'admin') {
    setGlobalRole(envEmail, 'admin');
    return { email: envEmail, action: 'upgraded' };
  }
  return { email: envEmail, action: 'exists' };
}

module.exports = {
  getUser, listUsers, createUser, touchLogin,
  setStatus, setGlobalRole, setCanInviteUsers, setBudget, softDeleteUser,
  recordAuditEvent, listAuditForUser,
  createInvite, findInviteByToken, inviteStatus, acceptInvite, revokeInvite, listActiveInvites,
  ensureAdminFromEnv,
};
