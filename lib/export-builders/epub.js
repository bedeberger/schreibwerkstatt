'use strict';
// EPUB-Export via epub-gen-memory. Funktioniert fuer alle Scopes: Buch (Multi-
// Kapitel-Hierarchie), Kapitel (Single-Parent mit Pages als Kinder oder Flach),
// Seite (Einzel-Entry).

const { EPub } = require('epub-gen-memory');
const logger = require('../../logger');
const { escXml, chapterIntroHtml, resolveTitle, chapterDepth, buildChaptersById } = require('./shared');

// Loest Autor/Sprache/TOC-Titel aus den Build-Optionen (vom Export-Aufrufer
// befuellt: Autor = Buch-Owner-Anzeigename, lang = book_settings.language) mit
// Fallback auf das Domain-Shape bzw. Sprach-Default. Pure + exportiert fuer Tests.
function _resolveEpubMeta(book, opts = {}) {
  const lang = opts.lang || 'de';
  return {
    lang,
    tocTitle: opts.tocTitle || (lang.startsWith('en') ? 'Contents' : 'Inhalt'),
    author: opts.author || book?.created_by?.name || book?.owned_by?.name || '',
  };
}

// Zaehlt <img>-Tags, deren src weder http(s) noch data: ist — die kann
// epub-gen-memory nicht einbetten und verwirft sie still. Wir loggen das,
// statt es zu verschlucken.
function _countUnfetchableImages(chapters) {
  let n = 0;
  for (const c of chapters) {
    const all = c.content?.match(/<img\b[^>]*\bsrc\s*=\s*["'][^"']*["']/gi) || [];
    for (const tag of all) {
      if (!/\bsrc\s*=\s*["'](https?:|data:)/i.test(tag)) n += 1;
    }
  }
  return n;
}

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
li { text-indent: 0; }
hr.pagebreak { border: 0; margin: 0; height: 0; page-break-after: always; break-after: page; }
div.blankpage { margin: 0; height: 0; page-break-before: always; page-break-after: always; break-before: page; break-after: page; }`;

// Editor-Umbruchmarker (`<hr class="pagebreak">` / `<hr class="blankpage">`) in
// EPUB-Aequivalente uebersetzen: Pagebreak bleibt randloses hr mit erzwungenem
// Seitenumbruch danach; Blankpage wird ein leeres div (hr kann keinen Inhalt
// tragen) mit Umbruch davor + danach, damit eine bewusst leere Seite entsteht.
function _applyBreaks(html) {
  if (!html) return html;
  return html
    .replace(/<hr\b[^>]*\bclass="[^"]*\bpagebreak\b[^"]*"[^>]*>/gi, '<hr class="pagebreak" />')
    .replace(/<hr\b[^>]*\bclass="[^"]*\bblankpage\b[^"]*"[^>]*>/gi, '<div class="blankpage"> </div>');
}

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

async function buildEpub({ scope, book, chapter, page, groups }, opts = {}) {
  const { lang, tocTitle, author } = _resolveEpubMeta(book, opts);
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
          content: _applyBreaks(x.pd.html),
          filename: `chap_${gi}_p_${pi}.xhtml`,
          __level: 1,
        });
      });
    } else {
      const x = g.pages[0];
      const title = ch ? ch.name : x.p.name;
      const heading = ch ? (introHtml || `<h1>${escXml(ch.name)}</h1>`) : `<h1>${escXml(x.p.name)}</h1>`;
      const content = heading + _applyBreaks(x.pd.html);
      epubChapters.push({
        title,
        content,
        filename: `entry_${gi}.xhtml`,
        __level: level,
        __hasChildren: false,
      });
    }
  });

  const unfetchable = _countUnfetchableImages(epubChapters);
  if (unfetchable > 0) {
    logger.warn(`epub: ${unfetchable} <img> mit nicht-einbettbarer src (weder http(s) noch data:) — werden vom Reader nicht angezeigt`);
  }

  const navMapXml = _buildNavMapXml(epubChapters);
  const tocBody = _buildTocXhtmlBody(epubChapters, tocTitle);
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
  const epub = new EPub(
    {
      title,
      author: author || undefined,
      description: book?.description || undefined,
      lang,
      tocTitle,
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

module.exports = { buildEpub, _resolveEpubMeta, _countUnfetchableImages };
