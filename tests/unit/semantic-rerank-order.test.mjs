// rerankOrder (lib/semantic-retrieval.js): generisches Reorder-Primitiv für Pfade
// mit eigenem Retrieval (Buch-Chat-FTS-Literalsuche). Deckt die Reihenfolge-Logik
// ab (Ranked-Spitze + angehängter, nicht gerankter Rest = voller Recall) und die
// Non-fatal-Fallbacks. rerank.js wird über den Require-Cache gemockt (kein Netz).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DB_PATH = path.join(os.tmpdir(), `sw-rerankorder-${process.pid}.db`);

const require = createRequire(import.meta.url);
const rerank = require('../../lib/rerank.js');
const { rerankOrder } = require('../../lib/semantic-retrieval.js');

function mockRerank({ enabled = true, topN = 30, minScore = 0, fn = null } = {}) {
  rerank.isEnabled = () => enabled;
  rerank.getConfig = () => ({ topN, minScore });
  rerank.rerank = fn || (async () => []);
}

test('rerankOrder: reordnet den Pool und hängt nicht gerankte Reste an', async () => {
  // 4 Docs, Reranker ordnet nur die ersten 3 (topN=3) → Rest-Index 3 bleibt am Ende.
  mockRerank({
    topN: 3,
    fn: async (q, docs) => {
      assert.equal(q, 'query');
      assert.equal(docs.length, 3);
      return [{ index: 2, score: 0.9 }, { index: 0, score: 0.5 }, { index: 1, score: 0.1 }];
    },
  });
  const order = await rerankOrder('query', ['a', 'b', 'c', 'd']);
  assert.deepEqual(order, [2, 0, 1, 3]);
});

test('rerankOrder: Backend liefert nur Teilmenge → fehlende Pool-Indizes landen im Rest', async () => {
  mockRerank({ topN: 30, fn: async () => [{ index: 1, score: 0.8 }] });
  const order = await rerankOrder('q', ['a', 'b', 'c']);
  // Index 1 gerankt, 0 und 2 als Rest in Original-Reihenfolge dahinter.
  assert.deepEqual(order, [1, 0, 2]);
});

test('rerankOrder: Rerank aus → null (Aufrufer behält Reihenfolge)', async () => {
  mockRerank({ enabled: false });
  assert.equal(await rerankOrder('q', ['a', 'b']), null);
});

test('rerankOrder: < 2 Docs oder leerer Query → null', async () => {
  mockRerank({ enabled: true });
  assert.equal(await rerankOrder('q', ['a']), null);
  assert.equal(await rerankOrder('   ', ['a', 'b']), null);
});

test('rerankOrder: Backend-Fehler ist non-fatal → null', async () => {
  mockRerank({ fn: async () => { throw new Error('endpoint down'); } });
  assert.equal(await rerankOrder('q', ['a', 'b']), null);
});

test('rerankOrder: AbortError propagiert (Job-Cancel)', async () => {
  mockRerank({ fn: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } });
  await assert.rejects(() => rerankOrder('q', ['a', 'b']), /aborted/);
});
