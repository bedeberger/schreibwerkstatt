'use strict';

// HTML→Plain-Text Normalisierung fuer page_stats / search / page_revisions.
// SSoT fuer Server-Pfade; Frontend-Pendant in public/js/html-text.js MUSS
// dieselbe Logik tragen (siehe CLAUDE.md „HTML→Text-Normalisierung fuer Stats:
// Frontend MUSS Server matchen").
//
// Reihenfolge: Tags zu Single-Space → HTML-Entities dekodieren → \s+ collapsen
// → trim. Entity-Decode ist Pflicht, sonst zaehlt z.B. `&#160;` (trailing NBSP
// aus Editor-Cursor-Anker) als 6 Zeichen rein, waehrend DOMParser-basierte
// Konsumenten (Revision-Diff) 1 NBSP → kollabiertes Whitespace sehen → Stats
// driften gegen sichtbaren Text.

const _NAMED = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
});

function _decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const isHex = code[1] === 'x' || code[1] === 'X';
      const n = isHex ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(n) || n < 0 || n > 0x10FFFF) return m;
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    const named = _NAMED[code];
    return named !== undefined ? named : m;
  });
}

function htmlToPlainText(html) {
  return _decodeEntities(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { htmlToPlainText };
