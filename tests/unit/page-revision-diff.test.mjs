// Tests fuer page-revision-diff: htmlToPlainText-Normalisierung, parseBlocks
// und Side-by-Side-Diff-Rendering. diffLib (diffArrays + diffWords) wird gemockt,
// damit der Test nicht von jsdiff abhaengt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToPlainText, parseBlocks, renderSideBySide } from '../../public/js/page-revision-diff.js';

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

test('renderSideBySide: identischer Inhalt → unchanged=true, html leer', () => {
  const lib = mockDiffLib({ arrays: [{ value: ['Hallo Welt'] }] });
  const out = renderSideBySide('<p>Hallo Welt</p>', '<p>Hallo Welt</p>', lib);
  assert.equal(out.unchanged, true);
  assert.equal(out.html, '');
});

test('renderSideBySide: gepaarter Change → zwei Zellen (left=del+eq, right=ins+eq)', () => {
  const lib = mockDiffLib({
    arrays: [
      { value: ['a'], removed: true },
      { value: ['b'], added: true },
    ],
    words: [
      { value: 'Hallo ' },
      { value: 'alte', removed: true },
      { value: 'neue', added: true },
      { value: ' Welt' },
    ],
  });
  const out = renderSideBySide('a', 'b', lib);
  assert.equal(out.unchanged, false);
  // Linke Spalte: del+eq (kein ins)
  assert.match(out.html, /diff-cell--changed diff-cell--left/);
  assert.match(out.html, /<del class="diff-del">alte<\/del>/);
  // Rechte Spalte: ins+eq (kein del)
  assert.match(out.html, /diff-cell--changed diff-cell--right/);
  assert.match(out.html, /<ins class="diff-add">neue<\/ins>/);
  // Inline-eq erscheint auf beiden Seiten
  const eqCount = (out.html.match(/<span class="diff-eq">Hallo <\/span>/g) || []).length;
  assert.equal(eqCount, 2);
});

test('renderSideBySide: fehlende diffLib oder Methoden → wirft', () => {
  assert.throws(() => renderSideBySide('a', 'b', null), /diffLib/);
  assert.throws(() => renderSideBySide('a', 'b', {}), /diffLib/);
  assert.throws(() => renderSideBySide('a', 'b', { diffWords: () => [] }), /diffArrays/);
});

test('renderSideBySide: nur removed → links del, rechts empty', () => {
  const lib = mockDiffLib({ arrays: [{ value: ['alles weg'], removed: true }] });
  const out = renderSideBySide('<p>alles weg</p>', '', lib);
  assert.equal(out.unchanged, false);
  assert.match(out.html, /diff-cell--removed diff-cell--left/);
  assert.match(out.html, /<del class="diff-del">alles weg<\/del>/);
  assert.match(out.html, /diff-cell--empty diff-cell--right/);
});

test('renderSideBySide: nur added → links empty, rechts ins', () => {
  const lib = mockDiffLib({ arrays: [{ value: ['alles neu'], added: true }] });
  const out = renderSideBySide('', '<p>alles neu</p>', lib);
  assert.equal(out.unchanged, false);
  assert.match(out.html, /diff-cell--empty diff-cell--left/);
  assert.match(out.html, /diff-cell--added diff-cell--right/);
  assert.match(out.html, /<ins class="diff-add">alles neu<\/ins>/);
});

test('renderSideBySide: unveraenderter Stretch wird kollabiert mit skipLabel', () => {
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
  const out = renderSideBySide(oldHtml, newHtml, lib, { skipLabel: (n) => `skip:${n}` });
  assert.equal(out.unchanged, false);
  // Trail-/Lead-Context sichtbar
  assert.match(out.html, />eq2</);
  assert.match(out.html, />eq3</);
  // eq1 + eq4 ausserhalb des Context-Fensters
  assert.doesNotMatch(out.html, />eq1</);
  assert.doesNotMatch(out.html, />eq4</);
  assert.match(out.html, /diff-cell--skip/);
  assert.match(out.html, /skip:1/);
});

test('renderSideBySide: Heading-Block behaelt semantisches Tag in beiden Spalten', () => {
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
  const out = renderSideBySide('<h1>Alter Titel</h1>', '<h1>Neuer Titel</h1>', lib);
  assert.match(out.html, /<h1 class="diff-cell diff-cell--h1 diff-cell--changed diff-cell--left">/);
  assert.match(out.html, /<h1 class="diff-cell diff-cell--h1 diff-cell--changed diff-cell--right">/);
});

test('renderSideBySide: eq-Block erscheint identisch in beiden Spalten', () => {
  // Anker-Change zwingt eq-Block ins kollabierende Fenster.
  const lib = mockDiffLib({
    arrays: [
      { value: ['eq'] },
      { value: ['old'], removed: true },
      { value: ['new'], added: true },
    ],
    words: [
      { value: 'old', removed: true },
      { value: 'new', added: true },
    ],
  });
  const out = renderSideBySide('<p>eq</p><p>old</p>', '<p>eq</p><p>new</p>', lib);
  const leftEq = (out.html.match(/diff-cell--eq diff-cell--left">eq</g) || []).length;
  const rightEq = (out.html.match(/diff-cell--eq diff-cell--right">eq</g) || []).length;
  assert.equal(leftEq, 1);
  assert.equal(rightEq, 1);
});
