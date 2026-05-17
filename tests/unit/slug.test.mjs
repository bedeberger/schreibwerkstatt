// slugify + uniqueSlug.
import { test } from 'node:test';
import assert from 'node:assert';

import { slugify, uniqueSlug } from '../../lib/slug.js';

test('slugify: lowercase + Trim', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('  Hallo  '), 'hallo');
});

test('slugify: deutsche Umlaute → ae/oe/ue/ss', () => {
  assert.equal(slugify('Märchen'), 'maerchen');
  assert.equal(slugify('Französisch'), 'franzoesisch');
  assert.equal(slugify('Größe'), 'groesse');
  assert.equal(slugify('Übung'), 'uebung');
});

test('slugify: Diakritika strippen (NFD)', () => {
  assert.equal(slugify('Café'), 'cafe');
  assert.equal(slugify('Resumé'), 'resume');
  assert.equal(slugify('São Paulo'), 'sao-paulo');
});

test('slugify: Sonderzeichen weg, multi-dash collapse', () => {
  assert.equal(slugify('Foo / Bar — Baz'), 'foo-bar-baz');
  assert.equal(slugify('a___b'), 'ab');
  assert.equal(slugify('-leading-and-trailing-'), 'leading-and-trailing');
});

test('slugify: Trim auf 64 Zeichen', () => {
  const long = 'a'.repeat(200);
  assert.equal(slugify(long).length, 64);
});

test('slugify: leerer / nicht-String → ""', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
});

test('uniqueSlug: kein Konflikt → Basis', () => {
  assert.equal(uniqueSlug('foo', () => false), 'foo');
});

test('uniqueSlug: Konflikt → -2, -3, …', () => {
  const taken = new Set(['foo', 'foo-2', 'foo-3']);
  assert.equal(uniqueSlug('foo', s => taken.has(s)), 'foo-4');
});

test('uniqueSlug: leerer Basis-Slug → "item"', () => {
  assert.equal(uniqueSlug('', () => false), 'item');
});
