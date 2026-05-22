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
  const root = makeRoot('<p>Er sagte „Hallo“ und «Welt».</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const count = normalizeQuotes(root, style);
  assert.equal(count, 0);
});

test('normalizeQuotes: drei Quote-Paare nacheinander, korrekt klassifiziert', () => {
  const root = makeRoot('<p>"Eins" sagte er, "Zwei" rief sie, "Drei" murmelte ich.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    '«Eins» sagte er, «Zwei» rief sie, «Drei» murmelte ich.',
  );
});

test('normalizeQuotes: Klammern um Quote', () => {
  const root = makeRoot('<p>Er sagte ("Hallo") laut.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Er sagte («Hallo») laut.');
});

test('normalizeQuotes: Punkt vor schliessendem Quote', () => {
  const root = makeRoot('<p>Er sagte "Hallo." und ging.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Er sagte «Hallo.» und ging.');
});

test('normalizeQuotes: nur ein Quote, am Wortanfang → öffnend', () => {
  const root = makeRoot('<p>Hier nur "ein offener Quote ohne Ende.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Hier nur «ein offener Quote ohne Ende.');
});

test('normalizeQuotes: nur ein Quote, am Wortende → schliessend', () => {
  const root = makeRoot('<p>Schliessendes ohne Anfang", sagte er.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Schliessendes ohne Anfang», sagte er.');
});

test('normalizeQuotes: Em-Dash vor öffnendem Quote', () => {
  const root = makeRoot('<p>Er rief — "Halt!" — und blieb stehen.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Er rief — «Halt!» — und blieb stehen.');
});

test('normalizeQuotes: nested single in double', () => {
  const root = makeRoot('<p>Er sagte: "Sie meinte \'sofort\', sagte er."</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    'Er sagte: «Sie meinte ‹sofort›, sagte er.»',
  );
});

test('normalizeQuotes: Possessiv-Apostroph kids\'', () => {
  const root = makeRoot('<p>the kids\' books</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  // kids' = Apostroph (nicht schliessendes Single-Quote)
  assert.equal(root.querySelector('p').textContent, 'the kids’ books');
});

test('normalizeQuotes: Quote über <em> hinweg → next-Kontext aus folgendem Text-Node', () => {
  const root = makeRoot('<p>Er rief "<em>Hallo Welt</em>" laut.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Er rief «Hallo Welt» laut.');
});
