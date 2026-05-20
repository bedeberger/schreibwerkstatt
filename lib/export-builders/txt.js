'use strict';
// Plain-Text-Export. Verkettet Titel + Kapitel-/Page-Headings + Body. `<br>`
// wird zu `\n` (Shift-Enter aus den Editoren = harter Zeilenumbruch); übrige
// Tags zu Single-Space, horizontale Whitespaces collapsed, Mehrfach-Leerzeilen
// auf max. 2 begrenzt.

const { chapterIntroHtml, resolveTitle } = require('./shared');

function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildTxt({ scope, book, chapter, page, groups }) {
  const out = [];
  const title = resolveTitle({ scope, book, chapter, page });
  if (title) out.push(title, '');

  for (const g of groups) {
    const ch = g.chapter;
    if (ch && (scope === 'book' || scope === 'chapter')) {
      out.push(ch.name);
      out.push('');
      const intro = htmlToText(chapterIntroHtml(ch));
      if (intro) { out.push(intro); out.push(''); }
    }
    const includePageHeadings = scope === 'book' && ch && g.pages.length > 1;
    for (const x of g.pages) {
      if (includePageHeadings) {
        out.push(x.p.name);
        out.push('');
      }
      const txt = htmlToText(x.pd.html);
      if (txt) { out.push(txt); out.push(''); }
    }
  }
  // BOM wird vom Caller (routes/export.js) gesetzt — Builder liefert nackten
  // UTF-8-Text.
  return Buffer.from(out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', 'utf8');
}

module.exports = { buildTxt, htmlToText };
