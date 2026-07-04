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

const { MM_TO_PT, _pageSize, _chapterLabel, _chapterLabelNested } = require('./layout');
const { _registerFonts, _patchDocTextSanitizer, _patchSoftHyphenStripper, _patchOpenTypeFeatures, _buildFeatureList } = require('./fonts');
const { createHyphenator } = require('./hyphenate');
const {
  TOC_PAGENUM_RESERVE_FALLBACK_PT,
  _renderCover,
  _renderTitlePage,
  _renderDedicationPage,
  _renderFrontMatterPage,
  _renderAuthorPage,
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
async function renderPdfBuffer({ book, groups, profile, coverBuf, authorImageBuf, token, lang, scope = 'book', chapter, page, meta }) {
  const config = profile.config;
  const layout = config.layout;
  const docLang = (lang === 'en' || lang === 'de') ? lang : 'de';
  // Beschnitt: Medienseite = Endformat (Trim) + 2×Bleed. Inhalt + Ränder messen
  // ab dem Endformat, deshalb wird der Bleed auf jeden Rand aufaddiert — der Text
  // bleibt so im selben Abstand zur Schnittkante wie ohne Beschnitt.
  const [trimW, trimH] = _pageSize(layout);
  const bleedPt = Math.max(0, config.print?.bleedMm || 0) * MM_TO_PT;
  const pageW = trimW + 2 * bleedPt;
  const pageH = trimH + 2 * bleedPt;
  const margins = {
    top:    layout.marginsMm.top    * MM_TO_PT + bleedPt,
    right:  layout.marginsMm.right  * MM_TO_PT + bleedPt,
    bottom: layout.marginsMm.bottom * MM_TO_PT + bleedPt,
    left:   layout.marginsMm.left   * MM_TO_PT + bleedPt,
  };

  // Author: buch-weiter Publikationsname (book_publication.author_name, bei
  // scope='book' in config.extras gespiegelt) uebersteuert den Account-Namen.
  const author = String(config.extras?.authorName || '').trim()
    || book.created_by?.name || book.owned_by?.name || '';
  // Subject/Keywords aus den buch-weiten Publikations-Metadaten (book_publication,
  // bei scope='book' in config.extras gespiegelt). Title bleibt SSoT books.name.
  const pubSubject  = String(config.extras?.description || '').trim();
  const pubKeywords = String(config.extras?.keywords || '').trim();

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
      ...(pubSubject  ? { Subject:  pubSubject }  : {}),
      ...(pubKeywords ? { Keywords: pubKeywords } : {}),
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
  // Soft-Hyphen-Stripper läuft unabhängig von Silbentrennung — SHY ist immer
  // unsichtbar, harmlos zu strippen. Schützt PDF/A gegen .notdef-Verstösse bei
  // Fonts ohne SHY-Glyph (alle gängigen Google-Fonts haben keinen).
  _patchSoftHyphenStripper(doc);
  // OpenType-Features (liga/clig/kern + ggf. onum/lnum) global injizieren.
  _patchOpenTypeFeatures(doc, _buildFeatureList(config.font));
  const hyphenator = config.layout.hyphenate !== false ? createHyphenator(docLang) : null;
  const mirror = !!config.layout.mirrorMargins;

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

  // Body-Inset + Mirror: gemeinsamer pageAdded-Hook MUSS vor jedem addPage
  // hängen, damit Frontmatter (Cover, Title, Widmung, TOC) ebenfalls die
  // korrekte Recto/Verso-Spiegelung bekommt. Body-Inset wird später im
  // Body-Loop via insetActive-Flag scharf geschaltet.
  const insetMm = layout.bodyInsetMm || { top: 0, right: 0, bottom: 0, left: 0 };
  const insetPt = {
    top:    (insetMm.top    || 0) * MM_TO_PT,
    right:  (insetMm.right  || 0) * MM_TO_PT,
    bottom: (insetMm.bottom || 0) * MM_TO_PT,
    left:   (insetMm.left   || 0) * MM_TO_PT,
  };
  const hasInset = !!(insetPt.top || insetPt.right || insetPt.bottom || insetPt.left);
  let insetActive = false;

  const _isVersoPageIdx = (idx) => idx % 2 === 1;
  const _applyMirror = () => {
    if (!mirror) return;
    // Full-bleed-Pages (Cover) haben margins=0 — keine Spiegelung anwenden.
    if (doc.page.margins.top === 0 && doc.page.margins.left === 0 && doc.page.margins.right === 0) return;
    const pageIdx = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
    const baseL = margins.left;
    const baseR = margins.right;
    doc.page.margins.left  = _isVersoPageIdx(pageIdx) ? baseR : baseL;
    doc.page.margins.right = _isVersoPageIdx(pageIdx) ? baseL : baseR;
  };
  // TrimBox (Endformat) + BleedBox (Medienkante) ins Page-Dictionary. Nur bei
  // Beschnitt relevant; die Druckerei beschneidet auf die TrimBox.
  const setPageBoxes = () => {
    if (bleedPt <= 0) return;
    const w = doc.page.width, h = doc.page.height;
    doc.page.dictionary.data.TrimBox  = [bleedPt, bleedPt, w - bleedPt, h - bleedPt];
    doc.page.dictionary.data.BleedBox = [0, 0, w, h];
  };
  const onPageAdded = () => {
    _applyMirror();
    setPageBoxes();
    if (insetActive) {
      doc.page.margins.top    += insetPt.top;
      doc.page.margins.right  += insetPt.right;
      doc.page.margins.bottom += insetPt.bottom;
      doc.page.margins.left   += insetPt.left;
    }
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
  if (hasInset || mirror || bleedPt > 0) doc.on('pageAdded', onPageAdded);

  // Cover (eigene Page ohne Margins)
  if (coverAllowed && config.cover.enabled && coverBuf) {
    doc.addPage({ size: [pageW, pageH], margins: { top: 0, right: 0, bottom: 0, left: 0 } });
    await _renderCover(doc, config.cover, coverBuf);
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

  // Frontmatter-Reihenfolge (Buchkonvention): Impressum/Copyright auf der
  // Titelseiten-Rückseite (wenn imprintPosition='front'), dann Widmung, dann
  // Motto/Vorwort, dann TOC. Diese Buch-Identitätsseiten nur bei scope='book'
  // (analog Cover/TOC); Teil-Exporte (chapter/page) lassen sie weg.
  const frontMatterAllowed = scope === 'book';
  // Default 'front' (Buchkonvention) — deckt auch ältere Profile ab, deren
  // config_json den Key noch nicht hat (kein Re-Validate beim Laden).
  const imprintPos = config.extras.imprintPosition === 'back' ? 'back' : 'front';
  if (frontMatterAllowed && imprintPos === 'front') {
    _renderImprintPage(doc, config);
  }

  // Widmung (optional, vor TOC + Body)
  _renderDedicationPage(doc, config);

  // Motto / Epigraph / kurzes Vorwort (optional, vor TOC)
  if (frontMatterAllowed) _renderFrontMatterPage(doc, config);

  // TOC: Plan aufbauen mit stabiler Zuordnung Plan → Body-Heading. Jeder Plan-
  // Eintrag bekommt blockIdx + itemIdx. Im Body-Loop schreiben wir pageIdx
  // zurück. Nach Body-Render wird per Plan + tocPositions[] die Seitenzahl
  // an der gespeicherten Position eingestempelt (Two-Pass-TOC).
  const blocks = _coalesceGroups(
    groups,
    config.chapter.pageStructure,
    config.chapter.pageBreakBetweenPages,
    config.chapter.unnumberedChapterIds,
    config.chapter.skipPageCounterChapterIds,
  );
  const tocPlan = [];
  // TOC-Counter pro Tiefe; geteilte Logik mit dem Body-Loop (siehe unten).
  const tocCounters = [0, 0, 0];
  const numberingMode = config.chapter.numberingMode || 'nested';
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    let title = b.title;
    const depth = Math.max(1, Math.min(3, b.depth || 1));
    if (b.isChapter && !b.unnumbered) {
      tocCounters[depth - 1] += 1;
      for (let d = depth; d < 3; d++) tocCounters[d] = 0; // tiefere Counter zuruecksetzen
      const lbl = _chapterLabelNested(config.chapter.numbering, tocCounters, depth, numberingMode, docLang);
      if (lbl) title = `${lbl}. ${b.title}`;
    }
    // TOC-Level: depth 1 → 0, depth 2 → 1, depth 3 → 2.
    tocPlan.push({ title, level: depth - 1, blockIdx: bi, itemIdx: -1, pageIdx: -1 });
    if (b.isChapter && config.chapter.pageStructure === 'nested') {
      for (let i = 0; i < b.items.length; i++) {
        if (b.items[i].heading) {
          tocPlan.push({ title: b.items[i].heading, level: depth, blockIdx: bi, itemIdx: i, pageIdx: -1 });
        }
      }
    }
  }
  const tocPositions = tocEffective.enabled ? _renderToc(doc, tocEffective, tocPlan, docLang, config.font) : [];

  // Header/Footer werden nicht reaktiv pro pageAdded gestempelt (führt zu
  // Re-Entry-Stack-Overflow), sondern nach Body-Render in einem separaten
  // Pass über bufferedPageRange.
  const bodyStartPageIdx = doc.bufferedPageRange().start + doc.bufferedPageRange().count;
  // Counter pro Tiefe; bei Eintritt in Tiefe d wird counters[d-1]++ und alle
  // tieferen auf 0. Top-Level-Counter triggert auch das „Kapitel 1 vs. Folge-
  // Kapitel"-Verhalten (initialer Break-Skip).
  const chapterCounters = [0, 0, 0];
  let topChapterCounter = 0;
  let currentChapterTitle = '';
  const chapterFirstPage = [];  // [{ pageIdx, title }]
  const pageTitleFirstPage = []; // [{ pageIdx, title }] — pro BookStack-Page
  const blankPageIdxs = new Set(); // Indices, auf denen kein Header/Footer gestempelt wird

  // Kapitel rendern
  const imageCache = new Map(); // src → { buffer, width, height } | null
  const dropCapHint = { pending: false };
  const firstParaHint = { pending: false };
  const dpiWarnings = [];
  const renderCtx = {
    font: config.font, token, imageCache, dropCapHint, firstParaHint,
    columns: layout.columns || 1,
    columnGap: (layout.columnGapMm || 0) * MM_TO_PT,
    bodyFirstLineIndentPt: (config.font.body.firstLineIndentMm || 0) * MM_TO_PT,
    hyphenate: hyphenator,
    widowOrphanControl: layout.widowOrphanControl !== false,
    dpiWarnThreshold: config.print?.dpiWarnThreshold || 0,
    dpiWarnings,
  };

  doc.addPage();
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    if (block.isChapter) {
      const depth = Math.max(1, Math.min(3, block.depth || 1));
      if (!block.unnumbered) chapterCounters[depth - 1] += 1;
      for (let d = depth; d < 3; d++) chapterCounters[d] = 0;
      // topChapterCounter zaehlt fuer Break-Logik immer — auch unnumbered
      // Kapitel brauchen den Page-Break vor ihrem Titel.
      if (depth === 1) topChapterCounter += 1;
      currentChapterTitle = block.title;
      // Page-Break-Verhalten:
      //  - Top-Level (depth 1): wie bisher, plus Recto-Adjust.
      //  - Sub-Kapitel: standardmaessig inline; nur wenn `breakBeforeSubchapter`
      //    aktiv ist und kein generelles 'none', erzwingen wir einen Break.
      const pageHasContent = doc.y > doc.page.margins.top + 1;
      const breakModeOn = config.chapter.breakBefore !== 'none';
      let wantBreak;
      if (depth === 1) {
        wantBreak = breakModeOn && (topChapterCounter > 1 || pageHasContent);
      } else {
        wantBreak = breakModeOn && config.chapter.breakBeforeSubchapter && pageHasContent;
      }
      let didBreak = false;
      if (wantBreak) {
        doc.addPage();
        didBreak = true;
        if (depth === 1
            && config.chapter.breakBefore === 'right-page'
            && doc.bufferedPageRange().count % 2 === 0) {
          doc.addPage();
        }
      }
      // Vertikaler Vorschub: pro Tiefe abgestuft, damit Sub-Kapitel nicht
      // mit demselben spaceBeforeMm wie Top-Level-Kapitel beginnen.
      const depthSpaceFactor = depth === 1 ? 1 : depth === 2 ? 0.4 : 0.2;
      const spaceAbove = config.chapter.spaceBeforeMm * MM_TO_PT * depthSpaceFactor;
      if (!pageHasContent || didBreak) {
        doc.y = doc.page.margins.top + spaceAbove;
      } else {
        doc.y += spaceAbove;
      }
      const label = block.unnumbered
        ? null
        : _chapterLabelNested(config.chapter.numbering, chapterCounters, depth, numberingMode, docLang);
      const style = config.chapter.titleStyle;
      const sizes = config.font.heading.sizes;
      // Tiefe → Heading-Groesse: depth 1 = h1 (bei 'minimal' h2),
      //                          depth 2 = h2, depth 3 = h3.
      let titleSize;
      if (depth === 1) {
        titleSize = style === 'minimal' ? sizes.h2 : sizes.h1;
      } else if (depth === 2) {
        titleSize = sizes.h2;
      } else {
        titleSize = sizes.h3;
      }
      // Sub-Kapitel immer linksbuendig; centered-large gilt nur fuer Top-Level.
      const titleAlign = depth === 1 && style === 'centered-large' ? 'center' : 'left';
      const headingColor = config.font.heading.color || '#000000';
      doc.font('heading').fontSize(titleSize).fillColor(headingColor);
      if (label) {
        doc.text(label, { align: titleAlign });
        doc.moveDown(0.4);
      }
      doc.text(block.title, { align: titleAlign });
      // titleRule nur fuer Top-Level (Sub-Kapitel mit Strich wirken zu schwer).
      if (depth === 1 && (style === 'left-rule' || config.chapter.titleRule)) {
        _drawTitleRule(doc, headingColor);
      }
      doc.moveDown(depth === 1 ? 1.2 : 0.6);
      doc.outline.addItem(label ? `${label}. ${block.title}` : block.title);
      const chapterPageIdx = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
      chapterFirstPage.push({
        pageIdx: chapterPageIdx,
        title: block.title,
        chapterId: block.chapterId,
        skipPageCounter: !!block.skipPageCounter,
      });
      const planChapter = tocPlan.find(e => e.blockIdx === bi && e.itemIdx === -1);
      if (planChapter) planChapter.pageIdx = chapterPageIdx;
      // DropCap nur am Top-Level-Kapitel-Start, nicht bei Sub-Kapiteln.
      dropCapHint.pending = depth === 1 && !!config.chapter.dropCap;
      // Erster Absatz nach Kapitel-Title nicht einruecken (Buchkonvention).
      firstParaHint.pending = true;
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
        firstParaHint.pending = true;
      }
      // Anker für `{pageTitle}`: Start jedes Items markiert Übergang auf neue
      // BookStack-Page. Header/Footer-Pass nutzt das später, um pro PDF-Page
      // den jeweils gültigen Page-Namen einzusetzen.
      if (it.pageName) {
        pageTitleFirstPage.push({
          pageIdx: doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1,
          title: it.pageName,
          pageId: it.pageId ?? null,
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
  if (hasInset || mirror || bleedPt > 0) doc.removeListener('pageAdded', onPageAdded);

  // Backmatter: "Über den Autor"-Seite (optional), dann Impressum ans Buchende
  // falls imprintPosition='back'. Beide bekommen KEINEN Header/Footer (Konvention)
  // und zählen nicht in der Seitennummerierung.
  if (frontMatterAllowed) {
    const authorRendered = await _renderAuthorPage(doc, config, docLang, authorImageBuf);
    if (authorRendered) {
      blankPageIdxs.add(doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1);
    }
  }
  if (frontMatterAllowed && imprintPos === 'back') {
    if (_renderImprintPage(doc, config)) {
      blankPageIdxs.add(doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1);
    }
  }

  // Seitenzaehler-Skip aufloesen: pro Body-pageIdx die Nummer ermitteln.
  // null = Page faellt aus der Zaehlung (Counter zaehlt sie nicht, Footer
  // {page}-Token bleibt leer). Greift fuer:
  //   - blankPageIdxs (leere Verso/Impressum) — gab's schon
  //   - Pages, deren aktives Kapitel in skipPageCounterChapterIds liegt
  //   - Pages, deren aktive BookStack-Page in skipPageCounterPageIds liegt
  // Pro-Page-Granularitaet greift nur bei pageStructure='nested' (in flatten
  // teilen sich mehrere Book-Pages dieselbe PDF-Page → nur die erste
  // identifizierbar).
  const range = doc.bufferedPageRange();
  const skipPageIdSet = new Set(Array.isArray(config.chapter.skipPageCounterPageIds) ? config.chapter.skipPageCounterPageIds : []);
  const pageNumByIdx = new Map();
  {
    // countFrontMatter=true: Titelei physisch mitzählen → Body-Zähler startet
    // um die Anzahl Titelei-Seiten (alles vor bodyStartPageIdx) höher. Die
    // Titelei selbst kriegt keinen Footer (Pass läuft ab bodyStartPageIdx).
    const frontMatterPages = layout.countFrontMatter ? (bodyStartPageIdx - range.start) : 0;
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
      if (blankPageIdxs.has(i)) { pageNumByIdx.set(i, null); continue; }
      const isSkipped = activeChapterSkip || (activePageId != null && skipPageIdSet.has(activePageId));
      if (isSkipped) {
        pageNumByIdx.set(i, null);
      } else {
        cnt += 1;
        pageNumByIdx.set(i, cnt);
      }
    }
  }
  // {pages} = höchste vergebene Seitenzahl (nicht nur Anzahl gezählter Seiten),
  // damit „Seite X von Y" mit pageNumberStart-/countFrontMatter-Offset stimmt.
  const _countedNums = Array.from(pageNumByIdx.values()).filter(v => v != null);
  const totalBodyPages = _countedNums.length ? Math.max(..._countedNums) : 0;

  // TOC-Page-Numbers-Stempel-Pass: für jeden Plan-Eintrag mit gerenderter
  // Position die effektive Body-Pagenummer rechts ausrichten. Eingaben mit
  // pageIdx = -1 (über TOC-Tiefe gefiltert oder nicht im Body gerendert)
  // werden geskippt — _renderToc liefert dafür `null` als Position. Liegt
  // die Zielseite im Counter-Skip, wird das Page-Number-Feld leer gelassen
  // (TOC-Eintrag bleibt sichtbar, aber ohne Nummer).
  if (tocEffective.enabled && tocEffective.showPageNumbers && tocPositions.length === tocPlan.length) {
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
      const right = doc.page.margins.right;
      const xRight = pageW - right - reservePt;
      doc.text(String(bodyPageNum), xRight, pos.y, {
        width: reservePt,
        align: 'right',
        lineBreak: false,
      });
    }
    doc.restore();
  }

  // Header/Footer-Stempel-Pass: für alle Body-Pages.
  const chapterStartSet = new Set(chapterFirstPage.map(c => c.pageIdx));
  const skipHeaderOnChapter = !layout.showHeaderOnChapterStart;
  const skipFooterOnChapter = layout.showFooterOnChapterStart === false;
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
    const rawPageNum = pageNumByIdx.get(i); // null fuer geskippte Pages → {page} bleibt leer
    // Sichtbarkeits-Gate: erst ab pageNumberFirstVisible wird die Nummer im
    // Footer gezeigt; früher gezählte Seiten bleiben ohne sichtbare Nummer.
    const pageNum = (rawPageNum != null && rawPageNum >= layout.pageNumberFirstVisible) ? rawPageNum : null;
    const isChapterStart = chapterStartSet.has(i);
    // Mirror nutzt 0-basierten PDF-Page-Index für Recto/Verso; bei Body-Pages
    // gilt das auch fuer Header/Footer-Slot-Pick (verso = i%2===1).
    const isVerso = mirror ? (i % 2 === 1) : false;
    _drawHeaderFooter(doc, layout, {
      title: book.name || '',
      author,
      chapter: chapterTitle,
      pageTitle,
      page: pageNum,
      pages: totalBodyPages,
      isVerso,
      skipHeader: isChapterStart && skipHeaderOnChapter,
      skipFooter: isChapterStart && skipFooterOnChapter,
    }, margins);
  }

  // Schnittmarken-Pass: auf ALLEN Seiten (inkl. Frontmatter/Cover), in den
  // Anschnitt gezeichnet. Nur mit Beschnitt sinnvoll — sonst kein Platz
  // ausserhalb des Endformats.
  if (bleedPt > 0 && config.print?.cropMarks) {
    const full = doc.bufferedPageRange();
    const markLen = Math.min(bleedPt, 5 * MM_TO_PT);
    for (let i = full.start; i < full.start + full.count; i++) {
      doc.switchToPage(i);
      _drawCropMarks(doc, bleedPt, markLen);
    }
  }

  if (meta) meta.dpiWarnings = dpiWarnings;

  doc.flushPages();
  doc.end();
  return done;
}

// Schnittmarken: pro Ecke je eine vertikale + horizontale Hairline im Anschnitt,
// bis exakt an die Trim-Ecke. pdfkit zeichnet mit Ursprung oben links.
function _drawCropMarks(doc, bleed, len) {
  const w = doc.page.width, h = doc.page.height;
  const L = bleed, T = bleed, R = w - bleed, B = h - bleed;
  doc.save();
  doc.lineWidth(0.25).strokeColor('#000000').undash();
  const seg = (x1, y1, x2, y2) => doc.moveTo(x1, y1).lineTo(x2, y2).stroke();
  seg(L, T - len, L, T);  seg(L - len, T, L, T);   // oben-links
  seg(R, T - len, R, T);  seg(R, T, R + len, T);   // oben-rechts
  seg(L, B, L, B + len);  seg(L - len, B, L, B);   // unten-links
  seg(R, B, R, B + len);  seg(R, B, R + len, B);   // unten-rechts
  doc.restore();
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
