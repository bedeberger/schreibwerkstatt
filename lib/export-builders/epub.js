'use strict';
// EPUB-Export via epub-gen-memory. Funktioniert fuer alle Scopes: Buch (Multi-
// Kapitel-Hierarchie), Kapitel (Single-Parent mit Pages als Kinder oder Flach),
// Seite (Einzel-Entry).

const { EPub } = require('epub-gen-memory');
// Lib-eigenes EPUB3-OPF-Template zur Laufzeit ziehen (statt kopieren) — bleibt
// driftfest bei Lib-Updates. Wir injizieren nur zusaetzliche dc:subject/Reihen-
// Metadaten vor </metadata>; die ejs-Platzhalter der Lib bleiben unberuehrt.
const EPUB3_OPF_TEMPLATE = require('epub-gen-memory/dist/lib/templates/epub3/content.opf.ejs').default;
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
div.blankpage { margin: 0; height: 0; page-break-before: always; page-break-after: always; break-before: page; break-after: page; }
.titlepage { text-align: center; margin-top: 25%; }
.titlepage h1 { font-size: 2.2em; margin: 0 0 0.3em; }
.titlepage .subtitle { font-size: 1.2em; font-style: italic; color: #555; margin: 0 0 2em; }
.titlepage .author { font-size: 1.1em; margin: 0; }
.titlepage .year { color: #777; margin-top: 2em; }
.titlepage p { text-indent: 0; }
.dedication { margin-top: 30%; text-align: center; font-style: italic; }
.dedication p { text-indent: 0; }
.imprint { font-size: 0.85em; color: #444; }
.imprint p { text-indent: 0; margin: 0 0 0.6em; }
.authorpage h2 { margin-bottom: 1em; }
.authorpage img { max-width: 45%; height: auto; display: block; margin: 0 0 1em; }`;

// Belletristik-Blocksatz optional (epub_justify). Reader-Default ist linksbuendig.
const EPUB_CSS_JUSTIFY = `\np { text-align: justify; }`;

// Schriftfamilie aus epub_css_style (serif|sans). Reader respektiert das, solange
// der User die Verlags-Schrift nicht selbst ueberschreibt. Default serif.
const EPUB_CSS_FONT = {
  serif: '\nbody { font-family: serif; }',
  sans: '\nbody { font-family: sans-serif; }',
};

// Prosa-Freitext (Widmung/Impressum/Bio) → XHTML. Escaped, Doppel-Zeilenumbruch
// = neuer Absatz, einfacher Umbruch = <br/>. Pflicht-Escape (x-html-Invariante).
function _proseToXhtml(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  return t.split(/\n{2,}/).map(par =>
    `<p>${escXml(par).replace(/\n/g, '<br/>')}</p>`
  ).join('\n');
}

// Frontmatter-Entries (Titelseite, Impressum, Widmung, Motto) — als XHTML-
// Kapitel VOR dem Inhaltsverzeichnis (beforeToc), aus der custom-TOC
// ausgeschlossen (__toc:false). Reihenfolge: Titel → Impressum → Widmung → Motto.
function _buildFrontmatter(meta, { title, author, lang }) {
  const m = meta || {};
  const entries = [];
  const titleLabel = lang.startsWith('en') ? 'Title' : 'Titel';
  let tp = `<div class="titlepage"><h1>${escXml(title)}</h1>`;
  if (m.subtitle) tp += `<p class="subtitle">${escXml(m.subtitle)}</p>`;
  if (author)     tp += `<p class="author">${escXml(author)}</p>`;
  if (m.year)     tp += `<p class="year">${escXml(m.year)}</p>`;
  tp += '</div>';
  entries.push({ title: titleLabel, content: tp, filename: 'front_title.xhtml', __level: 0, __toc: false, beforeToc: true });

  const imprintBody = [_proseToXhtml(m.copyright), _proseToXhtml(m.imprint), m.isbn ? `<p>ISBN: ${escXml(m.isbn)}</p>` : ''].filter(Boolean).join('\n');
  if (imprintBody) {
    entries.push({ title: 'Impressum', content: `<div class="imprint">${imprintBody}</div>`, filename: 'front_imprint.xhtml', __level: 0, __toc: false, beforeToc: true });
  }
  const ded = _proseToXhtml(m.dedication);
  if (ded) entries.push({ title: lang.startsWith('en') ? 'Dedication' : 'Widmung', content: `<div class="dedication">${ded}</div>`, filename: 'front_dedication.xhtml', __level: 0, __toc: false, beforeToc: true });
  const motto = _proseToXhtml(m.frontmatter);
  if (motto) entries.push({ title: 'Motto', content: `<div class="frontmatter">${motto}</div>`, filename: 'front_motto.xhtml', __level: 0, __toc: false, beforeToc: true });
  return entries;
}

// Autor-Bio-Backmatter (mit optionalem Foto als data-URI). Aus der TOC
// ausgeschlossen, ans Buchende.
function _buildBackmatter(meta, { lang }, authorImage) {
  const bio = _proseToXhtml(meta?.author_bio);
  if (!bio) return [];
  const heading = lang.startsWith('en') ? 'About the Author' : 'Über den Autor';
  let img = '';
  if (authorImage?.image && authorImage.mime) {
    const b64 = Buffer.from(authorImage.image).toString('base64');
    img = `<img src="data:${escXml(authorImage.mime)};base64,${b64}" alt="${escXml(heading)}"/>`;
  }
  return [{
    title: heading,
    content: `<div class="authorpage"><h2>${escXml(heading)}</h2>${img}${bio}</div>`,
    filename: 'back_author.xhtml',
    __level: 0,
    __toc: false,
  }];
}

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

// Buchhandels-Metadaten, die epub-gen-memory nicht nativ als Option kennt, als
// OPF-Metadata-Zeilen: Schlagwoerter → dc:subject (eins pro Term), Reihe →
// EPUB3-Collection + calibre-Legacy-Meta (von Calibre/vielen Readern gelesen).
function _buildOpfExtraMeta(meta) {
  const parts = [];
  const kw = String(meta?.keywords || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const k of kw) parts.push(`<dc:subject>${escXml(k)}</dc:subject>`);
  const series = String(meta?.series || '').trim();
  if (series) {
    const idx = String(meta?.series_index || '').trim();
    parts.push(`<meta property="belongs-to-collection" id="series-collection">${escXml(series)}</meta>`);
    parts.push('<meta refines="#series-collection" property="collection-type">series</meta>');
    if (idx) parts.push(`<meta refines="#series-collection" property="group-position">${escXml(idx)}</meta>`);
    parts.push(`<meta name="calibre:series" content="${escXml(series)}"/>`);
    if (idx) parts.push(`<meta name="calibre:series_index" content="${escXml(idx)}"/>`);
  }
  return parts.join('\n        ');
}

// Custom-OPF nur bauen wenn Extra-Metadaten anfallen; sonst Lib-Default. Injiziert
// die Extra-Zeilen vor </metadata> ins unveraenderte Lib-Template (ejs-Platzhalter
// bleiben, werden von epub-gen-memory gerendert).
function _buildContentOPF(meta) {
  const extra = _buildOpfExtraMeta(meta);
  if (!extra) return undefined;
  return EPUB3_OPF_TEMPLATE.replace('</metadata>', `        ${extra}\n    </metadata>`);
}

function _buildNavMapXml(allChapters) {
  const chapters = allChapters.filter(c => c.__toc !== false);
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

function _buildTocXhtmlBody(allChapters, tocTitle) {
  const chapters = allChapters.filter(c => c.__toc !== false);
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

  const title = resolveTitle({ scope, book, chapter, page });
  const meta = opts.meta || null;
  // Frontmatter (Titelseite/Impressum/Widmung/Motto) vor, Autor-Bio nach dem
  // Inhalt. Beide aus der custom-TOC ausgeschlossen (__toc:false).
  const allChapters = [
    ..._buildFrontmatter(meta, { title, author, lang }),
    ...epubChapters,
    ..._buildBackmatter(meta, { lang }, opts.authorImage),
  ];

  const unfetchable = _countUnfetchableImages(allChapters);
  if (unfetchable > 0) {
    logger.warn(`epub: ${unfetchable} <img> mit nicht-einbettbarer src (weder http(s) noch data:) — werden vom Reader nicht angezeigt`);
  }

  const navMapXml = _buildNavMapXml(allChapters);
  const tocBody = _buildTocXhtmlBody(allChapters, tocTitle);
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

  // Cover als File (epub-gen-memory akzeptiert string-URL oder File). Buffer aus
  // book_publication.cover_image wird in ein File mit korrektem MIME gewickelt.
  let cover;
  if (opts.cover?.image && opts.cover.mime) {
    const ext = /png/i.test(opts.cover.mime) ? 'png' : 'jpg';
    cover = new File([opts.cover.image], `cover.${ext}`, { type: opts.cover.mime });
  }

  const fontCss = EPUB_CSS_FONT[meta?.epub_css_style] || EPUB_CSS_FONT.serif;
  const css = EPUB_CSS + fontCss + (meta && meta.epub_justify === false ? '' : EPUB_CSS_JUSTIFY);

  // Buchhandels-Metadaten bevorzugt aus book_publication, Description faellt auf
  // die Domain-Beschreibung zurueck. date aus dem Erscheinungsjahr (Freitext).
  const trimmed = v => { const t = String(v ?? '').trim(); return t || undefined; };
  const description = trimmed(meta?.description) || trimmed(book?.description);
  const publisher = trimmed(meta?.publisher);
  const date = trimmed(meta?.year);
  const contentOPF = _buildContentOPF(meta);

  const epub = new EPub(
    {
      title,
      author: author || undefined,
      description,
      publisher,
      // date NUR wenn gesetzt — die Lib ueberschreibt sonst ihren Default mit
      // undefined und `new Date(undefined).toISOString()` wirft.
      ...(date ? { date } : {}),
      ...(contentOPF ? { contentOPF } : {}),
      cover,
      lang,
      tocTitle,
      css,
      // Builder liefert eigene Headings (Kapitel-Intro bzw. Seitenname). Lib-
      // Default-Prepend wuerde sie verdoppeln + Seiten innerhalb eines Kapitels
      // ungewollt mit Per-Page-Heading versehen.
      prependChapterTitles: false,
      ignoreFailedDownloads: true,
      tocNCX,
      tocXHTML,
    },
    allChapters,
  );
  return epub.genEpub();
}

module.exports = { buildEpub, _resolveEpubMeta, _countUnfetchableImages, _buildFrontmatter, _buildBackmatter, _proseToXhtml, _buildOpfExtraMeta, _buildContentOPF };
