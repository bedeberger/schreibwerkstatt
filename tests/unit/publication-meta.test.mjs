import { test } from 'node:test';
import assert from 'node:assert/strict';
import pub from '../../lib/publication-meta.js';

const { defaultMeta, validateMeta, isValidIsbn13, CSS_STYLES } = pub;

test('defaultMeta: leere Strings + serif + justify true', () => {
  const d = defaultMeta();
  assert.equal(d.isbn, '');
  assert.equal(d.epub_css_style, 'serif');
  assert.equal(d.epub_justify, true);
});

test('validateMeta: null/non-object → Defaults', () => {
  assert.deepEqual(validateMeta(null), defaultMeta());
  assert.deepEqual(validateMeta(42), defaultMeta());
});

test('validateMeta: bekannte Felder uebernommen, unbekannte verworfen', () => {
  const v = validateMeta({ isbn: '978-3-16-148410-0', subtitle: 'Ein Roman', evil: 'x', book_id: 9 });
  assert.equal(v.isbn, '978-3-16-148410-0');
  assert.equal(v.subtitle, 'Ein Roman');
  assert.equal(v.evil, undefined);
  assert.equal(v.book_id, undefined);
});

test('validateMeta: String-Clamp greift', () => {
  const v = validateMeta({ subtitle: 'x'.repeat(500) });
  assert.equal(v.subtitle.length, 300);
});

test('validateMeta: epub_css_style whitelisted, sonst serif', () => {
  assert.equal(validateMeta({ epub_css_style: 'sans' }).epub_css_style, 'sans');
  assert.equal(validateMeta({ epub_css_style: 'comic' }).epub_css_style, 'serif');
  assert.ok(CSS_STYLES.includes('serif') && CSS_STYLES.includes('sans'));
});

test('validateMeta: epub_justify akzeptiert bool/1/"1"', () => {
  assert.equal(validateMeta({ epub_justify: false }).epub_justify, false);
  assert.equal(validateMeta({ epub_justify: 0 }).epub_justify, false);
  assert.equal(validateMeta({ epub_justify: 1 }).epub_justify, true);
  assert.equal(validateMeta({ epub_justify: '1' }).epub_justify, true);
});

test('validateMeta: epub_unnumbered_chapter_ids — Array/JSON-String, dedup, filtert ungueltig', () => {
  assert.deepEqual(defaultMeta().epub_unnumbered_chapter_ids, []);
  assert.deepEqual(validateMeta({}).epub_unnumbered_chapter_ids, []);
  // Array vom Frontend: dedup + nur positive Integer, '5' wird geparst.
  assert.deepEqual(validateMeta({ epub_unnumbered_chapter_ids: [3, 3, 'x', -1, 0, '5'] }).epub_unnumbered_chapter_ids, [3, 5]);
  // JSON-String aus der DB-Spalte.
  assert.deepEqual(validateMeta({ epub_unnumbered_chapter_ids: '[7, 9, 9]' }).epub_unnumbered_chapter_ids, [7, 9]);
  // Kaputter String / Nicht-Array → [].
  assert.deepEqual(validateMeta({ epub_unnumbered_chapter_ids: 'not-json' }).epub_unnumbered_chapter_ids, []);
  assert.deepEqual(validateMeta({ epub_unnumbered_chapter_ids: 42 }).epub_unnumbered_chapter_ids, []);
});

test('isValidIsbn13: korrekte/falsche Pruefziffer, non-13 → null', () => {
  assert.equal(isValidIsbn13('978-3-16-148410-0'), true);
  assert.equal(isValidIsbn13('9783161484101'), false);
  assert.equal(isValidIsbn13('12345'), null);
  assert.equal(isValidIsbn13(''), null);
});
