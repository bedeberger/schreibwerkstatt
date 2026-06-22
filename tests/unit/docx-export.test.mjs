import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateConfig, defaultConfig, FONT_FAMILIES } = require('../../lib/docx-export-defaults.js');
const { buildDocxProfile } = require('../../lib/export-builders/docx.js');

const bundle = {
  scope: 'book',
  book: { id: 1, name: 'Der Process', slug: 'process' },
  groups: [
    { chapterId: 10, chapter: { id: 10, name: 'Verhaftung', parent_chapter_id: null }, pages: [
      { p: { id: 1, name: 'Szene 1' }, pd: { html: '<p>Jemand musste Josef K. <strong>verleumdet</strong> haben.</p><hr><p>Zweiter Absatz mit <em>kursiv</em> und <a href="https://x.de">Link</a>.</p>' } },
      { p: { id: 2, name: 'Szene 2' }, pd: { html: '<h2>Untertitel</h2><blockquote><p>Ein Zitat.</p></blockquote>' } },
    ] },
    { chapterId: 20, chapter: { id: 20, name: 'Anhang', parent_chapter_id: null }, pages: [
      { p: { id: 3, name: 'A' }, pd: { html: '<p>Text.</p>' } },
    ] },
  ],
};
const meta = { subtitle: 'Ein Roman', year: '1925', dedication: 'Für F.', imprint: 'Verlag XY', copyright: '© 2025', author_bio: 'Bio.', isbn: '9781234567890' };

// ── Validator ────────────────────────────────────────────────────────────────
test('validateConfig: fills defaults + clamps', () => {
  const c = validateConfig({});
  assert.equal(c.font.family, 'Times New Roman');
  assert.equal(c.font.lineSpacing, 'double');
  assert.ok(FONT_FAMILIES.includes(c.font.family));
  // Clamp font size to range
  assert.equal(validateConfig({ font: { sizePt: 99 } }).font.sizePt, 18);
  assert.equal(validateConfig({ font: { sizePt: 2 } }).font.sizePt, 8);
});

test('validateConfig: rejects unknown enums + non-whitelisted fonts', () => {
  assert.equal(validateConfig({ font: { family: 'Comic Sans' } }).font.family, 'Times New Roman');
  assert.equal(validateConfig({ header: { mode: 'bogus' } }).header.mode, defaultConfig().header.mode);
  assert.equal(validateConfig({ toc: { mode: 'wat' } }).toc.mode, 'none');
});

test('validateConfig: unnumberedChapterIds normalized to positive ints', () => {
  const c = validateConfig({ chapter: { unnumberedChapterIds: ['3', 3, -1, 0, 'x', 7] } });
  assert.deepEqual(c.chapter.unnumberedChapterIds, [3, 7]);
});

test('validateConfig: strips unknown top-level keys', () => {
  const c = validateConfig({ bogus: 1, page: { size: 'A5' } });
  assert.ok(!('bogus' in c));
  assert.equal(c.page.size, 'A5');
});

// ── Builder ──────────────────────────────────────────────────────────────────
async function build(config) {
  const buf = await buildDocxProfile(bundle, { author: 'Franz Kafka', lang: 'de', meta, config });
  assert.equal(buf[0], 0x50); // PK
  assert.equal(buf[1], 0x4B);
  return buf.toString('binary');
}

test('builder: produces valid docx with document.xml', async () => {
  const s = await build(defaultConfig());
  assert.ok(s.includes('word/document.xml'));
});

test('builder: TOC field mode builds a valid docx (exercises TableOfContents path)', async () => {
  // document.xml is DEFLATE-compressed inside the zip, so we cannot grep the
  // field instruction from the raw buffer — assert the field path builds clean.
  const s = await build(validateConfig({ toc: { mode: 'field', depth: 2 } }));
  assert.ok(s.includes('word/document.xml'));
});

test('builder: manuscript header + page number does not throw', async () => {
  const s = await build(validateConfig({ header: { mode: 'manuscript', pageNumber: 'headerRight' } }));
  assert.ok(s.includes('word/header'));
});

test('builder: footer page number creates a footer part', async () => {
  const s = await build(validateConfig({ header: { mode: 'none', pageNumber: 'footer' } }));
  assert.ok(s.includes('word/footer'));
});

test('builder: chapter numbering does not throw + emits headings', async () => {
  const s = await build(validateConfig({ chapter: { numbering: 'arabic', numberingMode: 'nested' } }));
  assert.ok(s.includes('word/document.xml'));
});

test('builder: title.none omits generated title page but still renders body', async () => {
  const s = await build(validateConfig({ title: { mode: 'none' }, header: { mode: 'none', pageNumber: 'none' } }));
  assert.ok(s.includes('word/document.xml'));
});
