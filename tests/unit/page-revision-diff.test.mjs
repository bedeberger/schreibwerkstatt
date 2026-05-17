// Tests fuer page-revision-diff: htmlToPlainText-Normalisierung + Word-Diff-
// Rendering. diffLib wird gemockt, damit der Test nicht von jsdiff abhaengt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToPlainText, renderWordDiff } from '../../public/js/page-revision-diff.js';

// Minimaler jsdiff-Mock. Greedy linear-Diff fuer Test-Cases, kein realer
// Myers-Diff — nur die Vertragsform `[{value, added?, removed?}]` zaehlt.
function mockDiffLib(parts) {
  return { diffWords: () => parts };
}

test('htmlToPlainText: Tags raus, Whitespace gecollapsed', () => {
  assert.equal(htmlToPlainText('<p>Hallo  <em>Welt</em></p>'), 'Hallo Welt');
  assert.equal(htmlToPlainText('<h1>Titel</h1>\n<p>Text</p>'), 'Titel Text');
  assert.equal(htmlToPlainText(null), '');
  assert.equal(htmlToPlainText(''), '');
});

test('renderWordDiff: identischer Text → unchanged=true, html leer', () => {
  const lib = mockDiffLib([{ value: 'Hallo Welt' }]);
  const out = renderWordDiff('<p>Hallo Welt</p>', '<p>Hallo Welt</p>', lib);
  assert.equal(out.unchanged, true);
  assert.equal(out.html, '');
});

test('renderWordDiff: add + del + eq → ins/del/span mit escHtml', () => {
  const lib = mockDiffLib([
    { value: 'Hallo ' },
    { value: 'alte', removed: true },
    { value: 'neue', added: true },
    { value: ' Welt <hier>' },
  ]);
  const out = renderWordDiff('a', 'b', lib);
  assert.equal(out.unchanged, false);
  // unchanged stuff → diff-eq span
  assert.match(out.html, /<span class="diff-eq">Hallo <\/span>/);
  // removed → del
  assert.match(out.html, /<del class="diff-del">alte<\/del>/);
  // added → ins
  assert.match(out.html, /<ins class="diff-add">neue<\/ins>/);
  // escape: `<` aus Token wird zu &lt;
  assert.match(out.html, /&lt;hier&gt;/);
});

test('renderWordDiff: fehlende diffLib → wirft', () => {
  assert.throws(() => renderWordDiff('a', 'b', null), /diffLib/);
  assert.throws(() => renderWordDiff('a', 'b', {}), /diffLib/);
});

test('renderWordDiff: nur removed (geleerter Text)', () => {
  const lib = mockDiffLib([{ value: 'alles weg', removed: true }]);
  const out = renderWordDiff('<p>alles weg</p>', '', lib);
  assert.equal(out.unchanged, false);
  assert.match(out.html, /<del class="diff-del">alles weg<\/del>/);
});
