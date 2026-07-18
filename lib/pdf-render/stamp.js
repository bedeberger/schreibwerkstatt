'use strict';
// Nach-Body-Pässe, die über die gepufferte Seitenfolge iterieren und via
// switchToPage auf einzelne Seiten stempeln: TOC-Seitenzahlen, Titelei-
// Nummerierung, laufende Kopf-/Fusszeile und Schnittmarken. Kein Layout-Fluss,
// nur nachträgliches Zeichnen auf fertige Seiten.

const { MM_TO_PT, _romanize, _isVersoPageIdx } = require('./layout');
const { _drawHeaderFooter, _drawCropMarks } = require('./chrome');
const { TOC_PAGENUM_RESERVE_FALLBACK_PT } = require('./pages');

// TOC-Page-Numbers-Stempel-Pass: für jeden Plan-Eintrag mit gerenderter Position
// die effektive Body-Pagenummer rechts ausrichten. Einträge mit pageIdx < 0
// (über TOC-Tiefe gefiltert / nicht im Body gerendert) und Ziel-Seiten im
// Counter-Skip (bodyPageNum == null) werden geskippt.
function stampTocPageNumbers(doc, { tocEffective, tocPlan, tocPositions, pageNumByIdx, config }) {
  if (!(tocEffective.enabled && tocEffective.showPageNumbers && tocPositions.length === tocPlan.length)) return;
  doc.save();
  const tocFont = config.font.toc || config.font.body;
  doc.font('toc').fontSize(tocFont.sizePt || 11).fillColor(tocFont.color || '#000000');
  const reservePt = (tocEffective.pageNumReserveMm != null)
    ? tocEffective.pageNumReserveMm * MM_TO_PT
    : TOC_PAGENUM_RESERVE_FALLBACK_PT;
  for (let i = 0; i < tocPlan.length; i++) {
    const pos = tocPositions[i];
    const plan = tocPlan[i];
    if (!pos || plan.pageIdx < 0) continue;
    const bodyPageNum = pageNumByIdx.get(plan.pageIdx);
    if (bodyPageNum == null) continue;
    doc.switchToPage(pos.tocPageIdx);
    const pageW = doc.page.width;
    // Rechtsmarge der Ziel-Seite lesen: switchToPage stellt die pro-Seite
    // gespeicherten (bei mirrorMargins bereits gespiegelten) Margins wieder her,
    // sodass die Seitenzahl auf Verso/Recto am selben Bund-relativen Ort steht
    // wie die Leader-Reserve im _renderToc-Pass.
    const xRight = pageW - doc.page.margins.right - reservePt;
    doc.text(String(bodyPageNum), xRight, pos.y, {
      width: reservePt,
      align: 'right',
      lineBreak: false,
    });
  }
  doc.restore();
}

// Titelei-Nummerierungs-Pass (eigener Zählstrang). Nummeriert die Seiten
// zwischen Cover und Body-Start (Titel/Widmung/Motto/TOC) — Cover nie
// (Full-Bleed), leere/Impressum-Seiten auch nicht. 'roman' → i, ii, iii,
// 'arabic' → 1, 2, 3. Nur Footer, kein laufender Header. Sichtbar erst ab
// frontMatterNumberFirstVisible; frühere Seiten zählen mit, zeigen keine Nummer.
function stampFrontMatterNumbering(doc, { layout, range, coverPageCount, bodyStartPageIdx, blankPageIdxs, book, author, margins, chromeFonts }) {
  const fmNumbering = layout.frontMatterNumbering; // 'none' | 'roman' | 'arabic'
  if (fmNumbering !== 'roman' && fmNumbering !== 'arabic') return;
  const fmStartIdx = range.start + coverPageCount;
  let fmCnt = 0;
  for (let i = fmStartIdx; i < bodyStartPageIdx; i++) {
    if (blankPageIdxs.has(i)) continue;
    fmCnt += 1;
    if (fmCnt < layout.frontMatterNumberFirstVisible) continue;
    const label = fmNumbering === 'roman' ? _romanize(fmCnt).toLowerCase() : String(fmCnt);
    doc.switchToPage(i);
    _drawHeaderFooter(doc, layout, {
      title: book.name || '',
      author,
      chapter: '',
      pageTitle: '',
      page: label,
      pages: null,
      isVerso: _isVersoPageIdx(i),
      skipHeader: true,
    }, margins, chromeFonts);
  }
}

// Header/Footer-Stempel-Pass für alle Body-Pages. Aktuelle Kapitel-/Page-
// Bezeichnung über die First-Page-Maps; Seitenzahl aus pageNumByIdx (null →
// {page} bleibt leer); Sichtbarkeits-Gate ab pageNumberFirstVisible.
function stampHeaderFooter(doc, { range, bodyStartPageIdx, layout, blankPageIdxs, chapterFirstPage, pageTitleFirstPage, chapterEndSet, pageNumByIdx, totalBodyPages, book, author, margins, chromeFonts }) {
  const chapterStartSet = new Set(chapterFirstPage.map(c => c.pageIdx));
  const skipHeaderOnChapter = !layout.showHeaderOnChapterStart;
  const skipFooterOnChapter = layout.showFooterOnChapterStart === false;
  const skipHeaderOnChapterEnd = layout.showHeaderOnChapterEnd === false;
  const skipFooterOnChapterEnd = layout.showFooterOnChapterEnd === false;
  for (let i = bodyStartPageIdx; i < range.start + range.count; i++) {
    if (blankPageIdxs.has(i)) continue; // leere Verso-Seiten + Impressum: kein Header/Footer
    doc.switchToPage(i);
    let chapterTitle = '';
    for (const cp of chapterFirstPage) {
      if (cp.pageIdx <= i) chapterTitle = cp.title;
      else break;
    }
    let pageTitle = '';
    for (const pp of pageTitleFirstPage) {
      if (pp.pageIdx <= i) pageTitle = pp.title;
      else break;
    }
    const rawPageNum = pageNumByIdx.get(i); // null fuer geskippte Pages → {page} bleibt leer
    const pageNum = (rawPageNum != null && rawPageNum >= layout.pageNumberFirstVisible) ? rawPageNum : null;
    const isChapterStart = chapterStartSet.has(i);
    const isChapterEnd = chapterEndSet.has(i);
    _drawHeaderFooter(doc, layout, {
      title: book.name || '',
      author,
      chapter: chapterTitle,
      pageTitle,
      page: pageNum,
      pages: totalBodyPages,
      isVerso: _isVersoPageIdx(i),
      skipHeader: (isChapterStart && skipHeaderOnChapter) || (isChapterEnd && skipHeaderOnChapterEnd),
      skipFooter: (isChapterStart && skipFooterOnChapter) || (isChapterEnd && skipFooterOnChapterEnd),
    }, margins, chromeFonts);
  }
}

// Schnittmarken-Pass auf ALLEN Seiten (inkl. Frontmatter/Cover), in den Anschnitt
// gezeichnet. Nur mit Beschnitt sinnvoll.
function stampCropMarks(doc, { bleedPt }) {
  const full = doc.bufferedPageRange();
  const markLen = Math.min(bleedPt, 5 * MM_TO_PT);
  for (let i = full.start; i < full.start + full.count; i++) {
    doc.switchToPage(i);
    _drawCropMarks(doc, bleedPt, markLen);
  }
}

module.exports = { stampTocPageNumbers, stampFrontMatterNumbering, stampHeaderFooter, stampCropMarks };
