'use strict';
// Default-Config für neue PDF-Export-Profile + Schema-Validator. Wird bei
// Profile-Erstellung als Vorlage gemerged und beim Speichern strikt geprüft —
// unbekannte Top-Level-Keys werden verworfen, Werte gegen Allow-Lists/Ranges
// gevalidiert. So bleiben User-Inputs sauber bei manueller JSON-Bearbeitung.

const PAGE_SIZES = ['A4', 'A5', 'A6', 'Letter', 'custom'];
const COLUMNS    = [1, 2];
const BREAK_BEFORE = ['always', 'right-page', 'none'];
const NUMBERING    = ['none', 'arabic', 'roman', 'word'];
const NUMBERING_MODE = ['flat', 'nested'];
const TITLE_STYLE  = ['centered-large', 'left-rule', 'minimal'];
const PAGE_STRUCTURE = ['flatten', 'nested'];
const COVER_FIT    = ['cover', 'contain'];
const OVERLAY_POS  = ['top', 'center', 'bottom'];
const TOC_DEPTH    = [1, 2, 3];
const TOC_LEADER   = ['none', 'dots', 'line'];
const TOC_TITLE_ALIGN = ['left', 'center', 'right'];
const PDFA_CONF    = ['B'];
const NUMERALS     = ['auto', 'lining', 'oldstyle'];
const IMPRINT_POS  = ['front', 'back'];

const DEFAULT_CONFIG = {
  layout: {
    pageSize: 'A4',
    customWidthMm: 210,
    customHeightMm: 297,
    marginsMm: { top: 25, right: 22, bottom: 25, left: 22 },
    bodyInsetMm: { top: 0, right: 0, bottom: 0, left: 0 },
    columns: 1,
    columnGapMm: 6,
    headerLeft: '', headerCenter: '{title}', headerRight: '',
    footerLeft: '', footerCenter: '{page}',  footerRight: '',
    // Verso-spezifische Slots (linke/gerade Seite). Leer = recto-Slot wird
    // beidseitig verwendet. Klassisch: verso=Buchtitel, recto=Kapitel.
    headerVersoLeft: '', headerVersoCenter: '', headerVersoRight: '',
    footerVersoLeft: '', footerVersoCenter: '', footerVersoRight: '',
    headerRule: false,
    footerRule: false,
    // Default-Konvention: erste Seite eines Kapitels traegt weder Header
    // noch Pagenummer (Buchkonvention).
    showHeaderOnChapterStart: false,
    showFooterOnChapterStart: false,
    // Spiegel-Margins fuer Recto/Verso: bei jeder verso-Page (Page 2, 4, …)
    // tauschen left/right. marginsMm.left ist dann immer der Bund-seitige
    // (inner) Wert, .right der aussen-seitige.
    mirrorMargins: false,
    // Silbentrennung via Hypher; nutzt docLang (de/en). Aus PDF/A-Sicht
    // unbedenklich — Soft-Hyphens werden vor Encoding gestrippt.
    hyphenate: true,
    // Witwen-/Waisen-Kontrolle: vor jedem Paragraph Höhe messen und ganzen
    // Absatz auf nächste Seite schieben, falls sonst nur 1 Zeile oben/unten
    // alleine stünde.
    widowOrphanControl: true,
    pageNumberStart: 1,
  },
  // heading.color dient zusätzlich als Farbe für Kapitel-/Seiten-Trennlinien
  // (titleRule, pageTitleRule) — abgestimmt auf die Überschrift.
  font: {
    body:     { family: 'Lora',             weight: 400, sizePt: 11, lineHeight: 1.45, paragraphGap: 0.3, firstLineIndentMm: 0, color: '#1a1a1a', numerals: 'auto' },
    heading:  { family: 'Playfair Display', weight: 700, sizes: { h1: 24, h2: 18, h3: 14 }, color: '#1a1a1a' },
    title:    { family: 'Playfair Display', weight: 700, sizePt: 38, color: '#1a1a1a' },
    subtitle: { family: 'Playfair Display', weight: 400, sizePt: 18, color: '#333333' },
    byline:   { family: 'Lora',             weight: 400, sizePt: 12, color: '#4a4a4a' },
    dedication: { family: 'Lora',             weight: 400, sizePt: 13, color: '#1a1a1a', italic: true },
    frontMatter:{ family: 'Lora',             weight: 400, sizePt: 13, color: '#1a1a1a', italic: true },
    authorBio:  { family: 'Lora',             weight: 400, sizePt: 11, lineHeight: 1.45, paragraphGap: 0.3, color: '#1a1a1a', italic: false },
    imprint:    { family: 'Lora',             weight: 400, sizePt: 10, color: '#1a1a1a', italic: false },
    year:       { family: 'Lora',             weight: 400, sizePt: 12, color: '#4a4a4a', italic: false },
    toc:        { family: 'Lora',             weight: 400, sizePt: 11, lineHeight: 1.45, paragraphGap: 0.3, color: '#1a1a1a' },
    tocTitle:   { family: 'Playfair Display', weight: 700, sizePt: 20, color: '#1a1a1a' },
  },
  chapter: {
    breakBefore: 'always',
    breakBeforeSubchapter: false, // Sub-Kapitel (depth>1) standardmaessig inline, kein Pagebreak.
    blankPageAfter: false,
    numbering: 'none',
    numberingMode: 'nested',      // 'flat' = 1, 2, 3; 'nested' = 1, 1.1, 1.1.1.
    // Chapter-IDs ohne Nummer (Vorwort/Prolog/Epilog/Anhang). Counter wird
    // dann fuer diese Kapitel uebersprungen — naechstes Kapitel zaehlt weiter
    // ohne Luecke. Cascade: ist ein Top-Kapitel hier gelistet, erben auch
    // seine Sub-Kapitel "kein Nummer".
    unnumberedChapterIds: [],
    // Seitenzaehler-Skip: PDF-Pages, die zu diesen Kapiteln/BookStack-Pages
    // gehoeren, zaehlen nicht in der Seitennummerierung mit. Anzeige der
    // Nummer entfaellt fuer geskippte Pages, naechste reguläre Page laeuft
    // ohne Sprung weiter. Cascade fuer Kapitel: Top-Kapitel -> Subs erben.
    // Pro-Page-Skip ist nur sinnvoll, wenn pageStructure='nested' ist
    // (sonst sind Book-Pages innerhalb eines Kapitels nicht trennbar).
    skipPageCounterChapterIds: [],
    skipPageCounterPageIds: [],
    titleStyle: 'centered-large',
    dropCap: false,
    spaceBeforeMm: 60,
    pageStructure: 'flatten',
    pageBreakBetweenPages: false,
    titleRule: false,
    pageTitleRule: false,
  },
  cover: {
    enabled: false,
    showTitleOverlay: true,
    overlayPosition: 'bottom',
    fit: 'cover',
  },
  // title leer = Renderer setzt Sprach-Default ('Inhaltsverzeichnis' / 'Table of Contents')
  // anhand der Buchsprache. User-Override per nicht-leeren String.
  // indentMm = Einrueckung pro Level (level 0 = 0, level 1 = 1*indentMm, ...).
  // pageNumReserveMm = reservierte Spaltenbreite rechts fuer die Seitenzahl.
  // leader = Verbindung zwischen Eintrag und Seitenzahl (none/dots/line).
  toc: {
    enabled: true,
    depth: 2,
    title: '',
    showPageNumbers: true,
    titleAlign: 'center',
    indentMm: 6,
    leader: 'none',
    pageNumReserveMm: 14,
  },
  // imprintPosition: 'front' = Rueckseite der Titelseite (Buchkonvention),
  // 'back' = ans Buchende. copyright: optionale strukturierte ©-Zeile, wird der
  // Impressum-Seite vorangestellt. isbn erscheint auf der Impressum-Seite.
  // frontMatter: freie Prosa-Seite (Motto/Epigraph/Vorwort) nach der Titelseite.
  // authorBio: "Ueber den Autor"-Backmatter-Seite (Foto separat als Profil-BLOB).
  extras: {
    dedication: '', imprint: '', subtitle: '', year: '',
    isbn: '', copyright: '', frontMatter: '', authorBio: '',
    imprintPosition: 'front',
  },
  pdfa: { enabled: true, conformance: 'B' },
};

function _isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function _num(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}
function _str(v, max = 200) {
  if (typeof v !== 'string') return '';
  return v.slice(0, max);
}
function _enum(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}
function _bool(v, fallback) {
  if (typeof v === 'boolean') return v;
  return fallback;
}
function _hex(v, fallback) {
  if (typeof v !== 'string') return fallback;
  const s = v.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const r = s[1], g = s[2], b = s[3];
    return ('#' + r + r + g + g + b + b).toLowerCase();
  }
  return fallback;
}

function _validateLayout(src) {
  const d = DEFAULT_CONFIG.layout;
  if (!_isObj(src)) return { ...d };
  const m = _isObj(src.marginsMm) ? src.marginsMm : d.marginsMm;
  const bi = _isObj(src.bodyInsetMm) ? src.bodyInsetMm : d.bodyInsetMm;
  return {
    pageSize:        _enum(src.pageSize, PAGE_SIZES, d.pageSize),
    customWidthMm:   _num(src.customWidthMm, 50, 500, d.customWidthMm),
    customHeightMm:  _num(src.customHeightMm, 50, 700, d.customHeightMm),
    marginsMm: {
      top:    _num(m.top,    5, 80, d.marginsMm.top),
      right:  _num(m.right,  5, 80, d.marginsMm.right),
      bottom: _num(m.bottom, 5, 80, d.marginsMm.bottom),
      left:   _num(m.left,   5, 80, d.marginsMm.left),
    },
    bodyInsetMm: {
      top:    _num(bi.top,    0, 60, d.bodyInsetMm.top),
      right:  _num(bi.right,  0, 60, d.bodyInsetMm.right),
      bottom: _num(bi.bottom, 0, 60, d.bodyInsetMm.bottom),
      left:   _num(bi.left,   0, 60, d.bodyInsetMm.left),
    },
    columns:    _enum(parseInt(src.columns), COLUMNS, d.columns),
    columnGapMm: _num(src.columnGapMm, 0, 30, d.columnGapMm),
    headerLeft:   _str(src.headerLeft,   200),
    headerCenter: _str(src.headerCenter, 200),
    headerRight:  _str(src.headerRight,  200),
    footerLeft:   _str(src.footerLeft,   200),
    footerCenter: _str(src.footerCenter, 200),
    footerRight:  _str(src.footerRight,  200),
    headerVersoLeft:   _str(src.headerVersoLeft,   200),
    headerVersoCenter: _str(src.headerVersoCenter, 200),
    headerVersoRight:  _str(src.headerVersoRight,  200),
    footerVersoLeft:   _str(src.footerVersoLeft,   200),
    footerVersoCenter: _str(src.footerVersoCenter, 200),
    footerVersoRight:  _str(src.footerVersoRight,  200),
    headerRule:   _bool(src.headerRule, d.headerRule),
    footerRule:   _bool(src.footerRule, d.footerRule),
    showHeaderOnChapterStart: _bool(src.showHeaderOnChapterStart, d.showHeaderOnChapterStart),
    showFooterOnChapterStart: _bool(src.showFooterOnChapterStart, d.showFooterOnChapterStart),
    mirrorMargins: _bool(src.mirrorMargins, d.mirrorMargins),
    hyphenate:     _bool(src.hyphenate,     d.hyphenate),
    widowOrphanControl: _bool(src.widowOrphanControl, d.widowOrphanControl),
    pageNumberStart: _num(src.pageNumberStart, 1, 9999, d.pageNumberStart),
  };
}

function _validateFontRole(src, defs) {
  if (!_isObj(src)) return { ...defs };
  return {
    family:     _str(src.family, 80) || defs.family,
    weight:     _num(src.weight, 100, 900, defs.weight),
    sizePt:     _num(src.sizePt, 6, 72, defs.sizePt),
    color:      _hex(src.color, defs.color),
    ...(defs.lineHeight !== undefined ? { lineHeight: _num(src.lineHeight, 0.8, 3, defs.lineHeight) } : {}),
    ...(defs.paragraphGap !== undefined ? { paragraphGap: _num(src.paragraphGap, 0, 3, defs.paragraphGap) } : {}),
    ...(defs.firstLineIndentMm !== undefined ? { firstLineIndentMm: _num(src.firstLineIndentMm, 0, 30, defs.firstLineIndentMm) } : {}),
    ...(defs.italic !== undefined ? { italic: _bool(src.italic, defs.italic) } : {}),
    ...(defs.numerals !== undefined ? { numerals: _enum(src.numerals, NUMERALS, defs.numerals) } : {}),
  };
}

function _validateFont(src) {
  const d = DEFAULT_CONFIG.font;
  if (!_isObj(src)) return structuredClone(d);
  const heading = _isObj(src.heading) ? src.heading : {};
  const headingSizes = _isObj(heading.sizes) ? heading.sizes : {};
  return {
    body:     _validateFontRole(src.body,     d.body),
    heading: {
      family: _str(heading.family, 80) || d.heading.family,
      weight: _num(heading.weight, 100, 900, d.heading.weight),
      color:  _hex(heading.color, d.heading.color),
      sizes: {
        h1: _num(headingSizes.h1, 10, 60, d.heading.sizes.h1),
        h2: _num(headingSizes.h2,  9, 48, d.heading.sizes.h2),
        h3: _num(headingSizes.h3,  8, 36, d.heading.sizes.h3),
      },
    },
    title:    _validateFontRole(src.title,    d.title),
    subtitle: _validateFontRole(src.subtitle, d.subtitle),
    byline:   _validateFontRole(src.byline,   d.byline),
    dedication: _validateFontRole(src.dedication, d.dedication),
    frontMatter:_validateFontRole(src.frontMatter, d.frontMatter),
    authorBio:  _validateFontRole(src.authorBio,   d.authorBio),
    imprint:    _validateFontRole(src.imprint,    d.imprint),
    year:       _validateFontRole(src.year,       d.year),
    toc:        _validateFontRole(src.toc,        d.toc),
    tocTitle:   _validateFontRole(src.tocTitle,   d.tocTitle),
  };
}

function _validateIdList(src) {
  if (!Array.isArray(src)) return [];
  const out = [];
  const seen = new Set();
  for (const v of src) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= 500) break;
  }
  return out;
}

function _validateChapter(src) {
  const d = DEFAULT_CONFIG.chapter;
  if (!_isObj(src)) {
    return {
      ...d,
      unnumberedChapterIds: [],
      skipPageCounterChapterIds: [],
      skipPageCounterPageIds: [],
    };
  }
  return {
    breakBefore:    _enum(src.breakBefore, BREAK_BEFORE, d.breakBefore),
    breakBeforeSubchapter: _bool(src.breakBeforeSubchapter, d.breakBeforeSubchapter),
    blankPageAfter: _bool(src.blankPageAfter, d.blankPageAfter),
    numbering:      _enum(src.numbering, NUMBERING, d.numbering),
    numberingMode:  _enum(src.numberingMode, NUMBERING_MODE, d.numberingMode),
    unnumberedChapterIds: _validateIdList(src.unnumberedChapterIds),
    skipPageCounterChapterIds: _validateIdList(src.skipPageCounterChapterIds),
    skipPageCounterPageIds:    _validateIdList(src.skipPageCounterPageIds),
    titleStyle:     _enum(src.titleStyle, TITLE_STYLE, d.titleStyle),
    dropCap:        _bool(src.dropCap, d.dropCap),
    spaceBeforeMm:  _num(src.spaceBeforeMm, 0, 200, d.spaceBeforeMm),
    pageStructure:  _enum(src.pageStructure, PAGE_STRUCTURE, d.pageStructure),
    pageBreakBetweenPages: _bool(src.pageBreakBetweenPages, d.pageBreakBetweenPages),
    titleRule:      _bool(src.titleRule, d.titleRule),
    pageTitleRule:  _bool(src.pageTitleRule, d.pageTitleRule),
  };
}

function _validateCover(src) {
  const d = DEFAULT_CONFIG.cover;
  if (!_isObj(src)) return { ...d };
  return {
    enabled:          _bool(src.enabled, d.enabled),
    showTitleOverlay: _bool(src.showTitleOverlay, d.showTitleOverlay),
    overlayPosition:  _enum(src.overlayPosition, OVERLAY_POS, d.overlayPosition),
    fit:              _enum(src.fit, COVER_FIT, d.fit),
  };
}

function _validateToc(src) {
  const d = DEFAULT_CONFIG.toc;
  if (!_isObj(src)) return { ...d };
  return {
    enabled:          _bool(src.enabled, d.enabled),
    depth:            _enum(parseInt(src.depth), TOC_DEPTH, d.depth),
    title:            _str(src.title, 80) || d.title,
    showPageNumbers:  _bool(src.showPageNumbers, d.showPageNumbers),
    titleAlign:       _enum(src.titleAlign, TOC_TITLE_ALIGN, d.titleAlign),
    indentMm:         _num(src.indentMm, 0, 40, d.indentMm),
    leader:           _enum(src.leader, TOC_LEADER, d.leader),
    pageNumReserveMm: _num(src.pageNumReserveMm, 6, 40, d.pageNumReserveMm),
  };
}

function _validateExtras(src) {
  const d = DEFAULT_CONFIG.extras;
  if (!_isObj(src)) return { ...d };
  return {
    dedication: _str(src.dedication, 1000),
    imprint:    _str(src.imprint, 4000),
    subtitle:   _str(src.subtitle, 200),
    year:       _str(src.year, 20),
    isbn:       _str(src.isbn, 20),
    copyright:  _str(src.copyright, 500),
    frontMatter:_str(src.frontMatter, 4000),
    authorBio:  _str(src.authorBio, 4000),
    imprintPosition: _enum(src.imprintPosition, IMPRINT_POS, d.imprintPosition),
  };
}

function _validatePdfa(src) {
  const d = DEFAULT_CONFIG.pdfa;
  if (!_isObj(src)) return { ...d };
  return {
    enabled:     _bool(src.enabled, d.enabled),
    conformance: _enum(src.conformance, PDFA_CONF, d.conformance),
  };
}

/** Tiefe Validierung gegen Defaults. Unbekannte Keys werden verworfen. */
function validateConfig(src) {
  const s = _isObj(src) ? src : {};
  return {
    layout:  _validateLayout(s.layout),
    font:    _validateFont(s.font),
    chapter: _validateChapter(s.chapter),
    cover:   _validateCover(s.cover),
    toc:     _validateToc(s.toc),
    extras:  _validateExtras(s.extras),
    pdfa:    _validatePdfa(s.pdfa),
  };
}

function defaultConfig() {
  return structuredClone(DEFAULT_CONFIG);
}

module.exports = { DEFAULT_CONFIG, validateConfig, defaultConfig };
