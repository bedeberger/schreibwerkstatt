// Tests fuer page-revision-diff: htmlToPlainText-Normalisierung, parseBlocks
// und Block-aware Diff-Rendering. diffLib (diffArrays + diffWords) wird gemockt,
// damit der Test nicht von jsdiff abhaengt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToPlainText, parseBlocks, renderWordDiff } from '../../public/js/page-revision-diff.js';

function mockDiffLib({ arrays = [], words = [] } = {}) {
  return {
    diffArrays: () => arrays,
    diffWords: () => words,
  };
}

test('htmlToPlainText: Tags raus, Whitespace gecollapsed', () => {
  assert.equal(htmlToPlainText('<p>Hallo  <em>Welt</em></p>'), 'Hallo Welt');
  assert.equal(htmlToPlainText('<h1>Titel</h1>\n<p>Text</p>'), 'Titel Text');
  assert.equal(htmlToPlainText(null), '');
  assert.equal(htmlToPlainText(''), '');
});

test('parseBlocks: extrahiert p/h*/li/blockquote/pre, ignoriert leere Bloecke', () => {
  const blocks = parseBlocks('<h1>Titel</h1><p>Erster Satz.</p><ul><li>A</li><li>B</li></ul>');
  assert.deepEqual(blocks, [
    { tag: 'h1', text: 'Titel' },
    { tag: 'p', text: 'Erster Satz.' },
    { tag: 'li', text: 'A' },
    { tag: 'li', text: 'B' },
  ]);
});

test('parseBlocks: ohne erkannte Bloecke → Fallback auf einen p-Block', () => {
  assert.deepEqual(parseBlocks('blosser text'), [{ tag: 'p', text: 'blosser text' }]);
  assert.deepEqual(parseBlocks(''), []);
});

test('renderWordDiff: identischer Inhalt → unchanged=true, html leer', () => {
  const lib = mockDiffLib({ arrays: [{ value: ['Hallo Welt'] }] });
  const out = renderWordDiff('<p>Hallo Welt</p>', '<p>Hallo Welt</p>', lib);
  assert.equal(out.unchanged, true);
  assert.equal(out.html, '');
});

test('renderWordDiff: gepaarter Change → diff-block--changed mit inline ins/del/eq', () => {
  const lib = mockDiffLib({
    arrays: [
      { value: ['a'], removed: true },
      { value: ['b'], added: true },
    ],
    words: [
      { value: 'Hallo ' },
      { value: 'alte', removed: true },
      { value: 'neue', added: true },
      { value: ' Welt <hier>' },
    ],
  });
  const out = renderWordDiff('a', 'b', lib);
  assert.equal(out.unchanged, false);
  assert.match(out.html, /diff-block--changed/);
  assert.match(out.html, /<span class="diff-eq">Hallo <\/span>/);
  assert.match(out.html, /<del class="diff-del">alte<\/del>/);
  assert.match(out.html, /<ins class="diff-add">neue<\/ins>/);
  assert.match(out.html, /&lt;hier&gt;/);
});

test('renderWordDiff: fehlende diffLib oder Methoden → wirft', () => {
  assert.throws(() => renderWordDiff('a', 'b', null), /diffLib/);
  assert.throws(() => renderWordDiff('a', 'b', {}), /diffLib/);
  assert.throws(() => renderWordDiff('a', 'b', { diffWords: () => [] }), /diffArrays/);
});

test('renderWordDiff: nur removed → diff-block--removed mit <del>', () => {
  const lib = mockDiffLib({ arrays: [{ value: ['alles weg'], removed: true }] });
  const out = renderWordDiff('<p>alles weg</p>', '', lib);
  assert.equal(out.unchanged, false);
  assert.match(out.html, /diff-block--removed/);
  assert.match(out.html, /<del class="diff-del">alles weg<\/del>/);
});

test('renderWordDiff: unveraenderter Stretch wird kollabiert mit skipLabel', () => {
  // 5 Bloecke, nur mittlerer aendert sich. eq1 vorne und eq4 hinten sollten
  // kollabieren; eq2 (Trail-Context) und eq3 (Lead-Context) bleiben sichtbar.
  const lib = mockDiffLib({
    arrays: [
      { value: ['eq1', 'eq2'] },
      { value: ['change-old'], removed: true },
      { value: ['change-new'], added: true },
      { value: ['eq3', 'eq4'] },
    ],
    words: [
      { value: 'change-old', removed: true },
      { value: 'change-new', added: true },
    ],
  });
  const oldHtml = '<p>eq1</p><p>eq2</p><p>change-old</p><p>eq3</p><p>eq4</p>';
  const newHtml = '<p>eq1</p><p>eq2</p><p>change-new</p><p>eq3</p><p>eq4</p>';
  const out = renderWordDiff(oldHtml, newHtml, lib, { skipLabel: (n) => `skip:${n}` });
  assert.equal(out.unchanged, false);
  // Trail-/Lead-Context sichtbar
  assert.match(out.html, />eq2</);
  assert.match(out.html, />eq3</);
  // eq1 + eq4 ausserhalb des Context-Fensters → in Skip-Bloecken
  assert.doesNotMatch(out.html, />eq1</);
  assert.doesNotMatch(out.html, />eq4</);
  assert.match(out.html, /diff-block--skip/);
  assert.match(out.html, /skip:1/);
});

test('renderWordDiff: Heading-Block behaelt semantisches Tag', () => {
  const lib = mockDiffLib({
    arrays: [
      { value: ['Alter Titel'], removed: true },
      { value: ['Neuer Titel'], added: true },
    ],
    words: [
      { value: 'Alter', removed: true },
      { value: 'Neuer', added: true },
      { value: ' Titel' },
    ],
  });
  const out = renderWordDiff('<h1>Alter Titel</h1>', '<h1>Neuer Titel</h1>', lib);
  assert.match(out.html, /<h1 class="diff-block diff-block--h1 diff-block--changed">/);
});
