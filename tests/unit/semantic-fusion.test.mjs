// Reciprocal Rank Fusion der hybriden semantischen Suche (lib/semantic-fusion.js):
// pure Rang-Fusion von Cosinus- und FTS-Trefferliste, kein DB/Netz.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fuseCandidates, RRF_K, _stripTags } = require('../../lib/semantic-fusion.js');

const sem = (kind, id, score, text = '') => ({ kind, entity_id: id, score, text });
const fts = (kind, id, title = '', snippet = '') => ({ kind, entity_id: id, title, snippet });

test('fuseCandidates: reine Semantik → RRF folgt der Semantik-Reihenfolge', () => {
  const out = fuseCandidates([sem('page', 1, 0.9), sem('page', 2, 0.5)], []);
  assert.equal(out.length, 2);
  assert.equal(out[0].entity_id, 1);
  assert.equal(out[0].semRank, 0);
  assert.equal(out[0].ftsRank, null);
  assert.ok(out[0].rrf > out[1].rrf);
});

test('fuseCandidates: derselbe Treffer aus beiden Quellen wird verschmolzen und hochgerankt', () => {
  // page:1 steht in beiden Listen ganz vorne → summierter RRF-Score schlägt die
  // Treffer, die nur in einer Liste stehen.
  const semHits = [sem('page', 1, 0.8, 'chunk-text'), sem('page', 2, 0.7)];
  const ftsHits = [fts('page', 1, 'Titel 1'), fts('page', 3, 'Titel 3')];
  const out = fuseCandidates(semHits, ftsHits);
  const p1 = out.find(c => c.entity_id === 1);
  assert.equal(out[0].entity_id, 1, 'in beiden Quellen führend → Platz 1');
  assert.equal(p1.semRank, 0);
  assert.equal(p1.ftsRank, 0);
  assert.equal(p1.rrf, 1 / (RRF_K + 0) + 1 / (RRF_K + 0));
  // verschmolzener Kandidat behält den Embedding-Chunk-Text (bevorzugt vor FTS).
  assert.equal(p1.text, 'chunk-text');
});

test('fuseCandidates: FTS-only-Kandidat bekommt Text aus Titel+Snippet (entschärft)', () => {
  const out = fuseCandidates([], [fts('figure', 9, 'Anna', 'die <mark>tapfere</mark> Heldin')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].semScore, null);
  assert.equal(out[0].ftsRank, 0);
  assert.ok(!out[0].text.includes('<mark>'), 'HTML-Tags entfernt');
  assert.ok(out[0].text.includes('tapfere'));
});

test('fuseCandidates: unterschiedliche kinds kollidieren nicht bei gleicher id', () => {
  const out = fuseCandidates([sem('page', 1, 0.9)], [fts('figure', 1, 'Figur 1')]);
  assert.equal(out.length, 2, 'page:1 und figure:1 sind verschiedene Kandidaten');
});

test('_stripTags: entfernt Tags und dekodiert die geläufigen Entities zu Leerzeichen', () => {
  assert.equal(_stripTags('a <b>x</b> &amp; y'), 'a x y');
  assert.equal(_stripTags(null), '');
});
