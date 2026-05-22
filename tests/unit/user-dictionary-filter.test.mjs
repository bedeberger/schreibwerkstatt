// Unit-Test fuer db/user-dictionary.js#filterMatches (pure, kein DB-Zugriff).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { filterMatches } = require('../../db/user-dictionary.js');

function mkMatch(word, offset = 0) {
  return {
    offset: 10,
    length: word.length,
    rule: { id: 'GERMAN_SPELLER' },
    context: { text: `Das ${word} ist seltsam.`, offset: 4, length: word.length },
  };
}

test('filterMatches: no dict -> matches unchanged', () => {
  const matches = [mkMatch('Foo')];
  assert.deepEqual(filterMatches(matches, new Set()), matches);
  assert.deepEqual(filterMatches(matches, null), matches);
});

test('filterMatches: dict word removed (case-insensitive)', () => {
  const matches = [mkMatch('Hugo'), mkMatch('Otto')];
  const dict = new Set(['hugo']);
  const out = filterMatches(matches, dict);
  assert.equal(out.length, 1);
  assert.equal(out[0].context.text.includes('Otto'), true);
});

test('filterMatches: empty matches -> empty out', () => {
  assert.deepEqual(filterMatches([], new Set(['x'])), []);
});

test('filterMatches: malformed match (no context) kept', () => {
  const matches = [{ rule: { id: 'X' } }];
  assert.deepEqual(filterMatches(matches, new Set(['foo'])), matches);
});
