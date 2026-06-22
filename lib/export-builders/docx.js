'use strict';
// DOCX-Export via @turbodocx/html-to-docx. Verkettet Buch/Kapitel/Seite zu
// einem grossen HTML-Stream und uebergibt ihn dem Converter. Zwei Varianten:
// Standard (Calibri, Lese-Layout) und Normseite (Courier New 12pt, doppelter
// Zeilenabstand, grosszuegige Raender ~60 Anschlaege/Zeile — das Einreich-
// Manuskriptformat fuer Lektorat/Verlag/Agentur).

const HTMLtoDOCX = require('@turbodocx/html-to-docx');
const { escXml, resolveTitle, chapterDepth, buildChaptersById } = require('./shared');

// Doppelter Zeilenabstand greift in html-to-docx nur, wenn line-height am
// jeweiligen Block-Tag steht — Vererbung von einem Wrapper-<div> ignoriert der
// Converter. Darum die Eigenschaft in jedes Block-Tag des Seiten-HTML injizieren.
const BLOCK_TAG_RE = /<(p|h[1-6]|li|blockquote|pre|div)\b([^>]*)>/gi;
function injectLineHeight(html, lh) {
  return String(html || '').replace(BLOCK_TAG_RE, (_m, tag, attrs) => {
    if (/\sstyle\s*=\s*"/i.test(attrs)) {
      return `<${tag}${attrs.replace(/(\sstyle\s*=\s*")([^"]*)"/i,
        (_s, pre, val) => `${pre}${val.replace(/;?\s*$/, '')};line-height:${lh}"`)}>`;
    }
    return `<${tag}${attrs} style="line-height:${lh}">`;
  });
}

async function buildDocxVariant({ scope, book, chapter, page, groups }, opts, normseite) {
  const author = opts.author || book?.created_by?.name || book?.owned_by?.name || '';
  const title = resolveTitle({ scope, book, chapter, page });
  const pageHtml = normseite ? (h) => injectLineHeight(h, 2) : (h) => h;

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
        body += pageHtml(x.pd.html) + '\n';
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
      body += pageHtml(x.pd.html) + '\n';
    }
  });

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escXml(title)}</title></head><body>${body}</body></html>`;

  const common = {
    title,
    creator: author || undefined,
    orientation: 'portrait',
    pageSize: { width: 11906, height: 16838 },
    pageNumber: true,
    table: { row: { cantSplit: true } },
  };
  const variant = normseite
    // ~60 Anschlaege/Zeile (Courier 12pt ≈ 0.1in/Zeichen, Textbreite via Raender)
    // und ~30 Zeilen/Seite durch doppelten Zeilenabstand (line-height:2).
    ? { ...common, font: 'Courier New', fontSize: 24,
        margins: { top: 1440, bottom: 1440, left: 1700, right: 1700 } }
    : { ...common, font: 'Calibri', fontSize: 22 };

  const buf = await HTMLtoDOCX(html, null, variant);
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

async function buildDocx(bundle, opts = {})          { return buildDocxVariant(bundle, opts, false); }
async function buildDocxNormseite(bundle, opts = {}) { return buildDocxVariant(bundle, opts, true); }

module.exports = { buildDocx, buildDocxNormseite };
