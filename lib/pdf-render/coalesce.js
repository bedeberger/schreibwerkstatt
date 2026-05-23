'use strict';
// Gruppiert die loadBookContents-Output zu Render-Blöcken. Pro Kapitel ein
// Block; Modus 'flatten' verkettet alle Pages, 'nested' rendert pro Page einen
// h2-Sub-Heading. Bei verschachtelten Kapiteln traegt jeder Block die `depth`
// (1..3), die im Renderer auf h1/h2/h3 + Page-Break-Verhalten gemappt wird.

// Berechnet die Tiefe eines Kapitels durch Aufstieg via parent_chapter_id.
// Capped bei MAX_DEPTH (3). Kapitel ohne bekannten Parent → depth=1.
const MAX_DEPTH = 3;
function _depthByChapterId(chapter, byId) {
  let d = 1;
  let cur = chapter;
  const seen = new Set();
  while (cur && cur.parent_chapter_id) {
    if (seen.has(cur.parent_chapter_id)) break;
    seen.add(cur.parent_chapter_id);
    const parent = byId.get(cur.parent_chapter_id);
    if (!parent) break;
    d += 1;
    if (d >= MAX_DEPTH) return MAX_DEPTH;
    cur = parent;
  }
  return d;
}

// True, wenn das Kapitel selbst oder irgendein Ancestor in `excludedSet` liegt.
function _ancestorInSet(chapter, byId, excludedSet) {
  let cur = chapter;
  const seen = new Set();
  while (cur) {
    if (excludedSet.has(cur.id)) return true;
    if (!cur.parent_chapter_id || seen.has(cur.parent_chapter_id)) return false;
    seen.add(cur.parent_chapter_id);
    cur = byId.get(cur.parent_chapter_id);
  }
  return false;
}

function _coalesceGroups(groups, pageStructure, pageBreakBetweenPages, unnumberedChapterIds, skipPageCounterChapterIds) {
  // Map fuer Depth-Lookup ueber Parent-Kette. Kapitel kommen aus loadContents
  // mit `parent_chapter_id`-Feld (siehe content-store/backends/localdb.js).
  const chaptersById = new Map();
  for (const g of groups) {
    if (g.chapter) chaptersById.set(g.chapter.id, g.chapter);
  }
  const excluded = new Set(Array.isArray(unnumberedChapterIds) ? unnumberedChapterIds : []);
  const skipCounterSet = new Set(Array.isArray(skipPageCounterChapterIds) ? skipPageCounterChapterIds : []);
  const out = [];
  for (const g of groups) {
    const depth = g.chapter ? _depthByChapterId(g.chapter, chaptersById) : 1;
    const unnumbered = g.chapter ? _ancestorInSet(g.chapter, chaptersById, excluded) : false;
    const skipPageCounter = g.chapter ? _ancestorInSet(g.chapter, chaptersById, skipCounterSet) : false;
    if (g.chapter && g.pages.length > 1 && pageStructure === 'nested') {
      const items = [];
      for (let i = 0; i < g.pages.length; i++) {
        items.push({
          heading: g.pages[i].p.name,
          pageName: g.pages[i].p.name,
          pageId: g.pages[i].p.id,
          html: g.pages[i].pd.html,
          breakBefore: i > 0 && pageBreakBetweenPages,
        });
      }
      out.push({
        title: g.chapter.name, level: 0, isChapter: true,
        chapterId: g.chapter.id,
        depth, unnumbered, skipPageCounter,
        introHtml: g.chapter.description_html || '',
        items,
      });
    } else if (g.chapter) {
      const html = (g.chapter.description_html || '') + g.pages.map(x => x.pd.html).join('\n');
      // Flatten-Mode: nur die erste BookStack-Page laesst sich noch sauber
      // verorten (alle anderen flow'en ohne Page-Anker). Pro-Page-Counter-Skip
      // ist hier eingeschraenkt; Kapitel-Skip greift weiterhin auf den Block.
      out.push({
        title: g.chapter.name, level: 0, isChapter: true,
        chapterId: g.chapter.id,
        depth, unnumbered, skipPageCounter,
        introHtml: '',
        items: [{
          html,
          pageName: g.pages[0]?.p?.name || g.chapter.name,
          pageId: g.pages[0]?.p?.id ?? null,
        }],
      });
    } else {
      const x = g.pages[0];
      out.push({
        title: x.p.name, level: 0, isChapter: false,
        chapterId: null,
        depth: 1, unnumbered: false, skipPageCounter: false,
        introHtml: '',
        items: [{ html: x.pd.html, pageName: x.p.name, pageId: x.p.id }],
      });
    }
  }
  return out;
}

module.exports = { _coalesceGroups };
