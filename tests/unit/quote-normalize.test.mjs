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

test('resolveQuoteStyle: en-US liefert modernen Stil', () => {
  const s = resolveQuoteStyle('en', 'US');
  assert.equal(s.ldquo, '“');
  assert.equal(s.rdquo, '”');
  assert.equal(s.lsquo, '‘');
  assert.equal(s.rsquo, '’');
  assert.equal(s.apostrophe, '’');
});

test('resolveQuoteStyle: en-GB modern (Oxford 2014+) = en-US', () => {
  const s = resolveQuoteStyle('en', 'GB');
  assert.equal(s.ldquo, '“');
  assert.equal(s.rdquo, '”');
  assert.equal(s.lsquo, '‘');
  assert.equal(s.rsquo, '’');
  assert.equal(s.apostrophe, '’');
});

test('normalizeQuotes: en-GB Outer-Quotes', () => {
  const root = makeRoot('<p>She said "Hello" loudly.</p>');
  const style = resolveQuoteStyle('en', 'GB');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'She said “Hello” loudly.');
});

test('normalizeQuotes: en-GB nested single in double', () => {
  const root = makeRoot('<p>She said "I heard \'hi\' loudly".</p>');
  const style = resolveQuoteStyle('en', 'GB');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'She said “I heard ‘hi’ loudly”.');
});

test('normalizeQuotes: en — Leading-Apostroph \'tis', () => {
  const root = makeRoot('<p>\'tis the season</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '’tis the season');
});

test('normalizeQuotes: en — \'em (Pronomen-Kontraktion)', () => {
  const root = makeRoot('<p>Get \'em all.</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'Get ’em all.');
});

test('normalizeQuotes: en — \'90s Year-Shorthand', () => {
  const root = makeRoot('<p>The \'90s were wild.</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'The ’90s were wild.');
});

test('normalizeQuotes: en — rock \'n\' roll', () => {
  const root = makeRoot('<p>rock \'n\' roll</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  // Beide ' werden zu ’ — leading via Kontraktions-Liste, trailing via
  // rsquo (das in en U+2019 == apostrophe ist).
  assert.equal(root.querySelector('p').textContent, 'rock ’n’ roll');
});

test('normalizeQuotes: en — \'cause (because-Kurzform)', () => {
  const root = makeRoot('<p>I left \'cause it was late.</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'I left ’cause it was late.');
});

test('normalizeQuotes: en — Leading-Quote bei NICHT-Kontraktion bleibt lsquo', () => {
  // 'hello' ist kein Leading-Apostroph-Wort → echte Single-Quote-Klammer.
  const root = makeRoot('<p>He said \'hello\' to me.</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, 'He said ‘hello’ to me.');
});

test('normalizeQuotes: de-CH — \'tis bleibt OHNE Kontraktions-Behandlung (nicht-en)', () => {
  // de-CH ist kein English-Style → Leading-Apostroph wird zu lsquo (‹).
  const root = makeRoot('<p>\'tis the season</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '‹tis the season');
});

test('resolveQuoteStyle: Fallback bei unbekannter Sprache', () => {
  const s = resolveQuoteStyle('zz', 'XX');
  // Default ist de-CH
  assert.equal(s.ldquo, '«');
});

test('resolveQuoteStyle: de ohne Region → de-CH (Swiss-Default)', () => {
  // Swiss-App: ohne explizite Region fällt `de` auf DEFAULT_STYLE = de-CH,
  // nicht auf de-DE. Buchsprache ohne Region soll nicht stillschweigend
  // Anführungszeichen ins deutsche Format kippen.
  const s = resolveQuoteStyle('de', '');
  assert.equal(s.ldquo, '«');
  assert.equal(s.rdquo, '»');
  assert.equal(s.lsquo, '‹');
  assert.equal(s.rsquo, '›');
});

test('resolveQuoteStyle: de mit unbekannter Region → de-CH', () => {
  // Fallback auf DEFAULT_STYLE statt auf de-DE.
  const s = resolveQuoteStyle('de', 'XX');
  assert.equal(s.ldquo, '«');
});

test('normalizeQuotes: blockquote mit nested p — kein State-Leak zwischen p\'s', () => {
  // Vor dem Fix: outermost-only-Filter behielt nur die blockquote, und
  // _normalizeBlock lief mit durchgehendem prevChar/quoteStack über beide p's.
  const root = makeRoot('<blockquote><p>"Eins</p><p>"Zwei"</p></blockquote>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  const ps = root.querySelectorAll('p');
  assert.equal(ps[0].textContent, '«Eins');
  assert.equal(ps[1].textContent, '«Zwei»');
});

test('normalizeQuotes: ul mit nested li — kein State-Leak zwischen li\'s', () => {
  const root = makeRoot('<ul><li>"Eins</li><li>"Zwei"</li></ul>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  const lis = root.querySelectorAll('li');
  assert.equal(lis[0].textContent, '«Eins');
  assert.equal(lis[1].textContent, '«Zwei»');
});

test('normalizeQuotes: direkter Text in blockquote + nested p werden beide normalisiert', () => {
  // blockquote enthält direkten Text VOR dem p. Beide müssen normalisiert
  // werden — ohne Doppel-Processing der p-Inhalte.
  const root = makeRoot('<blockquote>"Direkt" und <p>"InP"</p></blockquote>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  const bq = root.querySelector('blockquote');
  // Direkter Text wird via blockquote-Pass normalisiert (p wird übersprungen).
  assert.ok(bq.textContent.includes('«Direkt»'), `expected «Direkt» in: ${bq.textContent}`);
  // p-Inhalt wird via p-Pass normalisiert.
  assert.equal(root.querySelector('p').textContent, '«InP»');
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

test('normalizeQuotes: adjazente Mixed-Style Quotes lösen keinen Infinite-Loop aus', () => {
  // Regression: `„«` adjacent. Erste Iteration emittiert `«` für `„`. Bei der
  // zweiten Iteration ist out[-1]=`«` und repl=`«` (single-char) — alte Idempotenz-
  // Heuristik setzte matchOffset=1 → `repl.slice(1)=''` → `startsWith('', i)=true`
  // → emitted='' → `i += -1` → hang. Fix: matchOffset nur bei space-prefix repls.
  const root = makeRoot('<p>„Die Wohnung? „«, fragte er.</p>');
  const style = resolveQuoteStyle('de', 'CH');
  const count = normalizeQuotes(root, style);
  // Beide `„` und `«` klassifizieren sich kontextuell als öffnend → 2 Glyphen
  // werden zu `«` umgeschrieben (das dritte `«` ist bereits style-konform).
  // Wichtig: kein Hang, alle Glyphen sind Swiss.
  const text = root.querySelector('p').textContent;
  assert.ok(!/[„“”‚‘]/.test(text), `non-Swiss quote remained: ${text}`);
  assert.ok(count > 0);
});

test('normalizeQuotes: Page-105-Corpus → alle non-Swiss Quotes weg', () => {
  // Real-World-Mix aus Buch 102 / Seite 105: „… »…« mit gemischten Richtungen.
  // Erwartet: nach Normalisierung sind ausschliesslich Swiss-Glyphen (« » ‹ › ’)
  // im Text — keine deutschen „…“ oder englischen "…" Reste.
  const root = makeRoot(`
    <p>„Spurensicherung ist dort. Keine Einbruchsspuren.«</p>
    <p>„Und ihr Handy?«, während er von The Doors »The End« hörte.</p>
    <p>„Weg. Nicht in der Wohnung.« Markus setzte sich. „Letzter Anruf: tot.»</p>
    <p>„Natürlich.«</p>
    <p>„Ich war bei der Kanzlei«, sagte Markus.</p>
    <p>„Eine Affäre?«</p>
    <p>„Möglich. Oder etwas Berufliches.«</p>
    <p>„Mit wem?«</p>
    <p>Was soll’s.</p>
  `);
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  const all = root.textContent;
  assert.ok(!/[„“”‚‘"']/.test(all), `non-Swiss quotes remained: ${[...all].filter(c => /[„“”‚‘"']/.test(c)).join(' ')}`);
  // Vereinzelte Erwartungen: dialogische Sätze beginnen mit `«` und enden mit `»`.
  const ps = root.querySelectorAll('p');
  assert.equal(ps[0].textContent, '«Spurensicherung ist dort. Keine Einbruchsspuren.»');
  assert.equal(ps[1].textContent, '«Und ihr Handy?», während er von The Doors «The End» hörte.');
  assert.equal(ps[3].textContent, '«Natürlich.»');
  assert.equal(ps[4].textContent, '«Ich war bei der Kanzlei», sagte Markus.');
  assert.equal(ps[8].textContent, 'Was soll’s.');
});

// Stack-basiertes Depth-Tracking: User tippt durchgehend `"` für Outer und
// Inner. Klassifizierer-allein würde alle vier als Outer-Double sehen.
// Block-lokaler Stack erkennt Verschachtelung und demoted die mittleren zwei
// Double-Quotes zu Inner-Single.
test('normalizeQuotes: en — verschachtelte ASCII-Doubles → Inner zu Single', () => {
  const root = makeRoot('<p>He said: "Everything is "great" - but not always"</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    'He said: “Everything is ‘great’ - but not always”',
  );
});

test('normalizeQuotes: de-DE — verschachtelte ASCII-Doubles → Inner zu ‚…‘', () => {
  const root = makeRoot('<p>Er sagte: "Heute ist "schön" wirklich."</p>');
  const style = resolveQuoteStyle('de', 'DE');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    'Er sagte: „Heute ist ‚schön‘ wirklich.“',
  );
});

test('normalizeQuotes: de-CH — verschachtelte ASCII-Doubles → Inner zu ‹…›', () => {
  const root = makeRoot('<p>Er sagte: "Heute ist "schön" wirklich."</p>');
  const style = resolveQuoteStyle('de', 'CH');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    'Er sagte: «Heute ist ‹schön› wirklich.»',
  );
});

test('normalizeQuotes: en — 3-Level-Nesting (Double-Single-Double)', () => {
  // depth=0 outer "  depth=1 inner '  depth=2 wieder outer "
  const root = makeRoot('<p>"Sie sagte \'er rief "ja"\' laut."</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(
    root.querySelector('p').textContent,
    '“Sie sagte ‘er rief “ja”’ laut.”',
  );
});

test('normalizeQuotes: en — Apostroph innerhalb Outer-Dialog unverändert', () => {
  // Stack push für Outer, dann Apostroph (kein push/pop), dann Outer-Close.
  const root = makeRoot('<p>"It is foo\'s bar"</p>');
  const style = resolveQuoteStyle('en', '');
  normalizeQuotes(root, style);
  assert.equal(root.querySelector('p').textContent, '“It is foo’s bar”');
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
