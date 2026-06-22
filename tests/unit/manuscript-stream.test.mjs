// Adapter-Tests für das kanonische Manuskript-Stream-Modell. Pure Modul, kein
// DOM — direkt importierbar. Spiegelt die buildBlocksFromPages-Szenarien auf
// Modell-Ebene (fromPages) + deckt fromSnapshotTree/fromGroups ab.

import test from 'node:test';
import assert from 'node:assert/strict';

const { fromPages, fromSnapshotTree, fromGroups } = await import('../../public/js/manuscript-stream.js');

// ── fromPages ────────────────────────────────────────────────────────────────
test('fromPages: leeres/null Input → leeres Array', () => {
  assert.deepEqual(fromPages([]), []);
  assert.deepEqual(fromPages(null), []);
});

test('fromPages: Chapter-Header pro Kapitelwechsel, id===pageId, depth 0', () => {
  const entries = fromPages([
    { pageId: 1, pageName: 'A', chapterId: 10, chapterName: 'K1', html: '<p>a</p>' },
    { pageId: 2, pageName: 'B', chapterId: 10, chapterName: 'K1', html: '<p>b</p>' },
    { pageId: 3, pageName: 'C', chapterId: 20, chapterName: 'K2', html: '<p>c</p>' },
  ]);
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.map(e => e.kind), ['chapter', 'page', 'page', 'chapter', 'page']);
  assert.equal(entries[0].chapterId, 10);
  assert.equal(entries[0].name, 'K1');
  assert.equal(entries[1].id, 1);
  assert.equal(entries[1].html, '<p>a</p>');
  assert.equal(entries[3].chapterId, 20);
  assert.equal(entries[4].id, 3);
  for (const e of entries) assert.equal(e.depth, 0);
});

test('fromPages: Solo-Pages (chapterId null) → kein Header davor', () => {
  const entries = fromPages([
    { pageId: 1, pageName: 'Solo', chapterId: null, html: '<p>x</p>' },
    { pageId: 2, pageName: 'A', chapterId: 10, chapterName: 'K1', html: '<p>a</p>' },
  ]);
  assert.equal(entries[0].kind, 'page');
  assert.equal(entries[0].id, 1);
  assert.equal(entries[0].chapterId, null);
  assert.equal(entries[1].kind, 'chapter');
  assert.equal(entries[2].kind, 'page');
});

test('fromPages: aufeinanderfolgende Pages im selben Kapitel → nur ein Header', () => {
  const entries = fromPages([
    { pageId: 1, chapterId: 10, chapterName: 'K1' },
    { pageId: 2, chapterId: 10, chapterName: 'K1' },
    { pageId: 3, chapterId: 10, chapterName: 'K1' },
  ]);
  const headers = entries.filter(e => e.kind === 'chapter');
  assert.equal(headers.length, 1);
  assert.equal(headers[0].chapterId, 10);
});

// ── fromSnapshotTree ──────────────────────────────────────────────────────────
test('fromSnapshotTree: Nesting → steigende depth, srcId→id, key stabil', () => {
  const tree = [
    { type: 'page', name: 'Solo', html: '<p>s</p>', srcId: 5 },
    { type: 'chapter', name: 'K1', children: [
      { type: 'page', name: 'A', html: '<p>a</p>', srcId: 1 },
      { type: 'chapter', name: 'K1.1', children: [
        { type: 'page', name: 'B', html: '<p>b</p>', srcId: 2 },
      ] },
    ] },
  ];
  const entries = fromSnapshotTree(tree);
  assert.deepEqual(entries.map(e => e.kind), ['page', 'chapter', 'page', 'chapter', 'page']);
  assert.equal(entries[0].depth, 0);   // Solo-Page
  assert.equal(entries[0].id, 5);
  assert.equal(entries[1].depth, 0);   // K1
  assert.equal(entries[2].depth, 1);   // A unter K1
  assert.equal(entries[3].depth, 1);   // K1.1
  assert.equal(entries[4].depth, 2);   // B unter K1.1
  assert.deepEqual(entries.map(e => e.key), ['p0', 'c1', 'p2', 'c3', 'p4']);
});

test('fromSnapshotTree: srcId fehlend → id null, Fremd-Nodes übersprungen', () => {
  const entries = fromSnapshotTree([
    { type: 'page', name: 'X' },
    { type: 'note', name: 'ignored' },
    null,
    'garbage',
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, null);
});

test('fromSnapshotTree: kein Array → leer', () => {
  assert.deepEqual(fromSnapshotTree(null), []);
  assert.deepEqual(fromSnapshotTree(undefined), []);
});

// ── fromGroups ────────────────────────────────────────────────────────────────
test('fromGroups: Header pro Gruppe mit chapter, pd.id→id', () => {
  const groups = [
    { chapterId: 10, chapter: { id: 10, name: 'K1' }, pages: [
      { pd: { id: 1, name: 'A', html: '<p>a</p>' } },
      { pd: { id: 2, name: 'B', html: '<p>b</p>' } },
    ] },
    { chapterId: null, chapter: null, pages: [{ pd: { id: 3, name: 'Solo', html: '<p>s</p>' } }] },
  ];
  const entries = fromGroups(groups);
  assert.deepEqual(entries.map(e => e.kind), ['chapter', 'page', 'page', 'page']);
  assert.equal(entries[0].chapterId, 10);
  assert.equal(entries[1].id, 1);
  assert.equal(entries[1].chapterId, 10);
  assert.equal(entries[3].id, 3);          // Solo-Page
  assert.equal(entries[3].chapterId, null);
  for (const e of entries) assert.equal(e.depth, 0);
});

test('fromGroups: leeres/null Input + fehlende pd → robust', () => {
  assert.deepEqual(fromGroups(null), []);
  assert.deepEqual(fromGroups([]), []);
  const entries = fromGroups([{ chapter: null, pages: [{ pd: null }, { pd: { id: 7, name: 'P' } }] }]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 7);
});
