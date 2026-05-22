// Unit-Tests für public/js/editor/notebook/quote-normalize.js.
// Stellt sicher: Locale-Map liefert pro Region die richtigen Quotes,
// Walker erkennt Open/Close anhand Kontext, Apostroph zwischen
// Buchstaben/Ziffern wird zu U+2019, <pre>/<code> bleiben unangetastet,
// Block-Boundary resettet den Open/Close-State.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.NodeFilter = window.NodeFilter;
globalThis.HTMLElement = window.HTMLElement;

const { resolveQuoteStyle, normalizeQuotes } = await import('../../public/js/editor/notebook/quote-normalize.js');

function makeRoot(fragment) {
  const { document: d } = parseHTML(`<!doctype html><html><body><div id="root">${fragment}</div></body></html>`);
  return d.getElementById('root');
}

test('resolveQuoteStyle: de-CH liefert Guillemets', () => {
  const s = resolveQuoteStyle('de', 'CH');
  assert.equal(s.ldquo, '«');
  assert.equal(s.rdquo, '»');
  assert.equal(s.lsquo, '‹');
  assert.equal(s.rsquo, '›');
});

test('resolveQuoteStyle: de-DE liefert „…"', () => {
  const s = resolveQuoteStyle('de', 'DE');
  assert.equal(s.ldquo, '„');
  assert.equal(s.rdquo, '“');
  assert.equal(s.lsquo, '‚');
  assert.equal(s.rsquo, '‘');
});

test('resolveQuoteStyle: en ohne Region', () => {
  const s = resolveQuoteStyle('en', '');
  assert.equal(s.ldquo, '“');
  assert.equal(s.rdquo, '”');
});

test('resolveQuoteStyle: Fallback bei unbekannter Sprache', () => {
  const s = resolveQuoteStyle('zz', 'XX');
  // Default ist de-CH
  assert.equal(s.ldquo, '«');
});

test('normalizeQuotes: gerade Doppelquotes → de-CH Guillemets', () => {
  const root = makeRoot('<p>Er sagte "Hallo" zu mir.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const count = normalizeQuotes(root, style);
  assert.equal(count, 2);
  assert.equal(root.querySelector('p').textContent, 'Er sagte «Hallo» zu mir.');
});

test('normalizeQuotes: de-DE „…"', () => {
  const root = makeRoot('<p>Er sagte "Hallo" zu mir.</p>');
  const style = resolveQuoteStyle('de', 'DE');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Er sagte „Hallo“ zu mir.');
});

test('normalizeQuotes: Apostroph zwischen Buchstaben → U+2019', () => {
  const root = makeRoot('<p>don\'t</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'don’t');
});

test('normalizeQuotes: einfache Quotes als Open/Close', () => {
  const root = makeRoot('<p>He said \'hi\' to me.</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'He said ‘hi’ to me.');
});

test('normalizeQuotes: <pre> bleibt unangetastet', () => {
  const root = makeRoot('<p>"foo"</p><pre>const x = "bar";</pre>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '«foo»');
  assert.equal(root.querySelector('pre').textContent, 'const x = "bar";');
});

test('normalizeQuotes: <code> bleibt unangetastet', () => {
  const root = makeRoot('<p>Beispiel: <code>"x"</code> und "y".</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  // Im <code> bleiben gerade Quotes; ausserhalb werden sie ersetzt.
  assert.equal(root.querySelector('code').textContent, '"x"');
  const pText = root.querySelector('p').textContent;
  assert.ok(pText.includes('«y»'), `expected «y» in: ${pText}`);
});

test('normalizeQuotes: Quote überspannt <strong>', () => {
  const root = makeRoot('<p>Er rief "Hallo <strong>Welt</strong>" laut.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Er rief «Hallo Welt» laut.');
});

test('normalizeQuotes: Block-Boundary resettet State', () => {
  // Erste P hat nur einen Quote → state-leak könnte zweite P falsch öffnen.
  // Erwartet: jede P startet frisch mit Open.
  const root = makeRoot('<p>"Eins</p><p>"Zwei"</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  const ps = root.querySelectorAll('p');
  assert.equal(ps[0].textContent, '«Eins');
  assert.equal(ps[1].textContent, '«Zwei»');
});

test('normalizeQuotes: keine Quotes → count 0, kein Mutate', () => {
  const root = makeRoot('<p>Nichts hier.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const html = root.innerHTML;
  const count = normalizeQuotes(root, style);
  assert.equal(count, 0);
  assert.equal(root.innerHTML, html);
});

test('normalizeQuotes: bereits typografische Quotes bleiben', () => {
  // Strikte Erwartung: nur straight `"` und `'` werden ersetzt; bereits
  // typografische Zeichen bleiben (v1-Verhalten).
  const root = makeRoot('<p>Er sagte „Hallo“ und «Welt».</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const count = normalizeQuotes(root, style);
  assert.equal(count, 0);
});
