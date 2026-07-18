'use strict';
// Pure Helfer für die semantische Suche: Chunking, Vektor-(De)Serialisierung,
// Cosinus-Ähnlichkeit, Content-Hash. Ohne DB-/Netz-Abhängigkeit → unit-testbar
// (tests/unit/embed-chunk.test.mjs). Konsumiert von db/semantic-chunks.js,
// routes/jobs/embed-index.js und routes/search.js.

const crypto = require('crypto');

// Chunk-Grösse in Zeichen. ~1500 Zeichen ≈ 500 Tokens (Deutsch). bge-m3 hält 8k
// Kontext, aber kleinere Chunks lokalisieren Treffer präziser („diese Passage"
// statt „diese halbe Seite"). Overlap verhindert, dass ein an der Grenze zer-
// schnittener Gedanke in keinem Chunk mehr ganz vorkommt.
const CHUNK_CHARS = 1500;
const CHUNK_OVERLAP = 200;

// Zerlegt Plaintext in überlappende Chunks. Bricht bevorzugt an Absatz-/Satz-
// grenzen nahe der Zielgrösse, damit Chunks nicht mitten im Wort enden. Kurzer
// Text (< CHUNK_CHARS) → genau ein Chunk. Leerer/whitespace-Text → [].
function chunkText(text, { maxChars = CHUNK_CHARS, overlap = CHUNK_OVERLAP } = {}) {
  const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);
    if (end < clean.length) {
      // Rückwärts zur nächsten sinnvollen Grenze suchen (Satzende > Space),
      // aber nicht mehr als 25 % der Chunk-Grösse opfern.
      const floor = start + Math.floor(maxChars * 0.75);
      const slice = clean.slice(start, end);
      const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
      const space = slice.lastIndexOf(' ');
      const cut = sentence >= (floor - start) ? sentence + 1
        : space >= (floor - start) ? space
        : -1;
      if (cut > 0) end = start + cut;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

// Float32Array ↔ Buffer (Little-Endian, roh). Kompakt (4 Byte/Dimension) und
// direkt in eine SQLite-BLOB-Spalte schreibbar.
function vectorToBlob(vec) {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function blobToVector(buf) {
  // Kopie über Uint8Array, weil der Buffer nicht 4-Byte-aligned sein muss.
  const copy = Uint8Array.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

// Cosinus-Ähnlichkeit zweier gleich langer Vektoren, [-1, 1]. Ungleiche Länge
// (z.B. Modellwechsel) → -Infinity, damit solche Chunks nie als Treffer ranken.
function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return -Infinity;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -Infinity;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Stabiler Hash über den Chunk-Text — Basis des Delta-Caches (unveränderter
// Chunk → kein erneuter Embedding-Call).
function contentHash(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text)).digest('hex').slice(0, 16);
}

module.exports = {
  CHUNK_CHARS, CHUNK_OVERLAP,
  chunkText, vectorToBlob, blobToVector, cosineSim, contentHash,
};
