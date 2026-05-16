'use strict';
// Plain-Text-Export. Verkettet Titel + Kapitel-/Page-Headings + Body, alle HTML-
// Tags werden zu Single-Space, `\s+` collapsed (identisch zu routes/sync.js#
// htmlToText — CLAUDE.md-Regel "HTML→Text-Normalisierung").

const { chapterIntroHtml, resolveTitle } = require('./shared');

function htmlToText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
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
