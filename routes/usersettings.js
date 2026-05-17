'use strict';
const express = require('express');
const { getUser, updateUserSettings } = require('../db/schema');
const appUsers = require('../db/app-users');
const { setContext } = require('../lib/log-context');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

// Audit-Log-Events (UI-Trigger ohne anderen Server-Roundtrip).
// Allowlist verhindert beliebige Logs durch den Client.
const AUDIT_EVENTS = {
  chatOpened:     'Seiten-Chat geöffnet',
  bookChatOpened: 'Buch-Chat geöffnet',
  lektoratOpened: 'Lektorat geöffnet',
};

router.post('/event', jsonBody, (req, res) => {
  const event = String(req.body?.event || '');
  const label = AUDIT_EVENTS[event];
  if (!label) return res.status(400).json({ error_code: 'INVALID_EVENT' });
  const meta = req.body?.meta && typeof req.body.meta === 'object' ? req.body.meta : null;
  const bookId = meta && Number.isFinite(Number(meta.book)) ? parseInt(meta.book, 10) : null;
  if (bookId) setContext({ book: bookId });
  const suffix = meta
    ? ' ' + Object.entries(meta)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
    : '';
  logger.info(`${label}${suffix}`);
  res.json({ ok: true });
});

const VALID_LOCALES   = ['de', 'en'];
const VALID_THEMES    = ['auto', 'light', 'dark'];
const VALID_LANGUAGES = ['de', 'en'];
const VALID_REGIONS   = ['CH', 'DE', 'US', 'GB'];
const VALID_BUCHTYPEN = ['roman', 'kurzgeschichten', 'gesellschaft', 'krimi', 'historisch', 'fantasy_scifi', 'erotik', 'jugend', 'autobiografie', 'andere'];
const VALID_FOCUS_GRANULARITIES = ['paragraph', 'sentence', 'window-3', 'typewriter-only'];

// Tagesziel: 100 Zeichen ≈ kurzer Tweet (Untergrenze gegen Tippfehler),
// 50 000 ≈ 33 Normseiten als praktisches Maximum.
const DAILY_GOAL_MIN = 100;
const DAILY_GOAL_MAX = 50000;

const FIELDS = [
  { key: 'locale',            allowed: VALID_LOCALES,             label: 'locale' },
  { key: 'theme',             allowed: VALID_THEMES,              label: 'theme' },
  { key: 'default_buchtyp',   allowed: VALID_BUCHTYPEN,           label: 'default_buchtyp' },
  { key: 'default_language',  allowed: VALID_LANGUAGES,           label: 'default_language' },
  { key: 'default_region',    allowed: VALID_REGIONS,             label: 'default_region' },
  { key: 'focus_granularity', allowed: VALID_FOCUS_GRANULARITIES, label: 'focus_granularity' },
];

// Numerische Felder mit Range-Check (parallel zu FIELDS, weil
// Allowed-Array-Schema dort nicht passt).
const NUMERIC_FIELDS = [
  { key: 'daily_goal_chars', min: DAILY_GOAL_MIN, max: DAILY_GOAL_MAX, label: 'daily_goal_chars' },
];

/** Aktuelles User-Profil samt Einstellungen + app_users-Identity. */
router.get('/settings', (req, res) => {
  const email = req.session.user.email;
  const user = getUser(email);
  if (!user) return res.status(404).json({ error_code: 'USER_PROFILE_NOT_FOUND' });
  // Identity-Felder aus app_users mitliefern. Frontend nutzt
  // role + can_invite_users fuer UI-Gates (Admin-Karte, Invite-Dialog).
  const app = appUsers.getUser(email);
  res.json({
    ...user,
    role: app?.global_role || 'user',
    status: app?.status || 'active',
    can_invite_users: app?.can_invite_users ? 1 : 0,
    display_name: app?.display_name || null,
    model_override: app?.model_override || null,
  });
});

/** Partielles Update. Nicht übergebene Felder bleiben unverändert;
 *  leerer String oder null setzt das Feld zurück. */
router.patch('/settings', jsonBody, (req, res) => {
  const email = req.session.user.email;
  const existing = getUser(email);
  if (!existing) return res.status(404).json({ error_code: 'USER_PROFILE_NOT_FOUND' });

  const body = req.body || {};

  for (const { key, allowed, label } of FIELDS) {
    if (body[key] === undefined || body[key] === null || body[key] === '') continue;
    if (!allowed.includes(body[key])) {
      return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: label, allowed: allowed.join(', ') } });
    }
  }

  for (const { key, min, max, label } of NUMERIC_FIELDS) {
    if (body[key] === undefined || body[key] === null || body[key] === '') continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
      return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: label, allowed: `${min}–${max}` } });
    }
  }

  const merged = {};
  for (const { key } of FIELDS) {
    if (body[key] === undefined)           merged[key] = existing[key];
    else if (body[key] === '' || body[key] === null) merged[key] = null;
    else                                   merged[key] = body[key];
  }
  for (const { key } of NUMERIC_FIELDS) {
    if (body[key] === undefined)           merged[key] = existing[key];
    else if (body[key] === '' || body[key] === null) merged[key] = null;
    else                                   merged[key] = Number(body[key]);
  }

  updateUserSettings(email, merged);
  res.json({ ok: true, ...getUser(email) });
});

// User-Selbst-Invite. Gate via app_users.can_invite_users; Admins
// duerfen ueber /admin/users/invite mit role='admin' arbeiten, hier zwingend
// role='user'. Use-Case: Buch-Sharing-Dialog laedt frische Email ein.
router.post('/invite', jsonBody, (req, res) => {
  const inviter = req.session.user.email;
  const me = appUsers.getUser(inviter);
  if (!me) return res.status(403).json({ error_code: 'NOT_REGISTERED' });
  if (me.status !== 'active') return res.status(403).json({ error_code: 'NOT_ACTIVE' });
  if (!me.can_invite_users && me.global_role !== 'admin') {
    return res.status(403).json({ error_code: 'INVITE_FORBIDDEN' });
  }
  const email = (req.body?.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error_code: 'EMAIL_REQUIRED' });
  try {
    const invite = appUsers.createInvite({ email, globalRole: 'user', invitedBy: inviter });
    logger.info(`Self-Invite ausgestellt: ${email}`, { user: inviter });
    res.json({ invite });
  } catch (e) {
    logger.error(`Self-Invite: ${e.message}`, { user: inviter });
    res.status(500).json({ error_code: 'INVITE_FAILED', detail: e.message });
  }
});

module.exports = router;
