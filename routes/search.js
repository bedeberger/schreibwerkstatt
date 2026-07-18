'use strict';
// Volltextsuche-API.
//
// GET /search?q=...&kind=page,chapter&book_id=42&limit=50&offset=0
//   - ACL strikt: JOIN gegen book_access via session.user.email.
//   - book_id: viewer-Guard auf das Buch (Cross-Book-Suche unterbunden).
//   - kind: Komma-Liste aus VALID_KINDS (book/chapter/page/figure/location/
//           scene/idea); Default = page,chapter (Spec-Default).
//   - Trigram-Fallback automatisch bei Single-Word-Zero-Hit.
//
// Response: { hits: [{ kind, entity_id, book_id, title, snippet, rank }],
//             fallback: boolean }

const express = require('express');
const { toIntId } = require('../lib/validate');
const { requireBookAccess, sendACLError } = require('../lib/acl');
const { setContext } = require('../lib/log-context');
const bookAccess = require('../db/book-access');
const searchIndex = require('../lib/search');
const semanticChunks = require('../db/semantic-chunks');
const embed = require('../lib/embed');
const { db } = require('../db/connection');
const logger = require('../logger');

const router = express.Router();

const DEFAULT_KINDS = ['page', 'chapter'];
// Kinds, für die ein Embedding-Index existiert (semantische Suche).
const SEMANTIC_KINDS = ['page', 'scene', 'figure'];

function _userEmail(req) {
  return req.session?.user?.email || null;
}

function _parseKinds(raw) {
  if (raw == null) return DEFAULT_KINDS;
  const s = String(raw).trim();
  if (!s || s === '*' || s === 'all') return Array.from(searchIndex.VALID_KINDS);
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  const filtered = parts.filter(k => searchIndex.VALID_KINDS.has(k));
  return filtered.length ? filtered : DEFAULT_KINDS;
}

router.get('/', (req, res) => {
  const email = _userEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json({ hits: [], fallback: false });
  if (q.length > 200) return res.status(400).json({ error_code: 'QUERY_TOO_LONG' });

  const bookId = req.query.book_id ? toIntId(req.query.book_id) : null;
  if (req.query.book_id && !bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });

  if (bookId) {
    setContext({ book: bookId });
    try { requireBookAccess(req, bookId, 'viewer'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }

  const kinds = _parseKinds(req.query.kind);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  let allowedBookIds = null;
  if (!bookId) {
    allowedBookIds = bookAccess.listBookIdsForUser(email).map(r => r.book_id);
    if (!allowedBookIds.length) return res.json({ hits: [], fallback: false });
  }

  try {
    const result = searchIndex.query(q, {
      allowedBookIds, kinds, bookId, limit, offset,
    });
    res.json({
      hits: result.hits || [],
      fallback: !!result.fallback,
    });
  } catch (e) {
    logger.error(`[search] GET /search failed: ${e.message}`);
    res.status(500).json({ error_code: 'SEARCH_FAILED', detail: e.message });
  }
});

// Semantische Suche (Embedding-basiert, buch-skopiert). Zwei Eingänge:
//   ?q=…                    → Freitext, wird einmal embeddet
//   ?like_kind=…&like_id=…  → „ähnliche Stellen zu dieser Entität" (Figur/Szene/
//                             Seite); nutzt den bereits indizierten Mittelvektor,
//                             KEIN Embedding-Call, und schliesst die Quelle aus.
// Immer book_id-Pflicht (Vektoren leben pro Buch) + viewer-ACL. Trefferformat
// spiegelt die FTS-Route: { kind, entity_id, book_id, title, snippet, score }.
// Snippet fliesst im Frontend in einen x-html-Sink (search.html) → server-seitig
// escapen (Hard-Rule „x-html nur mit vorab-escaptem Content"). Kein <mark> nötig
// (semantische Treffer haben keine Wort-Offsets).
function _escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _resolveSemanticHits(hits) {
  const out = [];
  for (const h of hits) {
    let row = null;
    if (h.kind === 'page') row = db.prepare('SELECT page_name AS title, book_id FROM pages WHERE page_id = ?').get(h.entity_id);
    else if (h.kind === 'scene') row = db.prepare('SELECT titel AS title, book_id FROM figure_scenes WHERE id = ?').get(h.entity_id);
    else if (h.kind === 'figure') row = db.prepare('SELECT name AS title, book_id FROM figures WHERE id = ?').get(h.entity_id);
    if (!row) continue; // gelöschte Entität → Geister-Chunk überspringen
    out.push({
      kind: h.kind, entity_id: h.entity_id, book_id: row.book_id,
      title: row.title || '', snippet: _escHtml(String(h.text || '').slice(0, 300)),
      score: Math.round(h.score * 1000) / 1000,
    });
  }
  return out;
}

router.get('/semantic', async (req, res) => {
  const email = _userEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  if (!embed.isEnabled()) return res.status(400).json({ error_code: 'EMBED_DISABLED' });

  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'viewer'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const { model } = embed.getConfig();
  const rawKinds = _parseKinds(req.query.kind).filter(k => SEMANTIC_KINDS.includes(k));
  const kinds = rawKinds.length ? rawKinds : SEMANTIC_KINDS;
  const topK = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

  const likeKind = String(req.query.like_kind || '').trim();
  const likeId = req.query.like_id ? toIntId(req.query.like_id) : null;

  try {
    let queryVec = null;
    let exclude = { excludeKind: null, excludeEntityId: null };
    if (likeKind && likeId && SEMANTIC_KINDS.includes(likeKind)) {
      queryVec = semanticChunks.getEntityVector(likeKind, likeId, model);
      if (!queryVec) return res.json({ hits: [], mode: 'semantic', notIndexed: true });
      exclude = { excludeKind: likeKind, excludeEntityId: likeId };
    } else {
      const q = (req.query.q || '').toString().trim();
      if (q.length < 2) return res.json({ hits: [], mode: 'semantic' });
      if (q.length > 500) return res.status(400).json({ error_code: 'QUERY_TOO_LONG' });
      queryVec = await embed.embedOne(q);
    }
    const raw = semanticChunks.searchSimilar(bookId, model, queryVec, { kinds, topK, ...exclude });
    res.json({ hits: _resolveSemanticHits(raw), mode: 'semantic' });
  } catch (e) {
    logger.error(`[search] GET /search/semantic failed: ${e.message}`);
    res.status(503).json({ error_code: 'EMBED_UNAVAILABLE', detail: e.message });
  }
});

module.exports = router;
