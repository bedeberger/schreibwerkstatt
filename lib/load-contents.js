'use strict';
// Scope-Dispatcher fuer Export-Pipelines (Buch/Kapitel/Seite). Liefert eine
// einheitliche `groups`-Liste, gegen die alle Format-Builder + die PDF-Render-
// Pipeline arbeiten. Loest die bisherige `lib/load-book-contents.js` ab.
//
// Output-Shape:
//   {
//     scope: 'book' | 'chapter' | 'page',
//     book,                            // mapBook-Domain-Shape
//     chapter?: <mapChapter>,          // bei scope='chapter' / 'page' (falls Page in Kapitel)
//     page?:    <mapPage>,             // bei scope='page'
//     groups:   [{ chapterId, chapter, pages: [{ p: <pageMeta>, pd: <pageFull> }] }]
//   }
//
// Konsumenten: routes/export.js (Sync-Route) und routes/jobs/pdf-export.js
// (Custom-PDF). Storage-Zugriff laeuft ueber lib/content-store.js.

const contentStore = require('./content-store');
const { getDescendantChapterIds } = require('../db/book-order');

function _empty(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

async function _loadBookGroups(bookId, ctx) {
  const [sortedChapters, allPages] = await Promise.all([
    contentStore.listChapters(bookId, ctx),
    contentStore.listPages(bookId, ctx),
  ]);
  if (!allPages.length) throw _empty('BOOK_EMPTY');

  const chapterOrder = Object.fromEntries(sortedChapters.map((c, i) => [c.id, i]));
  const orderedPages = [...allPages].sort((a, b) => {
    const aO = a.chapter_id ? (chapterOrder[a.chapter_id] ?? 999) : -1;
    const bO = b.chapter_id ? (chapterOrder[b.chapter_id] ?? 999) : -1;
    if (aO !== bO) return aO - bO;
    return (a.position ?? 0) - (b.position ?? 0);
  });

  const pageDetails = await contentStore.loadPagesBatch(orderedPages, ctx, {
    batchSize: 15,
    onError: () => null,
  });
  const detailById = new Map(pageDetails.map(d => d ? [d.id, d] : [null, null]));
  const valid = orderedPages
    .map(p => ({ p, pd: detailById.get(p.id) || null }))
    .filter(x => x.pd && x.pd.html);
  if (!valid.length) throw _empty('BOOK_EMPTY');

  return _groupByChapter(valid, sortedChapters);
}

function _groupByChapter(valid, sortedChapters) {
  const groups = [];
  let cur = null;
  for (const x of valid) {
    if (x.p.chapter_id) {
      if (!cur || cur.chapterId !== x.p.chapter_id) {
        cur = {
          chapterId: x.p.chapter_id,
          chapter: sortedChapters.find(c => c.id === x.p.chapter_id) || null,
          pages: [],
        };
        groups.push(cur);
      }
      cur.pages.push(x);
    } else {
      groups.push({ chapterId: null, chapter: null, pages: [x] });
      cur = null;
    }
  }
  return groups;
}

async function _loadChapterGroups(chapterId, ctx, { includeSubchapters = false } = {}) {
  const chapter = await contentStore.loadChapter(chapterId, ctx);
  if (!chapter) throw _empty('CHAPTER_NOT_FOUND');
  const [sortedChapters, bookPages] = await Promise.all([
    contentStore.listChapters(chapter.book_id, ctx),
    contentStore.listPages(chapter.book_id, ctx),
  ]);

  // includeSubchapters: rekursiv Nachfahren (chapters.parent_chapter_id-CTE).
  // chapters.position ist depth-first global lueckenlos (siehe docs/chapter-hierarchy.md),
  // also reicht position-sort fuer Tree-Reihenfolge.
  const chapterIdSet = includeSubchapters
    ? new Set(getDescendantChapterIds(chapter.id, { includeSelf: true }))
    : new Set([chapter.id]);

  const chapterOrder = Object.fromEntries(sortedChapters.map((c, i) => [c.id, i]));
  const chapterPages = bookPages
    .filter(p => chapterIdSet.has(p.chapter_id))
    .sort((a, b) => {
      const aO = chapterOrder[a.chapter_id] ?? 999;
      const bO = chapterOrder[b.chapter_id] ?? 999;
      if (aO !== bO) return aO - bO;
      return (a.position ?? 0) - (b.position ?? 0);
    });
  if (!chapterPages.length) throw _empty('CHAPTER_EMPTY');

  const pageDetails = await contentStore.loadPagesBatch(chapterPages, ctx, {
    batchSize: 15,
    onError: () => null,
  });
  const detailById = new Map(pageDetails.map(d => d ? [d.id, d] : [null, null]));
  const valid = chapterPages
    .map(p => ({ p, pd: detailById.get(p.id) || null }))
    .filter(x => x.pd && x.pd.html);
  if (!valid.length) throw _empty('CHAPTER_EMPTY');

  return {
    chapter,
    groups: _groupByChapter(valid, sortedChapters),
  };
}

async function _loadPageGroup(pageId, ctx) {
  const page = await contentStore.loadPage(pageId, ctx);
  if (!page || !page.html) throw _empty('PAGE_EMPTY');
  let chapter = null;
  if (page.chapter_id) {
    try { chapter = await contentStore.loadChapter(page.chapter_id, ctx); }
    catch { chapter = null; }
  }
  return {
    page,
    chapter,
    groups: [{
      chapterId: chapter?.id ?? null,
      chapter,
      pages: [{ p: page, pd: page }],
    }],
  };
}

/**
 * Dispatcher.
 *
 * @param {{ scope: 'book'|'chapter'|'page', id: number, includeSubchapters?: boolean }} ref
 * @param {*} ctx  Express-Request oder Token-Objekt (siehe content-store).
 * @returns {Promise<{ scope, book, chapter?, page?, groups }>}
 */
async function loadContents({ scope, id, includeSubchapters = false }, ctx) {
  if (!Number.isFinite(id) || id <= 0) {
    const err = new Error('BAD_ID');
    err.code = 'BAD_ID';
    throw err;
  }
  if (scope === 'book') {
    const [book, groups] = await Promise.all([
      contentStore.loadBook(id, ctx),
      _loadBookGroups(id, ctx),
    ]);
    return { scope: 'book', book, groups };
  }
  if (scope === 'chapter') {
    const { chapter, groups } = await _loadChapterGroups(id, ctx, { includeSubchapters });
    const book = await contentStore.loadBook(chapter.book_id, ctx);
    return { scope: 'chapter', book, chapter, groups };
  }
  if (scope === 'page') {
    const { page, chapter, groups } = await _loadPageGroup(id, ctx);
    const book = await contentStore.loadBook(page.book_id, ctx);
    return { scope: 'page', book, chapter, page, groups };
  }
  const err = new Error('BAD_SCOPE');
  err.code = 'BAD_SCOPE';
  throw err;
}

module.exports = { loadContents };
