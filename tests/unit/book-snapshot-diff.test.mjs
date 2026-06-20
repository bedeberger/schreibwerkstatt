import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenSnapshot, diffSnapshots } from '../../public/js/book-snapshot-diff.js';

function page(srcId, name, html) { return { type: 'page', srcId, name, html }; }
function chapter(name, children) { return { type: 'chapter', name, children }; }

test('flattenSnapshot: liest Tree-Format und Node-Array, mit Kapitelpfad', () => {
  const tree = [
    page(1, 'Vorwort', '<p>a</p>'),
    chapter('Kap 1', [page(2, 'S1', '<p>b</p>'), chapter('Unterkapitel', [page(3, 'S2', '<p>c</p>')])]),
  ];
  const fromTree = flattenSnapshot({ book: {}, tree });
  const fromArr = flattenSnapshot(tree);
  assert.deepEqual(fromTree, fromArr);
  assert.equal(fromTree.length, 3);
  assert.deepEqual(fromTree[0].chapterPath, []);
  assert.deepEqual(fromTree[1].chapterPath, ['Kap 1']);
  assert.deepEqual(fromTree[2].chapterPath, ['Kap 1', 'Unterkapitel']);
});

test('diffSnapshots: erkennt added/removed/changed/unchanged', () => {
  const from = [page(1, 'A', '<p>hallo</p>'), page(2, 'B', '<p>welt</p>')];
  const to   = [page(1, 'A', '<p>hallo</p>'), page(3, 'C', '<p>neu</p>')];
  const { summary, entries } = diffSnapshots(from, to);
  assert.equal(summary.added, 1);     // C
  assert.equal(summary.removed, 1);   // B
  assert.equal(summary.unchanged, 1); // A
  assert.equal(summary.changed, 0);
  const byStatus = Object.fromEntries(entries.map(e => [e.srcId, e.status]));
  assert.equal(byStatus[1], 'unchanged');
  assert.equal(byStatus[3], 'added');
  assert.equal(byStatus[2], 'removed');
});

test('diffSnapshots: Textänderung zählt als changed (HTML-Markup ignoriert)', () => {
  const from = [page(1, 'A', '<p>der hund</p>')];
  const to   = [page(1, 'A', '<p><strong>der hund</strong></p>')]; // gleicher Text, anderes Markup
  const a = diffSnapshots(from, to);
  assert.equal(a.summary.unchanged, 1, 'reines Markup ändert den Text nicht');

  const to2 = [page(1, 'A', '<p>die katze</p>')];
  const b = diffSnapshots(from, to2);
  assert.equal(b.summary.changed, 1);
  assert.equal(b.entries[0].status, 'changed');
});

test('diffSnapshots: rename + move Flags', () => {
  const from = [chapter('Alt', [page(1, 'Titel', '<p>x</p>')])];
  const to   = [chapter('Neu', [page(1, 'Titel neu', '<p>x</p>')])];
  const { summary, entries } = diffSnapshots(from, to);
  assert.equal(summary.renamed, 1);
  assert.equal(summary.moved, 1);
  const e = entries.find(x => x.srcId === 1);
  assert.equal(e.renamed, true);
  assert.equal(e.oldName, 'Titel');
  assert.equal(e.moved, true);
  assert.deepEqual(e.oldChapterPath, ['Alt']);
  assert.deepEqual(e.chapterPath, ['Neu']);
});

test('diffSnapshots: charsFrom/charsTo aus Plain-Text', () => {
  const from = [page(1, 'A', '<p>abc</p>')];
  const to   = [page(1, 'A', '<p>abcdef</p>')];
  const { summary } = diffSnapshots(from, to);
  assert.equal(summary.charsFrom, 3);
  assert.equal(summary.charsTo, 6);
});
