'use strict';
// Redundanz-Radar: pure Vektor-Mathematik für die buchweite Doppelungs-Suche.
// Findet Chunk-Paare unterschiedlicher Entitäten (Seiten), deren Embeddings sich
// bedeutungsmässig stark ähneln — quasi-doppelte Beschreibungen, wiederkehrende
// Bilder, versehentlich zweimal erzählte Szenen. Reiner Ableitungs-Schritt über
// dem bestehenden semantic_chunks-Index (kein Embedding-/KI-Call). Ohne DB-/Netz-
// Abhängigkeit → unit-testbar (tests/unit/redundancy.test.mjs).
//
// Der teure Teil ist O(n²) Cosinus über alle Chunk-Paare. Zwei Massnahmen halten
// das billig: (a) Vektoren werden EINMAL auf Einheitslänge normiert, danach ist
// die Ähnlichkeit ein reines Skalarprodukt (kein Norm pro Paar); (b) der Scan
// läuft blockweise (scanBlock), damit der aufrufende Job zwischen den Blöcken an
// den Event-Loop zurückgeben kann (setImmediate) und den Server nicht einfriert.

// Sehr kurze Chunks (blosse Überschriften, ein Satz) ranken untereinander
// verrauscht hoch — unter dieser Zeichenzahl gar nicht erst vergleichen.
const MIN_CHARS = 40;

// Chunks (jeweils { entity_id, chunk_ix, text, vector }) in parallele, für den
// Scan optimierte Arrays überführen: normierte Vektoren (Einheitslänge) + Meta.
// Chunks unter MIN_CHARS oder mit Nullvektor werden verworfen (fallen aus dem
// Vergleich). Rückgabe: { vecs: Float32Array[], metas: [{entity_id,chunk_ix,text}] }.
function prepare(chunks, { minChars = MIN_CHARS } = {}) {
  const vecs = [];
  const metas = [];
  for (const c of chunks || []) {
    const text = String(c.text == null ? '' : c.text);
    if (text.trim().length < minChars) continue;
    const v = c.vector;
    if (!v || !v.length) continue;
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
    if (norm === 0) continue;
    const inv = 1 / Math.sqrt(norm);
    const unit = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) unit[i] = v[i] * inv;
    vecs.push(unit);
    metas.push({ entity_id: c.entity_id, chunk_ix: c.chunk_ix, text });
  }
  return { vecs, metas };
}

// Ein Block des oberen Dreiecks-Scans: für i in [iStart, iEnd) alle j > i.
// Vergleicht nur Chunks UNTERSCHIEDLICHER Entitäten (Doppelungen quer durchs
// Buch; chunk-interner Overlap derselben Seite ist trivial ähnlich und kein
// Befund). Hält pro Entitäts-Paar den besten Chunk-Treffer in `best` (Map
// `${a}:${b}` mit a<b → { a_id,a_ix,b_id,b_ix,score,ai,bi }). Mutiert `best` +
// gibt die Zahl der tatsächlich verglichenen Paare zurück (für Reporting).
function scanBlock(vecs, metas, iStart, iEnd, threshold, best) {
  let compared = 0;
  const n = vecs.length;
  for (let i = iStart; i < iEnd; i++) {
    const vi = vecs[i];
    const ei = metas[i].entity_id;
    const d = vi.length;
    for (let j = i + 1; j < n; j++) {
      const ej = metas[j].entity_id;
      if (ej === ei) continue; // gleiche Entität → skip
      const vj = vecs[j];
      if (vj.length !== d) continue; // Fremdmodell-Rest → nie Treffer
      compared++;
      let dot = 0;
      for (let k = 0; k < d; k++) dot += vi[k] * vj[k];
      if (dot < threshold) continue;
      // Entitäts-Paar-Key ordnungsunabhängig (a<b), damit beide Richtungen
      // in denselben Bucket fallen und pro Seitenpaar nur der beste Chunk zählt.
      const [a, b, ai, bi] = ei < ej ? [ei, ej, i, j] : [ej, ei, j, i];
      const key = a + ':' + b;
      const cur = best.get(key);
      if (!cur || dot > cur.score) {
        best.set(key, {
          a_id: a, a_ix: metas[ai].chunk_ix,
          b_id: b, b_ix: metas[bi].chunk_ix,
          score: dot, ai, bi,
        });
      }
    }
  }
  return compared;
}

// best-Map → sortierte Paar-Liste (höchster Score zuerst), auf topK gekappt.
// Snippet wird aus metas[ai/bi].text abgeleitet (auf snippetChars gekürzt).
// truncated = es gab mehr Paare über der Schwelle als topK zeigt.
function finalizePairs(best, metas, { topK = 50, snippetChars = 300 } = {}) {
  const all = Array.from(best.values()).sort((x, y) => y.score - x.score);
  const truncated = all.length > topK;
  const pairs = all.slice(0, topK).map(p => ({
    a_id: p.a_id, a_ix: p.a_ix, a_snippet: metas[p.ai].text.slice(0, snippetChars),
    b_id: p.b_id, b_ix: p.b_ix, b_snippet: metas[p.bi].text.slice(0, snippetChars),
    score: Math.round(p.score * 1000) / 1000,
  }));
  return { pairs, totalFound: all.length, truncated };
}

// Bequemer Voll-Scan in einem Rutsch — für Tests + kleine Bücher. Der Job nutzt
// prepare + scanBlock (blockweise mit Yield) + finalizePairs direkt.
function findRedundantPairs(chunks, { threshold = 0.82, topK = 50, minChars = MIN_CHARS, snippetChars = 300 } = {}) {
  const { vecs, metas } = prepare(chunks, { minChars });
  const best = new Map();
  const compared = scanBlock(vecs, metas, 0, vecs.length, threshold, best);
  return { ...finalizePairs(best, metas, { topK, snippetChars }), comparedPairs: compared, comparedChunks: vecs.length };
}

module.exports = { MIN_CHARS, prepare, scanBlock, finalizePairs, findRedundantPairs };
