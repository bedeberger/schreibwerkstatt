'use strict';
// Embedding-Client (self-hosted, OpenAI-kompatibler /v1/embeddings-Endpunkt,
// z.B. LocalAI). Reiner Netz-Adapter — keine Prompt-/JSON-Logik wie lib/ai.js,
// Embeddings sind blosse Zahlenvektoren. Host/Model/Key kommen aus app_settings
// (embed.*) und verlassen den Server nie. Konsumenten: der Index-Job
// (routes/jobs/embed-index.js) und der Semantik-Query-Pfad (routes/search.js).

const appSettings = require('./app-settings');

// Grösster Rohbatch pro HTTP-Call. LocalAI/llama.cpp nehmen Arrays; zu grosse
// Batches sprengen das Server-Kontextfenster. Der Job chunkt oberhalb weiter.
const MAX_BATCH = 32;

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
    throw new Error(`Embedding-Endpunkt nicht erreichbar (${host}): ${e.message}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Embedding-Endpunkt HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  const json = await resp.json();
  const data = Array.isArray(json?.data) ? json.data : null;
  if (!data || data.length !== input.length) {
    throw new Error(`Embedding-Antwort unvollständig: erwartet ${input.length}, erhalten ${data ? data.length : 0}`);
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
    const vecs = await _postBatch(host, model, apiKey, timeoutMs, slice, signal);
    result.push(...vecs);
  }
  return result;
}

// Einzeltext → Float32Array (Query-Pfad).
async function embedOne(text, opts) {
  const [v] = await embedBatch([text], opts);
  return v;
}

module.exports = { isEnabled, getConfig, embedBatch, embedOne, MAX_BATCH };
