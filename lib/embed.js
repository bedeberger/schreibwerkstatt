'use strict';
// Embedding-Client (self-hosted, OpenAI-kompatibler /v1/embeddings-Endpunkt,
// z.B. LocalAI). Reiner Netz-Adapter — keine Prompt-/JSON-Logik wie lib/ai.js,
// Embeddings sind blosse Zahlenvektoren. Host/Model/Key kommen aus app_settings
// (embed.*) und verlassen den Server nie. Konsumenten: der Index-Job
// (routes/jobs/embed-index.js) und der Semantik-Query-Pfad (routes/search.js).

const appSettings = require('./app-settings');
const logger = require('../logger');

// Grösster Rohbatch pro HTTP-Call. LocalAI/llama.cpp nehmen Arrays; zu grosse
// Batches sprengen das Server-Kontextfenster. Der Job chunkt oberhalb weiter.
const MAX_BATCH = 32;

// Retry bei transienten Backend-Aussetzern (Netz-Blip, Neustart, 429/5xx). Ein
// grosser Index besteht aus vielen HTTP-Calls — ohne Retry reisst ein einziger
// Blip den ganzen Job ab. Lineare Backoffs (1×, 2×, 3× base). Nicht-transiente
// Fehler (HTTP 4xx ausser 429, echter Job-Cancel) werfen sofort ohne Retry.
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;

function _abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

// Wartet ms, bricht aber sofort ab, wenn signal (Job-Cancel) feuert.
function _sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(_abortError());
    const onAbort = () => { clearTimeout(t); resolve = null; reject(_abortError()); };
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Ruft fn() mit Retry auf, solange der Fehler als transient markiert ist
// (err.retriable) und noch Versuche offen sind. Job-Cancel (signal) bricht sofort
// ab. Exportiert für Unit-Tests (retries/baseMs injizierbar).
async function _withRetry(fn, { retries = MAX_RETRIES, baseMs = RETRY_BASE_MS, signal, label = '' } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') throw e; // echter Job-Cancel
      if (!e?.retriable || attempt >= retries) throw e;
      attempt++;
      logger.warn(`Embedding-Retry ${attempt}/${retries}${label ? ` (${label})` : ''}: ${e.message}`);
      await _sleep(baseMs * attempt, signal);
    }
  }
}

function isEnabled() {
  return !!appSettings.get('embed.enabled') && !!String(appSettings.get('embed.host') || '').trim();
}

function getConfig() {
  return {
    host: String(appSettings.get('embed.host') || '').trim().replace(/\/$/, ''),
    model: String(appSettings.get('embed.model') || 'bge-m3').trim(),
    dim: parseInt(appSettings.get('embed.dim'), 10) || 1024,
    apiKey: String(appSettings.get('embed.api_key') || '').trim(),
    timeoutMs: parseInt(appSettings.get('embed.timeout_ms'), 10) || 60000,
  };
}

async function _postBatch(host, model, apiKey, timeoutMs, input, signal) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${host}/v1/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input }),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (signal && signal.aborted) throw e; // echter Abbruch (Job-Cancel)
    // Netz-Ebene (fetch failed / DNS / Reset) oder Timeout → transient, Retry.
    const err = new Error(`Embedding-Endpunkt nicht erreichbar (${host}): ${e.message}`);
    err.retriable = true;
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`Embedding-Endpunkt HTTP ${resp.status}: ${body.slice(0, 300)}`);
    // 429/5xx sind transient (Überlast/Neustart), 4xx nicht (Bad Request bleibt Bad Request).
    err.retriable = resp.status === 429 || resp.status >= 500;
    throw err;
  }
  const json = await resp.json();
  const data = Array.isArray(json?.data) ? json.data : null;
  if (!data || data.length !== input.length) {
    // Unvollständige Antwort → Backend unter Last, nächster Versuch kann klappen.
    const err = new Error(`Embedding-Antwort unvollständig: erwartet ${input.length}, erhalten ${data ? data.length : 0}`);
    err.retriable = true;
    throw err;
  }
  // OpenAI-Kontrakt: data[].index gibt die Zuordnung, nicht die Array-Position.
  const out = new Array(input.length);
  for (const row of data) {
    const ix = Number.isInteger(row.index) ? row.index : data.indexOf(row);
    const emb = row?.embedding;
    if (!Array.isArray(emb) || !emb.length) throw new Error('Embedding-Antwort ohne Vektor.');
    out[ix] = Float32Array.from(emb);
  }
  return out;
}

// Embeddet ein Array von Strings → Array von Float32Array (gleiche Reihenfolge).
// Ein einzelner String wird als [string] behandelt. Batcht intern auf MAX_BATCH.
async function embedBatch(texts, { signal } = {}) {
  if (!isEnabled()) throw new Error('Embedding-Backend nicht konfiguriert (embed.enabled/host).');
  const arr = Array.isArray(texts) ? texts : [texts];
  if (!arr.length) return [];
  const { host, model, apiKey, timeoutMs } = getConfig();
  if (!host) throw new Error('embed.host nicht gesetzt.');

  const result = [];
  for (let i = 0; i < arr.length; i += MAX_BATCH) {
    const slice = arr.slice(i, i + MAX_BATCH).map(s => String(s == null ? '' : s));
    const vecs = await _withRetry(
      () => _postBatch(host, model, apiKey, timeoutMs, slice, signal),
      { signal, label: `${slice.length} texts` },
    );
    result.push(...vecs);
  }
  return result;
}

// Einzeltext → Float32Array (Query-Pfad).
async function embedOne(text, opts) {
  const [v] = await embedBatch([text], opts);
  return v;
}

module.exports = { isEnabled, getConfig, embedBatch, embedOne, MAX_BATCH, _withRetry };
