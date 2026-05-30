import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  FORMAT, VERSION, MAX_DEPTH,
  buildManifest, treeToNodes, buildBookJson,
  validateManifest, validateBookJson, planFromNodes,
} = require('../../lib/book-bundle.js');

test('buildManifest setzt Format + Version', () => {
  const m = buildManifest({ sourceBookId: 42, exportedAt: '2026-05-30T00:00:00Z' });
  assert.equal(m.format, FORMAT);
  assert.equal(m.version, VERSION);
  assert.equal(m.sourceBookId, 42);
});

test('treeToNodes baut Hierarchie + Reihenfolge inkl. inline-HTML', () => {
  const tree = {
    topPages: [{ id: 1, name: 'Vorwort' }],
    chapters: [
      {
        id: 10, name: 'Kap 1', description: 'd1',
        pages: [{ id: 2, name: 'S1' }, { id: 3, name: 'S2' }],
        subchapters: [
          { id: 11, name: 'Kap 1.1', pages: [{ id: 4, name: 'S3' }], subchapters: [] },
        ],
      },
    ],
  };
  const html = new Map([[1, '<p>vw</p>'], [2, '<p>a</p>'], [3, '<p>b</p>'], [4, '<p>c</p>']]);
  const nodes = treeToNodes(tree, html);

  assert.equal(nodes[0].type, 'page');
  assert.equal(nodes[0].name, 'Vorwort');
  assert.equal(nodes[0].html, '<p>vw</p>');

  const ch = nodes[1];
  assert.equal(ch.type, 'chapter');
  assert.equal(ch.name, 'Kap 1');
  assert.equal(ch.children[0].name, 'S1');
  assert.equal(ch.children[1].name, 'S2');
  assert.equal(ch.children[2].type, 'chapter'); // subchapter nach pages
  assert.equal(ch.children[2].children[0].html, '<p>c</p>');
});

test('buildBookJson uebernimmt Buch-Meta + bereinigte Settings', () => {
  const bj = buildBookJson({
    book: { name: 'Mein Buch', description: 'desc' },
    settings: { language: 'de', region: 'CH', buchtyp: 'roman', is_finished: 1, junk: 'x' },
    nodes: [{ type: 'page', name: 'p', html: '' }],
  });
  assert.equal(bj.book.name, 'Mein Buch');
  assert.equal(bj.book.settings.buchtyp, 'roman');
  assert.equal(bj.book.settings.junk, undefined); // unbekannte Keys raus
  assert.equal(bj.tree.length, 1);
});

const hasCode = (code) => (e) => e && e.code === code;

test('validateManifest akzeptiert gut, lehnt fremd/zu-neu ab', () => {
  assert.ok(validateManifest({ format: FORMAT, version: 1 }));
  assert.throws(() => validateManifest({ format: 'andere-app', version: 1 }), hasCode('BAD_MANIFEST'));
  assert.throws(() => validateManifest({ format: FORMAT, version: 999 }), hasCode('UNSUPPORTED_VERSION'));
  assert.throws(() => validateManifest(null), hasCode('BAD_MANIFEST'));
});

test('validateBookJson verlangt Name + nicht-leeren Tree', () => {
  assert.ok(validateBookJson({ book: { name: 'X' }, tree: [{ type: 'page', name: 'p' }] }));
  assert.throws(() => validateBookJson({ book: { name: '' }, tree: [{}] }), hasCode('SWBOOK_EMPTY'));
  assert.throws(() => validateBookJson({ book: { name: 'X' }, tree: [] }), hasCode('SWBOOK_EMPTY'));
});

test('planFromNodes erhaelt Reihenfolge + Parent-Verkettung', () => {
  const nodes = [
    { type: 'page', name: 'Vorwort', html: '<p>vw</p>' },
    {
      type: 'chapter', name: 'Kap 1', description: 'd',
      children: [
        { type: 'page', name: 'S1', html: '<p>a</p>' },
        { type: 'chapter', name: 'Kap 1.1', children: [{ type: 'page', name: 'S2', html: '<p>b</p>' }] },
      ],
    },
  ];
  const { ops, cappedChapters } = planFromNodes(nodes);
  assert.equal(cappedChapters, 0);

  // Top-Page zuerst, parentTempId null
  assert.equal(ops[0].op, 'page');
  assert.equal(ops[0].parentTempId, null);
  assert.equal(ops[0].html, '<p>vw</p>');

  const kap1 = ops[1];
  assert.equal(kap1.op, 'chapter');
  assert.equal(kap1.parentTempId, null);

  const s1 = ops[2];
  assert.equal(s1.op, 'page');
  assert.equal(s1.parentTempId, kap1.tempId);

  const kap11 = ops[3];
  assert.equal(kap11.op, 'chapter');
  assert.equal(kap11.parentTempId, kap1.tempId);

  const s2 = ops[4];
  assert.equal(s2.parentTempId, kap11.tempId);
});

test('planFromNodes kappt Kapitel jenseits MAX_DEPTH, Pages bleiben erhalten', () => {
  // Tiefe 4: chapter>chapter>chapter>chapter mit page ganz unten
  let deepest = { type: 'page', name: 'tief', html: '<p>x</p>' };
  let node = deepest;
  for (let i = 0; i < 4; i += 1) node = { type: 'chapter', name: `c${i}`, children: [node] };
  const { ops, cappedChapters } = planFromNodes([node]);

  assert.equal(cappedChapters, 1); // 4. Kapitel-Ebene gekappt
  const chapterOps = ops.filter(o => o.op === 'chapter');
  assert.equal(chapterOps.length, MAX_DEPTH);
  // Page bleibt vorhanden
  const pageOp = ops.find(o => o.op === 'page');
  assert.ok(pageOp);
  assert.equal(pageOp.html, '<p>x</p>');
});

test('Round-Trip: Tree -> nodes -> plan rekonstruiert Struktur', () => {
  const tree = {
    topPages: [],
    chapters: [
      { id: 1, name: 'A', pages: [{ id: 100, name: 'a1' }], subchapters: [
        { id: 2, name: 'A.1', pages: [{ id: 101, name: 'a2' }], subchapters: [] },
      ] },
    ],
  };
  const html = new Map([[100, '<p>1</p>'], [101, '<p>2</p>']]);
  const nodes = treeToNodes(tree, html);
  const { ops } = planFromNodes(nodes);

  const chapters = ops.filter(o => o.op === 'chapter').map(o => o.name);
  const pages = ops.filter(o => o.op === 'page').map(o => o.name);
  assert.deepEqual(chapters, ['A', 'A.1']);
  assert.deepEqual(pages, ['a1', 'a2']);
});
