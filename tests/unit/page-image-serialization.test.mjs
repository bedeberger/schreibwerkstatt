// Manuskript-Bilder überleben Snapshot-Restore + .swbook-Migration: die im
// Seiten-HTML referenzierten Bild-BLOBs werden als base64 an die Page-Nodes
// gehängt (treeToNodes/planFromNodes) und beim Fassungs-Export zu selbsttragenden
// data:-URIs inlined (snapshotToBundle). Pure Pfade — kein DB-Harness nötig.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treeToNodes, planFromNodes, buildBookJson, validateBookJson } from '../../lib/book-bundle.js';
import { snapshotToBundle } from '../../lib/snapshot-export.js';

const IMG = { oldId: 5, mime: 'image/jpeg', width: 800, height: 600, b64: 'QUJD' };

test('treeToNodes hängt referenzierte Bilder an den Page-Node', () => {
  const tree = {
    topPages: [{ id: 42, name: 'S1' }],
    chapters: [],
  };
  const htmlById = new Map([[42, '<p>x</p><figure><img src="/content/page-image/5"></figure>']]);
  const imagesByPage = new Map([[42, [IMG]]]);
  const nodes = treeToNodes(tree, htmlById, imagesByPage);
  assert.equal(nodes.length, 1);
  assert.deepEqual(nodes[0].images, [IMG]);
});

test('treeToNodes ohne Bilder setzt kein images-Feld', () => {
  const tree = { topPages: [{ id: 1, name: 'S' }], chapters: [] };
  const nodes = treeToNodes(tree, new Map([[1, '<p>ohne Bild</p>']]), new Map());
  assert.equal(nodes[0].images, undefined);
});

test('planFromNodes reicht images pro Page-Op durch (fehlend → [])', () => {
  const nodes = [
    { type: 'page', name: 'A', html: '', srcId: 1, images: [IMG] },
    { type: 'page', name: 'B', html: '', srcId: 2 },
  ];
  const { ops } = planFromNodes(nodes);
  const pageOps = ops.filter(o => o.op === 'page');
  assert.deepEqual(pageOps[0].images, [IMG]);
  assert.deepEqual(pageOps[1].images, []);
});

test('validateBookJson akzeptiert Tree mit Bild-tragenden Nodes', () => {
  const nodes = [{ type: 'page', name: 'A', html: '<img src="/content/page-image/5">', srcId: 1, images: [IMG] }];
  const json = buildBookJson({ book: { name: 'Buch' }, settings: null, nodes });
  assert.doesNotThrow(() => validateBookJson(json));
});

test('snapshotToBundle inlined Bild-Refs zu data:-URI', () => {
  const content = {
    book: { name: 'Buch' },
    tree: [{
      type: 'page', name: 'S1', srcId: 42,
      html: '<figure><img src="/content/page-image/5"></figure>',
      images: [IMG],
    }],
  };
  const bundle = snapshotToBundle(content, { bookId: 7 });
  const html = bundle.groups[0].pages[0].pd.html;
  assert.match(html, /data:image\/jpeg;base64,QUJD/);
  assert.doesNotMatch(html, /\/content\/page-image\/5/);
});

test('snapshotToBundle lässt Refs ohne mitgeführtes Bild unverändert', () => {
  const content = {
    book: { name: 'Buch' },
    tree: [{ type: 'page', name: 'S1', srcId: 42, html: '<img src="/content/page-image/9">' }],
  };
  const bundle = snapshotToBundle(content, { bookId: 7 });
  assert.match(bundle.groups[0].pages[0].pd.html, /\/content\/page-image\/9/);
});
