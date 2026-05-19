'use strict';
const express = require('express');
const appUsers = require('../db/app-users');
const { getUser, updateUserSettings } = appUsers;
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

const FIELDS = [
  { key: 'locale',            allowed: VALID_LOCALES,             label: 'locale' },
  { key: 'theme',             allowed: VALID_THEMES,              label: 'theme' },
  { key: 'default_buchtyp',   allowed: VALID_BUCHTYPEN,           label: 'default_buchtyp' },
  { key: 'default_language',  allowed: VALID_LANGUAGES,           label: 'default_language' },
  { key: 'default_region',    allowed: VALID_REGIONS,             label: 'default_region' },
  { key: 'focus_granularity', allowed: VALID_FOCUS_GRANULARITIES, label: 'focus_granularity' },
];

// app_users.language ist die Spalte; nach aussen heisst sie `locale` (API-Vertrag).
function toResponse(u) {
  if (!u) return null;
  return {
    email:             u.email,
    created_at:        u.created_at,
    last_login_at:     u.last_login_at,
    last_seen_at:      u.last_seen_at,
    locale:            u.language,
    theme:             u.theme,
    default_buchtyp:   u.default_buchtyp,
    default_language:  u.default_language,
    default_region:    u.default_region,
    focus_granularity: u.focus_granularity,
    role:              u.global_role || 'user',
    status:            u.status || 'active',
    can_invite_users:  u.can_invite_users ? 1 : 0,
    display_name:      u.display_name || null,
    model_override:    u.model_override || null,
  };
}

/** Aktuelles User-Profil samt Einstellungen + app_users-Identity. */
router.get('/settings', (req, res) => {
  const email = req.session.user.email;
  const user = getUser(email);
  if (!user) return res.status(404).json({ error_code: 'USER_PROFILE_NOT_FOUND' });
  res.json(toResponse(user));
});

/**
 * Email → Display-Name-Map fuer Anzeige in Revision-Listen, Tree-Toasts und
 * generelle „Wer hat editiert"-Hints. Nur active/invited User. Keine PII
 * ausserhalb dessen, was die Buch-Mitglieder ohnehin via book_access sehen.
 */
router.get('/users-light', (_req, res) => {
  const rows = appUsers.listUsers().filter(u => u.status === 'active' || u.status === 'invited');
  res.json({
    users: rows.map(u => ({ email: u.email, display_name: u.display_name || null })),
  });
});

// API-Key (extern) → app_users-Spaltenname (intern). `locale` mappt auf `language`.
const FIELD_TO_COLUMN = {
  locale:            'language',
  theme:             'theme',
  default_buchtyp:   'default_buchtyp',
  default_language:  'default_language',
  default_region:    'default_region',
  focus_granularity: 'focus_granularity',
};

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

  const merged = {};
  for (const { key } of FIELDS) {
    const col = FIELD_TO_COLUMN[key];
    if (body[key] === undefined)                     merged[col] = existing[col];
    else if (body[key] === '' || body[key] === null) merged[col] = null;
    else                                             merged[col] = body[key];
  }

  updateUserSettings(email, merged);
  res.json({ ok: true, ...toResponse(getUser(email)) });
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
