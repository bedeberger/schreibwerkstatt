// HTML→Plain-Text Normalisierung. Frontend-Pendant zu lib/html-text.js.
// Pflicht-Parity (CLAUDE.md „HTML→Text-Normalisierung: Frontend MUSS Server
// matchen"). Konsumenten: book/tree.js (_syncPageStatsAfterSave),
// page-revision-diff.js (Plain-Text-Fallback).

const _NAMED = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
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

export function htmlToPlainText(html) {
  return _decodeEntities(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}
