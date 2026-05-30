import { test } from 'node:test';
import assert from 'node:assert/strict';
import epub from '../../lib/export-builders/epub.js';

const { _resolveEpubMeta, _countUnfetchableImages } = epub;

test('_resolveEpubMeta: opts.author/lang gewinnen vor Domain-Shape', () => {
  const m = _resolveEpubMeta({ created_by: { name: 'Alt' } }, { author: 'Owner Name', lang: 'en' });
  assert.equal(m.author, 'Owner Name');
  assert.equal(m.lang, 'en');
  assert.equal(m.tocTitle, 'Contents');
});

test('_resolveEpubMeta: Fallback auf created_by/owned_by wenn keine opts', () => {
  assert.equal(_resolveEpubMeta({ created_by: { name: 'A' } }, {}).author, 'A');
  assert.equal(_resolveEpubMeta({ owned_by: { name: 'B' } }, {}).author, 'B');
});

test('_resolveEpubMeta: Default de + Inhalt, kein Autor', () => {
  const m = _resolveEpubMeta(null, {});
  assert.equal(m.lang, 'de');
  assert.equal(m.tocTitle, 'Inhalt');
  assert.equal(m.author, '');
});

test('_resolveEpubMeta: tocTitle-Override schlaegt Sprach-Default', () => {
  assert.equal(_resolveEpubMeta(null, { lang: 'en', tocTitle: 'Index' }).tocTitle, 'Index');
});

test('_resolveEpubMeta: nur en-Praefix triggert Contents, sonst Inhalt', () => {
  assert.equal(_resolveEpubMeta(null, { lang: 'en-US' }).tocTitle, 'Contents');
  assert.equal(_resolveEpubMeta(null, { lang: 'de-CH' }).tocTitle, 'Inhalt');
  assert.equal(_resolveEpubMeta(null, { lang: 'fr' }).tocTitle, 'Inhalt');
});

test('_countUnfetchableImages: zaehlt nur non-http/non-data src', () => {
  const chapters = [
    { content: '<p>x</p><img src="https://a.com/x.jpg"><img src="data:image/png;base64,AAA">' },
    { content: '<img src="/local/rel.png"> und <img src="cover.jpg">' },
    { content: '<img SRC = "HTTP://b.com/y.png">' },
  ];
  // 2 unfetchbar: /local/rel.png + cover.jpg. http(s) + data + HTTP zaehlen nicht.
  assert.equal(_countUnfetchableImages(chapters), 2);
});

test('_countUnfetchableImages: leere/keine Bilder -> 0', () => {
  assert.equal(_countUnfetchableImages([{ content: '<p>kein Bild</p>' }, { content: '' }, {}]), 0);
});
