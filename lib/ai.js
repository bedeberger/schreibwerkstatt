'use strict';
// Gemeinsamer KI-Aufruf-Helfer – wird von routes/jobs.js und routes/figures.js importiert.
// Gibt { text, tokensIn, tokensOut } zurück.
// onProgress({ chars, tokIn }): optionaler Callback während des Streamings

const fsp = require('fs/promises');
const path = require('path');
const { jsonrepair } = require('jsonrepair');
const logger = require('../logger');
const appSettings = require('./app-settings');
const { getContext } = require('./log-context');

const VALID_PROVIDERS = new Set(['claude', 'ollama', 'llama']);

// Per-User-Provider-Resolution. Reihenfolge:
//   1. app_users.ai_provider_override (NULL = follows global)
//   2. app_settings.ai.provider
//   3. Hardcoded 'claude'
// userEmail wird ueblicherweise via ALS-Context aus dem Job/Request gezogen
// (siehe routes/jobs/shared/queue.js#runWithContext). Lazy-require auf db/app-users,
// damit lib/ai.js auch in Pre-Migration-Pfaden (Tests) ladbar bleibt.
function _globalProvider() {
  const v = String(appSettings.get('ai.provider') || 'claude').toLowerCase();
  return VALID_PROVIDERS.has(v) ? v : 'claude';
}

function _userOverride(email) {
  if (!email) return null;
  try {
    const appUsers = require('../db/app-users');
    const u = appUsers.getUser(email);
    if (!u || !u.ai_provider_override) return null;
    const v = String(u.ai_provider_override).toLowerCase();
    return VALID_PROVIDERS.has(v) ? v : null;
  } catch { return null; }
}

function resolveProvider({ userEmail } = {}) {
  const email = userEmail || getContext().user || null;
  return _userOverride(email) || _globalProvider();
}

// Nach N Dateien in ai_parse_fails/ werden die ältesten gelöscht – sonst wächst
// das Verzeichnis unbegrenzt, weil lokale Modelle oft identische Drifts produzieren.
const PARSE_FAILS_MAX = 50;

async function _rotateParseFails(dir) {
  try {
    const entries = await fsp.readdir(dir);
    if (entries.length <= PARSE_FAILS_MAX) return;
    const stats = await Promise.all(entries.map(async name => ({
      name, mtimeMs: (await fsp.stat(path.join(dir, name))).mtimeMs,
    })));
    stats.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const victims = stats.slice(0, entries.length - PARSE_FAILS_MAX);
    await Promise.all(victims.map(v => fsp.unlink(path.join(dir, v.name)).catch(() => {})));
  } catch { /* best-effort */ }
}

async function _dumpParseFail(clean, pos) {
  const dir = path.resolve(__dirname, '..', 'ai_parse_fails');
  try {
    await fsp.mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fp = path.join(dir, `${ts}.txt`);
    await fsp.writeFile(fp, clean, 'utf8');
    logger.error(`JSON-Parse-Fehler: Rohtext (${clean.length} chars, pos=${pos}) nach ${fp} geschrieben.`);
    _rotateParseFails(dir); // fire-and-forget
  } catch (writeErr) {
    logger.warn(`Konnte Rohtext nicht in ai_parse_fails/ schreiben: ${writeErr.message}`);
  }
}

// Durchschnittliche Zeichen pro Token – bestimmt die Umrechnung zwischen Text-Länge
// und Token-Budget. Tokenizer-abhängig: Claude komprimiert deutschen Text effizient
// (~3 chars/token); moderne SentencePiece-Tokenizer von Mistral/Llama liegen bei
// ~4 chars/token auf deutschem Fliesstext (gemessen an Mistral-Small3.2). Falscher
// Wert → Input-Budget grob unter-/überschätzt → entweder 400-Fehler vom Provider
// oder massiv unterausgelasteter Kontext. Admin-Setting `ai.chars_per_token` für
// Modelle mit abweichendem Tokenizer.
// Boot-frozen: Budget-Ableitungen (SINGLE_PASS_LIMIT etc.) lesen den Wert beim
// Modul-Load anderer Files. Admin-PUT erfordert App-Restart.
const _PROVIDER = String(appSettings.get('ai.provider') || 'claude').toLowerCase();
const _CHARS_PER_TOKEN_DEFAULT = _PROVIDER === 'claude' ? 3 : 4;
const CHARS_PER_TOKEN = appSettings.has('ai.chars_per_token')
  ? Number(appSettings.get('ai.chars_per_token')) || _CHARS_PER_TOKEN_DEFAULT
  : _CHARS_PER_TOKEN_DEFAULT;

// Maximale Output-Tokens.
const MAX_TOKENS_OUT = Number(appSettings.get('ai.claude.max_tokens_out')) || 64000;

// Gesamtes Kontextfenster des Modells (Input + Output). Für Claude-API provider-
// seitig fix (200K), für lokale Modelle vom User zu setzen je nach Deployment
// (Mistral-Small3.2: 128K, Gemma3-12B: 128K, kleinere Modelle oft 32K oder 8K).
const MODEL_CONTEXT = Number(appSettings.get('ai.claude.context_window')) || 200000;

// Sicherheitspuffer für Tokenisierungs-Unsicherheit und System-Prompt-Overhead,
// den CHARS_PER_TOKEN nicht exakt trifft.
const CONTEXT_SAFETY_MARGIN = 2000;

// Hard-Check: max_tokens_out muss genug Platz für Input lassen — pro Provider.
// Sonst kollabieren abgeleitete Budgets auf ihre Mindestwerte, und lokale Provider
// (llama.cpp/Ollama) schicken max_tokens > num_ctx → 400-Fehler.
for (const p of ['claude', 'ollama', 'llama']) {
  const ctx = Number(appSettings.get(`ai.${p}.context_window`));
  const out = Number(appSettings.get(`ai.${p}.max_tokens_out`));
  if (!ctx || !out) continue;
  if (out + CONTEXT_SAFETY_MARGIN >= ctx) {
    throw new Error(
      `Fehlkonfiguration: ai.${p}.max_tokens_out (${out}) + Sicherheitspuffer (${CONTEXT_SAFETY_MARGIN}) ` +
      `>= ai.${p}.context_window (${ctx}). max_tokens_out ist der Output-Cap und muss deutlich kleiner ` +
      `sein als das gesamte Kontextfenster context_window (Input + Output). Beispiel für Mistral-Small3.2: ` +
      `context_window=128000, max_tokens_out=16000.`
    );
  }
}

const INPUT_BUDGET_TOKENS = MODEL_CONTEXT - MAX_TOKENS_OUT - CONTEXT_SAFETY_MARGIN;
const INPUT_BUDGET_CHARS  = INPUT_BUDGET_TOKENS * CHARS_PER_TOKEN;

logger.info(`AI-Budget: context=${MODEL_CONTEXT} out=${MAX_TOKENS_OUT} inputBudget=${INPUT_BUDGET_TOKENS} tok (~${INPUT_BUDGET_CHARS} chars, ${CHARS_PER_TOKEN} chars/tok)`);

// Default-Temperaturen für lokale Provider – shared mit routes/proxies.js, damit
// Job-Pfad und Editor-Proxy-Pfad bei fehlender Env denselben Wert sehen.
const DEFAULT_OLLAMA_TEMP = 0.2;
const DEFAULT_LLAMA_TEMP  = 0.1;

function ollamaTemp(override) {
  if (override != null && Number.isFinite(override)) return override;
  const v = Number(appSettings.get('ai.ollama.temperature'));
  return Number.isFinite(v) ? v : DEFAULT_OLLAMA_TEMP;
}
function llamaTemp(override) {
  if (override != null && Number.isFinite(override)) return override;
  const v = Number(appSettings.get('ai.llama.temperature'));
  return Number.isFinite(v) ? v : DEFAULT_LLAMA_TEMP;
}

// Chat-spezifische Temperatur-Override (nur Ollama/Llama). Wenn `ai.chat_temperature`
// in app_settings gesetzt ist, übersteuert sie die Provider-Defaults – aber nur für
// Seiten- und Buch-Chat. Andere Job-Typen (Review, Lektorat, Komplett-Analyse) bleiben
// auf ihren Provider-Defaults, weil sie deterministische Analyse-Antworten brauchen.
function chatTemperature() {
  if (!appSettings.has('ai.chat_temperature')) return null;
  const n = Number(appSettings.get('ai.chat_temperature'));
  return Number.isFinite(n) ? n : null;
}

// Sicherheitsgrenze für lokale Modelle: Abbruch wenn Output-Tokens das N-fache
// der Input-Tokens übersteigen. Verhindert endlose Wiederholungsschleifen.
const MAX_OUTPUT_RATIO = 4;

// Ollama und Llama verarbeiten parallele Anfragen schlecht (VRAM-Überlauf, Verbindungsabbruch).
// Dieser Mutex serialisiert alle lokalen KI-Calls global – Jobs laufen weiter parallel,
// nur die eigentlichen KI-Aufrufe kommen nacheinander am Server an.
function makeLock() {
  let queue = Promise.resolve();
  return function withLock(fn) {
    const next = queue.then(fn);
    queue = next.catch(() => {}); // Fehler nicht in die Queue-Chain leiten
    return next;
  };
}
const withOllamaLock = makeLock();
const withLlamaLock  = makeLock();

// Erkennt Verbindungs-Fehler (Provider offline/DNS/Timeout) anhand cause.code.
// Liefert null, wenn der Fehler keine Connection-Klasse ist.
const _CONN_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET', 'ENETUNREACH']);
function _connErrorCode(err) {
  const code = err?.cause?.code || err?.code;
  if (code && _CONN_CODES.has(code)) return code;
  // node fetch wrappt DNS/Connect-Fehler oft als generisches "fetch failed".
  if (err?.message === 'fetch failed' && !err?.cause?.code) return 'FETCH_FAILED';
  return null;
}

// Wirft einen i18n-keyed Error für Provider-Unreachable. failJob übergibt
// `i18nParams` als `errorParams` an das Frontend; `t('error.LLAMA_UNREACHABLE', …)`
// rendert die Meldung in der User-Locale.
function _unreachableError(provider, host, fetchErr) {
  const code = _connErrorCode(fetchErr);
  const detail = code || fetchErr?.cause?.message || fetchErr?.message || 'unknown';
  const key = provider === 'ollama' ? 'error.OLLAMA_UNREACHABLE' : 'error.LLAMA_UNREACHABLE';
  const err = new Error(key);
  err.i18nParams = { host, detail };
  err.code = 'AI_UNREACHABLE';
  return err;
}

// Claude-API liefert 529 (Overloaded) und 429 (Rate-Limit) als transiente Fehler. Beide
// retryen mit Exponential-Backoff (1s/2s/4s + Jitter). Stream-`overloaded_error` retried
// nur, wenn noch kein Text/Block emittiert wurde (sonst würde Output dupliziert).
// 503 mit `error.type === 'overloaded_error'` (z. B. "API key validation is temporarily
// unavailable") ist ebenfalls transient – Detection nicht über Status, sondern über
// den Body-Typ (siehe `_isOverloadedBody`).
const RETRY_STATUS = new Set([429, 529]);
function _retryMaxAttempts() {
  return parseInt(appSettings.get('ai.claude.retry_max'), 10) || 3;
}

function _isOverloadedBody(rawText) {
  if (!rawText) return false;
  try {
    const parsed = JSON.parse(rawText);
    return parsed?.error?.type === 'overloaded_error';
  } catch {
    return false;
  }
}

function _parseRetryAfter(resp) {
  const v = resp?.headers?.get?.('retry-after');
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function _retryDelayMs(attempt, retryAfterSec) {
  if (retryAfterSec && retryAfterSec > 0) {
    return Math.min(retryAfterSec * 1000 + Math.random() * 250, 30000);
  }
  const base = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
  return base + Math.random() * 500;
}

function _overloadError(status, retryAfterSec, message) {
  const err = new Error(message || `Claude overloaded (status=${status || 'stream'})`);
  err.code = 'AI_OVERLOADED';
  err.status = status || null;
  err.retryAfterSec = retryAfterSec || null;
  return err;
}

function _sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Aborted'));
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason || new Error('Aborted'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

// jsonSchema: optionales JSON-Schema für Grammar-Constrained Decoding (nur lokale Provider).
// Wenn gesetzt, erzwingt llama.cpp/Ollama strukturkonformes JSON (inkl. korrekt escapete Strings).
// Claude ignoriert das Argument.
async function callAI(userPrompt, systemPrompt, onProgress, maxTokensOverride, signal, provider, jsonSchema) {
  const messages = [{ role: 'user', content: userPrompt }];
  return callAIChat(messages, systemPrompt, onProgress, maxTokensOverride, signal, provider, jsonSchema);
}

// Multi-Turn-Variante von callAI: akzeptiert ein vollständiges Messages-Array
// (user/assistant-Wechsel) statt eines einzelnen User-Prompts.
async function callAIChat(messages, systemPrompt, onProgress, maxTokensOverride, signal, provider, jsonSchema, temperatureOverride, prefill) {
  provider = provider || resolveProvider();

  // Lokale Provider kennen kein Prompt-Caching → Array-Form (mehrere Cache-Blöcke)
  // auf einen String flatten. Claude behält die Array-Form und erzeugt daraus
  // separate cache_control-Blöcke (für Cross-Call-Caching, z.B. Buchtext über
  // mehrere Phasen hinweg).
  const flatSystem = (provider !== 'claude' && Array.isArray(systemPrompt))
    ? systemPrompt.map(b => b.text).join('\n\n')
    : systemPrompt;

  if (provider === 'ollama') {
    return withOllamaLock(() => _callOllama(messages, flatSystem, onProgress, maxTokensOverride, signal, jsonSchema, temperatureOverride));
  }
  if (provider === 'llama') {
    return withLlamaLock(() => _callLlama(messages, flatSystem, onProgress, maxTokensOverride, signal, jsonSchema, temperatureOverride));
  }
  return _callClaude(messages, systemPrompt, onProgress, maxTokensOverride, signal, prefill);
}

async function _callOllama(messages, systemPrompt, onProgress, maxTokensOverride, signal, jsonSchema, temperatureOverride) {
    const host = String(appSettings.get('ai.ollama.host') || 'http://localhost:11434').replace(/\/$/, '');
    const model = appSettings.get('ai.ollama.model') || 'llama3.2';
    const ollamaCfg = getContextConfigFor('ollama');
    const globalMax = ollamaCfg.maxTokensOut;
    const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
    const temperature = ollamaTemp(temperatureOverride);
    const allMessages = [];
    if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt });
    allMessages.push(...messages);

    // Dient als Untergrenze – Ollama meldet bei KV-Cache-Treffer 0 oder nur User-Tokens.
    const estimatedTokIn = Math.ceil(allMessages.reduce((s, m) => s + (m.content?.length || 0), 0) / CHARS_PER_TOKEN);
    // num_ctx: Gesamtkontextfenster (Input + Output) – dynamisch aus Input-Schätzung + Output-Limit,
    // begrenzt durch das in app_settings konfigurierte native Modellfenster (`ai.ollama.context_window`).
    // Fester Wert wäre bei grossen Prompts zu klein und würde Input stillschweigend kürzen.
    // +1000 als Sicherheitspuffer.
    const num_ctx = Math.min(estimatedTokIn + maxTokens + 1000, ollamaCfg.contextWindow);
    // format: JSON-Schema-Objekt (strikt) oder 'json' (permissiv). Schema erzwingt via GBNF-Grammatik
    //   nicht nur gültiges JSON sondern auch korrekt escapete Strings und schema-konforme Felder –
    //   verhindert die «unescaped `"` im String»-Klasse von Bugs, die mistral-small3.2 regelmässig
    //   produziert. Fallback 'json' (ohne Schema) ist nur hint-basiert.
    const fmt = jsonSchema || 'json';
    let resp;
    try {
      resp = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: allMessages, stream: true, format: fmt, options: { num_ctx, num_predict: maxTokens, temperature, think: false } }),
        signal,
      });
    } catch (fetchErr) {
      if (fetchErr.name === 'AbortError') throw fetchErr;
      if (_connErrorCode(fetchErr)) throw _unreachableError('ollama', host, fetchErr);
      throw new Error(`Ollama fetch fehlgeschlagen (${host}): ${fetchErr.message}`);
    }
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', tokensIn = 0, tokensOut = 0, truncated = false, genDurationMs = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.done) {
            // Echten prompt_eval_count bevorzugen; nur bei vollständigem Cache-Hit
            // (prompt_eval_count=0) Fallback auf Schätzung, damit die Anzeige nicht 0 wird.
            // Vorher: Math.max(real, estimate) führte zu Überzählen, wenn die Schätzung
            // (CHARS_PER_TOKEN=3) zu pessimistisch war – die DB speicherte dann z.B. 128k,
            // obwohl das Modell 98k echte Tokens meldete.
            tokensIn = chunk.prompt_eval_count && chunk.prompt_eval_count > 0
              ? chunk.prompt_eval_count
              : estimatedTokIn;
            tokensOut = chunk.eval_count || 0;
            if (chunk.done_reason === 'length') truncated = true;
            if (chunk.eval_duration) genDurationMs = Math.round(chunk.eval_duration / 1e6);
            if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
          } else {
            const delta = chunk.message?.content || '';
            text += delta;
            // Während des Streamings kein Schätzwert für tokIn durchreichen –
            // das führte sonst zu einer Anzeige, die nach Job-Ende vom echten
            // Wert aus usage abweicht (Inkonsistenz Job-Status vs. DB-Nachricht).
            if (onProgress) onProgress({ chars: text.length, tokIn: 0, delta });
            // Sicherheitsabbruch: lokales Modell dreht durch (Wiederholungsschleife)
            const estOut = Math.ceil(text.length / CHARS_PER_TOKEN);
            if (estOut > MAX_OUTPUT_RATIO * estimatedTokIn) {
              logger.warn(`Ollama Sicherheitsabbruch: Output (~${estOut} Tokens) > ${MAX_OUTPUT_RATIO}× Input (~${estimatedTokIn} Tokens) – Generierung abgebrochen`);
              truncated = true;
              reader.cancel();
              break;
            }
          }
        } catch (e) {
          // Malformed NDJSON-Line: nicht abbrechen (Ollama emittiert manchmal
          // Partial-Lines am Stream-Ende), aber bei Debug-Level loggen, damit
          // Token-Drops sichtbar werden.
          logger.debug?.(`Ollama Chunk-Parse-Fehler: ${e.message} — Line: ${line.slice(0, 120)}`);
        }
      }
      if (truncated) break;
    }
    return { text, truncated, tokensIn, tokensOut, cacheReadIn: 0, cacheCreationIn: 0, genDurationMs, provider: 'ollama', model };
}

async function _callLlama(messages, systemPrompt, onProgress, maxTokensOverride, signal, jsonSchema, temperatureOverride) {
  const host = String(appSettings.get('ai.llama.host') || 'http://localhost:8080').replace(/\/$/, '');
  const model = appSettings.get('ai.llama.model') || 'llama3.2';
  const globalMax = getContextConfigFor('llama').maxTokensOut;
  const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
  const temperature = llamaTemp(temperatureOverride);
  const allMessages = [];
  if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt });
  allMessages.push(...messages);

  // response_format:
  //   - Mit Schema: json_schema strict:true → GBNF-Grammar-Constrained Decoding. Erzwingt
  //     schema-konforme Struktur UND korrekt escapete Strings (fixt den «unescaped `"`»-Bug,
  //     den mistral-small3.2 im json_object-Modus produziert).
  //   - Ohne Schema: json_object als Fallback-Hint (nicht grammar-erzwungen).
  const responseFormat = jsonSchema
    ? { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: jsonSchema } }
    : { type: 'json_object' };

  let resp;
  try {
    resp = await fetch(`${host}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: allMessages,
        stream: true,
        stream_options: { include_usage: true },
        temperature,
        max_tokens: maxTokens,
        response_format: responseFormat,
      }),
      signal,
    });
  } catch (fetchErr) {
    if (fetchErr.name === 'AbortError') throw fetchErr;
    if (_connErrorCode(fetchErr)) throw _unreachableError('llama', host, fetchErr);
    const cause = fetchErr.cause?.message || fetchErr.cause?.code || '';
    throw new Error(`Llama fetch fehlgeschlagen (${host}): ${fetchErr.message}${cause ? ' – ' + cause : ''}`);
  }
  if (!resp.ok) throw new Error(`Llama ${resp.status}: ${await resp.text()}`);

  const estimatedTokIn = Math.ceil(allMessages.reduce((s, m) => s + (m.content?.length || 0), 0) / CHARS_PER_TOKEN);

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', tokensIn = 0, tokensOut = 0, truncated = false;
  let t_first = 0, t_last = 0;
  try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6);
      if (raw === '[DONE]') continue;
      try {
        const chunk = JSON.parse(raw);
        const delta = chunk.choices?.[0]?.delta?.content || '';
        if (delta) {
          const now = Date.now();
          if (!t_first) t_first = now;
          t_last = now;
          text += delta;
          // Während des Streamings kein Schätzwert für tokIn durchreichen –
          // sonst weicht die Job-Anzeige vom echten prompt_tokens (aus usage) ab.
          if (onProgress) onProgress({ chars: text.length, tokIn: 0, delta });
          // Sicherheitsabbruch: lokales Modell dreht durch (Wiederholungsschleife)
          const estOut = Math.ceil(text.length / CHARS_PER_TOKEN);
          if (estOut > MAX_OUTPUT_RATIO * estimatedTokIn) {
            logger.warn(`Llama Sicherheitsabbruch: Output (~${estOut} Tokens) > ${MAX_OUTPUT_RATIO}× Input (~${estimatedTokIn} Tokens) – Generierung abgebrochen`);
            truncated = true;
            reader.cancel();
            break;
          }
        }
        if (chunk.choices?.[0]?.finish_reason === 'length') truncated = true;
        if (chunk.usage) {
          tokensIn  = chunk.usage.prompt_tokens     || estimatedTokIn;
          tokensOut = chunk.usage.completion_tokens || Math.ceil(text.length / CHARS_PER_TOKEN);
          if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
        }
      } catch (e) {
        logger.debug?.(`Llama Chunk-Parse-Fehler: ${e.message} — Line: ${line.slice(0, 120)}`);
      }
    }
    if (truncated) break;
  }
  } catch (streamErr) {
    if (streamErr.name === 'AbortError') throw streamErr;
    if (_connErrorCode(streamErr)) throw _unreachableError('llama', host, streamErr);
    const cause = streamErr.cause?.message || streamErr.cause?.code || '';
    throw new Error(`Llama Stream-Abbruch (${host}): ${streamErr.message}${cause ? ' – ' + cause : ''}`);
  }
  if (!tokensIn)  tokensIn  = estimatedTokIn;
  if (!tokensOut) tokensOut = Math.ceil(text.length / CHARS_PER_TOKEN);
  const genDurationMs = (t_first && t_last > t_first) ? t_last - t_first : null;
  return { text, truncated, tokensIn, tokensOut, cacheReadIn: 0, cacheCreationIn: 0, genDurationMs, provider: 'llama', model };
}

// Globaler Hard-Timeout für Claude-Calls. Schützt gegen hängende Streams (z.B. wenn
// die Anthropic-API die Verbindung stumm hält). User-Cancel (signal) bleibt zusätzlich aktiv.
function _claudeTimeoutMs() {
  return parseInt(appSettings.get('ai.claude.timeout_ms'), 10) || 600000;
}

/**
 * Baut Claude-system-Blocks aus String oder Array.
 * String  → ein cache_control-Block (5-min-TTL, Default-Verhalten).
 * Array   → je Eintrag ein Block; {text, ttl?} – ttl:'1h' nutzt den Extended-TTL-Beta.
 *           Mehrere Blöcke = mehrere Cache-Breakpoints (z.B. [Buchtext(1h), Phase-System(5min)]).
 */
function _buildClaudeSystemBlocks(systemPrompt) {
  if (!systemPrompt) return null;
  if (typeof systemPrompt === 'string') {
    return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
  }
  if (Array.isArray(systemPrompt) && systemPrompt.length > 0) {
    return systemPrompt.map(b => ({
      type: 'text',
      text: b.text,
      cache_control: b.ttl === '1h'
        ? { type: 'ephemeral', ttl: '1h' }
        : { type: 'ephemeral' },
    }));
  }
  return null;
}

function _combineSignals(userSignal, timeoutMs) {
  const ctrl = new AbortController();
  // `timedOut` markiert den Unterschied zwischen User-Cancel und Timeout.
  // Ohne Marker liefert node-fetch in beiden Fällen `error.name === 'AbortError'`,
  // sodass Job-Catches den Timeout fälschlich als User-Abbruch verbuchen.
  const state = { timedOut: false };
  const onAbort = () => ctrl.abort(userSignal?.reason);
  if (userSignal) {
    if (userSignal.aborted) ctrl.abort(userSignal.reason);
    else userSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    state.timedOut = true;
    ctrl.abort(new Error(`Claude-Timeout nach ${timeoutMs}ms`));
  }, timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    userSignal?.removeEventListener?.('abort', onAbort);
  };
  return { signal: ctrl.signal, cleanup, state };
}

async function _callClaude(messages, systemPrompt, onProgress, maxTokensOverride, signal, prefill) {
  const maxAttempts = _retryMaxAttempts();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await _callClaudeAttempt(messages, systemPrompt, onProgress, maxTokensOverride, signal, prefill);
    } catch (e) {
      if (e?.code === 'AI_OVERLOADED' && !signal?.aborted && attempt < maxAttempts - 1) {
        const delay = _retryDelayMs(attempt, e.retryAfterSec);
        logger.warn(`Claude overload (${e.status || 'stream'}), Versuch ${attempt + 1}/${maxAttempts}, retry in ${Math.round(delay)}ms`);
        await _sleep(delay, signal);
        continue;
      }
      throw e;
    }
  }
}

async function _callClaudeAttempt(messages, systemPrompt, onProgress, maxTokensOverride, signal, prefill) {
    const model = appSettings.get('ai.claude.model') || 'claude-sonnet-4-6';
    const globalMax = MAX_TOKENS_OUT;
    const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
    // Prefill (Anthropic-Standardtrick zum JSON-Erzwingen): assistant-Message mit
    // Anfangs-Tokens hängt an messages, Stream startet danach. Wird vorne wieder
    // an `text` geklebt, damit Caller sauberes JSON ab `{` sieht. Whitespace im
    // Prefill würde Claude verbieten (API-Validierung), darum kein Newline/Space.
    const effectiveMessages = prefill
      ? [...messages, { role: 'assistant', content: prefill }]
      : messages;
    const body = {
      model, max_tokens: maxTokens, temperature: 0.2,
      messages: effectiveMessages, stream: true,
    };
    const sysBlocks = _buildClaudeSystemBlocks(systemPrompt);
    if (sysBlocks) body.system = sysBlocks;

    const timeoutMs = _claudeTimeoutMs();
    const { signal: combinedSignal, cleanup, state: signalState } = _combineSignals(signal, timeoutMs);
    try {
    let resp;
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': appSettings.get('ai.claude.api_key') || '',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11',
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });
    } catch (e) {
      if (signalState.timedOut) {
        const err = new Error(`Claude-Timeout nach ${timeoutMs}ms`);
        err.code = 'AI_TIMEOUT';
        throw err;
      }
      throw e;
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      if (RETRY_STATUS.has(resp.status) || _isOverloadedBody(detail)) {
        const ra = _parseRetryAfter(resp);
        throw _overloadError(resp.status, ra, `Claude ${resp.status}: ${detail.slice(0, 300)}`);
      }
      throw new Error(`Claude ${resp.status}: ${detail || resp.statusText}`);
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let text = prefill || '', buf = '', tokensIn = 0, tokensOut = 0, cacheReadIn = 0, cacheCreationIn = 0, truncated = false;
    let stopReason = null;
    let t_first = 0, t_last = 0;
    let streamDone = false;
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6);
        if (raw === '[DONE]') { streamDone = true; break; }
        let ev;
        try { ev = JSON.parse(raw); } catch { continue; }
        if (ev.type === 'error') {
          if (ev.error?.type === 'overloaded_error' && text.length === 0) {
            throw _overloadError(null, null, `Claude Stream-Fehler: overloaded_error – ${ev.error?.message || ''}`);
          }
          throw new Error(`Claude Stream-Fehler: ${ev.error?.type} – ${ev.error?.message}`);
        }
        if (ev.type === 'message_start' && ev.message?.usage) {
          const u = ev.message.usage;
          cacheCreationIn = u.cache_creation_input_tokens || 0;
          cacheReadIn     = u.cache_read_input_tokens || 0;
          tokensIn = (u.input_tokens || 0) + cacheCreationIn + cacheReadIn;
          if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
        }
        if (ev.type === 'message_delta') {
          if (ev.usage?.output_tokens != null) tokensOut = ev.usage.output_tokens;
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          if (ev.delta?.stop_reason === 'max_tokens') truncated = true;
        }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          const now = Date.now();
          if (!t_first) t_first = now;
          t_last = now;
          const delta = ev.delta.text || '';
          text += delta;
          if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn, delta });
        }
      }
    }
    const genDurationMs = (t_first && t_last > t_first) ? t_last - t_first : null;
    return { text, truncated, tokensIn, tokensOut, cacheReadIn, cacheCreationIn, genDurationMs, stopReason, provider: 'claude', model };
    } finally {
      cleanup();
    }
}

// ── Tool-Use (Anthropic Messages API) ──────────────────────────────────────
// Einzelner Round-Trip mit Tool-Use. Der Caller (Job-Runner) verwaltet den Loop:
// wenn stopReason === 'tool_use' muss er die Tools ausführen, Results als
// tool_result-Blocks an die messages anhängen und erneut aufrufen.
//
// Rückgabe:
//   { text, toolUses, stopReason, rawContentBlocks, tokensIn, tokensOut, genDurationMs, truncated }
//   - text: kumulierter Text aller text_delta-Blocks (kann leer sein bei reiner Tool-Antwort)
//   - toolUses: [{ id, name, input }] mit bereits geparstem input (Objekt)
//   - stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | ...
//   - rawContentBlocks: Original-Content-Blocks (text+tool_use) für die nächste Runde
//
// Nur Claude-Provider. Ollama/Llama werfen einen Fehler – Caller muss auf
// Fallback-Pfad (klassischer Buch-Chat) umschalten.
async function callAIWithTools(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal, provider) {
  provider = provider || resolveProvider();
  if (provider !== 'claude') {
    throw new Error(`Tool-Use nicht unterstützt für Provider '${provider}' – Caller muss auf Fallback-Pfad umschalten.`);
  }
  return _callClaudeWithTools(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal);
}

async function _callClaudeWithTools(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal) {
  const maxAttempts = _retryMaxAttempts();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await _callClaudeWithToolsAttempt(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal);
    } catch (e) {
      if (e?.code === 'AI_OVERLOADED' && !signal?.aborted && attempt < maxAttempts - 1) {
        const delay = _retryDelayMs(attempt, e.retryAfterSec);
        logger.warn(`Claude overload (${e.status || 'stream'}), Versuch ${attempt + 1}/${maxAttempts}, retry in ${Math.round(delay)}ms`);
        await _sleep(delay, signal);
        continue;
      }
      throw e;
    }
  }
}

async function _callClaudeWithToolsAttempt(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal) {
  const model = appSettings.get('ai.claude.model') || 'claude-sonnet-4-6';
  const globalMax = MAX_TOKENS_OUT;
  const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
  const body = {
    model, max_tokens: maxTokens, temperature: 0.2,
    messages, stream: true,
  };
  const sysBlocks = _buildClaudeSystemBlocks(systemPrompt);
  if (sysBlocks) body.system = sysBlocks;
  if (Array.isArray(tools) && tools.length) body.tools = tools;

  const timeoutMs = _claudeTimeoutMs();
  const { signal: combinedSignal, cleanup, state: signalState } = _combineSignals(signal, timeoutMs);
  try {
  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': appSettings.get('ai.claude.api_key') || '',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11',
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
  } catch (e) {
    if (signalState.timedOut) {
      const err = new Error(`Claude-Timeout nach ${timeoutMs}ms`);
      err.code = 'AI_TIMEOUT';
      throw err;
    }
    throw e;
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    if (RETRY_STATUS.has(resp.status) || _isOverloadedBody(detail)) {
      const ra = _parseRetryAfter(resp);
      throw _overloadError(resp.status, ra, `Claude ${resp.status}: ${detail.slice(0, 300)}`);
    }
    throw new Error(`Claude ${resp.status}: ${detail || resp.statusText}`);
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  // Content-Blocks werden per Index addressiert (content_block_start/delta/stop).
  // Jeder Block ist entweder text oder tool_use; bei tool_use wird input_json
  // in deltas geliefert und muss akkumuliert werden.
  const blocks = []; // [{ type:'text', text } | { type:'tool_use', id, name, _inputJson }]
  let textAcc = '';
  let buf = '';
  let tokensIn = 0, tokensOut = 0, cacheReadIn = 0, cacheCreationIn = 0, truncated = false;
  let stopReason = null;
  let t_first = 0, t_last = 0;
  let streamDone = false;
  while (!streamDone) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6);
      if (raw === '[DONE]') { streamDone = true; break; }
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (ev.type === 'error') {
        if (ev.error?.type === 'overloaded_error' && textAcc.length === 0 && blocks.filter(Boolean).length === 0) {
          throw _overloadError(null, null, `Claude Stream-Fehler: overloaded_error – ${ev.error?.message || ''}`);
        }
        throw new Error(`Claude Stream-Fehler: ${ev.error?.type} – ${ev.error?.message}`);
      }
      if (ev.type === 'message_start' && ev.message?.usage) {
        const u = ev.message.usage;
        cacheCreationIn = u.cache_creation_input_tokens || 0;
        cacheReadIn     = u.cache_read_input_tokens || 0;
        tokensIn = (u.input_tokens || 0) + cacheCreationIn + cacheReadIn;
        if (onProgress) onProgress({ chars: textAcc.length, tokIn: tokensIn });
      }
      if (ev.type === 'content_block_start') {
        const cb = ev.content_block || {};
        if (cb.type === 'tool_use') {
          blocks[ev.index] = { type: 'tool_use', id: cb.id, name: cb.name, _inputJson: '' };
        } else if (cb.type === 'text') {
          blocks[ev.index] = { type: 'text', text: '' };
        }
      }
      if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        const b = blocks[ev.index];
        if (!b) continue;
        if (d.type === 'text_delta') {
          b.text += d.text || '';
          textAcc += d.text || '';
          const now = Date.now();
          if (!t_first) t_first = now;
          t_last = now;
          if (onProgress) onProgress({ chars: textAcc.length, tokIn: tokensIn });
        } else if (d.type === 'input_json_delta') {
          b._inputJson += d.partial_json || '';
        }
      }
      if (ev.type === 'content_block_stop') {
        // tool_use: akkumuliertes input-JSON parsen (kann leer sein → {})
        const b = blocks[ev.index];
        if (b && b.type === 'tool_use') {
          try { b.input = b._inputJson ? JSON.parse(b._inputJson) : {}; }
          catch (e) { b.input = {}; b.parseError = e.message; }
          delete b._inputJson;
        }
      }
      if (ev.type === 'message_delta') {
        if (ev.usage?.output_tokens != null) tokensOut = ev.usage.output_tokens;
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.delta?.stop_reason === 'max_tokens') truncated = true;
      }
    }
  }
  const toolUses = blocks.filter(b => b && b.type === 'tool_use').map(b => ({
    id: b.id, name: b.name, input: b.input || {}, ...(b.parseError ? { parseError: b.parseError } : {}),
  }));
  const rawContentBlocks = blocks.filter(Boolean).map(b => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
  });
  const genDurationMs = (t_first && t_last > t_first) ? t_last - t_first : null;
  return { text: textAcc, toolUses, stopReason, rawContentBlocks, tokensIn, tokensOut, cacheReadIn, cacheCreationIn, genDurationMs, truncated, provider: 'claude', model };
  } finally {
    cleanup();
  }
}

// Extrahiert das erste balancierte JSON-Objekt aus text, ohne Trailing-Content
// mit {}-Mustern (z.B. Modell-Hinweise nach dem JSON) einzuschliessen.
// Nutzt einen typ-sensitiven Stack – so wird `{"a":[}` nicht fälschlich als
// balanciert erkannt (wie die frühere depth-Zählung ohne Typ-Info es tat).
function extractBalancedJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  const stack = [];
  let inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString && ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const opener = stack.pop();
      const expected = ch === '}' ? '{' : '[';
      if (opener !== expected) return null; // unpassendes Schliesszeichen → kein valider JSON-Bereich
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Heuristik gegen unescaptes ASCII-`"` mitten in JSON-String-Werten (typisch:
// Modell schreibt Anführungszeichen-Beispiele in «erklaerung» und vergisst Escape).
// Walk char-für-char, im String-State: ist das nächste non-whitespace nach `"`
// eines von , } ] : → echter Terminator; sonst escape `"` zu `\"`.
function escapeUnescapedQuotes(text) {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escape) { out += ch; escape = false; continue; }
    if (ch === '\\') { out += ch; escape = true; continue; }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) j++;
      const next = text[j];
      if (next === ',' || next === '}' || next === ']' || next === ':' || next === undefined) {
        out += ch;
        inString = false;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function parseJSON(text) {
  const clean = text.replace(/```json\s*|```/g, '').trim();
  try { return JSON.parse(clean); } catch {
    const candidate = extractBalancedJson(clean) ?? clean;
    try { return JSON.parse(candidate); } catch {
      try { return JSON.parse(jsonrepair(candidate)); } catch {
        const escaped = escapeUnescapedQuotes(candidate);
        try { return JSON.parse(escaped); } catch {
          try { return JSON.parse(jsonrepair(escaped)); } catch (e3) {
        const posMatch = /position\s+(\d+)/i.exec(e3.message);
        const pos = posMatch ? parseInt(posMatch[1], 10) : null;
        let preview;
        if (pos != null) {
          const from = Math.max(0, pos - 300);
          const to   = Math.min(clean.length, pos + 300);
          preview = `…${clean.slice(from, pos)}⟦HIER⟧${clean.slice(pos, to)}… (pos ${pos} von ${clean.length})`;
        } else {
          preview = clean.length > 300 ? clean.slice(0, 300) + '…' : clean;
        }
        _dumpParseFail(clean, pos);
        throw new Error(`JSON-Parse fehlgeschlagen (${e3.message}). Kontext: ${preview}`);
          }
        }
      }
    }
  }
}

// Anführungszeichen-Paare, die das Modell statt ASCII `"` produzieren kann.
// Reihenfolge: ASCII zuerst (Standard), dann typografische Varianten.
// Modelle verwechseln gerne JSON-Quotes mit Sprach-Quotes (DE „…", CH «…»,
// EN "…", FR «…»/‹…›). Bei kaputtem JSON akzeptieren wir alle.
const QUOTE_PAIRS = [
  ['"', '"'],
  ['„', '“'], // „ … "  DE
  ['«', '»'], // « … »  CH/FR
  ['“', '”'], // " … "  typografisch EN
  ['‘', '’'], // ' … '  typografisch single
  ['‚', '‘'], // ‚ … '  DE single
  ['‹', '›'], // ‹ … ›  FR single guillemets
];

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Extrahiert String-Feldwert per Regex aus JSON-Rohtext, ohne den Baum zu
// parsen. Zweck: wenn parseJSON wirft (z.B. unescaptes `"` in Nachbarfeld
// oder Modell-Mix mit Sprach-Quotes), wenigstens Pflichtfeld retten.
// Iteriert alle Quote-Paare für Schlüssel und Wert. JSON-decoded falls
// möglich (nur ASCII-Capture), sonst Roh-Capture.
function extractStringField(text, fieldName) {
  for (const [ko, kc] of QUOTE_PAIRS) {
    for (const [vo, vc] of QUOTE_PAIRS) {
      const re = new RegExp(
        `${escapeRe(ko)}${escapeRe(fieldName)}${escapeRe(kc)}\\s*:\\s*${escapeRe(vo)}((?:\\\\.|(?!${escapeRe(vc)}).)*)${escapeRe(vc)}`,
        's',
      );
      const m = text.match(re);
      if (m) {
        if (vo === '"') {
          try { return JSON.parse('"' + m[1] + '"'); }
          catch { return m[1]; }
        }
        return m[1];
      }
    }
  }
  return null;
}

// Lenient parseJSON: schluckt Parse-Fehler, extrahiert benannte String-Felder
// einzeln. Für Konsumenten, die User-sichtbare Prosa retten wollen statt zu
// failen. Rückgabe: { ok, parsed?, partial?, error? } — partial._raw als
// Notnagel der fence-freie Rohtext.
function parseJSONLenient(text, stringFields = []) {
  try { return { ok: true, parsed: parseJSON(text) }; }
  catch (err) {
    const partial = {};
    for (const f of stringFields) {
      const v = extractStringField(text, f);
      if (v != null) partial[f] = v;
    }
    if (Object.keys(partial).length === 0) {
      partial._raw = text.replace(/```json\s*|```/g, '').trim();
    }
    return { ok: false, partial, error: err };
  }
}

// Per-Provider Context-Config. Boot-Konstanten (`INPUT_BUDGET_TOKENS` etc.)
// bleiben fuer Backwards-Compat — sie repraesentieren den Globalwert beim Server-Start.
// Code-Pfade mit auflusbarem userEmail nutzen `getContextConfigFor(provider)`, um
// das per-Provider-Limit zu lesen. Fehlt fuer Ollama/Llama ein eigenes context_window
// in app_settings, faellt es auf 32 000 (typisch fuer 32K-Modelle) zurueck — der
// Admin kann via `ai.ollama.context_window` / `ai.llama.context_window` hoeher setzen.
const PROVIDER_CONTEXT_DEFAULTS = {
  claude: 200000,
  ollama: 32000,
  llama:  32000,
};

function getContextConfigFor(provider) {
  const p = VALID_PROVIDERS.has(provider) ? provider : 'claude';
  const settingKey = p === 'claude' ? 'ai.claude.context_window' : `ai.${p}.context_window`;
  const ctx = Number(appSettings.get(settingKey)) || PROVIDER_CONTEXT_DEFAULTS[p];
  const maxOutKey = p === 'claude' ? 'ai.claude.max_tokens_out' : `ai.${p}.max_tokens_out`;
  const maxOut = Number(appSettings.get(maxOutKey)) || MAX_TOKENS_OUT;
  const safety = CONTEXT_SAFETY_MARGIN;
  const cpt = p === 'claude' ? CHARS_PER_TOKEN : (CHARS_PER_TOKEN || 4);
  const inputBudgetTokens = Math.max(2000, ctx - maxOut - safety);
  return {
    provider: p,
    contextWindow: ctx,
    maxTokensOut: maxOut,
    charsPerToken: cpt,
    inputBudgetTokens,
    inputBudgetChars: inputBudgetTokens * cpt,
  };
}

module.exports = {
  callAI, callAIChat, callAIWithTools, parseJSON, parseJSONLenient, extractStringField, chatTemperature,
  ollamaTemp, llamaTemp,
  CHARS_PER_TOKEN, MAX_TOKENS_OUT,
  MODEL_CONTEXT, INPUT_BUDGET_TOKENS, INPUT_BUDGET_CHARS,
  DEFAULT_OLLAMA_TEMP, DEFAULT_LLAMA_TEMP,
  resolveProvider, VALID_PROVIDERS, getContextConfigFor,
};
