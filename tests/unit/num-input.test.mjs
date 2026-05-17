// Pure-Helper-Tests fuer num-input.js — Roundtrip Format/Parse (CH + US),
// Clamp-Verhalten, Decimal-Inferenz aus `step`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferDecimals,
  localeTagFromUi,
  formatNum,
  formatNumRaw,
  parseNum,
  clampNum,
} from '../../public/js/num-input.js';

// ── inferDecimals ────────────────────────────────────────────────────────────

test('inferDecimals: integer flag → 0', () => {
  assert.equal(inferDecimals({ integer: true, step: 0.1 }), 0);
});
test('inferDecimals: explicit decimals override', () => {
  assert.equal(inferDecimals({ decimals: 3, step: 0.1 }), 3);
});
test('inferDecimals: from step=0.1 → 1', () => {
  assert.equal(inferDecimals({ step: 0.1 }), 1);
});
test('inferDecimals: from step=0.05 → 2', () => {
  assert.equal(inferDecimals({ step: 0.05 }), 2);
});
test('inferDecimals: from step=1 → 0', () => {
  assert.equal(inferDecimals({ step: 1 }), 0);
});
test('inferDecimals: default step=undefined → 0', () => {
  assert.equal(inferDecimals({}), 0);
});

// ── localeTagFromUi ──────────────────────────────────────────────────────────

test('localeTagFromUi: en → en-US', () => {
  assert.equal(localeTagFromUi('en'), 'en-US');
});
test('localeTagFromUi: de → de-CH', () => {
  assert.equal(localeTagFromUi('de'), 'de-CH');
});
test('localeTagFromUi: undefined → de-CH (fallback)', () => {
  assert.equal(localeTagFromUi(undefined), 'de-CH');
});

// ── formatNum ────────────────────────────────────────────────────────────────

test('formatNum: de-CH thousand uses U+2019 apostrophe', () => {
  const s = formatNum(10000, { localeTag: 'de-CH', decimals: 0 });
  assert.match(s, /10[’']000/);
});
test('formatNum: de-CH decimal uses dot', () => {
  const s = formatNum(1.5, { localeTag: 'de-CH', decimals: 1 });
  assert.equal(s, '1.5');
});
test('formatNum: en-US thousand uses comma', () => {
  assert.equal(formatNum(10000, { localeTag: 'en-US', decimals: 0 }), '10,000');
});
test('formatNum: null/empty → empty string', () => {
  assert.equal(formatNum(null, { localeTag: 'de-CH', decimals: 0 }), '');
  assert.equal(formatNum('', { localeTag: 'de-CH', decimals: 0 }), '');
  assert.equal(formatNum(NaN, { localeTag: 'de-CH', decimals: 0 }), '');
});
test('formatNum: grouping=false suppresses thousand sep', () => {
  assert.equal(formatNum(10000, { localeTag: 'de-CH', decimals: 0, grouping: false }), '10000');
});
test('formatNum: fixed decimals — pads with zeros', () => {
  assert.equal(formatNum(2, { localeTag: 'de-CH', decimals: 2 }), '2.00');
});

// ── formatNumRaw (Edit-Form) ─────────────────────────────────────────────────

test('formatNumRaw: int (decimals=0) → trunc', () => {
  assert.equal(formatNumRaw(10000.7, { decimals: 0 }), '10000');
});
test('formatNumRaw: decimals=1 → toFixed', () => {
  assert.equal(formatNumRaw(1.5, { decimals: 1 }), '1.5');
});
test('formatNumRaw: null → empty', () => {
  assert.equal(formatNumRaw(null, { decimals: 1 }), '');
});

// ── parseNum ─────────────────────────────────────────────────────────────────

test('parseNum: strip Swiss apostrophe thousand', () => {
  assert.equal(parseNum('10’000'), 10000);
  assert.equal(parseNum("10'000"), 10000);
});
test('parseNum: strip whitespace + NBSP', () => {
  assert.equal(parseNum('10 000'), 10000);
  assert.equal(parseNum('10 000'), 10000);
  assert.equal(parseNum('10 000'), 10000);
});
test('parseNum: accept `.` decimal', () => {
  assert.equal(parseNum('1.5'), 1.5);
});
test('parseNum: accept `,` decimal (German habit)', () => {
  assert.equal(parseNum('1,5'), 1.5);
});
test('parseNum: en-US format "10,000.5" → 10000.5 (strip comma)', () => {
  assert.equal(parseNum('10,000.5'), 10000.5);
});
test('parseNum: de-CH format "10’000.5" → 10000.5', () => {
  assert.equal(parseNum('10’000.5'), 10000.5);
});
test('parseNum: empty/null → null', () => {
  assert.equal(parseNum(''), null);
  assert.equal(parseNum(null), null);
  assert.equal(parseNum('   '), null);
});
test('parseNum: garbage → null', () => {
  assert.equal(parseNum('abc'), null);
});
test('parseNum: negative numbers', () => {
  assert.equal(parseNum('-1.5'), -1.5);
});

// ── clampNum ─────────────────────────────────────────────────────────────────

test('clampNum: below min → min', () => {
  assert.equal(clampNum(0, 1, 10), 1);
});
test('clampNum: above max → max', () => {
  assert.equal(clampNum(20, 1, 10), 10);
});
test('clampNum: within range → unchanged', () => {
  assert.equal(clampNum(5, 1, 10), 5);
});
test('clampNum: min undefined → no lower bound', () => {
  assert.equal(clampNum(-100, undefined, 10), -100);
});
test('clampNum: max undefined → no upper bound', () => {
  assert.equal(clampNum(9999, 0, undefined), 9999);
});
test('clampNum: null input → null', () => {
  assert.equal(clampNum(null, 0, 10), null);
});

// ── Roundtrip (parse → format) ───────────────────────────────────────────────

test('Roundtrip de-CH: format → parse identity', () => {
  for (const n of [0, 1, 10, 100, 1234, 10000, 1234567, 1.5, 0.05, 999.99]) {
    const fmt = formatNum(n, { localeTag: 'de-CH', decimals: 2 });
    assert.equal(parseNum(fmt), n, `Roundtrip CH n=${n} fmt="${fmt}"`);
  }
});
test('Roundtrip en-US: format → parse identity', () => {
  for (const n of [0, 1, 10, 100, 1234, 10000, 1234567, 1.5, 0.05, 999.99]) {
    const fmt = formatNum(n, { localeTag: 'en-US', decimals: 2 });
    assert.equal(parseNum(fmt), n, `Roundtrip US n=${n} fmt="${fmt}"`);
  }
});
