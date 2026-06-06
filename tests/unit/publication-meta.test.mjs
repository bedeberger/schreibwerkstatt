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

test('validateMeta: author_file_as — String, geclamped auf 200', () => {
  assert.equal(defaultMeta().author_file_as, '');
  assert.equal(validateMeta({ author_file_as: 'Beispiel, Anna' }).author_file_as, 'Beispiel, Anna');
  assert.equal(validateMeta({ author_file_as: 'x'.repeat(300) }).author_file_as.length, 200);
});

test('validateMeta: PDF-Pendant-Enums — Defaults + Whitelist', () => {
  const d = defaultMeta();
  assert.equal(d.epub_imprint_position, 'front');
  assert.equal(d.epub_chapter_title_style, 'centered-large');
  assert.equal(d.epub_heading_font, 'match');
  assert.equal(d.epub_heading_scale, 'normal');
  assert.equal(d.epub_cover_fit, 'contain');
  assert.equal(d.epub_numerals, 'default');
  // Gueltige Werte uebernommen, ungueltige fallen auf Default.
  assert.equal(validateMeta({ epub_imprint_position: 'back' }).epub_imprint_position, 'back');
  assert.equal(validateMeta({ epub_imprint_position: 'side' }).epub_imprint_position, 'front');
  assert.equal(validateMeta({ epub_chapter_title_style: 'left-rule' }).epub_chapter_title_style, 'left-rule');
  assert.equal(validateMeta({ epub_chapter_title_style: 'bogus' }).epub_chapter_title_style, 'centered-large');
  // epub_heading_font akzeptiert 'match' + jede CSS_STYLES-Familie.
  assert.equal(validateMeta({ epub_heading_font: 'garamond' }).epub_heading_font, 'garamond');
  assert.equal(validateMeta({ epub_heading_font: 'comic' }).epub_heading_font, 'match');
  assert.equal(validateMeta({ epub_numerals: 'oldstyle' }).epub_numerals, 'oldstyle');
});

test('validateMeta: epub_toc_depth — Int-Enum {1,2}, sonst Default 2', () => {
  assert.equal(defaultMeta().epub_toc_depth, 2);
  assert.equal(validateMeta({ epub_toc_depth: 1 }).epub_toc_depth, 1);
  assert.equal(validateMeta({ epub_toc_depth: '2' }).epub_toc_depth, 2);
  assert.equal(validateMeta({ epub_toc_depth: 3 }).epub_toc_depth, 2, '>2 faellt auf Default');
  assert.equal(validateMeta({ epub_toc_depth: 'x' }).epub_toc_depth, 2);
});

test('validateMeta: PDF-Pendant-Bools — Defaults + bool/1/"1"', () => {
  const d = defaultMeta();
  assert.equal(d.epub_subchapter_pagebreak, false);
  assert.equal(d.epub_chapter_rule, false);
  assert.equal(d.epub_page_rule, false);
  assert.equal(d.epub_toc_enabled, true);
  assert.equal(validateMeta({ epub_subchapter_pagebreak: 1 }).epub_subchapter_pagebreak, true);
  assert.equal(validateMeta({ epub_toc_enabled: 0 }).epub_toc_enabled, false);
  assert.equal(validateMeta({ epub_chapter_rule: '1' }).epub_chapter_rule, true);
});

test('validateMeta: co_authors — Array/JSON, dropt leere Namen, clampt auf 10', () => {
  assert.deepEqual(defaultMeta().co_authors, []);
  assert.deepEqual(
    validateMeta({ co_authors: [{ name: 'Max Muster', file_as: 'Muster, Max' }, { name: '' }, { file_as: 'X' }] }).co_authors,
    [{ name: 'Max Muster', file_as: 'Muster, Max' }],
  );
  // JSON-String aus der DB-Spalte → Array, file_as default ''.
  assert.deepEqual(validateMeta({ co_authors: '[{"name":"A"}]' }).co_authors, [{ name: 'A', file_as: '' }]);
  // Kaputt / Nicht-Array → [].
  assert.deepEqual(validateMeta({ co_authors: 'nope' }).co_authors, []);
  // Anzahl gedeckelt.
  const many = Array.from({ length: 15 }, (_, i) => ({ name: `A${i}` }));
  assert.equal(validateMeta({ co_authors: many }).co_authors.length, 10);
});

test('validateMeta: extra_sections — placement-Enum, toc-Default, leere verworfen, clampt auf 30', () => {
  assert.deepEqual(defaultMeta().extra_sections, []);
  const v = validateMeta({ extra_sections: [
    { placement: 'front', title: 'Warnung', body: 'X' },
    { placement: 'bogus', title: '', body: '', link_url: '' },                   // leer → verworfen
    { title: 'Newsletter', link_url: 'https://x', link_label: 'Go', toc: false }, // placement default 'back'
  ] }).extra_sections;
  assert.equal(v.length, 2);
  assert.equal(v[0].placement, 'front');
  assert.equal(v[0].toc, true);          // Default true
  assert.equal(v[1].placement, 'back');  // bogus → back, fehlend → back
  assert.equal(v[1].toc, false);
  // JSON-String round-trip + Cap.
  assert.equal(validateMeta({ extra_sections: '[{"title":"T","placement":"back"}]' }).extra_sections.length, 1);
  const many = Array.from({ length: 40 }, (_, i) => ({ title: `S${i}`, body: 'x' }));
  assert.equal(validateMeta({ extra_sections: many }).extra_sections.length, 30);
});

test('isValidIsbn13: korrekte/falsche Pruefziffer, non-13 → null', () => {
  assert.equal(isValidIsbn13('978-3-16-148410-0'), true);
  assert.equal(isValidIsbn13('9783161484101'), false);
  assert.equal(isValidIsbn13('12345'), null);
  assert.equal(isValidIsbn13(''), null);
});
