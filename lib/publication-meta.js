'use strict';
// Default + strikter Validator fuer buch-weite Publikations-Metadaten
// (book_publication). Von PDF- und EPUB-Export sowie der Publikation-Karte
// konsumiert. Strict: unbekannte Keys verworfen, Strings laengen-geclamped,
// Enums whitelisted. ISBN-Pruefziffer wird geprueft, aber NICHT erzwungen
// (non-blocking, Warnung Sache des UI).

// epub_css_style steuert die Schriftfamilie. Ohne Font-Embedding referenzieren
// wir generische + verbreitete Familien (Reader nutzt sie, wenn vorhanden, sonst
// Fallback der Stack-Definition in epub.js). 'serif'/'sans' bleiben Default-tauglich.
const CSS_STYLES = ['serif', 'sans', 'georgia', 'palatino', 'garamond', 'times', 'baskerville', 'helvetica', 'verdana'];

// Enum-Whitelists fuer die erweiterten EPUB-Reflow-Optionen. Default = erstes
// Element ist NICHT garantiert; Defaults stehen in defaultMeta().
const _ENUMS = {
  epub_font_size: ['small', 'normal', 'large'],
  epub_line_height: ['tight', 'normal', 'relaxed'],
  epub_paragraph_style: ['indent', 'spaced'],
  epub_indent_size: ['small', 'medium', 'large'],
  epub_scene_separator: ['line', 'asterism', 'stars', 'blank', 'fleuron'],
  epub_titlepage_mode: ['generated', 'cover', 'none'],
  epub_chapter_numbering: ['none', 'arabic', 'roman', 'word'],
  epub_chapter_numbering_mode: ['flat', 'nested'],
};

// Bool-Felder (0/1 in der DB, true/false im Meta-Objekt) mit Default.
const _BOOLS = {
  epub_justify: true,
  epub_hyphenation: false,
  epub_chapter_pagebreak: true,
  epub_drop_caps: false,
  epub_nest_pages_in_toc: true,
};

const _LIMITS = {
  author_name: 200,
  isbn: 20,
  subtitle: 300,
  year: 10,
  dedication: 2000,
  imprint: 8000,
  copyright: 500,
  frontmatter: 8000,
  author_bio: 4000,
  epub_toc_title: 100,
  description: 4000,
  publisher: 200,
  series: 200,
  series_index: 10,
  keywords: 500,
  epub_rights: 500,
  epub_pubdate: 10,
  epub_translator: 200,
  epub_illustrator: 200,
  epub_editor_name: 200,
  epub_uuid: 100,
};

function defaultMeta() {
  return {
    author_name: '',
    isbn: '',
    subtitle: '',
    year: '',
    dedication: '',
    imprint: '',
    copyright: '',
    frontmatter: '',
    author_bio: '',
    epub_css_style: 'serif',
    epub_toc_title: '',
    description: '',
    publisher: '',
    series: '',
    series_index: '',
    keywords: '',
    // Erweiterte EPUB-Optionen.
    epub_font_size: 'normal',
    epub_line_height: 'normal',
    epub_paragraph_style: 'indent',
    epub_indent_size: 'medium',
    epub_scene_separator: 'line',
    epub_titlepage_mode: 'generated',
    epub_chapter_numbering: 'none',
    epub_chapter_numbering_mode: 'nested',
    epub_rights: '',
    epub_pubdate: '',
    epub_translator: '',
    epub_illustrator: '',
    epub_editor_name: '',
    epub_uuid: '',
    // Bools (Defaults aus _BOOLS).
    epub_justify: true,
    epub_hyphenation: false,
    epub_chapter_pagebreak: true,
    epub_drop_caps: false,
    epub_nest_pages_in_toc: true,
  };
}

function _str(v, max) {
  if (v == null) return '';
  return String(v).slice(0, max);
}

// ISBN-13-Pruefziffer (EAN-13-Modulo-10). Akzeptiert Bindestriche/Spaces.
// Liefert true/false/null (null = kein 13-stelliger Kandidat → nicht pruefbar).
function isValidIsbn13(raw) {
  const digits = String(raw || '').replace(/[\s-]/g, '');
  if (!/^\d{13}$/.test(digits)) return null;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[12]);
}

function _bool(v) {
  return v === true || v === 1 || v === '1';
}

function validateMeta(src) {
  const out = defaultMeta();
  if (!src || typeof src !== 'object') return out;
  for (const key of Object.keys(_LIMITS)) {
    if (src[key] != null) out[key] = _str(src[key], _LIMITS[key]);
  }
  if (CSS_STYLES.includes(src.epub_css_style)) out.epub_css_style = src.epub_css_style;
  for (const [key, allowed] of Object.entries(_ENUMS)) {
    if (allowed.includes(src[key])) out[key] = src[key];
  }
  for (const key of Object.keys(_BOOLS)) {
    if (src[key] != null) out[key] = _bool(src[key]);
  }
  return out;
}

module.exports = { defaultMeta, validateMeta, isValidIsbn13, CSS_STYLES };
