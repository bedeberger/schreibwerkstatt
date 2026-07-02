// Pure-Helper: Entkopplung der Extraktions- von der Kontinuitäts-Schwelle (#1).
// resolveExtractSinglePassLimit(singlePassLimit, extractCapChars) ist rein → schnell + deterministisch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveExtractSinglePassLimit } = require('../../routes/jobs/shared/loader.js');

const SINGLE = 1_800_000; // typische Kontinuitäts-Schwelle bei Opus 4.8 + 1M

test('cap = 0 → folgt der Kontinuitäts-Schwelle (keine Entkopplung)', () => {
  assert.equal(resolveExtractSinglePassLimit(SINGLE, 0), SINGLE);
  assert.equal(resolveExtractSinglePassLimit(SINGLE, null), SINGLE);
  assert.equal(resolveExtractSinglePassLimit(SINGLE, undefined), SINGLE);
});

test('cap < Kontinuitäts-Schwelle → Extraktion wird tiefer gekappt', () => {
  assert.equal(resolveExtractSinglePassLimit(SINGLE, 700_000), 700_000);
});

test('cap > Kontinuitäts-Schwelle → auf Kontinuitäts-Schwelle geklemmt (nie lockerer)', () => {
  assert.equal(resolveExtractSinglePassLimit(SINGLE, 5_000_000), SINGLE);
});

test('cap unter dem 20000-Zeichen-Floor → Floor gewinnt', () => {
  assert.equal(resolveExtractSinglePassLimit(SINGLE, 5_000), 20_000);
});

test('negative/Unfug → 0-Behandlung (folgt Schwelle)', () => {
  assert.equal(resolveExtractSinglePassLimit(SINGLE, -1), SINGLE);
  assert.equal(resolveExtractSinglePassLimit(SINGLE, NaN), SINGLE);
});
