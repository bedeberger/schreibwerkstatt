'use strict';
// Zentraler Freitext-Query-Pfad der semantischen Suche — eine Stelle für alle
// Qualitäts-Stufen, geteilt von der Such-Route und dem Buch-Chat-Tool
// `search_similar`:
//
//   1. Retrieval   — Embedding-Cosinus (embed.min_score als Long-Tail-Floor)
//   2. Hybrid      — optionale Fusion mit der FTS5/bm25-Rangliste via RRF
//                    (embed.hybrid) → exakte Begriffe/Eigennamen kommen zurück
//   3. Reranking   — optionale Cross-Encoder-Nachordnung des Kandidatenpools
//                    (rerank.*) → schärfere Relevanz als Retrieval allein
//
// Rein rückwärtsgewandt (findet Bestehendes, schreibt nie in den Buchtext). Der
// „ähnliche Stellen zu Entität"-Pfad läuft NICHT hierüber (kein Query-Text →
// kein Rerank/Hybrid); er nutzt db/semantic-chunks#searchSimilar direkt.

const appSettings = require('./app-settings');
const embed = require('./embed');
const rerank = require('./rerank');
const semanticChunks = require('../db/semantic-chunks');
const searchIndex = require('./search');
const { fuseCandidates } = require('./semantic-fusion');
const logger = require('../logger');

function _hybridEnabled() {
  return appSettings.get('embed.hybrid') !== false;
}
function _minScore() {
  const v = Number(appSettings.get('embed.min_score'));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// Freitext-Semantiksuche. bookId + query Pflicht. kinds default = alle indizierten
// Kinds (page/scene/figure). Rückgabe: [{ kind, entity_id, text, score }] in
// finaler Reihenfolge (score-Bedeutung: Rerank-Relevanz > RRF-Score > Cosinus,
// je nachdem welche Stufe aktiv ist). Fällt der Reranker aus → RRF/Cosinus.
async function semanticQuery(bookId, query, { kinds = null, topK = 20, signal } = {}) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return [];

  const { model } = embed.getConfig();
  const useHybrid = _hybridEnabled();
  const useRerank = rerank.isEnabled();
  const rr = useRerank ? rerank.getConfig() : null;

  // Kandidatenpool grösser ziehen als topK, damit Fusion/Rerank Spielraum haben.
  const pool = Math.min(100, Math.max(topK, useRerank ? rr.topN : 0, useHybrid ? 30 : 0));

  const qVec = await embed.embedQuery(q, { signal });
  const semHits = semanticChunks.searchSimilar(bookId, model, qVec, {
    kinds, topK: pool, minScore: _minScore(),
  });

  let ftsHits = [];
  if (useHybrid) {
    try {
      const r = searchIndex.query(q, { bookId, kinds, limit: pool });
      ftsHits = (r.hits || []).filter(h => !kinds || kinds.includes(h.kind));
    } catch (e) {
      logger.warn(`[semantic] Hybrid-FTS fehlgeschlagen ("${q}"): ${e.message}`);
    }
  }

  const fused = fuseCandidates(semHits, ftsHits);
  if (!fused.length) return [];

  if (useRerank) {
    const cands = fused.slice(0, rr.topN);
    let order = null;
    try {
      order = await rerank.rerank(q, cands.map(c => c.text), { signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      logger.warn(`[semantic] Reranker nicht erreichbar, RRF-Fallback: ${e.message}`);
    }
    if (order && order.length) {
      return order
        .filter(o => o.score >= (rr.minScore || 0))
        .slice(0, topK)
        .map(o => ({ kind: cands[o.index].kind, entity_id: cands[o.index].entity_id, text: cands[o.index].text, score: o.score }));
    }
    // sonst: still auf die Fusions-Reihenfolge zurückfallen
  }

  return fused.slice(0, topK).map(c => ({
    kind: c.kind,
    entity_id: c.entity_id,
    text: c.text,
    // Hybrid: RRF-Score (listen-intern vergleichbar). Reine Semantik: Cosinus.
    score: useHybrid ? c.rrf : (c.semScore != null ? c.semScore : c.rrf),
  }));
}

module.exports = { semanticQuery };
