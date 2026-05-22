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

const { resolveQuoteStyle, normalizeQuotes, normalizeQuotesInRange } = await import('../../public/js/editor/shared/quote-normalize.js');

function makeRoot(fragment) {
  const { document: d } = parseHTML(`<!doctype html><html><body><div id="root">${fragment}</div></body></html>`);
  return d.getElementById('root');
}

// Minimal-Range-Shim — linkedom hat keine setStart/setEnd-API mit Offset.
// Reicht für die Eigenschaften, die normalizeQuotesInRange liest.
function makeRange(startContainer, startOffset, endContainer, endOffset) {
  return {
    collapsed: startContainer === endContainer && startOffset === endOffset,
    commonAncestorContainer:
      startContainer === endContainer
        ? startContainer
        : (startContainer.parentNode || startContainer),
    startContainer, startOffset, endContainer, endOffset,
    intersectsNode(node) {
      // Tests benutzen aktuell nur Single-Text-Node-Ranges. Erweitern bei Bedarf.
      return node === startContainer || node === endContainer;
    },
  };
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

test('normalizeQuotes: style-konforme Quotes bleiben (idempotent)', () => {
  const root = makeRoot('<p>Er sagte «Hallo» laut.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const count = normalizeQuotes(root, style);
  assert.equal(count, 0);
  assert.equal(root.querySelector('p').textContent, 'Er sagte «Hallo» laut.');
});

test('normalizeQuotes: fremder Style (de-DE „…") → de-CH «…»', () => {
  const root = makeRoot('<p>Er sagte „Hallo“ laut.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const count = normalizeQuotes(root, style);
  assert.equal(count, 2);
  assert.equal(root.querySelector('p').textContent, 'Er sagte «Hallo» laut.');
});

test('normalizeQuotes: en Smart-Quotes → de-CH Guillemets', () => {
  const root = makeRoot('<p>He said “Hello” loud.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'He said «Hello» loud.');
});

test('normalizeQuotes: de-CH Guillemets → de-DE „…"', () => {
  const root = makeRoot('<p>Er sagte «Hallo» laut.</p>');
  const style = resolveQuoteStyle('de', 'DE');
  const count = normalizeQuotes(root, style);
  assert.equal(count, 2);
  assert.equal(root.querySelector('p').textContent, 'Er sagte „Hallo“ laut.');
});

test('normalizeQuotes: gemischt ASCII + typografisch → Style-konform', () => {
  const root = makeRoot('<p>Er sagte „Hallo" und "Welt“ laut.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Er sagte «Hallo» und «Welt» laut.');
});

test('normalizeQuotes: nested single (typografisch) → de-CH inner Guillemets', () => {
  const root = makeRoot('<p>Er sagte: «Sie meinte ‚sofort‘, sagte er.»</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    'Er sagte: «Sie meinte ‹sofort›, sagte er.»',
  );
});

test('normalizeQuotes: Apostroph U+2019 zwischen Buchstaben bleibt', () => {
  const root = makeRoot('<p>Marie’s Buch und don’t go</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const count = normalizeQuotes(root, style);
  assert.equal(count, 0);
  assert.equal(root.querySelector('p').textContent, 'Marie’s Buch und don’t go');
});

test('normalizeQuotes: FR-Style fügt NBSP innen ein', () => {
  const root = makeRoot('<p>Il a dit "Bonjour" fort.</p>');
  const style = resolveQuoteStyle('fr', '');
  normalizeQuotes(root, style);
  // « + NBSP + Bonjour + NBSP + »
  assert.equal(root.querySelector('p').textContent, 'Il a dit « Bonjour » fort.');
});

test('normalizeQuotes: FR-Style idempotent (keine Doppel-NBSP)', () => {
  const root = makeRoot('<p>Il a dit « Bonjour » fort.</p>');
  const style = resolveQuoteStyle('fr', '');
  const count = normalizeQuotes(root, style);
  assert.equal(count, 0);
  assert.equal(root.querySelector('p').textContent, 'Il a dit « Bonjour » fort.');
});

test('normalizeQuotes: FR-Style frisst bestehenden regulären Space', () => {
  const root = makeRoot('<p>Il a dit « Bonjour » fort.</p>');
  const style = resolveQuoteStyle('fr', '');
  normalizeQuotes(root, style);
  // Reguläre Spaces werden zu NBSP (kein Doppel-Space).
  assert.equal(root.querySelector('p').textContent, 'Il a dit « Bonjour » fort.');
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

test('normalizeQuotesInRange: nur Selection wird transformiert', () => {
  const root = makeRoot('<p>"Eins" und "Zwei"</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const p = root.querySelector('p');
  const t = p.firstChild;
  // Selektiere genau "Eins" inkl. der umgebenden geraden Quotes (offsets 0..6).
  const range = makeRange(t, 0, t, 6);
  const count = normalizeQuotesInRange(range, style);
  assert.equal(count, 2);
  assert.equal(p.textContent, '«Eins» und "Zwei"');
});

test('normalizeQuotesInRange: leere Range → 0', () => {
  const root = makeRoot('<p>"foo"</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const p = root.querySelector('p');
  const range = makeRange(p.firstChild, 2, p.firstChild, 2);
  assert.equal(normalizeQuotesInRange(range, style), 0);
  assert.equal(p.textContent, '"foo"');
});

test('normalizeQuotesInRange: prev-Kontext aus Text vor Range', () => {
  // Range umschliesst `"Hallo"` (offsets 9..17). prev-Kontext ist Whitespace
  // VOR der Range → erstes `"` wird öffnend, zweites schliessend.
  const root = makeRoot('<p>Er sagte "Hallo" laut.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const p = root.querySelector('p');
  const t = p.firstChild;
  const range = makeRange(t, 9, t, 17);
  normalizeQuotesInRange(range, style);
  assert.equal(p.textContent, 'Er sagte «Hallo» laut.');
});
