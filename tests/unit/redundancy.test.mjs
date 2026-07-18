import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prepare, scanBlock, finalizePairs, findRedundantPairs } = require('../../lib/redundancy.js');

// Kleiner Helfer: Chunk mit langem Text (über MIN_CHARS) + Vektor.
function chunk(entity_id, chunk_ix, vector, extra = '') {
  return { entity_id, chunk_ix, text: 'Ein ausreichend langer Beispieltext für den Chunk. ' + extra, vector };
}

test('findRedundantPairs: findet ähnliches Paar über Schwelle', () => {
  const chunks = [
    chunk(1, 0, [1, 0, 0]),
    chunk(2, 0, [0.99, 0.01, 0]), // fast identisch zu 1 → Treffer
    chunk(3, 0, [0, 1, 0]),       // orthogonal → kein Treffer
  ];
  const { pairs } = findRedundantPairs(chunks, { threshold: 0.9 });
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].a_id, pairs[0].b_id], [1, 2]);
  assert.ok(pairs[0].score >= 0.9);
});

test('findRedundantPairs: gleiche Entität wird nie verglichen', () => {
  const chunks = [
    chunk(5, 0, [1, 0, 0]),
    chunk(5, 1, [1, 0, 0]), // identisch, aber selbe Seite → skip
  ];
  const { pairs, comparedPairs } = findRedundantPairs(chunks, { threshold: 0.5 });
  assert.equal(pairs.length, 0);
  assert.equal(comparedPairs, 0);
});

test('findRedundantPairs: bester Chunk pro Seitenpaar, nur einmal gelistet', () => {
  const chunks = [
    chunk(1, 0, [1, 0, 0]),
    chunk(1, 1, [0.8, 0.2, 0]),
    chunk(2, 0, [1, 0, 0]),       // beste Übereinstimmung mit 1/chunk0
    chunk(2, 1, [0.7, 0.3, 0]),
  ];
  const { pairs } = findRedundantPairs(chunks, { threshold: 0.5 });
  assert.equal(pairs.length, 1, 'Seitenpaar 1↔2 nur einmal');
  assert.equal(pairs[0].score, 1, 'nimmt den stärksten Chunk-Treffer');
});

test('finalizePairs: topK kappt + setzt truncated', () => {
  // Drei Seiten, alle paarweise ähnlich → 3 Paare; topK=2.
  const chunks = [
    chunk(1, 0, [1, 0, 0]),
    chunk(2, 0, [0.99, 0.01, 0]),
    chunk(3, 0, [0.98, 0.02, 0]),
  ];
  const { vecs, metas } = prepare(chunks);
  const best = new Map();
  scanBlock(vecs, metas, 0, vecs.length, 0.9, best);
  const { pairs, totalFound, truncated } = finalizePairs(best, metas, { topK: 2 });
  assert.equal(totalFound, 3);
  assert.equal(pairs.length, 2);
  assert.equal(truncated, true);
  // Nach Score absteigend sortiert.
  assert.ok(pairs[0].score >= pairs[1].score);
});

test('prepare: zu kurze Chunks + Nullvektoren fallen raus', () => {
  const chunks = [
    { entity_id: 1, chunk_ix: 0, text: 'kurz', vector: [1, 0, 0] },        // < MIN_CHARS
    { entity_id: 2, chunk_ix: 0, text: 'x'.repeat(60), vector: [0, 0, 0] }, // Nullvektor
    chunk(3, 0, [1, 0, 0]),                                                  // ok
  ];
  const { vecs, metas } = prepare(chunks);
  assert.equal(vecs.length, 1);
  assert.equal(metas[0].entity_id, 3);
});

test('scanBlock: blockweiser Scan == Voll-Scan (Zerlegung ändert Ergebnis nicht)', () => {
  const chunks = [];
  // Deterministische, verschiedene Vektoren über mehrere Seiten.
  for (let e = 1; e <= 8; e++) {
    chunks.push(chunk(e, 0, [Math.cos(e), Math.sin(e), e / 10]));
  }
  const { vecs, metas } = prepare(chunks);

  const full = new Map();
  scanBlock(vecs, metas, 0, vecs.length, 0.5, full);

  const blocked = new Map();
  for (let i = 0; i < vecs.length; i += 3) {
    scanBlock(vecs, metas, i, Math.min(i + 3, vecs.length), 0.5, blocked);
  }
  assert.deepEqual(
    finalizePairs(full, metas, { topK: 100 }).pairs,
    finalizePairs(blocked, metas, { topK: 100 }).pairs,
  );
});
