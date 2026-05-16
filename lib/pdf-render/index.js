'use strict';
// PDF-Renderer auf pdfkit. Nimmt geladene Buch-Inhalte (Output von
// loadBookContents in routes/export.js) und ein validiertes Profil-Config.
// Liefert ein finales PDF/A-2B-Buffer. PDF/A-Subset (XMP pdfaid + sRGB
// OutputIntent) macht pdfkit nativ via `subset: 'PDF/A-2b'`.
//
// Verantwortlichkeiten:
//  - Page-Setup (Größe, Margins) via PDFKit-Doc-Optionen
//  - Font-Bootstrapping: alle 5 Rollen-Fonts via lib/font-fetch laden + registerFont
//  - Cover-Page (optional, mit Title-Overlay)
//  - Title-Page (Titel + Subtitle + Byline)
//  - TOC-Outline (PDF-Bookmarks via doc.outline)
//  - Kapitel-Loop: per pageStructure 'flatten' oder 'nested' rendern
//  - Header/Footer pro Seite via 'pageAdded'-Event
//  - Block-Renderer für walker-Output (heading/paragraph/list/blockquote/poem/pre/image/hr)

const PDFDocument = require('pdfkit');
const { parseHtmlToBlocks } = require('./html-walker');

const { MM_TO_PT, _pageSize, _chapterLabel } = require('./layout');
const { _registerFonts, _patchDocTextSanitizer } = require('./fonts');
const {
  TOC_PAGENUM_RESERVE,
  _renderCover,
  _renderTitlePage,
  _renderDedicationPage,
  _renderImprintPage,
  _renderToc,
} = require('./pages');
const { _drawHeaderFooter } = require('./chrome');
const { _coalesceGroups } = require('./coalesce');
const { _renderBlock } = require('./blocks');

/**
 * @param {object} args
 * @param {object} args.book        - Book-Metadata (Domain-Shape via content-mapper)
 * @param {object} args.groups      - Output von lib/load-contents.js#loadContents
 * @param {object} args.profile     - Validiertes Profil { config, ... }
 * @param {Buffer|null} args.coverBuf - Vorbereitetes Cover-Image (sharp-prepared) oder null
 * @param {string|null} args.token  - BookStack-Token (für Image-Fetch)
 * @param {string|null} args.lang   - 'de' | 'en'
 * @param {string} [args.scope]     - 'book' | 'chapter' | 'page' (Default 'book')
 * @param {object} [args.chapter]   - Bei scope='chapter'/'page' (falls Page in Kapitel)
 * @param {object} [args.page]      - Bei scope='page'
 * @returns {Promise<Buffer>} PDF-Buffer (vor PDF/A-Postprocess)
 */
async function renderPdfBuffer({ book, groups, profile, coverBuf, token, lang, scope = 'book', chapter, page }) {
  const config = profile.config;
  const layout = config.layout;
  const docLang = (lang === 'en' || lang === 'de') ? lang : 'de';
  const [pageW, pageH] = _pageSize(layout);
  const margins = {
    top:    layout.marginsMm.top    * MM_TO_PT,
    right:  layout.marginsMm.right  * MM_TO_PT,
    bottom: layout.marginsMm.bottom * MM_TO_PT,
    left:   layout.marginsMm.left   * MM_TO_PT,
  };

  const author = book.created_by?.name || book.owned_by?.name || '';

  const pdfaConf = String(config.pdfa.conformance || 'B').toLowerCase();
  const docOpts = {
    size: [pageW, pageH],
    margins,
    autoFirstPage: false,
    bufferPages: true,
    pdfVersion: '1.7',
    tagged: true,
    displayTitle: true,
    lang: docLang,
    info: {
      Title:    book.name || '',
      Author:   author,
      Creator:  'schreibwerkstatt',
      Producer: 'pdfkit',
    },
  };
  if (config.pdfa.enabled) {
    // pdfkit-Subset triggert intern endSubset(): hängt pdfaid-XMP an + schreibt
    // OutputIntent mit eingebettetem sRGB-ICC-Profil. Manuelles Anhängen via
    // doc._root.data.Metadata wird sonst von endMetadata() ueberschrieben.
    docOpts.subset = `PDF/A-2${pdfaConf}`;
  }
  const doc = new PDFDocument(docOpts);

  await _registerFonts(doc, config.font);
  if (config.pdfa.enabled) _patchDocTextSanitizer(doc);

  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // Scope-Adjustments: Cover/TOC/Title-Page-Defaults bei Teil-Exporten.
  // Cover bei chapter/page weglassen (Buch-Identitaet ist nicht das Subjekt).
  // TOC bei page komplett weg, bei chapter einstufig.
  const coverAllowed = scope === 'book';
  const tocEnabled = config.toc.enabled && scope !== 'page';
  const tocDepth = scope === 'chapter' ? 1 : config.toc.depth;
  const tocEffective = { ...config.toc, enabled: tocEnabled, depth: tocDepth };

  // Cover (eigene Page ohne Margins)
  if (coverAllowed && config.cover.enabled && coverBuf) {
    doc.addPage({ size: [pageW, pageH], margins: { top: 0, right: 0, bottom: 0, left: 0 } });
    await _renderCover(doc, config.cover, coverBuf, book, profile);
  }

  // Title-Page: bei chapter/page Kapitel-/Seitentitel als Haupttitel, Buchname
  // als Untertitel-Kontext (config.extras.subtitle weicht in dem Fall der
  // Scope-Override; Profilautor kann das ueber Custom-Renderer noch nicht
  // erzwingen — wenn dort Bedarf entsteht, eigener Profil-Toggle).
  const titleOverrides = {};
  if (scope === 'chapter' && chapter) {
    titleOverrides.title = chapter.name || book.name || '';
    titleOverrides.subtitle = book.name || '';
  } else if (scope === 'page' && page) {
    titleOverrides.title = page.name || book.name || '';
    titleOverrides.subtitle = book.name || '';
  }
  _renderTitlePage(doc, book, config, titleOverrides);

  // Widmung (optional, vor TOC + Body)
  _renderDedicationPage(doc, config);

  // TOC: Plan aufbauen mit stabiler Zuordnung Plan → Body-Heading. Jeder Plan-
  // Eintrag bekommt blockIdx + itemIdx. Im Body-Loop schreiben wir pageIdx
  // zurück. Nach Body-Render wird per Plan + tocPositions[] die Seitenzahl
  // an der gespeicherten Position eingestempelt (Two-Pass-TOC).
  const blocks = _coalesceGroups(groups, config.chapter.pageStructure, config.chapter.pageBreakBetweenPages);
  const tocPlan = [];
  let tocChapCount = 0;
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    let title = b.title;
    if (b.isChapter) {
      tocChapCount++;
      const lbl = _chapterLabel(config.chapter.numbering, tocChapCount, docLang);
      if (lbl) title = `${lbl}. ${b.title}`;
    }
    tocPlan.push({ title, level: 0, blockIdx: bi, itemIdx: -1, pageIdx: -1 });
    if (b.isChapter && config.chapter.pageStructure === 'nested') {
      for (let i = 0; i < b.items.length; i++) {
        if (b.items[i].heading) {
          tocPlan.push({ title: b.items[i].heading, level: 1, blockIdx: bi, itemIdx: i, pageIdx: -1 });
        }
      }
    }
  }
  const tocPositions = tocEffective.enabled ? _renderToc(doc, tocEffective, tocPlan, docLang, config.font) : [];

  // Header/Footer werden nicht reaktiv pro pageAdded gestempelt (führt zu
  // Re-Entry-Stack-Overflow), sondern nach Body-Render in einem separaten
  // Pass über bufferedPageRange.
  const bodyStartPageIdx = doc.bufferedPageRange().start + doc.bufferedPageRange().count;
  let chapterCounter = 0;
  let currentChapterTitle = '';
  const chapterFirstPage = [];  // [{ pageIdx, title }]
  const pageTitleFirstPage = []; // [{ pageIdx, title }] — pro BookStack-Page
  const blankPageIdxs = new Set(); // Indices, auf denen kein Header/Footer gestempelt wird

  // Kapitel rendern
  const imageCache = new Map(); // src → { buffer, width, height } | null
  const dropCapHint = { pending: false };
  const renderCtx = {
    font: config.font, token, imageCache, dropCapHint,
    columns: layout.columns || 1,
    columnGap: (layout.columnGapMm || 0) * MM_TO_PT,
  };

  // Body-Inset: zusätzlicher Einzug, der nur für Fliesstext (Inhalt eines
  // Kapitels) gilt. Kapitel-Heading + leere/Impressum-Pages bleiben am
  // äusseren Seitenrand. Implementiert via temporärer Mutation der
  // page.margins, plus pageAdded-Listener für auto-paginierte Folgeseiten.
  const insetMm = layout.bodyInsetMm || { top: 0, right: 0, bottom: 0, left: 0 };
  const insetPt = {
    top:    (insetMm.top    || 0) * MM_TO_PT,
    right:  (insetMm.right  || 0) * MM_TO_PT,
    bottom: (insetMm.bottom || 0) * MM_TO_PT,
    left:   (insetMm.left   || 0) * MM_TO_PT,
  };
  const hasInset = !!(insetPt.top || insetPt.right || insetPt.bottom || insetPt.left);
  let insetActive = false;
  const onPageAdded = () => {
    if (!insetActive) return;
    doc.page.margins.top    += insetPt.top;
    doc.page.margins.right  += insetPt.right;
    doc.page.margins.bottom += insetPt.bottom;
    doc.page.margins.left   += insetPt.left;
    if (doc.x < doc.page.margins.left) doc.x = doc.page.margins.left;
    if (doc.y < doc.page.margins.top)  doc.y = doc.page.margins.top;
  };
  const enableBodyInset = () => {
    if (!hasInset || insetActive) return;
    insetActive = true;
    doc.page.margins.top    += insetPt.top;
    doc.page.margins.right  += insetPt.right;
    doc.page.margins.bottom += insetPt.bottom;
    doc.page.margins.left   += insetPt.left;
    if (doc.x < doc.page.margins.left) doc.x = doc.page.margins.left;
    if (doc.y < doc.page.margins.top)  doc.y = doc.page.margins.top;
  };
  const disableBodyInset = () => {
    if (!hasInset || !insetActive) return;
    insetActive = false;
    doc.page.margins.top    -= insetPt.top;
    doc.page.margins.right  -= insetPt.right;
    doc.page.margins.bottom -= insetPt.bottom;
    doc.page.margins.left   -= insetPt.left;
  };
  if (hasInset) doc.on('pageAdded', onPageAdded);

  doc.addPage();
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    if (block.isChapter) {
      chapterCounter++;
      currentChapterTitle = block.title;
      // Break: chapter 2+ bricht immer (Original-Verhalten, deckt
      // blankPageAfter-Folgeseite mit ab). Zusätzlich Kapitel 1, wenn auf
      // Body-Page-1 bereits lose Seiten gerendert wurden — ohne diesen
      // Bruch überlagert das spaceBeforeMm-Reset (unten) den Vorinhalt.
      const pageHasContent = doc.y > doc.page.margins.top + 1;
      const wantBreak = config.chapter.breakBefore !== 'none'
        && (chapterCounter > 1 || pageHasContent);
      let didBreak = false;
      if (wantBreak) {
        doc.addPage();
        didBreak = true;
        // Recto = ungerade Seitenzahl (1-indexiert). Wenn nach addPage die
        // gesamte Page-Count gerade ist, sind wir auf einer Verso-Seite —
        // dann eine zusätzliche leere Seite einschieben, damit das Kapitel
        // auf der nächsten Recto-Seite startet.
        if (config.chapter.breakBefore === 'right-page' && doc.bufferedPageRange().count % 2 === 0) {
          doc.addPage();
        }
      }
      // Vertikaler Vorschub: bei frischer Page absolut vom Top, sonst relativ
      // (Inline-Kapitel mit breakBefore='none' nach vorherigem Inhalt).
      if (!pageHasContent || didBreak) {
        doc.y = doc.page.margins.top + (config.chapter.spaceBeforeMm * MM_TO_PT);
      } else {
        doc.y += config.chapter.spaceBeforeMm * MM_TO_PT;
      }
      // Kapitel-Heading. Drei Stile:
      //  - centered-large: zentriert, Default-Größe (h1)
      //  - left-rule:      linksbündig + horizontaler Strich darunter
      //  - minimal:        linksbündig, kleiner (h2-Größe)
      const label = _chapterLabel(config.chapter.numbering, chapterCounter, docLang);
      const style = config.chapter.titleStyle;
      const titleSize = style === 'minimal'
        ? config.font.heading.sizes.h2
        : config.font.heading.sizes.h1;
      const titleAlign = style === 'centered-large' ? 'center' : 'left';
      const headingColor = config.font.heading.color || '#000000';
      doc.font('heading').fontSize(titleSize).fillColor(headingColor);
      if (label) {
        doc.text(label, { align: titleAlign });
        doc.moveDown(0.4);
      }
      doc.text(block.title, { align: titleAlign });
      // 'left-rule' style zeichnet bereits eine Linie; bei 'titleRule'-Toggle
      // doppeln wir nicht.
      if (style === 'left-rule' || config.chapter.titleRule) {
        _drawTitleRule(doc, headingColor);
      }
      doc.moveDown(1.2);
      doc.outline.addItem(label ? `${label}. ${block.title}` : block.title);
      const chapterPageIdx = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
      chapterFirstPage.push({ pageIdx: chapterPageIdx, title: block.title });
      const planChapter = tocPlan.find(e => e.blockIdx === bi && e.itemIdx === -1);
      if (planChapter) planChapter.pageIdx = chapterPageIdx;
      // DropCap am Anfang des Kapitels: erste Paragraph bekommt Initial-Buchstaben.
      dropCapHint.pending = !!config.chapter.dropCap;

      if (block.introHtml) {
        enableBodyInset();
        const introBlocks = parseHtmlToBlocks(block.introHtml);
        for (const ib of introBlocks) await _renderBlock(doc, ib, renderCtx);
      }
    }
    if (block.items.length) enableBodyInset();
    for (let ii = 0; ii < block.items.length; ii++) {
      const it = block.items[ii];
      if (it.breakBefore) doc.addPage();
      if (it.heading && config.chapter.pageStructure === 'nested') {
        doc.moveDown(0.6);
        const headingColor = config.font.heading.color || '#000000';
        doc.font('heading').fontSize(config.font.heading.sizes.h2).fillColor(headingColor);
        doc.text(it.heading, { align: 'left' });
        if (config.chapter.pageTitleRule) _drawTitleRule(doc, headingColor);
        doc.moveDown(0.6);
        const planSub = tocPlan.find(e => e.blockIdx === bi && e.itemIdx === ii);
        if (planSub) planSub.pageIdx = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
        if (config.chapter.dropCap) dropCapHint.pending = true;
      }
      // Anker für `{pageTitle}`: Start jedes Items markiert Übergang auf neue
      // BookStack-Page. Header/Footer-Pass nutzt das später, um pro PDF-Page
      // den jeweils gültigen Page-Namen einzusetzen.
      if (it.pageName) {
        pageTitleFirstPage.push({
          pageIdx: doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1,
          title: it.pageName,
        });
      }
      const itemBlocks = parseHtmlToBlocks(it.html);
      for (const ib of itemBlocks) await _renderBlock(doc, ib, renderCtx);
    }
    // Inset deaktivieren BEVOR blankPageAfter / nächster Chapter-AddPage
    // ausgelöst wird — sonst erbt die Leer-/Recto-Folgeseite den Body-Inset.
    disableBodyInset();
    if (config.chapter.blankPageAfter) {
      doc.addPage();
      blankPageIdxs.add(doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1);
    }
  }
  if (hasInset) doc.removeListener('pageAdded', onPageAdded);

  // Impressum-Page ans Buchende. Bekommt KEINEN Header/Footer (Konvention).
  if (config.extras.imprint) {
    _renderImprintPage(doc, config);
    blankPageIdxs.add(doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1);
  }

  // TOC-Page-Numbers-Stempel-Pass: für jeden Plan-Eintrag mit gerenderter
  // Position die effektive Body-Pagenummer rechts ausrichten. Eingaben mit
  // pageIdx = -1 (über TOC-Tiefe gefiltert oder nicht im Body gerendert)
  // werden geskippt — _renderToc liefert dafür `null` als Position.
  if (tocEffective.enabled && tocEffective.showPageNumbers && tocPositions.length === tocPlan.length) {
    doc.save();
    doc.font('body').fontSize(11).fillColor(config.font.body.color || '#000000');
    for (let i = 0; i < tocPlan.length; i++) {
      const pos = tocPositions[i];
      const plan = tocPlan[i];
      if (!pos || plan.pageIdx < 0) continue;
      const bodyPageNum = plan.pageIdx - bodyStartPageIdx + layout.pageNumberStart;
      doc.switchToPage(pos.tocPageIdx);
      const pageW = doc.page.width;
      const right = doc.page.margins.right;
      const xRight = pageW - right - TOC_PAGENUM_RESERVE;
      doc.text(String(bodyPageNum), xRight, pos.y, {
        width: TOC_PAGENUM_RESERVE,
        align: 'right',
        lineBreak: false,
      });
    }
    doc.restore();
  }

  // Header/Footer-Stempel-Pass: für alle Body-Pages.
  const range = doc.bufferedPageRange();
  const totalBodyPages = (range.start + range.count) - bodyStartPageIdx;
  for (let i = bodyStartPageIdx; i < range.start + range.count; i++) {
    if (blankPageIdxs.has(i)) continue; // leere Verso-Seiten + Impressum: kein Header/Footer
    doc.switchToPage(i);
    // Aktuelle Kapitel- und Page-Bezeichnung über die First-Page-Maps.
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
    const pageNumInBody = i - bodyStartPageIdx + 1;
    const pageNum = pageNumInBody + layout.pageNumberStart - 1;
    _drawHeaderFooter(doc, layout, {
      title: book.name || '',
      author,
      chapter: chapterTitle,
      pageTitle,
      page: pageNum,
      pages: totalBodyPages,
    }, margins);
  }

  doc.flushPages();
  doc.end();
  return done;
}

function _drawTitleRule(doc, color = '#000000') {
  const ruleY = doc.y + 4;
  const startX = doc.page.margins.left;
  const endX = doc.page.width - doc.page.margins.right;
  doc.save();
  doc.lineWidth(1).strokeColor(color)
     .moveTo(startX, ruleY).lineTo(endX, ruleY).stroke();
  doc.restore();
  doc.y = ruleY + 8;
}

module.exports = { renderPdfBuffer, MM_TO_PT };
