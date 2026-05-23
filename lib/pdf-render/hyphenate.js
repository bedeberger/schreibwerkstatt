'use strict';
// Silbentrennung. Injiziert Soft-Hyphens (­) in Runs vor `doc.text()`.
// pdfkit's LineWrapper benutzt SHY als Break-Opportunity, ersetzt trailing-SHY
// am Zeilenende durch HYPHEN '-'. Restliche SHYs innerhalb einer nicht
// gebrochenen Zeile entfernt der `_fragment`-Patch (siehe fonts.js).

const Hypher = require('hypher');
const dePatterns = require('hyphenation.de');
const enPatterns = require('hyphenation.en-us');

const _PATTERNS = { de: dePatterns, en: enPatterns };
const _CACHE = new Map();

function createHyphenator(lang) {
  if (!lang || !_PATTERNS[lang]) return null;
  if (_CACHE.has(lang)) return _CACHE.get(lang);
  const h = new Hypher(_PATTERNS[lang]);
  const fn = (text) => (typeof text === 'string' ? h.hyphenateText(text) : text);
  _CACHE.set(lang, fn);
  return fn;
}

module.exports = { createHyphenator };
