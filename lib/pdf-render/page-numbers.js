'use strict';
// Zwei reine Berechnungspässe über die gepufferte Seitenfolge (kein Zeichnen):
//  - computePageNumbers: Body-pageIdx → sichtbare Seitenzahl (null = aus der
//    Zählung genommen: leere Verso/Impressum-Seiten, Counter-Skip-Kapitel/-Pages)
//  - computeChapterEndSet: pro Kapitel die letzte nicht-leere Body-Seite

// pageCountMode='physical': alle physischen Seiten zählen mit → gedruckte Zahl =
// PDF-Seite. Die Titelei (alles vor bodyStartPageIdx) fliesst als Offset in den
// Body-Zähler ein; Body-Leerseiten zählen ebenfalls mit. Titelei + Leerseiten
// kriegen selbst keinen Footer, verbrauchen aber je einen Zählschritt, damit die
// Nummerierung lückenlos der Blattfolge folgt.
// pageCountMode='body': Leerseiten fallen aus der Zählung (Buchkonvention).
function computePageNumbers({ layout, range, bodyStartPageIdx, chapterFirstPage, pageTitleFirstPage, blankPageIdxs, skipPageIdSet }) {
  const pageNumByIdx = new Map();
  const physical = layout.pageCountMode === 'physical';
  const frontMatterPages = physical ? (bodyStartPageIdx - range.start) : 0;
  let cnt = layout.pageNumberStart - 1 + frontMatterPages;
  let chIdx = 0;
  let ptIdx = 0;
  let activeChapterSkip = false;
  let activePageId = null;
  for (let i = bodyStartPageIdx; i < range.start + range.count; i++) {
    while (chIdx < chapterFirstPage.length && chapterFirstPage[chIdx].pageIdx <= i) {
      activeChapterSkip = !!chapterFirstPage[chIdx].skipPageCounter;
      activePageId = null; // an Kapitel-Grenze ruecksetzen, naechster Item-Anker setzt neu
      chIdx++;
    }
    while (ptIdx < pageTitleFirstPage.length && pageTitleFirstPage[ptIdx].pageIdx <= i) {
      activePageId = pageTitleFirstPage[ptIdx].pageId ?? null;
      ptIdx++;
    }
    if (blankPageIdxs.has(i)) {
      if (physical) { cnt += 1; pageNumByIdx.set(i, cnt); }
      else { pageNumByIdx.set(i, null); }
      continue;
    }
    const isSkipped = activeChapterSkip || (activePageId != null && skipPageIdSet.has(activePageId));
    if (isSkipped) {
      pageNumByIdx.set(i, null);
    } else {
      cnt += 1;
      pageNumByIdx.set(i, cnt);
    }
  }
  // {pages} = höchste vergebene Seitenzahl (nicht nur Anzahl gezählter Seiten),
  // damit „Seite X von Y" mit pageNumberStart-/pageCountMode-Offset stimmt.
  const counted = Array.from(pageNumByIdx.values()).filter(v => v != null);
  const totalBodyPages = counted.length ? Math.max(...counted) : 0;
  return { pageNumByIdx, totalBodyPages };
}

// Kapitel-Endseiten: pro Kapitel die letzte nicht-leere Body-Seite (rückwärts
// gesucht, damit leere Verso-/Impressum-Seiten übersprungen werden).
function computeChapterEndSet({ chapterFirstPage, range, blankPageIdxs }) {
  const chapterEndSet = new Set();
  const starts = chapterFirstPage.map(c => c.pageIdx).sort((a, b) => a - b);
  const lastBodyIdx = range.start + range.count - 1;
  for (let k = 0; k < starts.length; k++) {
    const rangeEnd = (k + 1 < starts.length) ? starts[k + 1] - 1 : lastBodyIdx;
    for (let i = rangeEnd; i >= starts[k]; i--) {
      if (!blankPageIdxs.has(i)) { chapterEndSet.add(i); break; }
    }
  }
  return chapterEndSet;
}

module.exports = { computePageNumbers, computeChapterEndSet };
