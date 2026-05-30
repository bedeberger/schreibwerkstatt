'use strict';
// EPUB-Export via epub-gen-memory. Funktioniert fuer alle Scopes: Buch (Multi-
// Kapitel-Hierarchie), Kapitel (Single-Parent mit Pages als Kinder oder Flach),
// Seite (Einzel-Entry).

const { EPub } = require('epub-gen-memory');
const { escXml, chapterIntroHtml, resolveTitle, chapterDepth, buildChaptersById } = require('./shared');

// Belletristik-Satz: Erstzeilen-Einzug, kein Absatzabstand. Erster Absatz nach
// einer Ueberschrift ohne Einzug. Alles in em (Reader skaliert die Schrift).
// Behaelt zusaetzlich die Default-Regeln von epub-gen-memory (Author/TOC/hr),
// weil ein eigenes `css`-Feld das Default-Stylesheet vollstaendig ersetzt.
const EPUB_CSS = `.epub-author { color: #555; }
.epub-link { margin-bottom: 30px; }
.epub-link a { color: #666; font-size: 90%; }
.toc-author { font-size: 90%; color: #555; }
.toc-link { color: #999; font-size: 85%; display: block; }
hr { border: 0; border-bottom: 1px solid #dedede; margin: 2em 10%; }
p { margin: 0; text-indent: 1.5em; line-height: 1.4; }
p:first-of-type, h1 + p, h2 + p, h3 + p, h4 + p, h5 + p, h6 + p,
blockquote + p, hr + p, figure + p { text-indent: 0; }
blockquote { margin: 1em 2em; }
li { text-indent: 0; }`;

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
  // NavMap kann nur 2 Ebenen; sub-sub-Kapitel werden auf Level 1 zusammengelegt
  // (Inhalt bleibt vollstaendig, nur die Outline ist flacher).
  const byId = buildChaptersById(groups);
  groups.forEach((g, gi) => {
    const ch = g.chapter;
    const introHtml = chapterIntroHtml(ch);
    const d = ch ? chapterDepth(ch, byId) : 1;
    const level = Math.min(1, d - 1); // 0 = Top, 1 = nested.
    if (ch && g.pages.length > 1) {
      epubChapters.push({
        title: ch.name,
        content: introHtml || `<h1>${escXml(ch.name)}</h1>`,
        filename: `chap_${gi}.xhtml`,
        __level: level,
        __hasChildren: level === 0,
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
      const heading = ch ? (introHtml || `<h1>${escXml(ch.name)}</h1>`) : `<h1>${escXml(x.p.name)}</h1>`;
      const content = heading + x.pd.html;
      epubChapters.push({
        title,
        content,
        filename: `entry_${gi}.xhtml`,
        __level: level,
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
      css: EPUB_CSS,
      // Builder liefert eigene Headings (Kapitel-Intro bzw. Seitenname). Lib-
      // Default-Prepend wuerde sie verdoppeln + Seiten innerhalb eines Kapitels
      // ungewollt mit Per-Page-Heading versehen.
      prependChapterTitles: false,
      ignoreFailedDownloads: true,
      tocNCX,
      tocXHTML,
    },
    epubChapters,
  );
  return epub.genEpub();
}

module.exports = { buildEpub };
