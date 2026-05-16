'use strict';
// Phase 4c (BookStack-Exit, docs/bookstack-exit.md): Single Source of Truth
// fuer Runtime-Configs. Konsumenten lesen Werte ueber get(key) und reagieren
// optional auf das 'changed'-Event, wenn der Admin per PUT etwas aendert.
//
// Auflösung:
//   1. DB-Setting (app_settings)
//   2. Hardcoded Default (DEFAULTS)
// Kein ENV-Fallback fuer migrierte Keys — `.env` ist fuer diese Keys tot.
// Boot-Layer-Werte (PORT, DB_PATH, APP_URL, SESSION_SECRET, ADMIN_EMAIL,
// ADMIN_PASSWORD, TZ, LOG_LEVEL, LOCAL_DEV_MODE, VERAPDF_BIN) bleiben in ENV.

const { EventEmitter } = require('events');
const { db } = require('../db/connection');
const { encrypt, decrypt, isEncrypted } = require('./crypto');
const logger = require('../logger');

const events = new EventEmitter();

// Pro Server-Boot Memory-Cache; Invalidierung via set() + clearCache().
const _cache = new Map();

// Hardcoded Defaults. Werte sind nicht-sensitiv (keine API-Keys, keine Tokens).
// Bei migrierten Keys greift der Default, solange `app_settings` keine Row hat.
const DEFAULTS = {
  // Auth
  'auth.allowed_emails':       '',        // CSV — Whitelist; leer = alle eingeladenen User
  'auth.allow_open_signup':    false,

  // KI-Provider
  'ai.provider':               'claude',
  'ai.claude.model':           'claude-sonnet-4-6',
  'ai.claude.max_tokens_out':  64000,
  'ai.claude.context_window':  200000,
  'ai.claude.retry_max':       3,
  'ai.claude.timeout_ms':      300000,
  'ai.claude.phase1_concurrency': 4,
  'ai.ollama.host':            'http://localhost:11434',
  'ai.ollama.model':           'llama3.2',
  'ai.ollama.temperature':     0.7,
  'ai.llama.host':             'http://localhost:8080',
  'ai.llama.model':            'llama3.2',
  'ai.llama.temperature':      0.7,
  'ai.chat_temperature':       0.7,
  'ai.chars_per_token':        3,
  'ai.lektorat_batch_concurrency': 2,

  // Jobs / Buch-Chat
  'jobs.max_concurrent':       1,
  'jobs.book_chat.mode':       'auto',
  'jobs.book_chat.max_tool_iter': 12,
  'jobs.book_chat.token_budget':  0,

  // Cron / Sync
  'cron.timezone':             'Europe/Zurich',
  'cron.stale_days':           7,

  // PDF/A
  'pdfa.flavour':              '2b',
  'pdfa.disabled':             false,

  // Storage-Backend (vorbereitet — Phase 1 schaltet localdb scharf)
  'app.backend':               'bookstack',
  'app.setup_completed':       false,
};

// Welche Keys werden encrypted persistiert? `set()` darf das nicht selbst
// raten — Caller markiert explizit, weil ein vergessener `encrypted:true`-
// Flag Token-Klartext in der DB landen liesse.
const ENCRYPTED_KEYS = new Set([
  'auth.google.client_id',
  'auth.google.client_secret',
  'ai.claude.api_key',
  'app.bookstack.token_id',
  'app.bookstack.token_secret',
  'smtp.gmail.client_id',
  'smtp.gmail.client_secret',
  'smtp.gmail.refresh_token',
  'smtp.gmail.app_password',
  'smtp.password',
]);

function isEncryptedKey(key) {
  return ENCRYPTED_KEYS.has(key);
}

const _stmtGet = db.prepare('SELECT value_json, encrypted FROM app_settings WHERE key = ?');
const _stmtList = db.prepare('SELECT key, value_json, encrypted, updated_at, updated_by FROM app_settings ORDER BY key');
const _stmtUpsert = db.prepare(`
  INSERT INTO app_settings (key, value_json, encrypted, updated_at, updated_by)
  VALUES (@key, @value_json, @encrypted, datetime('now'), @updated_by)
  ON CONFLICT(key) DO UPDATE SET
    value_json = excluded.value_json,
    encrypted  = excluded.encrypted,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
`);
const _stmtDelete = db.prepare('DELETE FROM app_settings WHERE key = ?');
const _stmtAuditInsert = db.prepare(`
  INSERT INTO app_settings_audit (key, old_hash, new_hash, updated_by)
  VALUES (?, ?, ?, ?)
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
  ['LEKTORAT_BATCH_CONCURRENCY', 'ai.lektorat_batch_concurrency', v => parseInt(v, 10)],
  ['MAX_CONCURRENT_JOBS', 'jobs.max_concurrent',        v => parseInt(v, 10)],
  ['BOOK_CHAT_MODE',      'jobs.book_chat.mode',        v => String(v)],
  ['BOOK_CHAT_MAX_TOOL_ITER', 'jobs.book_chat.max_tool_iter', v => parseInt(v, 10)],
  ['BOOK_CHAT_TOKEN_BUDGET',  'jobs.book_chat.token_budget',  v => parseInt(v, 10)],
  ['CRON_TIMEZONE',       'cron.timezone',              v => String(v)],
  ['STALE_DAYS',          'cron.stale_days',            v => parseInt(v, 10)],
  ['VERAPDF_FLAVOUR',     'pdfa.flavour',               v => String(v)],
  ['VERAPDF_DISABLED',    'pdfa.disabled',              v => v === 'true' || v === '1'],
  ['GOOGLE_CLIENT_ID',    'auth.google.client_id',      v => String(v)],
  ['GOOGLE_CLIENT_SECRET','auth.google.client_secret',  v => String(v)],
  ['ALLOWED_EMAILS',      'auth.allowed_emails',        v => String(v)],
  ['ALLOW_OPEN_SIGNUP',   'auth.allow_open_signup',     v => v === 'true' || v === '1'],
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
