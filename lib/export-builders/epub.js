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

// Statisches CSS-Grundgeruest (Titelei/Backmatter/Umbruch-Marker). Die
// reflow-/typografie-abhaengigen Regeln baut _buildCss(meta) dynamisch dazu.
// Ein eigenes `css`-Feld ersetzt das epub-gen-memory-Default-Stylesheet
// vollstaendig — darum die Lib-Defaults (Author/TOC/hr) hier mitfuehren.
const EPUB_CSS_BASE = `.epub-author { color: #555; }
.epub-link { margin-bottom: 30px; }
.epub-link a { color: #666; font-size: 90%; }
.toc-author { font-size: 90%; color: #555; }
.toc-link { color: #999; font-size: 85%; display: block; }
blockquote { margin: 1em 2em; }
li { text-indent: 0; }
hr.pagebreak { border: 0; margin: 0; height: 0; page-break-after: always; break-after: page; }
div.blankpage { margin: 0; height: 0; page-break-before: always; page-break-after: always; break-before: page; break-after: page; }
.scene-sep { text-align: center; text-indent: 0; margin: 1.6em 0; color: #555; }
hr.scene-line { border: 0; border-bottom: 1px solid #dedede; margin: 2em 10%; }
hr.scene-blank { border: 0; margin: 2em 0; }
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

// Schriftfamilien-Stacks fuer epub_css_style — generische + verbreitete Familien
// (kein Embedding, Reader nutzt sie wenn vorhanden, sonst der Stack-Fallback).
const FONT_STACKS = {
  serif: 'serif',
  sans: 'sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
  palatino: '"Palatino Linotype", Palatino, "Book Antiqua", serif',
  garamond: '"EB Garamond", Garamond, Georgia, serif',
  times: '"Times New Roman", Times, serif',
  baskerville: '"Libre Baskerville", Baskerville, Georgia, serif',
  helvetica: 'Helvetica, Arial, sans-serif',
  verdana: 'Verdana, Geneva, sans-serif',
};

const _FONT_SIZE = { small: '0.9em', normal: '1em', large: '1.15em' };
const _LINE_HEIGHT = { tight: '1.3', normal: '1.45', relaxed: '1.7' };
const _INDENT = { small: '1em', medium: '1.5em', large: '2.5em' };

// Vollstaendiges Stylesheet aus Basis + reflow-/typografie-Optionen der Meta.
function _buildCss(meta) {
  const m = meta || {};
  const fontFamily = FONT_STACKS[m.epub_css_style] || FONT_STACKS.serif;
  const fontSize = _FONT_SIZE[m.epub_font_size] || _FONT_SIZE.normal;
  const lineHeight = _LINE_HEIGHT[m.epub_line_height] || _LINE_HEIGHT.normal;
  const spaced = m.epub_paragraph_style === 'spaced';
  const indent = _INDENT[m.epub_indent_size] || _INDENT.medium;

  let css = EPUB_CSS_BASE;
  css += `\nbody { font-family: ${fontFamily}; font-size: ${fontSize}; }`;
  if (spaced) {
    // Sachbuch-Satz: Absatzabstand statt Erstzeilen-Einzug.
    css += `\np { margin: 0 0 0.8em; text-indent: 0; line-height: ${lineHeight}; }`;
  } else {
    // Belletristik-Satz: Erstzeilen-Einzug, kein Absatzabstand. Erster Absatz
    // nach Ueberschrift/Trenner ohne Einzug.
    css += `\np { margin: 0; text-indent: ${indent}; line-height: ${lineHeight}; }`;
    css += `\np:first-of-type, h1 + p, h2 + p, h3 + p, h4 + p, h5 + p, h6 + p,`;
    css += `\nblockquote + p, hr + p, figure + p, .scene-sep + p { text-indent: 0; }`;
  }
  if (m.epub_justify !== false) css += `\np { text-align: justify; }`;
  if (m.epub_hyphenation) css += `\np { -webkit-hyphens: auto; -epub-hyphens: auto; hyphens: auto; }`;
  if (m.epub_chapter_pagebreak) css += `\n.epub-chapter-head { page-break-before: always; break-before: page; }`;
  if (m.epub_drop_caps) {
    css += `\nh1 + p::first-letter, h2 + p::first-letter {`
      + ` float: left; font-size: 3.2em; line-height: 0.8; padding: 0.05em 0.08em 0 0; font-weight: bold; }`;
  }
  return css;
}

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
  // Titelseiten-Modus: 'generated' = eigene XHTML-Titelseite (Default),
  // 'cover'/'none' = keine generierte Titelseite (bei 'cover' uebernimmt das
  // eingebettete Cover-Bild diese Rolle).
  if ((m.epub_titlepage_mode || 'generated') === 'generated') {
    let tp = `<div class="titlepage"><h1>${escXml(title)}</h1>`;
    if (m.subtitle) tp += `<p class="subtitle">${escXml(m.subtitle)}</p>`;
    if (author)     tp += `<p class="author">${escXml(author)}</p>`;
    if (m.year)     tp += `<p class="year">${escXml(m.year)}</p>`;
    tp += '</div>';
    entries.push({ title: titleLabel, content: tp, filename: 'front_title.xhtml', __level: 0, __toc: false, beforeToc: true });
  }

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
const _SCENE_MARKUP = {
  line: '<hr class="scene-line" />',
  blank: '<hr class="scene-blank" />',
  asterism: '<p class="scene-sep">⁂</p>',
  stars: '<p class="scene-sep">* * *</p>',
  fleuron: '<p class="scene-sep">❦</p>',
};

function _applyBreaks(html, sceneSep = 'line') {
  if (!html) return html;
  const scene = _SCENE_MARKUP[sceneSep] || _SCENE_MARKUP.line;
  return html
    .replace(/<hr\b[^>]*\bclass="[^"]*\bpagebreak\b[^"]*"[^>]*>/gi, '<hr class="pagebreak" />')
    .replace(/<hr\b[^>]*\bclass="[^"]*\bblankpage\b[^"]*"[^>]*>/gi, '<div class="blankpage"> </div>')
    .replace(/<hr(?![^>]*\bclass=)[^>]*>/gi, scene);
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
  const rights = String(meta?.epub_rights || '').trim();
  if (rights) parts.push(`<dc:rights>${escXml(rights)}</dc:rights>`);
  // Mitwirkende → dc:contributor + MARC-Relator-Rolle (trl/ill/edt). id refines
  // koppelt Rolle an den Eintrag (EPUB3).
  const contributors = [
    ['translator', 'trl', meta?.epub_translator],
    ['illustrator', 'ill', meta?.epub_illustrator],
    ['editor', 'edt', meta?.epub_editor_name],
  ];
  contributors.forEach(([key, role, raw]) => {
    const name = String(raw || '').trim();
    if (!name) return;
    parts.push(`<dc:contributor id="contrib-${key}">${escXml(name)}</dc:contributor>`);
    parts.push(`<meta refines="#contrib-${key}" property="role" scheme="marc:relators">${role}</meta>`);
  });
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
  const meta = opts.meta || null;
  const sceneSep = meta?.epub_scene_separator || 'line';
  // Top-Level-Kapitelkopf bekommt eine Klasse fuer den optionalen Seitenumbruch
  // (CSS-Regel nur aktiv bei epub_chapter_pagebreak). Klasse schadet sonst nicht.
  const headWrap = (html) => `<div class="epub-chapter-head">${html}</div>`;
  // Seiten innerhalb eines Mehrseiten-Kapitels im Inhaltsverzeichnis zeigen?
  const nestPages = meta?.epub_nest_pages_in_toc !== false;
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
        content: headWrap(introHtml || `<h1>${escXml(ch.name)}</h1>`),
        filename: `chap_${gi}.xhtml`,
        __level: level,
        __hasChildren: level === 0 && nestPages,
      });
      g.pages.forEach((x, pi) => {
        epubChapters.push({
          title: x.p.name,
          content: _applyBreaks(x.pd.html, sceneSep),
          filename: `chap_${gi}_p_${pi}.xhtml`,
          __level: 1,
          __toc: nestPages,
        });
      });
    } else {
      const x = g.pages[0];
      const title = ch ? ch.name : x.p.name;
      const heading = ch ? (introHtml || `<h1>${escXml(ch.name)}</h1>`) : `<h1>${escXml(x.p.name)}</h1>`;
      const content = headWrap(heading) + _applyBreaks(x.pd.html, sceneSep);
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

  const css = _buildCss(meta);

  // Buchhandels-Metadaten bevorzugt aus book_publication, Description faellt auf
  // die Domain-Beschreibung zurueck. date: explizites Erscheinungsdatum
  // (epub_pubdate) vor dem Freitext-Jahr.
  const trimmed = v => { const t = String(v ?? '').trim(); return t || undefined; };
  const description = trimmed(meta?.description) || trimmed(book?.description);
  const publisher = trimmed(meta?.publisher);
  const date = trimmed(meta?.epub_pubdate) || trimmed(meta?.year);
  const id = trimmed(meta?.epub_uuid);
  const contentOPF = _buildContentOPF(meta);

  const epub = new EPub(
    {
      title,
      author: author || undefined,
      description,
      publisher,
      // Eigener Identifier (URN/UUID) wenn gesetzt — sonst Lib-Auto-UUID.
      ...(id ? { id } : {}),
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

module.exports = { buildEpub, _resolveEpubMeta, _countUnfetchableImages, _buildFrontmatter, _buildBackmatter, _proseToXhtml, _buildOpfExtraMeta, _buildContentOPF, _buildCss, _applyBreaks };
