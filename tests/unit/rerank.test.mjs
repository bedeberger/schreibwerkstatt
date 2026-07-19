// Reranker-Client (lib/rerank.js): Antwort-Parsing (Jina/Cohere-Schema) +
// Retry-Klassifikation. Pure Helfer, kein Netz/DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Temp-DB, damit das Require von app-settings (via rerank.js) die Dev-DB nicht anfasst.
process.env.DB_PATH = path.join(os.tmpdir(), `sw-rerank-${process.pid}.db`);

const require = createRequire(import.meta.url);
const { _parseRerankResponse, _withRetry } = require('../../lib/rerank.js');

test('_parseRerankResponse: results mit relevance_score → absteigend sortiert', () => {
  const json = { results: [
    { index: 0, relevance_score: 0.2 },
    { index: 1, relevance_score: 0.9 },
    { index: 2, relevance_score: 0.5 },
  ] };
  const out = _parseRerankResponse(json, 3);
  assert.deepEqual(out.map(o => o.index), [1, 2, 0]);
  assert.equal(out[0].score, 0.9);
});

test('_parseRerankResponse: akzeptiert `score` und `data` als Aliase', () => {
  const json = { data: [{ index: 1, score: 0.7 }, { index: 0, score: 0.1 }] };
  const out = _parseRerankResponse(json, 2);
  assert.deepEqual(out.map(o => o.index), [1, 0]);
});

test('_parseRerankResponse: verwirft Out-of-Range-, fehlende- und Duplikat-Indizes', () => {
  const json = { results: [
    { index: 0, relevance_score: 0.8 },
    { index: 5, relevance_score: 0.9 },   // out of range (nDocs=2)
    { index: 0, relevance_score: 0.4 },   // Duplikat → verworfen
    { relevance_score: 0.7 },             // ohne index → verworfen
    { index: 1 },                          // ohne score → verworfen
  ] };
  const out = _parseRerankResponse(json, 2);
  assert.deepEqual(out.map(o => o.index), [0]);
  assert.equal(out.length, 1);
});

test('_parseRerankResponse: fehlendes results-Array → wirft', () => {
  assert.throws(() => _parseRerankResponse({ foo: 1 }, 3), /results/);
});

test('_withRetry: transient → Erfolg nach Retries; nicht-transient → sofort', async () => {
  let calls = 0;
  const out = await _withRetry(async () => {
    calls++;
    if (calls < 2) { const e = new Error('blip'); e.retriable = true; throw e; }
    return 'ok';
  }, { retries: 3, baseMs: 1 });
  assert.equal(out, 'ok');
  assert.equal(calls, 2);

  let c2 = 0;
  await assert.rejects(
    () => _withRetry(async () => { c2++; throw new Error('HTTP 400'); }, { retries: 3, baseMs: 1 }),
    /400/,
  );
  assert.equal(c2, 1);
});
