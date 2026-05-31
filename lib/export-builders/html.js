'use strict';
// Single-File-HTML-Export. Verpackt Buch/Kapitel/Seite mit Print-CSS-Wrapper.
// Page-HTML wird unveraendert eingebettet (BookStack-WYSIWYG-Markup ist bereits
// gueltiges HTML5). XSS-Schutz erfolgt bei Eingang ueber lib/html-clean#
// cleanPageHtml; Builder schreibt nichts dazu, was nicht aus Schema/Body kommt.

const { escXml, resolveTitle, chapterDepth, buildChaptersById } = require('./shared');

const STYLE = `
:root { color-scheme: light; }
body {
  font-family: 'Lora', Georgia, serif;
  line-height: 1.55;
  max-width: 72ch;
  margin: 2rem auto;
  padding: 0 1rem;
  color: #1a1a1a;
}
h1, h2, h3 { font-family: 'Playfair Display', Georgia, serif; }
h1 { font-size: 2.2em; margin-top: 0; }
h2 { font-size: 1.6em; margin-top: 2em; border-top: 1px solid #ddd; padding-top: 1em; }
h3 { font-size: 1.2em; margin-top: 1.6em; }
p { margin: 0 0 0.8em; }
blockquote { border-left: 3px solid #888; margin: 1em 0; padding-left: 1em; color: #555; }
img { max-width: 100%; height: auto; }
.poem { white-space: pre-wrap; font-style: italic; }
hr { border: 0; border-top: 1px solid #ddd; margin: 2em 0; }
@media print {
  body { max-width: none; margin: 0; }
  h2 { page-break-before: always; border-top: 0; }
}
`.trim();

function buildHtml({ scope, book, chapter, page, groups }) {
  const title = resolveTitle({ scope, book, chapter, page });
  const parts = [];
  parts.push('<!DOCTYPE html>');
  parts.push(`<html lang="de"><head><meta charset="UTF-8"><title>${escXml(title)}</title>`);
  parts.push(`<style>${STYLE}</style>`);
  parts.push('</head><body>');
  parts.push(`<h1>${escXml(title)}</h1>`);
  // Tiefen-Lookup: Kapitel kennen parent_chapter_id. Top-Level → h2, Sub → h3,
  // Sub-Sub → h4. Page-Headings darunter eine Stufe (max h6).
  const byId = buildChaptersById(groups);
  for (const g of groups) {
    const ch = g.chapter;
    if (ch && (scope === 'book' || scope === 'chapter')) {
      const d = chapterDepth(ch, byId);
      const tag = `h${Math.min(6, d + 1)}`;
      parts.push(`<${tag}>${escXml(ch.name)}</${tag}>`);
    }
    const includePageHeadings = scope === 'book' && ch && g.pages.length > 1;
    for (const x of g.pages) {
      if (includePageHeadings) {
        const d = chapterDepth(ch, byId);
        const tag = `h${Math.min(6, d + 2)}`;
        parts.push(`<${tag}>${escXml(x.p.name)}</${tag}>`);
      }
      parts.push(x.pd.html || '');
    }
  }
  parts.push('</body></html>');
  return Buffer.from(parts.join('\n'), 'utf8');
}

module.exports = { buildHtml };
