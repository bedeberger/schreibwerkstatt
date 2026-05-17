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
const logger = require('../logger');

const router = express.Router();

const DEFAULT_KINDS = ['page', 'chapter'];

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

module.exports = router;
