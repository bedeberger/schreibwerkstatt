'use strict';
const express = require('express');
const appUsers = require('../db/app-users');
const { getUser, updateUserSettings } = appUsers;
const deviceTokens = require('../db/device-tokens');
const { db } = require('../db/schema');
const { listBookIdsForUser } = require('../db/book-access');
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
 * Aggregierte Schreib-Statistik ueber ALLE eigenen Buecher (role='owner').
 * Inhalts-Kennzahlen (chars/words/tok/pages) live aus `page_stats` — gleiche
 * Quelle wie admin-books, frischer als der Tages-Snapshot. Kapitel-Anzahl aus
 * dem letzten `book_stats_history`-Snapshot pro Buch (taeglich synchronisiert).
 * Schreibzeit aus `writing_time` (per-User). `page_stats`/`book_stats_history`/
 * `writing_time` sind Cache-/Aggregat-Tabellen (kein Content-Store-Verstoss).
 */
router.get('/profile-stats', (req, res) => {
  const email = req.session.user.email;
  const owned = listBookIdsForUser(email)
    .filter(r => r.role === 'owner')
    .map(r => r.book_id);
  const empty = { books: 0, chapters: 0, pages: 0, chars: 0, words: 0, unique_words: 0, tok: 0, writing_seconds: 0 };
  if (!owned.length) return res.json(empty);
  try {
    const ph = owned.map(() => '?').join(',');
    const content = db.prepare(`
      SELECT COALESCE(SUM(chars), 0) AS chars,
             COALESCE(SUM(words), 0) AS words,
             COALESCE(SUM(tok),   0) AS tok,
             COUNT(*)                AS pages
      FROM page_stats WHERE book_id IN (${ph})
    `).get(...owned);
    // Letzter Snapshot pro Buch (MAX(recorded_at)) — daraus chapter_count +
    // unique_words summieren (Wortschatz; ueber Buecher summiert = Naeherung,
    // gleiche Konvention wie chars).
    const snap = db.prepare(`
      SELECT COALESCE(SUM(bsh.chapter_count), 0) AS chapters,
             COALESCE(SUM(bsh.unique_words), 0)  AS unique_words
      FROM book_stats_history bsh
      JOIN (
        SELECT book_id, MAX(recorded_at) AS mx
        FROM book_stats_history WHERE book_id IN (${ph}) GROUP BY book_id
      ) m ON m.book_id = bsh.book_id AND m.mx = bsh.recorded_at
    `).get(...owned);
    const wt = db.prepare(`
      SELECT COALESCE(SUM(seconds), 0) AS writing_seconds
      FROM writing_time WHERE user_email = ? AND book_id IN (${ph})
    `).get(email, ...owned);
    res.json({
      books:           owned.length,
      chapters:        snap?.chapters || 0,
      pages:           content?.pages || 0,
      chars:           content?.chars || 0,
      words:           content?.words || 0,
      unique_words:    snap?.unique_words || 0,
      tok:             content?.tok || 0,
      writing_seconds: wt?.writing_seconds || 0,
    });
  } catch (e) {
    logger.error('[me/profile-stats] DB-Fehler: ' + e.message, { user: email });
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

/**
 * Tages-Zeitreihe fuer den Entwicklungs-Chart — pro Buch aufgeschluesselt.
 * `history`: book_stats_history-Rows aller eigenen Buecher (eine pro (book_id,
 * Tag)). Das Frontend baut daraus sowohl die Gesamt-Kurve (Summe pro Tag) als
 * auch die Pro-Buch-Linien; Buchnamen kommen aus der bereits geladenen
 * Root-Buchliste (kein books-Query hier → Content-Store-Regel).
 * `writing`: Schreib-Sekunden pro (book_id, Tag) (nur aktive Tage).
 */
router.get('/profile-stats-history', (req, res) => {
  const email = req.session.user.email;
  const owned = listBookIdsForUser(email)
    .filter(r => r.role === 'owner')
    .map(r => r.book_id);
  if (!owned.length) return res.json({ history: [], writing: [] });
  try {
    const ph = owned.map(() => '?').join(',');
    const history = db.prepare(`
      SELECT book_id, recorded_at, chars, words, tok, page_count, chapter_count, unique_words
      FROM book_stats_history WHERE book_id IN (${ph})
      ORDER BY recorded_at ASC
    `).all(...owned);
    const writing = db.prepare(`
      SELECT book_id, date, seconds
      FROM writing_time WHERE user_email = ? AND book_id IN (${ph}) AND seconds > 0
      ORDER BY date ASC
    `).all(email, ...owned);
    res.json({ history, writing });
  } catch (e) {
    logger.error('[me/profile-stats-history] DB-Fehler: ' + e.message, { user: email });
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

/**
 * Email → Display-Name-Map fuer Anzeige in Revision-Listen, Tree-Toasts und
 * generelle „Wer hat editiert"-Hints. Nur active/invited User. Keine PII
 * ausserhalb dessen, was die Buch-Mitglieder ohnehin via book_access sehen.
 */
router.get('/users-light', (_req, res) => {
  const rows = appUsers.listUsers().filter(u => u.status === 'active' || u.status === 'invited');
  res.json({
    users: rows.map(u => ({ email: u.email, display_name: u.display_name || null, global_role: u.global_role || null })),
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

// ── Device-Tokens (native Clients, z.B. Mac-Focus-Writer) ────────────────────
// Per-User-Bearer-Token. Klartext verlaesst den Server NUR einmal in der
// Create-Response; danach existiert in der DB ausschliesslich der Hash.

/** Liste der Device-Tokens des eingeloggten Users (ohne Klartext). */
router.get('/device-tokens', (req, res) => {
  const email = req.session.user.email;
  res.json({ tokens: deviceTokens.listDeviceTokens(email) });
});

/** Neuen Device-Token ausstellen. Body: { device_name, platform? }.
 *  Antwort enthaelt `plain_token` — wird nie wieder ausgegeben. */
router.post('/device-tokens', jsonBody, (req, res) => {
  const email = req.session.user.email;
  // Device-Tokens duerfen nicht selbst ueber ein Device-Token ausgestellt werden
  // (kein Self-Minting offline): nur echte interaktive Sessions.
  if (req.session.user.via === 'device_token') {
    return res.status(403).json({ error_code: 'DEVICE_TOKEN_SELF_MINT_FORBIDDEN' });
  }
  const deviceName = String(req.body?.device_name || '').trim();
  if (!deviceName) return res.status(400).json({ error_code: 'DEVICE_NAME_REQUIRED' });
  const platform = req.body?.platform ? String(req.body.platform).trim() : null;
  try {
    const tok = deviceTokens.createDeviceToken({ userEmail: email, deviceName, platform });
    logger.info(`Device-Token ausgestellt: "${tok.device_name}"`, { user: email });
    res.json({ token: tok });
  } catch (e) {
    logger.error(`Device-Token create: ${e.message}`, { user: email });
    res.status(500).json({ error_code: 'DEVICE_TOKEN_CREATE_FAILED', detail: e.message });
  }
});

/** Device-Token widerrufen (Soft-Revoke, sofort ungueltig). */
router.post('/device-tokens/:id/revoke', (req, res) => {
  const email = req.session.user.email;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error_code: 'INVALID_ID' });
  const ok = deviceTokens.revokeDeviceToken(id, email);
  if (!ok) return res.status(404).json({ error_code: 'TOKEN_NOT_FOUND' });
  logger.info(`Device-Token widerrufen (id=${id})`, { user: email });
  res.json({ ok: true });
});

/** Device-Token endgueltig loeschen. */
router.delete('/device-tokens/:id', (req, res) => {
  const email = req.session.user.email;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error_code: 'INVALID_ID' });
  const ok = deviceTokens.deleteDeviceToken(id, email);
  if (!ok) return res.status(404).json({ error_code: 'TOKEN_NOT_FOUND' });
  logger.info(`Device-Token geloescht (id=${id})`, { user: email });
  res.json({ ok: true });
});

module.exports = router;
