'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { defaultConfig, validateConfig } = require('../../lib/pdf-export-defaults');

test('defaultConfig liefert vollständigen Schema-Baum', () => {
  const c = defaultConfig();
  assert.equal(c.layout.pageSize, 'A4');
  assert.equal(c.font.body.family, 'Lora');
  assert.equal(c.chapter.pageStructure, 'flatten');
  assert.equal(c.cover.enabled, false);
  assert.equal(c.toc.enabled, true);
  assert.equal(c.pdfa.enabled, true);
});

test('validateConfig clamped Margins auf erlaubten Bereich', () => {
  const c = validateConfig({ layout: { marginsMm: { top: 1000, right: -50, bottom: 25, left: 22 } } });
  assert.equal(c.layout.marginsMm.top, 80);
  assert.equal(c.layout.marginsMm.right, 5);
  assert.equal(c.layout.marginsMm.bottom, 25);
});

test('validateConfig verwirft unbekannte enum-Werte', () => {
  const c = validateConfig({ chapter: { breakBefore: 'bogus', numbering: 'arabic' } });
  assert.equal(c.chapter.breakBefore, 'always');
  assert.equal(c.chapter.numbering, 'arabic');
});

test('validateConfig verwirft Top-Level-Junk', () => {
  const c = validateConfig({ layout: { pageSize: 'A5' }, junkKey: 42, weirdField: 'x' });
  assert.equal(c.layout.pageSize, 'A5');
  assert.equal(c.junkKey, undefined);
  assert.equal(c.weirdField, undefined);
});

test('validateConfig clamped numerische Bereiche bei Schriftgrössen', () => {
  const c = validateConfig({ font: { body: { family: 'Lora', weight: 400, sizePt: 999 } } });
  assert.equal(c.font.body.sizePt, 72);
});

test('validateConfig erhält pageStructure und pageBreakBetweenPages', () => {
  const c = validateConfig({ chapter: { pageStructure: 'nested', pageBreakBetweenPages: true } });
  assert.equal(c.chapter.pageStructure, 'nested');
  assert.equal(c.chapter.pageBreakBetweenPages, true);
});

test('validateConfig erhält titleRule und pageTitleRule', () => {
  const c = validateConfig({ chapter: { titleRule: true, pageTitleRule: true } });
  assert.equal(c.chapter.titleRule, true);
  assert.equal(c.chapter.pageTitleRule, true);
});

test('validateConfig: numberingMode nested|flat + Default nested', () => {
  const def = defaultConfig();
  assert.equal(def.chapter.numberingMode, 'nested');
  const flat = validateConfig({ chapter: { numberingMode: 'flat' } });
  assert.equal(flat.chapter.numberingMode, 'flat');
  const bogus = validateConfig({ chapter: { numberingMode: 'wat' } });
  assert.equal(bogus.chapter.numberingMode, 'nested');
});

test('validateConfig: unnumberedChapterIds dedup + Integer-Cast + Junk-Filter', () => {
  const def = defaultConfig();
  assert.deepEqual(def.chapter.unnumberedChapterIds, []);
  const c = validateConfig({ chapter: { unnumberedChapterIds: [1, '2', 2, 'abc', 0, -3, 4] } });
  assert.deepEqual(c.chapter.unnumberedChapterIds, [1, 2, 4]);
  const empty = validateConfig({ chapter: { unnumberedChapterIds: 'nope' } });
  assert.deepEqual(empty.chapter.unnumberedChapterIds, []);
});

test('validateConfig: breakBeforeSubchapter Default false, akzeptiert true', () => {
  const def = defaultConfig();
  assert.equal(def.chapter.breakBeforeSubchapter, false);
  const on = validateConfig({ chapter: { breakBeforeSubchapter: true } });
  assert.equal(on.chapter.breakBeforeSubchapter, true);
});

test('validateConfig: toc.depth akzeptiert 3', () => {
  const c = validateConfig({ toc: { depth: 3 } });
  assert.equal(c.toc.depth, 3);
});

test('defaultConfig: Trennlinien-Toggles default off', () => {
  const c = defaultConfig();
  assert.equal(c.chapter.titleRule, false);
  assert.equal(c.chapter.pageTitleRule, false);
});

test('defaultConfig: Farbe pro Schriftrolle vorkonfiguriert', () => {
  const c = defaultConfig();
  assert.match(c.font.body.color,     /^#[0-9a-f]{6}$/);
  assert.match(c.font.heading.color,  /^#[0-9a-f]{6}$/);
  assert.match(c.font.title.color,    /^#[0-9a-f]{6}$/);
  assert.match(c.font.subtitle.color, /^#[0-9a-f]{6}$/);
  assert.match(c.font.byline.color,   /^#[0-9a-f]{6}$/);
});

test('validateConfig: Hex-Farben akzeptiert (6-stellig, 3-stellig, lowercase)', () => {
  const c = validateConfig({ font: {
    body:     { color: '#ABCDEF' },
    heading:  { color: '#f00' },
    title:    { color: '#012345' },
  }});
  assert.equal(c.font.body.color,    '#abcdef');
  assert.equal(c.font.heading.color, '#ff0000');
  assert.equal(c.font.title.color,   '#012345');
});

test('defaultConfig: mirrorMargins/hyphenate/chapter-start-toggles vorhanden', () => {
  const c = defaultConfig();
  assert.equal(c.layout.mirrorMargins, false);
  assert.equal(c.layout.hyphenate, true);
  assert.equal(c.layout.showHeaderOnChapterStart, false);
  assert.equal(c.layout.showFooterOnChapterStart, false);
  assert.equal(c.layout.headerVersoLeft, '');
  assert.equal(c.layout.headerVersoCenter, '');
  assert.equal(c.layout.headerVersoRight, '');
  assert.equal(c.layout.footerVersoLeft, '');
  assert.equal(c.layout.footerVersoCenter, '');
  assert.equal(c.layout.footerVersoRight, '');
});

test('validateConfig: mirrorMargins akzeptiert true, verso-Slots passieren', () => {
  const c = validateConfig({ layout: {
    mirrorMargins: true,
    hyphenate: false,
    showFooterOnChapterStart: true,
    headerVersoCenter: '{title}',
    footerVersoCenter: '{page}',
  }});
  assert.equal(c.layout.mirrorMargins, true);
  assert.equal(c.layout.hyphenate, false);
  assert.equal(c.layout.showFooterOnChapterStart, true);
  assert.equal(c.layout.headerVersoCenter, '{title}');
  assert.equal(c.layout.footerVersoCenter, '{page}');
});

test('validateConfig: Bad Hex fällt auf Default zurück', () => {
  const d = defaultConfig();
  const c = validateConfig({ font: {
    body:    { color: 'red' },
    heading: { color: '#12' },
    title:   { color: '#GGGGGG' },
    byline:  { color: null },
  }});
  assert.equal(c.font.body.color,    d.font.body.color);
  assert.equal(c.font.heading.color, d.font.heading.color);
  assert.equal(c.font.title.color,   d.font.title.color);
  assert.equal(c.font.byline.color,  d.font.byline.color);
});
