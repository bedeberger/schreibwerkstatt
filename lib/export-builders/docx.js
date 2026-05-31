'use strict';
// DOCX-Export via @turbodocx/html-to-docx. Verkettet Buch/Kapitel/Seite zu
// einem grossen HTML-Stream und uebergibt ihn dem Converter.

const HTMLtoDOCX = require('@turbodocx/html-to-docx');
const { escXml, resolveTitle, chapterDepth, buildChaptersById } = require('./shared');

async function buildDocx({ scope, book, chapter, page, groups }, opts = {}) {
  const author = opts.author || book?.created_by?.name || book?.owned_by?.name || '';
  const title = resolveTitle({ scope, book, chapter, page });

  let body = `<h1 style="page-break-before: avoid; text-align: center;">${escXml(title)}</h1>\n`;
  if (author) body += `<p style="text-align: center;"><em>${escXml(author)}</em></p>\n`;
  if (scope === 'book' && book?.description) {
    body += `<p style="text-align: center;">${escXml(book.description)}</p>\n`;
  }

  const byId = buildChaptersById(groups);
  groups.forEach((g, gi) => {
    const ch = g.chapter;
    const d = ch ? chapterDepth(ch, byId) : 1;
    // depth 1 → h1 (Pagebreak), depth 2 → h2 (kein Break), depth 3 → h3.
    const chapTag = `h${Math.min(6, d)}`;
    const pageTag = `h${Math.min(6, d + 1)}`;
    const chapStyle = d === 1 ? ' style="page-break-before: always;"' : '';
    if (ch && g.pages.length > 1) {
      body += `<${chapTag}${chapStyle}>${escXml(ch.name)}</${chapTag}>\n`;
      g.pages.forEach((x) => {
        body += `<${pageTag}>${escXml(x.p.name)}</${pageTag}>\n`;
        body += x.pd.html + '\n';
      });
    } else {
      const x = g.pages[0];
      const entryTitle = ch ? ch.name : x.p.name;
      // Lose Seite ohne Kapitel: h1; im Kapitelkontext nutzt entryTitle den
      // chapTag (depth-abhaengig). Pagebreak nur bei Top-Level.
      const breakStyle = (!ch || d === 1)
        ? (gi === 0 ? '' : ' style="page-break-before: always;"')
        : '';
      const tag = ch ? chapTag : 'h1';
      body += `<${tag}${breakStyle}>${escXml(entryTitle)}</${tag}>\n`;
      body += x.pd.html + '\n';
    }
  });

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escXml(title)}</title></head><body>${body}</body></html>`;

  const buf = await HTMLtoDOCX(html, null, {
    title,
    creator: author || undefined,
    orientation: 'portrait',
    pageSize: { width: 11906, height: 16838 },
    pageNumber: true,
    font: 'Calibri',
    fontSize: 22,
    table: { row: { cantSplit: true } },
  });
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

module.exports = { buildDocx };
