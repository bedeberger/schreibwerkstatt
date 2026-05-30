'use strict';
// Default + strikter Validator fuer buch-weite Publikations-Metadaten
// (book_publication). Von PDF- und EPUB-Export sowie der Publikation-Karte
// konsumiert. Strict: unbekannte Keys verworfen, Strings laengen-geclamped,
// Enums whitelisted. ISBN-Pruefziffer wird geprueft, aber NICHT erzwungen
// (non-blocking, Warnung Sache des UI).

const CSS_STYLES = ['serif', 'sans'];

const _LIMITS = {
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
};

function defaultMeta() {
  return {
    isbn: '',
    subtitle: '',
    year: '',
    dedication: '',
    imprint: '',
    copyright: '',
    frontmatter: '',
    author_bio: '',
    epub_css_style: 'serif',
    epub_justify: true,
    epub_toc_title: '',
    description: '',
    publisher: '',
    series: '',
    series_index: '',
    keywords: '',
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

function validateMeta(src) {
  const out = defaultMeta();
  if (!src || typeof src !== 'object') return out;
  for (const key of Object.keys(_LIMITS)) {
    if (src[key] != null) out[key] = _str(src[key], _LIMITS[key]);
  }
  if (CSS_STYLES.includes(src.epub_css_style)) out.epub_css_style = src.epub_css_style;
  if (src.epub_justify != null) {
    out.epub_justify = !!(src.epub_justify === true || src.epub_justify === 1 || src.epub_justify === '1');
  }
  return out;
}

module.exports = { defaultMeta, validateMeta, isValidIsbn13, CSS_STYLES };
