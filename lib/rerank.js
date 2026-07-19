'use strict';
// Reranker-Client (self-hosted, OpenAI/Jina-kompatibler /v1/rerank-Endpunkt,
// z.B. LocalAI, HuggingFace TEI). Cross-Encoder-Nachordnung der Freitext-
// Kandidaten aus der semantischen Suche: bewertet (query, document)-Paare direkt
// statt über Vektor-Distanz → schärfere Relevanz als die Retrieval-Stufe allein.
// Reiner Netz-Adapter wie lib/embed.js — keine Prompt-/JSON-Logik. Host/Model/Key
// kommen aus app_settings (rerank.*) und verlassen den Server nie. Konsument:
// lib/semantic-retrieval.js. Fällt der Endpunkt aus, greift dort still die RRF-/
// Cosinus-Reihenfolge (non-fatal, wie veraPDF beim PDF-Export).

const appSettings = require('./app-settings');
const logger = require('../logger');

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;

function _abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function _sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(_abortError());
    const onAbort = () => { clearTimeout(t); reject(_abortError()); };
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Retry bei transienten Backend-Aussetzern (Netz-Blip, Neustart, 429/5xx).
// Nicht-transiente Fehler (HTTP 4xx ausser 429, echter Job-Cancel) werfen sofort.
async function _withRetry(fn, { retries = MAX_RETRIES, baseMs = RETRY_BASE_MS, signal, label = '' } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') throw e;
      if (!e?.retriable || attempt >= retries) throw e;
      attempt++;
      logger.warn(`Rerank-Retry ${attempt}/${retries}${label ? ` (${label})` : ''}: ${e.message}`);
      await _sleep(baseMs * attempt, signal);
    }
  }
}

// Reranking setzt aktivierte semantische Suche voraus (es ordnet deren Kandidaten
// nach) — ohne Embedding-Index gibt es nichts zu reranken.
function isEnabled() {
  const embed = require('./embed');
  return !!appSettings.get('rerank.enabled')
    && !!String(appSettings.get('rerank.host') || '').trim()
    && embed.isEnabled();
}

function getConfig() {
  return {
    host: String(appSettings.get('rerank.host') || '').trim().replace(/\/$/, ''),
    model: String(appSettings.get('rerank.model') || 'bge-reranker-v2-m3').trim(),
    apiKey: String(appSettings.get('rerank.api_key') || '').trim(),
    timeoutMs: parseInt(appSettings.get('rerank.timeout_ms'), 10) || 30000,
    topN: parseInt(appSettings.get('rerank.top_n'), 10) || 30,
    minScore: Number(appSettings.get('rerank.min_score')) || 0,
  };
}

// Parst die /v1/rerank-Antwort (Jina/Cohere-Schema) → [{ index, score }]
// absteigend. Akzeptiert `results` oder `data`; Score aus `relevance_score` oder
// `score`; `index` verweist auf die Dokument-Position (nicht die Array-Position).
// Ungültige/ausserhalb-des-Bereichs liegende Indizes werden verworfen (defensiv
// gegen fehlerhafte Backends), Duplikate auf denselben Index ebenfalls.
function _parseRerankResponse(json, nDocs) {
  const results = Array.isArray(json?.results) ? json.results
    : Array.isArray(json?.data) ? json.data
    : null;
  if (!results) throw new Error('Rerank-Antwort ohne results-Array.');
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const ix = Number.isInteger(r?.index) ? r.index : null;
    if (ix == null || ix < 0 || ix >= nDocs || seen.has(ix)) continue;
    const score = typeof r.relevance_score === 'number' ? r.relevance_score
      : typeof r.score === 'number' ? r.score
      : null;
    if (score == null || !Number.isFinite(score)) continue;
    seen.add(ix);
    out.push({ index: ix, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

async function _post(host, model, apiKey, timeoutMs, query, documents, signal) {
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
    resp = await fetch(`${host}/v1/rerank`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, query, documents }),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (signal && signal.aborted) throw e;
    const err = new Error(`Rerank-Endpunkt nicht erreichbar (${host}): ${e.message}`);
    err.retriable = true;
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`Rerank-Endpunkt HTTP ${resp.status}: ${body.slice(0, 300)}`);
    err.retriable = resp.status === 429 || resp.status >= 500;
    throw err;
  }
  const json = await resp.json();
  return _parseRerankResponse(json, documents.length);
}

// Rerankt documents gegen query → [{ index, score }] absteigend. Leere Eingabe
// → []. Wirft bei hartem Backend-Fehler (Aufrufer fängt und fällt auf die
// Retrieval-Reihenfolge zurück).
async function rerank(query, documents, { signal } = {}) {
  if (!isEnabled()) throw new Error('Reranker nicht konfiguriert (rerank.enabled/host).');
  const docs = Array.isArray(documents) ? documents : [];
  if (!docs.length) return [];
  const { host, model, apiKey, timeoutMs } = getConfig();
  const clean = docs.map(d => String(d == null ? '' : d));
  return _withRetry(
    () => _post(host, model, apiKey, timeoutMs, String(query == null ? '' : query), clean, signal),
    { signal, label: `${clean.length} docs` },
  );
}

module.exports = { isEnabled, getConfig, rerank, _parseRerankResponse, _withRetry };
