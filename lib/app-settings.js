'use strict';
// Single Source of Truth fuer Runtime-Configs. Konsumenten lesen Werte ueber get(key) und reagieren
// optional auf das 'changed'-Event, wenn der Admin per PUT etwas aendert.
//
// Auflösung:
//   1. DB-Setting (app_settings)
//   2. Hardcoded Default (DEFAULTS)
// Kein ENV-Fallback fuer migrierte Keys — `.env` ist fuer diese Keys tot.
// Boot-Layer-Werte (PORT, DB_PATH, SESSION_SECRET, ADMIN_EMAIL,
// ADMIN_PASSWORD, TZ, LOG_LEVEL, LOCAL_DEV_MODE, VERAPDF_BIN) bleiben in ENV.

const { EventEmitter } = require('events');
const { db } = require('../db/connection');
require('../db/migrations');
const { NOW_ISO_SQL } = require('../db/now');
const { encrypt, decrypt, isEncrypted } = require('./crypto');
const logger = require('../logger');

const events = new EventEmitter();

// Pro Server-Boot Memory-Cache; Invalidierung via set() + clearCache().
const _cache = new Map();

// Hardcoded Defaults. Werte sind nicht-sensitiv (keine API-Keys, keine Tokens).
// Bei migrierten Keys greift der Default, solange `app_settings` keine Row hat.
const DEFAULTS = {
  // Auth
  'auth.allow_open_signup':    false,
  // hCaptcha-Schutz fuer /register. Leer = Captcha aus; harter
  // Rate-Limit (3/h/IP) bleibt unabhaengig davon aktiv.
  'auth.captcha.site_key':     '',
  'auth.captcha.secret_key':   '',
  // Maximalalter pending-Anfragen; Cron setzt sie danach auf
  // 'expired' (DB-Status). Default 30 Tage analog spec.
  'auth.registration.expire_days': 30,

  // SMTP (Gmail-App-Password). Pflichtfelder fuer Mailer-Aktivierung sind
  // `smtp.gmail.user` + `smtp.gmail.app_password`. Defaults leer, damit das
  // Admin-Settings-UI die Keys auch ohne bestehende DB-Row rendert (sonst
  // greift der `if (!s) continue`-Guard im Save-Pfad).
  'smtp.gmail.user':           '',
  'smtp.gmail.app_password':   '',
  'smtp.from_name':            'Schreibwerkstatt',
  'smtp.reply_to':             '',
  'smtp.rate_limit_per_minute': 30,

  // Notification-Mails (Job-Crash, Token-Cap, Budget-Overrun).
  // Master-Toggles je Pfad; Throttle deduped Crash-/Token-Cap-Mails
  // pro {type,errorPrefix} fuer N Minuten. skip_errors blockiert genannte
  // i18n-Keys (Komma-Liste); leer = Defaults aus lib/notify.js.
  'mail.notify.admin_on_job_fail':        true,
  'mail.notify.admin_on_token_cap':       true,
  'mail.notify.user_on_budget_overrun':   true,
  'mail.notify.admin_on_budget_overrun':  true,
  'mail.notify.job_fail_throttle_min':    60,
  'mail.notify.skip_errors':              'job.cancelled,BUDGET_EXCEEDED,job.error.aiTruncated,job.error.parseFailed,job.error.aiInvalidJson',
  // Forward-Adresse fuer Admin-Notifications. Leer = an alle aktiven Admin-User
  // (global_role='admin'). Gesetzt = ersetzt diese Liste komplett, sodass
  // Mails an eine Adresse gehen, die nicht zwingend einem Admin-Account
  // entspricht.
  'mail.notify.admin_recipient':          '',

  // KI-Provider
  'ai.provider':               'claude',
  'ai.claude.model':           'claude-sonnet-4-6',
  'ai.claude.max_tokens_out':  64000,
  'ai.claude.context_window':  200000,
  'ai.claude.retry_max':       3,
  'ai.claude.timeout_ms':      600000,
  'ai.claude.phase1_concurrency': 4,
  'ai.ollama.host':            'http://localhost:11434',
  'ai.ollama.model':           'llama3.2',
  'ai.ollama.temperature':     0.7,
  'ai.ollama.context_window':  32000,
  'ai.ollama.max_tokens_out':  16000,
  'ai.llama.host':             'http://localhost:8080',
  'ai.llama.model':            'llama3.2',
  'ai.llama.temperature':      0.7,
  'ai.llama.context_window':   32000,
  'ai.llama.max_tokens_out':   16000,
  'ai.chat_temperature':       0.7,
  'ai.chars_per_token':        3,
  'ai.lektorat_batch_concurrency': 2,

  // Jobs / Buch-Chat
  'jobs.max_concurrent':       1,
  'jobs.book_chat.mode':       'auto',
  'jobs.book_chat.max_tool_iter': 12,
  'jobs.book_chat.token_budget':  0,

  // Cron / Sync
  // app.timezone gilt fuer Cron, Server-Datums-Buckets (lib/local-date.js)
  // und Frontend-Display-Formatter (toLocaleString, Intl.DateTimeFormat).
  // Single Source of Truth — Browser-TZ wird ueberschrieben.
  'app.timezone':              'Europe/Zurich',
  'cron.stale_days':           7,

  // PDF/A
  'pdfa.flavour':              '2b',
  'pdfa.disabled':             false,

  // App-Name fuer Startup-Log, Mail-Templates etc.
  'app.name':                  'Schreibwerkstatt',

  // Storage-Backend
  'app.backend':               'bookstack',

  // Source-Read-Only-Marker fuer Backend-Migration. Wert = Name des
  // Backends, dessen Writes blockiert werden ('bookstack' | 'localdb'); leerer
  // String = aus. Content-Store-Facade wirft 423 LOCKED, wenn currentBackend()
  // mit dem Marker uebereinstimmt. Bleibt nach Cutover gesetzt als
  // Rollback-Sperre.
  'app.migrate.source_readonly': '',

  // Floor fuer page_revisions-Tiered-Retention: jueng­ste N Revisions pro Seite
  // werden zusaetzlich zum GFS-Bucket-Schema (Tag/Woche/Monat/Jahr) garantiert
  // behalten. Cleanup-Hook in lib/cache-cleanup.js → db/page-revisions.js#pruneTiered.
  // Range 10..500; Default 50.
  'app.page_revision_limit':   50,

  // Öffentliche Basis-URL der App (ohne Slash am Ende). Wird für OIDC-Callback,
  // Invite-Mails und Share-Links genutzt. Admin-Pflicht: leer = OIDC-Login und
  // Invite-Versand nicht möglich; LOCAL_DEV_MODE fällt auf http://localhost:PORT.
  'app.public_url':            '',

  // Plausible-Analytics (self-hosted). enabled=false → kein Tracking, kein
  // CSP-Eintrag. script_url ist die volle URL zum Bootstrap-JS, z.B.
  // https://analytics.example.com/js/pa-XXXX.js — Origin wird daraus
  // abgeleitet und in CSP scriptSrc/connectSrc aufgenommen.
  'analytics.plausible.enabled':    false,
  'analytics.plausible.script_url': '',

  // LanguageTool (self-hosted, regelbasierte Rechtschreib-/Grammatikpruefung).
  // enabled=true + url gesetzt aktiviert Overlay-Spellcheck in allen Editoren
  // und deaktiviert Browser-Spellcheck. Picky-Mode aktiviert zusaetzliche
  // Stil-Regeln.
  'languagetool.enabled': false,
  'languagetool.url':     '',
  'languagetool.picky':   false,
};

// Welche Keys werden encrypted persistiert? `set()` darf das nicht selbst
// raten — Caller markiert explizit, weil ein vergessener `encrypted:true`-
// Flag Token-Klartext in der DB landen liesse.
const ENCRYPTED_KEYS = new Set([
  'auth.google.client_id',
  'auth.google.client_secret',
  'auth.captcha.secret_key',
  'ai.claude.api_key',
  'smtp.gmail.app_password',
]);

function isEncryptedKey(key) {
  return ENCRYPTED_KEYS.has(key);
}

const _stmtGet = db.prepare('SELECT value_json, encrypted FROM app_settings WHERE key = ?');
const _stmtList = db.prepare('SELECT key, value_json, encrypted, updated_at, updated_by FROM app_settings ORDER BY key');
const _stmtUpsert = db.prepare(`
  INSERT INTO app_settings (key, value_json, encrypted, updated_at, updated_by)
  VALUES (@key, @value_json, @encrypted, ${NOW_ISO_SQL}, @updated_by)
  ON CONFLICT(key) DO UPDATE SET
    value_json = excluded.value_json,
    encrypted  = excluded.encrypted,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
`);
const _stmtDelete = db.prepare('DELETE FROM app_settings WHERE key = ?');
const _stmtAuditInsert = db.prepare(`
  INSERT INTO app_settings_audit (key, old_hash, new_hash, updated_by, updated_at)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})
`);

function _readFromDb(key) {
  const row = _stmtGet.get(key);
  if (!row) return undefined;
  let raw = row.value_json;
  if (row.encrypted) {
    try { raw = decrypt(raw); }
    catch (e) {
      logger.error(`app-settings: Decrypt-Fehler fuer ${key}: ${e.message}`);
      return undefined;
    }
  }
  try { return JSON.parse(raw); }
  catch (e) {
    logger.error(`app-settings: JSON-Parse-Fehler fuer ${key}: ${e.message}`);
    return undefined;
  }
}

function get(key) {
  if (_cache.has(key)) return _cache.get(key);
  const fromDb = _readFromDb(key);
  const value = fromDb !== undefined ? fromDb : (DEFAULTS[key] !== undefined ? DEFAULTS[key] : undefined);
  _cache.set(key, value);
  return value;
}

function has(key) {
  return _readFromDb(key) !== undefined;
}

function set(key, value, { updatedBy = 'system' } = {}) {
  const encrypted = isEncryptedKey(key);
  // Sentinel `__unchanged__` fuer Encrypted-Felder: nicht ueberschreiben.
  if (encrypted && value === '__unchanged__') return get(key);
  const json = JSON.stringify(value);
  const stored = encrypted && typeof value === 'string' ? encrypt(json) : json;
  // Audit: SHA-256-Hash beider Werte. Klartext-Secrets nie in der Audit-Tabelle.
  const crypto = require('crypto');
  const oldRaw = _readFromDb(key);
  const oldHash = oldRaw === undefined ? null : crypto.createHash('sha256').update(JSON.stringify(oldRaw)).digest('hex').slice(0, 16);
  const newHash = crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
  _stmtUpsert.run({
    key,
    value_json: stored,
    encrypted: encrypted ? 1 : 0,
    updated_by: updatedBy,
  });
  _stmtAuditInsert.run(key, oldHash, newHash, updatedBy);
  _cache.delete(key);
  events.emit('changed', { key, updatedBy });
  return value;
}

function remove(key, { updatedBy = 'system' } = {}) {
  _stmtDelete.run(key);
  _cache.delete(key);
  events.emit('changed', { key, removed: true, updatedBy });
}

// Liste fuer Admin-UI: encrypted-Werte werden maskiert (letzte 4 Zeichen
// sichtbar, falls vorhanden — sonst Sentinel "***").
function listForAdmin() {
  const rows = _stmtList.all();
  const map = new Map(rows.map(r => [r.key, r]));
  const allKeys = new Set([...rows.map(r => r.key), ...Object.keys(DEFAULTS)]);
  const out = [];
  for (const key of [...allKeys].sort()) {
    const row = map.get(key);
    const encrypted = row?.encrypted ? 1 : (isEncryptedKey(key) ? 1 : 0);
    let value;
    let masked = null;
    if (row) {
      let raw = row.value_json;
      if (row.encrypted) {
        try {
          const dec = decrypt(raw);
          const parsed = JSON.parse(dec);
          masked = typeof parsed === 'string' && parsed.length > 4
            ? '***' + parsed.slice(-4)
            : '***';
          value = '__masked__';
        } catch { value = '__masked__'; masked = '***'; }
      } else {
        try { value = JSON.parse(raw); } catch { value = raw; }
      }
    } else {
      value = DEFAULTS[key];
    }
    out.push({
      key,
      value,
      masked,
      encrypted,
      isDefault: !row,
      updated_at: row?.updated_at || null,
      updated_by: row?.updated_by || null,
    });
  }
  return out;
}

function clearCache() {
  _cache.clear();
}

function on(event, fn) {
  events.on(event, fn);
}

function off(event, fn) {
  events.off(event, fn);
}

// ENV → DB Bootstrap. Beim Server-Start einmalig: fuer jeden ENV-Key, der
// noch nicht in der DB liegt, Wert aus process.env in app_settings spiegeln.
// Damit Admins beim ersten 4c-Lauf nicht alles in der UI nachpflegen muessen.
// Keine Ueberschreibung bestehender DB-Werte — ENV ist nur „Erstbefuellung".
// Spaeter koennen die ENV-Reads in den Konsumenten ersatzlos entfernt werden.
const ENV_MAP = [
  // [envVar, key, transform]
  ['API_PROVIDER',        'ai.provider',                v => String(v).toLowerCase()],
  ['ANTHROPIC_API_KEY',   'ai.claude.api_key',          v => String(v)],
  ['MODEL_NAME',          'ai.claude.model',            v => String(v)],
  ['MODEL_TOKEN',         'ai.claude.max_tokens_out',   v => parseInt(v, 10)],
  ['MODEL_CONTEXT',       'ai.claude.context_window',   v => parseInt(v, 10)],
  ['CHARS_PER_TOKEN',     'ai.chars_per_token',         v => parseFloat(v)],
  ['OLLAMA_HOST',         'ai.ollama.host',             v => String(v)],
  ['OLLAMA_MODEL',        'ai.ollama.model',            v => String(v)],
  ['OLLAMA_TEMPERATURE',  'ai.ollama.temperature',      v => parseFloat(v)],
  ['LLAMA_HOST',          'ai.llama.host',              v => String(v)],
  ['LLAMA_MODEL',         'ai.llama.model',             v => String(v)],
  ['LLAMA_TEMPERATURE',   'ai.llama.temperature',       v => parseFloat(v)],
  ['CHAT_TEMPERATURE',    'ai.chat_temperature',        v => parseFloat(v)],
  ['CLAUDE_RETRY_MAX',    'ai.claude.retry_max',        v => parseInt(v, 10)],
  ['CLAUDE_TIMEOUT_MS',   'ai.claude.timeout_ms',       v => parseInt(v, 10)],
  ['CLAUDE_PHASE1_CONCURRENCY', 'ai.claude.phase1_concurrency', v => parseInt(v, 10)],
  ['LEKTORAT_BATCH_CONCURRENCY', 'ai.lektorat_batch_concurrency', v => parseInt(v, 10)],
  ['MAX_CONCURRENT_JOBS', 'jobs.max_concurrent',        v => parseInt(v, 10)],
  ['BOOK_CHAT_MODE',      'jobs.book_chat.mode',        v => String(v)],
  ['BOOK_CHAT_MAX_TOOL_ITER', 'jobs.book_chat.max_tool_iter', v => parseInt(v, 10)],
  ['BOOK_CHAT_TOKEN_BUDGET',  'jobs.book_chat.token_budget',  v => parseInt(v, 10)],
  ['CRON_TIMEZONE',       'app.timezone',               v => String(v)],
  ['TZ',                  'app.timezone',               v => String(v)],
  ['STALE_DAYS',          'cron.stale_days',            v => parseInt(v, 10)],
  ['VERAPDF_FLAVOUR',     'pdfa.flavour',               v => String(v)],
  ['VERAPDF_DISABLED',    'pdfa.disabled',              v => v === 'true' || v === '1'],
  ['GOOGLE_CLIENT_ID',    'auth.google.client_id',      v => String(v)],
  ['GOOGLE_CLIENT_SECRET','auth.google.client_secret',  v => String(v)],
  ['ALLOW_OPEN_SIGNUP',   'auth.allow_open_signup',     v => v === 'true' || v === '1'],
  ['APP_URL',             'app.public_url',             v => String(v).replace(/\/$/, '')],
];

function bootstrapFromEnv() {
  let mirrored = 0;
  for (const [envVar, key, transform] of ENV_MAP) {
    if (has(key)) continue;
    const raw = process.env[envVar];
    if (raw === undefined || raw === '') continue;
    let value;
    try { value = transform(raw); }
    catch (e) {
      logger.warn(`app-settings: bootstrap ${envVar}→${key} transform failed: ${e.message}`);
      continue;
    }
    if (typeof value === 'number' && Number.isNaN(value)) continue;
    try {
      set(key, value, { updatedBy: 'env-bootstrap' });
      mirrored++;
    } catch (e) {
      logger.warn(`app-settings: bootstrap ${envVar}→${key} write failed: ${e.message}`);
    }
  }
  if (mirrored > 0) logger.info(`app-settings: ${mirrored} ENV-Wert(e) initial in DB gespiegelt.`);
  return mirrored;
}

module.exports = {
  get, has, set, remove,
  listForAdmin, clearCache,
  on, off,
  isEncryptedKey, ENCRYPTED_KEYS, DEFAULTS,
  bootstrapFromEnv, ENV_MAP,
};
