'use strict';
// DOCX-Export via die programmatische `docx`-Lib (dolanmiu). Pendant zum
// Custom-PDF-Renderer: volle Kontrolle über laufende Kopfzeile mit Seitenzahl
// (Standard-Manuskript-/Shunn-Format), echtes Word-Inhaltsverzeichnis-Feld
// (aktualisiert sich in Word), benannte Heading-Styles und Titelei.
//
// Eingabe ist der Export-`bundle` (lib/load-contents) + ein validiertes Profil
// (lib/docx-export-defaults). Die Titelei-Texte (Titel/Untertitel/Autor/Widmung/
// Impressum/Copyright/Frontmatter/Bio/Jahr/ISBN) kommen buch-weit aus
// book_publication (opts.meta), geteilt mit PDF + EPUB.
//
// Seiten-HTML wird über denselben Walker wie der PDF-Renderer in eine flache
// Block-Liste übersetzt (lib/pdf-render/html-walker) und block-weise in docx-
// Paragraphen gemappt. Tabellen werden als Fliesstext durchgereicht, Bilder
// (wie beim PDF-Manuskript) nicht übernommen — ein Einreich-Manuskript ist Text.

const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  PageNumber, Header, Footer, TableOfContents, ExternalHyperlink,
  BorderStyle, LineRuleType, convertMillimetersToTwip,
} = require('docx');
const { parseHtmlToBlocks } = require('../pdf-render/html-walker');
const { resolveTitle, chapterDepth, buildChaptersById, ancestorInSet } = require('./shared');
const { _chapterLabelNested } = require('../pdf-render/layout');
const { validateConfig, defaultConfig } = require('../docx-export-defaults');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Seitengrösse in Twips (1/1440 inch). A4/A5 metrisch, Letter US.
const PAGE_DIMS = {
  A4:     { width: 11906, height: 16838 },
  A5:     { width: 8391,  height: 11906 },
  Letter: { width: 12240, height: 15840 },
};
const LINE_MULT = { single: 240, oneAndHalf: 360, double: 480 };

const LABELS = {
  de: { toc: 'Inhalt', aboutAuthor: 'Über die Autorin / den Autor', words: 'ca. {n} Wörter', by: 'von' },
  en: { toc: 'Contents', aboutAuthor: 'About the Author', words: 'approx. {n} words', by: 'by' },
};
function _labels(lang) { return LABELS[lang] || LABELS.de; }

// ── Inline-Runs → docx TextRuns ──────────────────────────────────────────────
function _runsToChildren(runs, base = {}) {
  const out = [];
  for (const r of runs || []) {
    if (r.text === '\n') { out.push(new TextRun({ break: 1 })); continue; }
    const props = {
      text: r.text,
      bold: r.bold || base.bold || undefined,
      italics: r.italic || base.italic || undefined,
      underline: r.underline ? {} : undefined,
      font: base.font || undefined,
    };
    if (r.link && /^(https?:|mailto:)/i.test(r.link)) {
      out.push(new ExternalHyperlink({ link: r.link, children: [new TextRun({ ...props, style: 'Hyperlink' })] }));
    } else {
      out.push(new TextRun(props));
    }
  }
  return out;
}

// Szenentrenner-Paragraph für klassenlose <hr> / leere Autor-Absätze.
function _sceneSeparator(kind) {
  if (kind === 'blank') return new Paragraph({ spacing: { before: 240, after: 240 }, children: [] });
  if (kind === 'line') {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 240, after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 4, color: 'aaaaaa' } },
      children: [],
    });
  }
  const text = kind === 'asterism' ? '⁂' : '* * *';
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 240, after: 240 },
    children: [new TextRun(text)],
  });
}

// ── Block → Paragraph[] ──────────────────────────────────────────────────────
function _blockToParagraphs(block, cfg, ctx) {
  const f = cfg.font;
  const indentActive = f.paragraphStyle === 'indent';
  const bodyParaProps = {
    alignment: f.justify ? AlignmentType.JUSTIFIED : AlignmentType.LEFT,
    ...(f.paragraphStyle === 'spaced' ? { spacing: { after: 200 } } : {}),
  };

  switch (block.kind) {
    case 'paragraph': {
      // Erstzeilen-Einzug nur bei Belletristik-Stil; nicht direkt nach einem
      // Szenentrenner/Heading (ctx.suppressIndent).
      const indent = indentActive && !ctx.suppressIndent
        ? { firstLine: convertMillimetersToTwip(f.indentMm) } : undefined;
      ctx.suppressIndent = false;
      return [new Paragraph({ ...bodyParaProps, indent, children: _runsToChildren(block.runs) })];
    }
    case 'blankline':
      // Autor-Leerzeile (leerer Absatz, Enter auf leerer Zeile) = echter
      // Leerabsatz, kein Szenentrenner. Der Folgeabsatz behält seinen
      // Erstzeilen-Einzug — es ist ein normaler Absatzwechsel, kein Szenenbruch.
      return [new Paragraph({ children: [] })];
    case 'hr':
      // Explizite Trennlinie (Editor-Toolbar) = konfigurierbarer Szenentrenner;
      // der Folgeabsatz wird nach Manuskript-Konvention nicht eingerückt.
      ctx.suppressIndent = true;
      return [_sceneSeparator(cfg.chapter.sceneSeparator)];
    case 'pagebreak':
    case 'blankpage':
      ctx.suppressIndent = true;
      return [new Paragraph({ pageBreakBefore: true, children: [] })];
    case 'heading': {
      ctx.suppressIndent = true;
      const lvl = block.level === 1 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      return [new Paragraph({ heading: lvl, children: [new TextRun({ text: block.text, bold: true })] })];
    }
    case 'list': {
      const out = [];
      block.items.forEach((item, i) => {
        const prefix = block.ordered ? `${i + 1}. ` : '• ';
        item.forEach((sub, si) => {
          if (sub.kind === 'paragraph') {
            const kids = _runsToChildren(sub.runs);
            if (si === 0) kids.unshift(new TextRun(prefix));
            out.push(new Paragraph({ indent: { left: convertMillimetersToTwip(8) }, children: kids }));
          } else {
            out.push(..._blockToParagraphs(sub, cfg, ctx));
          }
        });
      });
      ctx.suppressIndent = true;
      return out;
    }
    case 'poem':
      ctx.suppressIndent = true;
      return block.lines.map(line => new Paragraph({
        spacing: { line: 240, lineRule: LineRuleType.AUTO },
        children: line.length ? _runsToChildren(line, { italic: true }) : [],
      }));
    case 'pre':
      ctx.suppressIndent = true;
      return block.lines.map(line => new Paragraph({
        spacing: { line: 240, lineRule: LineRuleType.AUTO },
        children: _runsToChildren(line, { font: 'Courier New' }),
      }));
    case 'image':
      // Manuskript = reiner Text; Bilder werden nicht übernommen.
      return [];
    default:
      return [];
  }
}

// Blockquote braucht echte Einrückung — eigenständig gebaut, weil ein
// docx-Paragraph nach Konstruktion nicht mehr eingerückt werden kann.
function _blockquoteParagraphs(block, cfg, ctx) {
  const out = [];
  for (const sub of block.blocks) {
    if (sub.kind === 'paragraph') {
      out.push(new Paragraph({
        indent: { left: convertMillimetersToTwip(10) },
        spacing: { after: 120 },
        children: _runsToChildren(sub.runs, { italic: true }),
      }));
    } else {
      out.push(..._blockToParagraphs(sub, cfg, ctx));
    }
  }
  ctx.suppressIndent = true;
  return out;
}

function _htmlToParagraphs(html, cfg, ctx) {
  const blocks = parseHtmlToBlocks(html);
  const out = [];
  for (const b of blocks) {
    if (b.kind === 'blockquote') out.push(..._blockquoteParagraphs(b, cfg, ctx));
    else out.push(..._blockToParagraphs(b, cfg, ctx));
  }
  return out;
}

// ── Titelei ──────────────────────────────────────────────────────────────────
function _proseParagraphs(text, props = {}) {
  return String(text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean).map(p => {
    const runs = [];
    p.split(/\n/).forEach((line, i) => {
      if (i > 0) runs.push({ text: '\n' });
      runs.push({ text: line });
    });
    return new Paragraph({ spacing: { after: 160 }, alignment: props.alignment, children: _runsToChildren(runs, props.run || {}) });
  });
}

function _titlePageParagraphs(title, opts, cfg) {
  const meta = opts.meta || {};
  const L = _labels(opts.lang);
  const out = [];
  out.push(new Paragraph({ spacing: { before: 2400 }, children: [] }));
  out.push(new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun({ text: title })] }));
  if (meta.subtitle) {
    out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 240 },
      children: [new TextRun({ text: meta.subtitle, italics: true, size: (cfg.font.sizePt + 2) * 2 })] }));
  }
  if (opts.author) {
    out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 480 }, children: [new TextRun({ text: `${L.by} ${opts.author}` })] }));
  }
  if (meta.year) {
    out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120 }, children: [new TextRun({ text: String(meta.year) })] }));
  }
  if (cfg.title.wordCount && opts.wordCount) {
    out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 480 },
      children: [new TextRun({ text: L.words.replace('{n}', opts.wordCount.toLocaleString('de-CH')), italics: true })] }));
  }
  out.push(new Paragraph({ pageBreakBefore: true, children: [] }));
  return out;
}

// Eine Frontmatter-/Backmatter-Seite (eigener Seitenumbruch davor).
function _matterPage(inner) {
  if (!inner.length) return [];
  return [new Paragraph({ pageBreakBefore: true, children: [] }), ...inner];
}

function _imprintPage(opts, cfg) {
  const meta = opts.meta || {};
  const fm = cfg.frontmatter;
  if (!fm.imprint && !fm.copyright) return [];
  const lines = [];
  if (fm.copyright && meta.copyright) lines.push(..._proseParagraphs(meta.copyright));
  if (fm.imprint && meta.imprint) lines.push(..._proseParagraphs(meta.imprint));
  if (fm.imprint && meta.isbn) lines.push(new Paragraph({ spacing: { before: 160 }, children: [new TextRun(`ISBN ${meta.isbn}`)] }));
  return _matterPage(lines);
}

function _buildFrontmatter(opts, cfg) {
  const meta = opts.meta || {};
  const fm = cfg.frontmatter;
  const out = [];
  if (fm.dedication && meta.dedication) {
    out.push(..._matterPage([
      new Paragraph({ spacing: { before: 2400 }, children: [] }),
      ..._proseParagraphs(meta.dedication, { alignment: AlignmentType.CENTER, run: { italic: true } }),
    ]));
  }
  if (fm.frontMatter && meta.frontmatter) {
    out.push(..._matterPage(_proseParagraphs(meta.frontmatter, { alignment: AlignmentType.CENTER, run: { italic: true } })));
  }
  if (fm.imprintPosition === 'front') out.push(..._imprintPage(opts, cfg));
  return out;
}

function _buildBackmatter(opts, cfg) {
  const meta = opts.meta || {};
  const fm = cfg.frontmatter;
  const L = _labels(opts.lang);
  const out = [];
  if (fm.imprintPosition === 'back') out.push(..._imprintPage(opts, cfg));
  if (fm.authorBio && meta.author_bio) {
    out.push(..._matterPage([
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: L.aboutAuthor, bold: true })] }),
      ..._proseParagraphs(meta.author_bio),
    ]));
  }
  return out;
}

// ── Kopf-/Fusszeile ──────────────────────────────────────────────────────────
function _pageNumberRun() { return new TextRun({ children: [PageNumber.CURRENT] }); }

function _headerFooter(cfg, ctx) {
  const { mode, pageNumber } = cfg.header;
  const running = mode === 'manuscript' ? `${ctx.surname} / ${ctx.titleKeyword}`
                : mode === 'title' ? ctx.title : '';
  let header, footer;

  if (pageNumber === 'headerRight') {
    const kids = [];
    if (running) kids.push(new TextRun(`${running} / `));
    kids.push(_pageNumberRun());
    header = new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: kids })] });
  } else if (running) {
    header = new Header({ children: [new Paragraph({
      alignment: mode === 'manuscript' ? AlignmentType.RIGHT : AlignmentType.CENTER,
      children: [new TextRun(running)] })] });
  }

  if (pageNumber === 'footer') {
    footer = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [_pageNumberRun()] })] });
  }
  return { header, footer };
}

// ── Kapitel-Body ─────────────────────────────────────────────────────────────
function _chapterHeading(label, name, level, cfg, ctx, isFirst) {
  ctx.suppressIndent = true;
  const text = label ? `${label}.  ${name}` : name;
  const lvl = level === 0 ? HeadingLevel.HEADING_1 : level === 1 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
  const pageBreak = level === 0 && cfg.chapter.pageBreakBefore && !isFirst;
  return new Paragraph({
    heading: lvl,
    pageBreakBefore: pageBreak,
    alignment: AlignmentType.CENTER,
    spacing: { before: level === 0 ? 480 : 240, after: 240 },
    children: [new TextRun({ text, bold: true })],
  });
}

function _buildBodyParagraphs(bundle, cfg, ctx) {
  const { groups } = bundle;
  const lang = ctx.lang;
  const out = [];

  const byId = buildChaptersById(groups);
  const numbering = cfg.chapter.numbering;
  const numberingMode = cfg.chapter.numberingMode;
  const excludedIds = new Set(cfg.chapter.unnumberedChapterIds || []);
  const numCounters = [0, 0, 0];
  const chapterLabel = (depth, unnumbered) => {
    if (numbering === 'none') return null;
    const dd = Math.max(1, Math.min(3, depth));
    if (!unnumbered) numCounters[dd - 1] += 1;
    for (let k = dd; k < 3; k++) numCounters[k] = 0;
    return unnumbered ? null : _chapterLabelNested(numbering, numCounters, dd, numberingMode, lang);
  };

  const nested = cfg.chapter.pageStructure === 'nested';

  groups.forEach((g, gi) => {
    const ch = g.chapter;
    const d = ch ? chapterDepth(ch, byId) : 1;
    const level = ch ? Math.min(2, d - 1) : 0;
    const unnumbered = ch ? ancestorInSet(ch, byId, excludedIds) : false;
    const label = ch ? chapterLabel(d, unnumbered) : null;

    if (ch && g.pages.length > 1) {
      out.push(_chapterHeading(label, ch.name, level, cfg, ctx, gi === 0));
      g.pages.forEach((x) => {
        if (nested) out.push(_chapterHeading(null, x.p.name, Math.min(2, level + 1), cfg, ctx, true));
        out.push(..._htmlToParagraphs(x.pd.html, cfg, ctx));
      });
    } else {
      const x = g.pages[0];
      const name = ch ? ch.name : x.p.name;
      out.push(_chapterHeading(label, name, level, cfg, ctx, gi === 0));
      out.push(..._htmlToParagraphs(x.pd.html, cfg, ctx));
    }
  });
  return out;
}

// ── Wortzahl (auf 100 gerundet) ──────────────────────────────────────────────
function _approxWordCount(groups) {
  let words = 0;
  for (const g of groups || []) {
    for (const x of g.pages || []) {
      const text = String(x.pd?.html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
      const m = text.match(/\S+/g);
      words += m ? m.length : 0;
    }
  }
  return Math.round(words / 100) * 100;
}

// ── TOC ──────────────────────────────────────────────────────────────────────
function _tocParagraphs(cfg, opts, bundle) {
  const L = _labels(opts.lang);
  const out = [new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: L.toc, bold: true })] })];
  if (cfg.toc.mode === 'field') {
    out.push(new TableOfContents(L.toc, { hyperlink: true, headingStyleRange: `1-${cfg.toc.depth}` }));
  } else {
    // Statische Liste: nur Titel (Seitenzahlen sind im Reflow-Layout unbekannt).
    const byId = buildChaptersById(bundle.groups);
    for (const g of bundle.groups) {
      const ch = g.chapter;
      const d = ch ? chapterDepth(ch, byId) : 1;
      if (d > cfg.toc.depth) continue;
      const name = ch ? ch.name : g.pages[0]?.p?.name;
      if (name) out.push(new Paragraph({ indent: { left: convertMillimetersToTwip((d - 1) * 6) }, children: [new TextRun(name)] }));
    }
  }
  out.push(new Paragraph({ pageBreakBefore: true, children: [] }));
  return out;
}

// ── Hauptbuilder ─────────────────────────────────────────────────────────────
async function buildDocxProfile(bundle, opts = {}) {
  const cfg = opts.config ? validateConfig(opts.config) : defaultConfig();
  const title = resolveTitle(bundle);
  const lang = (opts.lang || 'de').slice(0, 2);
  const surname = (opts.author || '').trim().split(/\s+/).pop() || (opts.author || '');
  const titleKeyword = title.split(/\s+/).find(w => w.length > 3) || title.split(/\s+/)[0] || title;

  const ctx = { lang, surname, titleKeyword, title, suppressIndent: true };

  const children = [];
  if (cfg.title.mode === 'generated') {
    children.push(..._titlePageParagraphs(title, { ...opts, lang, wordCount: cfg.title.wordCount ? _approxWordCount(bundle.groups) : 0 }, cfg));
  }
  children.push(..._buildFrontmatter({ ...opts, lang }, cfg));
  if (cfg.toc.mode !== 'none') children.push(..._tocParagraphs(cfg, { ...opts, lang }, bundle));
  children.push(..._buildBodyParagraphs(bundle, cfg, ctx));
  children.push(..._buildBackmatter({ ...opts, lang }, cfg));

  const { header, footer } = _headerFooter(cfg, ctx);
  const dims = PAGE_DIMS[cfg.page.size] || PAGE_DIMS.A4;
  const line = LINE_MULT[cfg.font.lineSpacing] || LINE_MULT.double;
  const sizeHp = cfg.font.sizePt * 2; // docx-Grössen sind Halbpunkte

  const doc = new Document({
    creator: opts.author || undefined,
    title,
    ...(cfg.toc.mode === 'field' ? { features: { updateFields: true } } : {}),
    styles: {
      default: {
        document: {
          run: { font: cfg.font.family, size: sizeHp },
          paragraph: { spacing: { line, lineRule: LineRuleType.AUTO } },
        },
        title: { run: { font: cfg.font.family, size: (cfg.font.sizePt + 14) * 2, bold: true } },
        heading1: { run: { font: cfg.font.family, size: (cfg.font.sizePt + 6) * 2, bold: true }, paragraph: { spacing: { line, lineRule: LineRuleType.AUTO }, outlineLevel: 0 } },
        heading2: { run: { font: cfg.font.family, size: (cfg.font.sizePt + 3) * 2, bold: true }, paragraph: { spacing: { line, lineRule: LineRuleType.AUTO }, outlineLevel: 1 } },
        heading3: { run: { font: cfg.font.family, size: (cfg.font.sizePt + 1) * 2, bold: true }, paragraph: { spacing: { line, lineRule: LineRuleType.AUTO }, outlineLevel: 2 } },
      },
    },
    sections: [{
      properties: {
        titlePage: cfg.header.skipFirstPage,
        page: {
          size: { width: dims.width, height: dims.height },
          margin: {
            top:    convertMillimetersToTwip(cfg.page.marginsMm.top),
            right:  convertMillimetersToTwip(cfg.page.marginsMm.right),
            bottom: convertMillimetersToTwip(cfg.page.marginsMm.bottom),
            left:   convertMillimetersToTwip(cfg.page.marginsMm.left),
          },
        },
      },
      headers: header ? { default: header, ...(cfg.header.skipFirstPage ? { first: new Header({ children: [new Paragraph({ children: [] })] }) } : {}) } : undefined,
      footers: footer ? { default: footer, ...(cfg.header.skipFirstPage ? { first: new Footer({ children: [new Paragraph({ children: [] })] }) } : {}) } : undefined,
      children,
    }],
  });

  const buf = await Packer.toBuffer(doc);
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

// Built-in-Presets für die Sync-/Snapshot-Pfade (kein Profil aus der DB).
// 'reading' = Lesefassung; 'manuscript' = Normseite/Einreich-Manuskript (Times
// 12pt, doppelter Abstand, Shunn-Kopfzeile, generierte Titelseite).
const PRESET_READING = {
  font: { family: 'Georgia', sizePt: 11, lineSpacing: 'oneAndHalf', paragraphStyle: 'indent', justify: true },
  header: { mode: 'title', pageNumber: 'footer', skipFirstPage: true },
  title: { mode: 'generated', wordCount: false },
  chapter: { numbering: 'none', pageBreakBefore: true },
};
const PRESET_MANUSCRIPT = {
  font: { family: 'Times New Roman', sizePt: 12, lineSpacing: 'double', paragraphStyle: 'indent', justify: false },
  header: { mode: 'manuscript', pageNumber: 'headerRight', skipFirstPage: true },
  title: { mode: 'generated', wordCount: true },
  chapter: { numbering: 'none', pageBreakBefore: true },
};

async function buildDocx(bundle, opts = {}) {
  return buildDocxProfile(bundle, { ...opts, config: validateConfig(PRESET_READING) });
}
async function buildDocxNormseite(bundle, opts = {}) {
  return buildDocxProfile(bundle, { ...opts, config: validateConfig(PRESET_MANUSCRIPT) });
}

module.exports = { buildDocx, buildDocxNormseite, buildDocxProfile, DOCX_MIME };
