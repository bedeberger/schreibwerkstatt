'use strict';
// Liefert alle Kapitel + Seiten eines Buchs in Lesereihenfolge mit vollem HTML.
// Frontend rendert daraus den durchgehend scrollbaren Bucheditor.
//
// Server-Side-Aggregation statt N Client-Requests:
//   - Eine Anfrage statt 50+ → keine Browser-Concurrency-Limits.
//   - Batch-Loader (Concurrency 15) verteilt Last gegen Laravel-Throttle.
//
// Frische Reads: gleicher Vertrag wie selectPage(p) — Cache-Lieferung okay,
// Save-Pfad pro Block macht `_checkPageConflict`/`savePage` mit Stale-Schutz.

const express = require('express');
const contentStore = require('../lib/content-store');
const { bookParamHandler } = require('../lib/log-context');
const { toIntId } = require('../lib/validate');
const { getTokenForRequest } = require('../db/schema');
const logger = require('../logger');

const router = express.Router();
router.param('book_id', bookParamHandler);

router.get('/:book_id/contents', async (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  if (!getTokenForRequest(req)) return res.status(401).json({ error_code: 'NO_TOKEN' });

  try {
    const tree = await contentStore.bookTree(bookId, req);

    // Flat-Liste in Lesereihenfolge (Kapitel-Seiten gefolgt von Top-Level-Seiten)
    // analog zur Frontend-Tree-Konstruktion.
    const flatMetas = [
      ...tree.chapters.flatMap(c => c.pages.map(p => ({ ...p, _chapterName: c.name }))),
      ...tree.topPages.map(p => ({ ...p, _chapterName: null })),
    ];

    const details = await contentStore.loadPagesBatch(flatMetas, req, { batchSize: 15 });

    // Reihenfolge erhalten: loadPagesBatch garantiert keine Ordnung (Promise.allSettled).
    const byId = new Map(details.map(d => [d.id, d]));
    const ordered = flatMetas
      .map(meta => {
        const d = byId.get(meta.id);
        if (!d) return null;
        return {
          pageId: d.id,
          pageName: d.name,
          pagePriority: d.position,
          chapterId: d.chapter_id || null,
          chapterName: meta._chapterName,
          html: d.html || '',
          updated_at: d.updated_at,
          revision_count: d.revision_count || 0,
          book_slug: d.book_slug || null,
          slug: d.slug || null,
        };
      })
      .filter(Boolean);

    res.json({
      bookId,
      pages: ordered,
      missing: flatMetas.length - ordered.length,
    });
  } catch (e) {
    logger.error(`[book-editor/contents] ${e.message}`);
    res.status(500).json({ error_code: 'LOAD_FAILED', message: e.message });
  }
});

module.exports = router;
