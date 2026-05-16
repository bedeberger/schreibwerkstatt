// Phase 4d: PRICING + costUsd().
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICING, costUsd, fallbackFamily } from '../../lib/pricing.js';

test('costUsd: lokale Provider liefern 0', () => {
  assert.equal(costUsd({ provider: 'ollama', model: 'llama3.2', tokensIn: 1000, tokensOut: 500 }), 0);
  assert.equal(costUsd({ provider: 'llama',  model: 'llama3.2', tokensIn: 1000, tokensOut: 500 }), 0);
});

test('costUsd: unbekanntes Modell faellt auf 0 zurueck (kein Throw)', () => {
  const usd = costUsd({ provider: 'claude', model: 'claude-mystery-9-0', tokensIn: 1_000_000, tokensOut: 1_000_000 });
  assert.equal(usd, 0);
});

test('costUsd: Sonnet 4-6 fixe Preise', () => {
  // 1 Mio Input + 1 Mio Output = 3.00 + 15.00 = 18.00 USD
  const usd = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 1_000_000, tokensOut: 1_000_000 });
  assert.equal(Math.round(usd * 1000) / 1000, 18.0);
});

test('costUsd: Cache-Read billiger als Input, Cache-Write teurer', () => {
  // Sonnet: cache_read 0.30 < input 3.00 < cache_write 3.75
  const cacheRead = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', cacheReadIn: 1_000_000 });
  const inputOnly = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 1_000_000 });
  const cacheWrite = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', cacheCreationIn: 1_000_000 });
  assert.ok(cacheRead < inputOnly);
  assert.ok(inputOnly < cacheWrite);
  assert.equal(cacheRead, 0.30);
  assert.equal(inputOnly, 3.00);
  assert.equal(cacheWrite, 3.75);
});

test('fallbackFamily: dated model IDs auf Familie mappen', () => {
  assert.equal(fallbackFamily('claude-sonnet-4-6-20251015'), 'claude-sonnet-4-6');
  assert.equal(fallbackFamily('claude-opus-4-7-20260101'),   'claude-opus-4-7');
  assert.equal(fallbackFamily('claude-haiku-4-5-2025xxxx'),  'claude-haiku-4-5');
  assert.equal(fallbackFamily('unknown-foo'),                null);
});

test('costUsd: Family-Fallback wirkt fuer dated model IDs', () => {
  const exact = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6',          tokensIn: 1_000_000 });
  const dated = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6-20251015', tokensIn: 1_000_000 });
  assert.equal(exact, dated);
});

test('PRICING: Opus > Sonnet > Haiku (Input-Preis)', () => {
  assert.ok(PRICING['claude-opus-4-7'].input > PRICING['claude-sonnet-4-6'].input);
  assert.ok(PRICING['claude-sonnet-4-6'].input > PRICING['claude-haiku-4-5'].input);
});

test('costUsd: nullish/NaN-Tokens behandelt wie 0', () => {
  const usd = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: null, tokensOut: undefined });
  assert.equal(usd, 0);
});
