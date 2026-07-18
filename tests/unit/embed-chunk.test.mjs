// Pure Helfer der semantischen Suche: Chunking, Vektor-(De)Serialisierung,
// Cosinus, Content-Hash. Ohne DB/Netz → hier isoliert getestet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chunkText, vectorToBlob, blobToVector, cosineSim, contentHash, CHUNK_CHARS } = require('../../lib/embed-chunk.js');

test('chunkText: leerer/whitespace Text → []', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\t '), []);
  assert.deepEqual(chunkText(null), []);
});

test('chunkText: kurzer Text → genau ein Chunk, whitespace-normalisiert', () => {
  const out = chunkText('Ein kurzer   Satz.\n\nMit Umbruch.');
  assert.equal(out.length, 1);
  assert.equal(out[0], 'Ein kurzer Satz. Mit Umbruch.');
});

test('chunkText: langer Text → mehrere überlappende Chunks, alle <= maxChars', () => {
  const sentence = 'Dies ist ein Satz mit etwas Inhalt. ';
  const long = sentence.repeat(200); // ~7200 Zeichen
  const out = chunkText(long, { maxChars: 1000, overlap: 100 });
  assert.ok(out.length >= 6, `erwartet mehrere Chunks, bekam ${out.length}`);
  for (const c of out) assert.ok(c.length <= 1000, `Chunk zu lang: ${c.length}`);
  // Überlappung: das Ende von Chunk n taucht am Anfang von Chunk n+1 wieder auf.
  const tail = out[0].slice(-50);
  assert.ok(out[1].includes(tail.trim().split(' ')[0]), 'Overlap fehlt');
});

test('chunkText: Default-Chunkgrösse greift ohne Optionen', () => {
  const long = 'Wort '.repeat(1000); // 5000 Zeichen
  const out = chunkText(long);
  for (const c of out) assert.ok(c.length <= CHUNK_CHARS);
});

test('vectorToBlob/blobToVector: Roundtrip erhält Werte', () => {
  const v = Float32Array.from([0.1, -0.5, 3.25, 0, 42.0]);
  const blob = vectorToBlob(v);
  assert.ok(Buffer.isBuffer(blob));
  assert.equal(blob.length, v.length * 4);
  const back = blobToVector(blob);
  assert.equal(back.length, v.length);
  for (let i = 0; i < v.length; i++) assert.ok(Math.abs(back[i] - v[i]) < 1e-6);
});

test('cosineSim: identische Vektoren → 1', () => {
  const v = Float32Array.from([1, 2, 3, 4]);
  assert.ok(Math.abs(cosineSim(v, v) - 1) < 1e-6);
});

test('cosineSim: orthogonale Vektoren → 0', () => {
  const a = Float32Array.from([1, 0]);
  const b = Float32Array.from([0, 1]);
  assert.ok(Math.abs(cosineSim(a, b)) < 1e-6);
});

test('cosineSim: gegensätzliche Vektoren → -1', () => {
  const a = Float32Array.from([1, 1]);
  const b = Float32Array.from([-1, -1]);
  assert.ok(Math.abs(cosineSim(a, b) + 1) < 1e-6);
});

test('cosineSim: ungleiche Länge oder Nullvektor → -Infinity (nie Treffer)', () => {
  assert.equal(cosineSim(Float32Array.from([1, 2, 3]), Float32Array.from([1, 2])), -Infinity);
  assert.equal(cosineSim(Float32Array.from([0, 0]), Float32Array.from([1, 1])), -Infinity);
});

test('contentHash: stabil + verschieden bei Änderung', () => {
  assert.equal(contentHash('Hallo Welt'), contentHash('Hallo Welt'));
  assert.notEqual(contentHash('Hallo Welt'), contentHash('Hallo Welt!'));
  assert.match(contentHash('x'), /^[0-9a-f]{16}$/);
});
