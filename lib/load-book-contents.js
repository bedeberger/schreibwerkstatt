'use strict';
// Lädt Kapitel + Seiten eines Buchs und gruppiert sie für Export-/Render-
// Pipelines. Ergibt eine Liste von { chapterId, chapter, pages }.
// Wird von routes/export.js und lib/pdf-render.js konsumiert.
//
// Storage-Zugriff laeuft ueber lib/content-store.js (Domain-Repository).

const contentStore = require('./content-store');

async function loadBookContents(bookId, token) {
  const [sortedChapters, allPages] = await Promise.all([
    contentStore.listChapters(bookId, token), // position-sortiert
    contentStore.listPages(bookId, token),
  ]);
  if (!allPages.length) {
    const err = new Error('BOOK_EMPTY');
    err.code = 'BOOK_EMPTY';
    throw err;
  }

  const chapterOrder = Object.fromEntries(sortedChapters.map((c, i) => [c.id, i]));
  const orderedPages = [...allPages].sort((a, b) => {
    const aO = a.chapter_id ? (chapterOrder[a.chapter_id] ?? 999) : -1;
    const bO = b.chapter_id ? (chapterOrder[b.chapter_id] ?? 999) : -1;
    if (aO !== bO) return aO - bO;
    return (a.position ?? 0) - (b.position ?? 0);
  });

  const pageDetails = await contentStore.loadPagesBatch(orderedPages, token, {
    batchSize: 15,
    onError: () => null,
  });
  const detailById = new Map(pageDetails.map(d => [d.id, d]));
  const valid = orderedPages
    .map(p => ({ p, pd: detailById.get(p.id) || null }))
    .filter(x => x.pd && x.pd.html);
  if (!valid.length) {
    const err = new Error('BOOK_EMPTY');
    err.code = 'BOOK_EMPTY';
    throw err;
  }

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
  return { groups };
}

module.exports = { loadBookContents };
