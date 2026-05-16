'use strict';
// EPUB-Export via epub-gen-memory. Funktioniert fuer alle Scopes: Buch (Multi-
// Kapitel-Hierarchie), Kapitel (Single-Parent mit Pages als Kinder oder Flach),
// Seite (Einzel-Entry).

const { EPub } = require('epub-gen-memory');
const { escXml, chapterIntroHtml, resolveTitle } = require('./shared');

function _buildNavMapXml(chapters) {
  let play = 0;
  let openParent = false;
  let out = '<navMap>\n';
  chapters.forEach((c, i) => {
    const lvl = c.__level || 0;
    const id = `np_${i}`;
    const file = c.filename;
    const title = escXml(c.title);
    if (lvl === 0) {
      if (openParent) { out += '</navPoint>\n'; openParent = false; }
      const cls = c.__hasChildren ? 'part' : 'chapter';
      out += `<navPoint id="${id}" playOrder="${++play}" class="${cls}">\n`;
      out += `<navLabel><text>${title}</text></navLabel>\n`;
      out += `<content src="${file}"/>\n`;
      if (c.__hasChildren) openParent = true;
      else out += '</navPoint>\n';
    } else {
      out += `<navPoint id="${id}" playOrder="${++play}" class="chapter">\n`;
      out += `<navLabel><text>${title}</text></navLabel>\n`;
      out += `<content src="${file}"/>\n`;
      out += '</navPoint>\n';
    }
  });
  if (openParent) out += '</navPoint>\n';
  out += '</navMap>';
  return out;
}

function _buildTocXhtmlBody(chapters, tocTitle) {
  let openParent = false;
  let out = `<h1 class="h1">${escXml(tocTitle)}</h1>\n<nav id="toc" epub:type="toc">\n<ol style="list-style: none">\n`;
  chapters.forEach(c => {
    const lvl = c.__level || 0;
    const file = c.filename;
    const title = escXml(c.title);
    if (lvl === 0) {
      if (openParent) { out += '</ol>\n</li>\n'; openParent = false; }
      if (c.__hasChildren) {
        out += `<li class="table-of-content"><a href="${file}">${title}</a>\n<ol style="list-style: none">\n`;
        openParent = true;
      } else {
        out += `<li class="table-of-content"><a href="${file}">${title}</a></li>\n`;
      }
    } else {
      out += `<li class="table-of-content"><a href="${file}">${title}</a></li>\n`;
    }
  });
  if (openParent) out += '</ol>\n</li>\n';
  out += '</ol>\n</nav>';
  return out;
}

async function buildEpub({ scope, book, chapter, page, groups }) {
  const epubChapters = [];
  groups.forEach((g, gi) => {
    const ch = g.chapter;
    const introHtml = chapterIntroHtml(ch);
    if (ch && g.pages.length > 1) {
      epubChapters.push({
        title: ch.name,
        content: introHtml || `<h1>${escXml(ch.name)}</h1>`,
        filename: `chap_${gi}.xhtml`,
        __level: 0,
        __hasChildren: true,
      });
      g.pages.forEach((x, pi) => {
        epubChapters.push({
          title: x.p.name,
          content: x.pd.html,
          filename: `chap_${gi}_p_${pi}.xhtml`,
          __level: 1,
        });
      });
    } else {
      const x = g.pages[0];
      const title = ch ? ch.name : x.p.name;
      const content = ch ? (introHtml + x.pd.html) : x.pd.html;
      epubChapters.push({
        title,
        content,
        filename: `entry_${gi}.xhtml`,
        __level: 0,
        __hasChildren: false,
      });
    }
  });

  const navMapXml = _buildNavMapXml(epubChapters);
  const tocBody = _buildTocXhtmlBody(epubChapters, 'Inhalt');
  const tocNCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
<meta name="dtb:uid" content="<%= id %>"/>
<meta name="dtb:depth" content="2"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text><%= title %></text></docTitle>
<docAuthor><text><%= author.join(", ") %></text></docAuthor>
${navMapXml}
</ncx>`;
  const tocXHTML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="<%- lang %>" lang="<%- lang %>">
<head>
<title><%= title %></title>
<meta charset="UTF-8" />
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
${tocBody}
</body>
</html>`;

  const title = resolveTitle({ scope, book, chapter, page });
  const author = book?.created_by?.name || book?.owned_by?.name || '';
  const epub = new EPub(
    {
      title,
      author: author || undefined,
      description: book?.description || undefined,
      lang: 'de',
      tocTitle: 'Inhalt',
      ignoreFailedDownloads: true,
      tocNCX,
      tocXHTML,
    },
    epubChapters,
  );
  return epub.genEpub();
}

module.exports = { buildEpub };
