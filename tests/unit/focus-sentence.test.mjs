// Unit-Tests für Sentence-/Mark-Helpers des Focus-Editors
// (public/js/editor/focus/sentence.js + dom-blocks.js):
//   - `findSentenceAtCaret` — TreeWalker-basierte Satz-Erkennung am Caret.
//   - `clearAllFocusMarks` — räumt active-/near-Klassen + leeres class-Attribut
//     ab (Letzteres verhindert eine Phantom-Revision beim nächsten Save).
//
// linkedom liefert createTreeWalker; die Selection ist ein Minimal-Fake mit
// startContainer/startOffset (linkedom-Range kennt kein setStart). Test-HTML
// sind statische Literale.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body><div id="ed"></div></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.NodeFilter = window.NodeFilter || { SHOW_TEXT: 4 };

const { findSentenceAtCaret, clearAllFocusMarks } = await import('../../public/js/editor/focus.js');

function blockWith(html) {
  const ed = window.document.getElementById('ed');
  ed.innerHTML = html;
  return ed.querySelector('p');
}
function caretSel(node, offset) {
  return { rangeCount: 1, getRangeAt: () => ({ startContainer: node, startOffset: offset }) };
}

// --- findSentenceAtCaret ----------------------------------------------------

test('findSentenceAtCaret: Caret im ersten Satz → erste Range', () => {
  const block = blockWith('<p>Hallo Welt. Zweiter Satz hier.</p>');
  const info = findSentenceAtCaret(block, caretSel(block.firstChild, 3));
  assert.deepEqual(info.sentence, [0, 12]);
  assert.equal(info.totalLength, 30);
});

test('findSentenceAtCaret: Caret im zweiten Satz → zweite Range', () => {
  const block = blockWith('<p>Hallo Welt. Zweiter Satz hier.</p>');
  const info = findSentenceAtCaret(block, caretSel(block.firstChild, 20));
  assert.deepEqual(info.sentence, [12, 30]);
});

test('findSentenceAtCaret: kein Block / keine Selektion → null', () => {
  assert.equal(findSentenceAtCaret(null, caretSel(window.document.body, 0)), null);
  const block = blockWith('<p>Text.</p>');
  assert.equal(findSentenceAtCaret(block, { rangeCount: 0, getRangeAt: () => null }), null);
});

test('findSentenceAtCaret: Caret ausserhalb des Blocks → null', () => {
  const block = blockWith('<p>Drin.</p>');
  const aussen = window.document.body; // nicht im Block enthalten
  assert.equal(findSentenceAtCaret(block, caretSel(aussen, 0)), null);
});

test('findSentenceAtCaret: leerer Block → ganze (Null-)Länge als Range', () => {
  const block = blockWith('<p></p>');
  const info = findSentenceAtCaret(block, caretSel(block, 0));
  assert.deepEqual(info.sentence, [0, 0]);
  assert.equal(info.totalLength, 0);
});

// --- clearAllFocusMarks -----------------------------------------------------

test('clearAllFocusMarks: entfernt active + near und leeres class-Attribut', () => {
  const ed = window.document.getElementById('ed');
  ed.innerHTML = '<p class="focus-paragraph-active">a</p><p class="focus-paragraph-near">b</p>';
  clearAllFocusMarks(ed);
  for (const p of ed.querySelectorAll('p')) {
    assert.equal(p.classList.contains('focus-paragraph-active'), false);
    assert.equal(p.classList.contains('focus-paragraph-near'), false);
    assert.equal(p.hasAttribute('class'), false, 'leeres class-Attribut muss weg (sonst Save-Diff)');
  }
});

test('clearAllFocusMarks: erhält fremde Klassen', () => {
  const ed = window.document.getElementById('ed');
  ed.innerHTML = '<p class="poem focus-paragraph-active">a</p>';
  clearAllFocusMarks(ed);
  const p = ed.querySelector('p');
  assert.equal(p.classList.contains('poem'), true);
  assert.equal(p.classList.contains('focus-paragraph-active'), false);
});

test('clearAllFocusMarks: null-Container → kein Wurf', () => {
  assert.doesNotThrow(() => clearAllFocusMarks(null));
});
