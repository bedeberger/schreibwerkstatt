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
  // ALTCHA-Proof-of-Work-Schutz fuer /register und den ENV-Admin-Login.
  // Self-hosted, kein Drittanbieter-Call. enabled=false = aus; harter
  // Rate-Limit (3/h/IP Register, 5/15min Admin-Login) bleibt unabhaengig
  // davon aktiv. Das HMAC-Secret (auth.altcha.hmac_secret) wird beim
  // Aktivieren automatisch generiert, falls noch leer.
  'auth.altcha.enabled':       false,
  // PoW-Schwierigkeit = obere Grenze der zu durchsuchenden Zahl. Hoeher =
  // mehr Browser-Rechenzeit pro Loesung (Bot-Kosten), aber traegere UX.
  'auth.altcha.complexity':    100000,
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
  // Anti-Loop: penalisiert kürzlich wiederholte Tokens und bricht so die
  // Wiederholungsschleifen, in die kleine Modelle bei grammar-constrained JSON
  // laufen (endloses Generieren identischer Array-Items bis zum Token-Cap).
  // 1.0 = aus; mild (1.1–1.2) reicht meist, ohne legitime Key-Wiederholung im
  // JSON zu schädigen.
  'ai.ollama.repeat_penalty':  1.15,
  // Reasoning/„Thinking" an/aus. Viele lokale Modelle (Qwen3, DeepSeek-R1-Distill,
  // Magistral …) denken per Default und verbrennen so Output-Tokens für eine
  // <think>-Spur, die wir verwerfen. false (Default) unterdrückt das via Ollama-
  // `think`-Flag; true lässt das Modell denken.
  'ai.ollama.think':           false,
  'ai.openai-compat.host':           'http://localhost:8080',
  'ai.openai-compat.model':          'llama3.2',
  'ai.openai-compat.temperature':    0.7,
  'ai.openai-compat.context_window': 32000,
  'ai.openai-compat.max_tokens_out': 16000,
  // Optionaler Bearer-Token für gehostete OpenAI-kompatible Endpoints (vLLM,
  // LiteLLM, OpenAI). Leer = kein Authorization-Header (lokale llama.cpp-Server).
  'ai.openai-compat.api_key':        '',
  // Anti-Loop für OpenAI-kompatible lokale Server, siehe ai.ollama.repeat_penalty.
  'ai.openai-compat.repeat_penalty': 1.15,
  // Reasoning/„Thinking" an/aus, siehe ai.ollama.think. false (Default) sendet
  // `chat_template_kwargs: { enable_thinking: false }` mit — der De-facto-Standard
  // für vLLM/SGLang/llama.cpp (Qwen3 & Co). Server ohne dieses Template-Kwarg
  // ignorieren es folgenlos. true sendet das Kwarg NICHT (Modell-Default, denkt
  // i.d.R.) — so bleibt auch echtes OpenAI, das unbekannte Felder ablehnt, nutzbar.
  'ai.openai-compat.think':          false,
  'ai.chat_temperature':       0.7,
  'ai.chars_per_token':        3,
  'ai.lektorat_batch_concurrency': 2,
  // Output-Token-Cap pro Komplettanalyse-Extraktions-Call (Phase 1: Single-Pass-
  // lokal sowie Multi-Pass Split-Pässe A/B). Basis-Versuch; bei Truncation eskaliert
  // der Job einmalig auf das Provider-Ceiling (`ai.<provider>.max_tokens_out`), statt
  // den Chunk zu verwerfen. Effektiv immer durch das Provider-Ceiling gedeckelt.
  'ai.komplett.extract_max_tokens': 16000,

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

  // Floor fuer page_revisions-Tiered-Retention: jueng­ste N Revisions pro Seite
  // werden zusaetzlich zum GFS-Bucket-Schema (Tag/Woche/Monat/Jahr) garantiert
  // behalten. Cleanup-Hook in lib/cache-cleanup.js → db/page-revisions.js#pruneTiered.
  // Range 1..500 (Validator + UI); Default 50.
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
  // Debounce-Zeit fuer den Spellcheck-Controller in den drei Editoren
  // (contenteditable). Nach jeder Eingabe wartet der Controller diese Spanne,
  // bevor er /languagetool/check ruft. Form-Felder (input/textarea) nutzen
  // eigene Defaults und sind hiervon unberuehrt.
  'languagetool.debounce_ms': 1500,

  // Speech-to-Text (self-hosted, OpenAI-kompatibler Whisper-Endpunkt).
  // enabled=true + host gesetzt blendet den Mic-Diktat-Button im Notebook-Editor
  // ein. Sprache loest der /stt/transcribe-Proxy pro Request aus der Buch-Locale
  // auf (SSoT wie LanguageTool); stt.language ist nur Fallback ohne Buchscope.
  // VAD-Schwellen steuern die browserseitige Sprechpausen-Segmentierung und
  // gehen ueber /config ins Frontend (VAD laeuft im Browser).
  'stt.enabled':            false,
  'stt.host':               '',
  'stt.model':              '',
  'stt.language':           'de',
  'stt.vad.silence_ms':     800,
  'stt.vad.threshold':      0.015,
  'stt.vad.max_segment_s':  30,

  // Geocoding (Orte-Karte). provider waehlt die Koordinaten-Quelle: OSM-Nominatim
  // (public oder self-hosted) oder Photon (Komoot, self-hosted). Die jeweilige
  // url-Setting zeigt auf die Instanz. Nominatim hat einen public Default;
  // Photon braucht zwingend eine eigene URL (leer = kein Geocoding-Vorschlag,
  // manueller Pin bleibt moeglich).
  'geocode.provider':      'nominatim',
  'geocode.nominatim.url': 'https://nominatim.openstreetmap.org/search',
  'geocode.photon.url':    '',
};

// Range-/Enum-Validation pro Key. `set()` wirft bei Verstoss
// `InvalidSettingValueError` — Admin-PUT-Route mappt das auf 400, andere Caller
// (env-bootstrap, Tests) loggen + skippen. Ranges decken sich mit der
// numInput-min/max-Spec im Admin-UI (public/partials/admin-settings.html);
// wer dort ein Limit aendert, zieht es hier mit.
//
// Bewusst nicht abgedeckt: freie String-Settings (URLs, Tokens, Hosts) —
// dort ist „leer = aus" valider Zustand, harte Pattern-Checks bringen wenig.
const VALIDATORS = {
  // Auth
  'auth.registration.expire_days':      { type: 'int',    min: 1,    max: 365   },
  'auth.altcha.complexity':             { type: 'int',    min: 1000, max: 5000000 },
  // SMTP
  'smtp.rate_limit_per_minute':         { type: 'int',    min: 1,    max: 500   },
  // Mail-Notify
  'mail.notify.job_fail_throttle_min':  { type: 'int',    min: 0,    max: 1440  },
  // KI
  'ai.provider':                        { type: 'enum',   oneOf: ['claude', 'ollama', 'openai-compat'] },
  'ai.claude.max_tokens_out':           { type: 'int',    min: 1024, max: 200000 },
  'ai.claude.context_window':           { type: 'int',    min: 8000, max: 2000000 },
  'ai.claude.retry_max':                { type: 'int',    min: 0,    max: 10    },
  'ai.claude.timeout_ms':               { type: 'int',    min: 1000, max: 3600000 },
  'ai.claude.phase1_concurrency':       { type: 'int',    min: 1,    max: 16    },
  'ai.ollama.temperature':              { type: 'number', min: 0,    max: 2     },
  'ai.ollama.context_window':           { type: 'int',    min: 2048, max: 2000000 },
  'ai.ollama.max_tokens_out':           { type: 'int',    min: 512,  max: 200000 },
  'ai.ollama.repeat_penalty':           { type: 'number', min: 1,    max: 2     },
  'ai.openai-compat.temperature':       { type: 'number', min: 0,    max: 2     },
  'ai.openai-compat.context_window':    { type: 'int',    min: 2048, max: 2000000 },
  'ai.openai-compat.max_tokens_out':    { type: 'int',    min: 512,  max: 200000 },
  'ai.openai-compat.repeat_penalty':    { type: 'number', min: 1,    max: 2     },
  'ai.chat_temperature':                { type: 'number', min: 0,    max: 2     },
  'ai.chars_per_token':                 { type: 'number', min: 1,    max: 10    },
  'ai.lektorat_batch_concurrency':      { type: 'int',    min: 1,    max: 8     },
  'ai.komplett.extract_max_tokens':     { type: 'int',    min: 1024, max: 200000 },
  // Jobs
  'jobs.max_concurrent':                { type: 'int',    min: 1,    max: 8     },
  'jobs.book_chat.mode':                { type: 'enum',   oneOf: ['auto', 'agent', 'classic'] },
  'jobs.book_chat.max_tool_iter':       { type: 'int',    min: 1,    max: 50    },
  'jobs.book_chat.token_budget':        { type: 'int',    min: 0,    max: 2000000 },
  // Cron / App
  'cron.stale_days':                    { type: 'int',    min: 1,    max: 365   },
  'app.page_revision_limit':            { type: 'int',    min: 1,    max: 500   },
  // PDF/A
  'pdfa.flavour':                       { type: 'enum',   oneOf: ['2b', '3b']   },
  // LanguageTool
  'languagetool.debounce_ms':           { type: 'int',    min: 200,  max: 10000 },
  // Speech-to-Text (VAD-Schwellen; Ranges deckungsgleich mit numInput im Admin-UI)
  'stt.vad.silence_ms':                 { type: 'int',    min: 200,  max: 5000  },
  'stt.vad.threshold':                  { type: 'number', min: 0,    max: 1     },
  'stt.vad.max_segment_s':              { type: 'int',    min: 5,    max: 120   },
  // Geocoding
  'geocode.provider':                   { type: 'enum',   oneOf: ['nominatim', 'photon'] },
};

class InvalidSettingValueError extends Error {
  constructor(key, reason) {
    super(`${key}: ${reason}`);
    this.name = 'InvalidSettingValueError';
    this.code = 'INVALID_VALUE';
    this.key = key;
    this.reason = reason;
  }
}

function _validate(key, value) {
  const v = VALIDATORS[key];
  if (!v) return;
  if (v.type === 'enum') {
    if (!v.oneOf.includes(value)) {
      throw new InvalidSettingValueError(key, `muss einer aus [${v.oneOf.join(', ')}] sein (got ${JSON.stringify(value)})`);
    }
    return;
  }
  if (v.type === 'int') {
    if (!Number.isInteger(value)) {
      throw new InvalidSettingValueError(key, `muss Integer sein (got ${JSON.stringify(value)})`);
    }
  } else if (v.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidSettingValueError(key, `muss Number sein (got ${JSON.stringify(value)})`);
    }
  }
  if (typeof v.min === 'number' && value < v.min) {
    throw new InvalidSettingValueError(key, `muss >= ${v.min} sein (got ${value})`);
  }
  if (typeof v.max === 'number' && value > v.max) {
    throw new InvalidSettingValueError(key, `muss <= ${v.max} sein (got ${value})`);
  }
}

// Welche Keys werden encrypted persistiert? `set()` darf das nicht selbst
// raten — Caller markiert explizit, weil ein vergessener `encrypted:true`-
// Flag Token-Klartext in der DB landen liesse.
const ENCRYPTED_KEYS = new Set([
  'auth.google.client_id',
  'auth.google.client_secret',
  'auth.altcha.hmac_secret',
  'ai.claude.api_key',
  'ai.openai-compat.api_key',
  'smtp.gmail.app_password',
  'stt.api_key',
]);

function isEncryptedKey(key) {
  return ENCRYPTED_KEYS.has(key);
}

// Bekannter Key = hat einen Hardcoded-Default ODER ist ein (defaultloser)
// Encrypted-Key. Die Admin-PUT-Route lehnt unbekannte Keys ab, damit Tippfehler
// nicht stillschweigend als toter Eintrag in app_settings landen.
function isKnownKey(key) {
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key) || ENCRYPTED_KEYS.has(key);
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
  _validate(key, value);
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
  ['OPENAI_COMPAT_HOST',        'ai.openai-compat.host',        v => String(v)],
  ['OPENAI_COMPAT_MODEL',       'ai.openai-compat.model',       v => String(v)],
  ['OPENAI_COMPAT_TEMPERATURE', 'ai.openai-compat.temperature', v => parseFloat(v)],
  ['OPENAI_COMPAT_API_KEY',     'ai.openai-compat.api_key',     v => String(v)],
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
  ['GEOCODE_PROVIDER',    'geocode.provider',           v => String(v).toLowerCase()],
  ['NOMINATIM_URL',       'geocode.nominatim.url',      v => String(v)],
  ['PHOTON_URL',          'geocode.photon.url',         v => String(v)],
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
  isEncryptedKey, isKnownKey, ENCRYPTED_KEYS, DEFAULTS,
  bootstrapFromEnv, ENV_MAP,
  VALIDATORS, InvalidSettingValueError,
};
