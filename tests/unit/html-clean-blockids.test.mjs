// Unit-Tests für ensureBlockIds (lib/html-clean.js) — stabile data-bid-Vergabe
// als Basis für den Block-Level-Merge. Lauf: `node --test tests/unit/html-clean-blockids.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ensureBlockIds } = require('../../lib/html-clean.js');

const bids = (html) => [...html.matchAll(/data-bid="([0-9a-f]+)"/g)].map(m => m[1]);

test('ensureBlockIds: vergibt data-bid auf allen Block-Tags', () => {
  const out = ensureBlockIds('<p>A</p><h2>B</h2><ul><li>x</li></ul><blockquote>q</blockquote><pre>c</pre><hr>');
  // p, h2, ul, blockquote, pre, hr → 6 Blöcke (li bekommt KEIN bid).
  assert.equal(bids(out).length, 6);
  assert.doesNotMatch(out, /<li[^>]*data-bid/);
});

test('ensureBlockIds: 16-Hex-IDs', () => {
  for (const b of bids(ensureBlockIds('<p>A</p><p>B</p>'))) {
    assert.match(b, /^[0-9a-f]{16}$/);
  }
});

test('ensureBlockIds: bestehende IDs bleiben unverändert', () => {
  const input = '<p data-bid="aaaaaaaaaaaaaaaa">A</p><p>B</p>';
  const out = ensureBlockIds(input);
  assert.match(out, /<p data-bid="aaaaaaaaaaaaaaaa">A<\/p>/);
  assert.equal(bids(out).length, 2);
});

test('ensureBlockIds: idempotent — zweiter Run identisch', () => {
  const once = ensureBlockIds('<p>A</p><h3>B</h3><ol><li>1</li></ol>');
  const twice = ensureBlockIds(once);
  assert.equal(once, twice);
});

test('ensureBlockIds: Duplikat-IDs (Copy-Paste) werden aufgelöst', () => {
  const out = ensureBlockIds('<p data-bid="abcdef0123456789">A</p><p data-bid="abcdef0123456789">B</p>');
  const got = bids(out);
  assert.equal(got.length, 2);
  assert.notEqual(got[0], got[1]);
  assert.equal(got[0], 'abcdef0123456789'); // erstes Vorkommen behält
});

test('ensureBlockIds: div.poem bekommt bid, Wrapper-div nicht', () => {
  const out = ensureBlockIds('<div class="poem">Vers</div><div>wrap<p>x</p></div>');
  assert.match(out, /<div [^>]*class="poem"[^>]*>/);
  assert.equal(bids(out).length, 2); // poem + innerer p
  // Genau ein <div> trägt data-bid (das poem), Wrapper-div nicht.
  assert.equal([...out.matchAll(/<div [^>]*data-bid/g)].length, 1);
});

test('ensureBlockIds: table/figure als ein Block', () => {
  const out = ensureBlockIds('<table><tr><td>x</td></tr></table><figure>f</figure>');
  assert.equal(bids(out).length, 2);
  assert.doesNotMatch(out, /<td[^>]*data-bid/);
});

test('ensureBlockIds: Edge-Cases', () => {
  assert.equal(ensureBlockIds(''), '');
  assert.equal(ensureBlockIds(null), null);
  assert.equal(ensureBlockIds(undefined), undefined);
});
