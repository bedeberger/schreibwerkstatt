'use strict';
// Liefert alle Kapitel + Seiten eines Buchs in Lesereihenfolge mit vollem HTML.
// Frontend rendert daraus den durchgehend scrollbaren Bucheditor.
//
// Server-Side-Aggregation statt N Client-Requests:
//   - Eine Anfrage statt 50+ → keine Browser-Concurrency-Limits.
//   - `bsBatch` (Concurrency 15) verteilt Last gegen Laravel-Throttle.
//   - bsGet retried 429 mit Retry-After automatisch.
//
// Frische Reads: gleicher Vertrag wie selectPage(p) — Cache-Lieferung okay,
// Save-Pfad pro Block macht `_checkPageConflict`/`bsPut` mit Stale-Schutz.

const express = require('express');
const { bsGetAll, bsGet, bsBatch } = require('../lib/bookstack');
const { bookParamHandler } = require('../lib/log-context');
const { toIntId } = require('../lib/validate');
const logger = require('../logger');

const router = express.Router();
router.param('book_id', bookParamHandler);

router.get('/:book_id/contents', async (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const token = req.session?.bookstackToken;
  if (!token) return res.status(401).json({ error_code: 'NO_TOKEN' });

  try {
    const [chapters, pages] = await Promise.all([
      bsGetAll(`chapters?filter[book_id]=${bookId}`, token),
      bsGetAll(`pages?filter[book_id]=${bookId}`, token),
    ]);

    const sortedChapters = [...chapters].sort((a, b) => a.priority - b.priority);
    const chapterOrder = Object.fromEntries(sortedChapters.map((c, i) => [c.id, i]));
    const chMap = Object.fromEntries(sortedChapters.map(c => [c.id, c.name]));

    const sortedPages = [...pages].sort((a, b) => {
      const aO = a.chapter_id ? (chapterOrder[a.chapter_id] ?? 999) : -1;
      const bO = b.chapter_id ? (chapterOrder[b.chapter_id] ?? 999) : -1;
      if (aO !== bO) return aO - bO;
      return a.priority - b.priority;
    });

    const details = await bsBatch(sortedPages, async (p) => {
      const full = await bsGet('pages/' + p.id, token);
      return {
        pageId: p.id,
        pageName: p.name,
        pagePriority: p.priority,
        chapterId: p.chapter_id || null,
        chapterName: p.chapter_id ? (chMap[p.chapter_id] || null) : null,
        html: full.html || '',
        updated_at: full.updated_at,
        revision_count: full.revision_count || 0,
        book_slug: p.book_slug || full.book_slug || null,
        slug: p.slug || full.slug || null,
      };
    }, { batchSize: 15 });

    // bsBatch verwirft fehlgeschlagene Pages (null). Damit der Bucheditor
    // den selben Page-Bestand wie der Tree zeigt, in Originalreihenfolge
    // sortieren (bsBatch garantiert keine Reihenfolge).
    const byId = new Map(details.map(d => [d.pageId, d]));
    const ordered = sortedPages.map(p => byId.get(p.id)).filter(Boolean);

    res.json({
      bookId,
      pages: ordered,
      missing: sortedPages.length - ordered.length,
    });
  } catch (e) {
    logger.error(`[book-editor/contents] ${e.message}`);
    res.status(500).json({ error_code: 'LOAD_FAILED', message: e.message });
  }
});

module.exports = router;
