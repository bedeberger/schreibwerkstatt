// Retry-Logik des Embedding-Clients (lib/embed.js#_withRetry): transiente
// Fehler (err.retriable) werden mit Backoff wiederholt, nicht-transiente werfen
// sofort, Job-Cancel (signal) bricht ohne weiteren Versuch ab.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Temp-DB, damit das Require von app-settings nicht die Dev-DB anfasst.
process.env.DB_PATH = path.join(os.tmpdir(), `sw-embed-retry-${process.pid}.db`);

const require = createRequire(import.meta.url);
const { _withRetry, _stripLoneSurrogates } = require('../../lib/embed.js');

const retriable = (msg) => { const e = new Error(msg); e.retriable = true; return e; };

test('_stripLoneSurrogates: entfernt einzelne Surrogate, behält gültige Paare', () => {
  // 🙈 (U+1F648) = gültiges Paar 🙈 → bleibt unverändert.
  const emoji = 'abc\u{1F648}def';
  assert.equal(_stripLoneSurrogates(emoji), emoji);
  // Lone Low-Surrogate (Chunk-Split-Artefakt) → entfernt, sonst JSON-\udXXX → UTF-8-Crash am Endpunkt.
  assert.equal(_stripLoneSurrogates('abc\uDE48def'), 'abcdef');
  // Lone High-Surrogate → ebenfalls entfernt.
  assert.equal(_stripLoneSurrogates('abc\uD83Ddef'), 'abcdef');
  // Sauberer Text bleibt unverändert.
  assert.equal(_stripLoneSurrogates('Hallo Welt'), 'Hallo Welt');
});

test('_withRetry: transienter Fehler → Erfolg nach Retries', async () => {
  let calls = 0;
  const out = await _withRetry(async () => {
    calls++;
    if (calls < 3) throw retriable('fetch failed');
    return 'ok';
  }, { retries: 3, baseMs: 1 });
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
});

test('_withRetry: nicht-transienter Fehler → sofort werfen, kein Retry', async () => {
  let calls = 0;
  await assert.rejects(
    () => _withRetry(async () => { calls++; throw new Error('HTTP 400 bad request'); }, { retries: 3, baseMs: 1 }),
    /400/,
  );
  assert.equal(calls, 1);
});

test('_withRetry: Retries erschöpft → letzter Fehler wirft', async () => {
  let calls = 0;
  await assert.rejects(
    () => _withRetry(async () => { calls++; throw retriable('still down'); }, { retries: 2, baseMs: 1 }),
    /still down/,
  );
  assert.equal(calls, 3); // 1 Initial + 2 Retries
});

test('_withRetry: Job-Cancel (signal aborted) → kein Retry trotz retriable', async () => {
  const ctrl = new AbortController();
  let calls = 0;
  await assert.rejects(
    () => _withRetry(async () => {
      calls++;
      ctrl.abort();
      throw retriable('blip during cancel');
    }, { retries: 3, baseMs: 1, signal: ctrl.signal }),
  );
  assert.equal(calls, 1);
});

test('_withRetry: AbortError wird nie wiederholt', async () => {
  let calls = 0;
  await assert.rejects(
    () => _withRetry(async () => {
      calls++;
      const e = new Error('aborted'); e.name = 'AbortError'; throw e;
    }, { retries: 3, baseMs: 1 }),
  );
  assert.equal(calls, 1);
});
