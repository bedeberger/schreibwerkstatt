// Unit-Test fuer lib/languagetool-chunk.js: chunkText + adjustMatches.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chunkText, adjustMatches, CHUNK_MAX } = require('../../lib/languagetool-chunk.js');

test('chunkText: empty returns []', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText(null), []);
});

test('chunkText: short text returns single chunk with offset 0', () => {
  const res = chunkText('hallo welt');
  assert.equal(res.length, 1);
  assert.equal(res[0].text, 'hallo welt');
  assert.equal(res[0].offset, 0);
});

test('chunkText: splits at paragraph boundaries (greedy)', () => {
  const para = 'a'.repeat(30_000);
  const text = `${para}\n\n${para}\n\n${para}`;
  const res = chunkText(text, 50_000);
  // Greedy: 30k+30k > 50k -> flush 30k, naechster 30k+30k > 50k -> flush 30k,
  // letzter 30k. Drei Chunks, jeder <= 50k.
  assert.equal(res.length, 3);
  for (const c of res) assert.ok(c.text.length <= 50_000);
  // Stitching: chunks aneinandergehaengt geben original.
  let i = 0;
  for (const c of res) {
    assert.equal(c.offset, i);
    i += c.text.length;
  }
  assert.equal(i, text.length);
});

test('chunkText: greedy packs small paragraphs', () => {
  // 10x kleine Paragraphen je 5k -> sollten zu wenigen Chunks gepackt werden.
  const para = 'a'.repeat(5_000);
  const text = Array(10).fill(para).join('\n\n');
  const res = chunkText(text, 50_000);
  assert.ok(res.length <= 2, `expected <=2 chunks, got ${res.length}`);
  let i = 0;
  for (const c of res) {
    assert.equal(c.offset, i);
    i += c.text.length;
  }
  assert.equal(i, text.length);
});

test('chunkText: paragraph >max splits at sentences', () => {
  // 80k Paragraph, viele Saetze.
  const sent = 'Dies ist ein Satz. ';
  const para = sent.repeat(5000); // ~95k
  const res = chunkText(para, 50_000);
  assert.ok(res.length >= 2);
  for (const c of res) assert.ok(c.text.length <= 50_000);
  // Offset-Konsistenz: sum of texts = original.
  let i = 0;
  for (const c of res) {
    assert.equal(c.offset, i);
    i += c.text.length;
  }
  assert.equal(i, para.length);
});

test('chunkText: extreme single-sentence triggers hard split', () => {
  const huge = 'x'.repeat(120_000);
  const res = chunkText(huge, 50_000);
  assert.ok(res.length >= 3);
  for (const c of res) assert.ok(c.text.length <= 50_000);
  let i = 0;
  for (const c of res) {
    assert.equal(c.offset, i);
    i += c.text.length;
  }
  assert.equal(i, huge.length);
});

test('adjustMatches: empty', () => {
  assert.deepEqual(adjustMatches(100, []), []);
  assert.deepEqual(adjustMatches(0, null), []);
});

test('adjustMatches: shifts offsets by chunkOffset', () => {
  const matches = [
    { offset: 5, length: 3, rule: { id: 'A' } },
    { offset: 10, length: 2, rule: { id: 'B' } },
  ];
  const out = adjustMatches(1000, matches);
  assert.equal(out[0].offset, 1005);
  assert.equal(out[1].offset, 1010);
  // Original unveraendert.
  assert.equal(matches[0].offset, 5);
});

test('adjustMatches: zero offset returns shallow copy', () => {
  const matches = [{ offset: 1, length: 1 }];
  const out = adjustMatches(0, matches);
  assert.deepEqual(out, matches);
  assert.notStrictEqual(out, matches);
});

test('CHUNK_MAX exported', () => {
  assert.equal(typeof CHUNK_MAX, 'number');
  assert.equal(CHUNK_MAX, 50_000);
});
