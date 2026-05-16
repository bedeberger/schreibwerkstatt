'use strict';
// DOCX-Export via @turbodocx/html-to-docx. Verkettet Buch/Kapitel/Seite zu
// einem grossen HTML-Stream und uebergibt ihn dem Converter.

const HTMLtoDOCX = require('@turbodocx/html-to-docx');
const { escXml, chapterIntroHtml, resolveTitle } = require('./shared');

async function buildDocx({ scope, book, chapter, page, groups }) {
  const author = book?.created_by?.name || book?.owned_by?.name || '';
  const title = resolveTitle({ scope, book, chapter, page });

  let body = `<h1 style="page-break-before: avoid; text-align: center;">${escXml(title)}</h1>\n`;
  if (author) body += `<p style="text-align: center;"><em>${escXml(author)}</em></p>\n`;
  if (scope === 'book' && book?.description) {
    body += `<p style="text-align: center;">${escXml(book.description)}</p>\n`;
  }

  groups.forEach((g, gi) => {
    const ch = g.chapter;
    const introHtml = chapterIntroHtml(ch);
    if (ch && g.pages.length > 1) {
      body += `<h1 style="page-break-before: always;">${escXml(ch.name)}</h1>\n`;
      if (introHtml) body += introHtml + '\n';
      g.pages.forEach((x) => {
        body += `<h2>${escXml(x.p.name)}</h2>\n`;
        body += x.pd.html + '\n';
      });
    } else {
      const x = g.pages[0];
      const entryTitle = ch ? ch.name : x.p.name;
      const breakStyle = gi === 0 ? '' : ' style="page-break-before: always;"';
      body += `<h1${breakStyle}>${escXml(entryTitle)}</h1>\n`;
      if (ch && introHtml) body += introHtml + '\n';
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
