'use strict';
// Spezial-Seiten: Cover (Vollbild + optional Title-Overlay), Title-Page, Widmung,
// Impressum, TOC. TOC liefert Two-Pass-Positionen — der Body-Render schreibt
// die Pagenummern später an diese Anker.

const sharp = require('sharp');

const _TOC_DEFAULT_TITLE = {
  de: 'Inhaltsverzeichnis',
  en: 'Table of Contents',
};

// Reservierter Platz rechts in der TOC-Zeile für die Page-Number, wenn aktiviert.
const TOC_PAGENUM_RESERVE = 48;

async function _renderCover(doc, cover, coverImageBuf, book, profile) {
  if (!cover.enabled || !coverImageBuf) return false;
  // Vollbild — wir fügen eine Page ohne Margins ein.
  const oldMargins = doc.page.margins;
  doc.page.margins = { top: 0, right: 0, bottom: 0, left: 0 };
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const meta = await sharp(coverImageBuf).metadata();
  const fitCover = cover.fit === 'cover';
  const imgRatio = meta.width / meta.height;
  const pageRatio = pageW / pageH;
  let drawW, drawH, drawX, drawY;
  if (fitCover ? imgRatio > pageRatio : imgRatio < pageRatio) {
    drawH = pageH; drawW = drawH * imgRatio;
  } else {
    drawW = pageW; drawH = drawW / imgRatio;
  }
  drawX = (pageW - drawW) / 2;
  drawY = (pageH - drawH) / 2;
  doc.image(coverImageBuf, drawX, drawY, { width: drawW, height: drawH });
  if (cover.showTitleOverlay) {
    const overlayY = cover.overlayPosition === 'top'    ? pageH * 0.10
                   : cover.overlayPosition === 'center' ? pageH * 0.45
                                                        : pageH * 0.78;
    // Halbtransparent-Hintergrund würde Transparenz im PDF erzeugen — nicht
    // erlaubt in PDF/A-2B. Stattdessen direkt Text in Weiß mit Schatten-Box
    // aus solidem Schwarz: 20%-Bar.
    doc.save();
    doc.rect(0, overlayY - 12, pageW, 90).fill('#000000');
    doc.fillColor('#ffffff').font('title').fontSize(profile.config.font.title.sizePt)
       .text(book.name || '', 0, overlayY, { width: pageW, align: 'center', lineBreak: false });
    if (profile.config.extras.subtitle) {
      doc.font('subtitle').fontSize(profile.config.font.subtitle.sizePt)
         .text(profile.config.extras.subtitle, 0, overlayY + profile.config.font.title.sizePt + 6, { width: pageW, align: 'center', lineBreak: false });
    }
    doc.restore();
  }
  doc.page.margins = oldMargins;
  return true;
}

function _renderTitlePage(doc, book, config, overrides = {}) {
  doc.addPage();
  const f = config.font;
  const pageW = doc.page.width;
  const left = doc.page.margins.left;
  const usableW = pageW - left - doc.page.margins.right;
  const startY = doc.page.height * 0.30;
  doc.y = startY;
  const title = overrides.title ?? (book.name || '');
  const subtitle = overrides.subtitle ?? config.extras.subtitle ?? '';
  doc.font('title').fontSize(f.title.sizePt).fillColor(f.title.color || '#000000')
     .text(title, left, doc.y, { width: usableW, align: 'center' });
  if (subtitle) {
    doc.moveDown(0.6);
    doc.font('subtitle').fontSize(f.subtitle.sizePt).fillColor(f.subtitle.color || '#000000')
       .text(subtitle, left, doc.y, { width: usableW, align: 'center' });
  }
  doc.moveDown(2);
  const author = book.created_by?.name || book.owned_by?.name || '';
  const year   = config.extras.year;
  const byline = [author, year].filter(Boolean).join(' · ');
  if (byline) {
    doc.font('byline').fontSize(f.byline.sizePt).fillColor(f.byline.color || '#000000')
       .text(byline, left, doc.y, { width: usableW, align: 'center' });
  }
}

// Widmung-Seite: zentriert, kursiv, kleiner Text, ~40 %-Höhe.
function _renderDedicationPage(doc, config) {
  if (!config.extras.dedication) return;
  doc.addPage();
  const f = config.font;
  const pageW = doc.page.width;
  const left = doc.page.margins.left;
  const usableW = pageW - left - doc.page.margins.right;
  doc.y = doc.page.height * 0.40;
  doc.font('body-italic').fontSize(f.body.sizePt + 2).fillColor(f.body.color || '#000000');
  doc.text(config.extras.dedication, left, doc.y, {
    width: usableW, align: 'center',
    lineGap: (f.body.lineHeight - 1) * (f.body.sizePt + 2),
  });
}

// Impressum-Seite: linksbündig, Body-Schrift, mehrzeilig. Wird ans Buchende
// als eigene Seite angehängt (nach Body-Loop, vor PDF/A-Postprocess).
function _renderImprintPage(doc, config) {
  if (!config.extras.imprint) return;
  doc.addPage();
  const f = config.font;
  const pageW = doc.page.width;
  const left = doc.page.margins.left;
  const usableW = pageW - left - doc.page.margins.right;
  doc.y = doc.page.margins.top;
  doc.font('body').fontSize(f.body.sizePt - 1).fillColor(f.body.color || '#000000');
  doc.text(config.extras.imprint, left, doc.y, {
    width: usableW, align: 'left',
    lineGap: (f.body.lineHeight - 1) * (f.body.sizePt - 1),
  });
}

// TOC rendering. Reserviert auf der rechten Seite Platz für die nachträglich
// eingestempelte Seitenzahl (Two-Pass: Body-Render kennt erst nach Render
// die effektiven Pagenummern). Liefert `positions[]` aligned mit den
// gerenderten Einträgen — jede Position hält die Buffered-Page-ID + Y, an der
// die Seitenzahl später überschrieben werden kann.
function _renderToc(doc, toc, entries, lang, font) {
  if (!toc.enabled) return [];
  doc.addPage();
  const fallback = _TOC_DEFAULT_TITLE[lang] || _TOC_DEFAULT_TITLE.de;
  const headingColor = font?.heading?.color || '#000000';
  const bodyColor = font?.body?.color || '#000000';
  doc.font('heading').fontSize(20).fillColor(headingColor)
     .text(toc.title || fallback, { align: 'center' });
  doc.moveDown(1);
  doc.font('body').fontSize(11).fillColor(bodyColor);

  // Reserve nur einrechnen, wenn Page-Numbers gewünscht — sonst hat der Titel
  // die volle Breite zur Verfügung.
  const reserve = toc.showPageNumbers ? TOC_PAGENUM_RESERVE : 0;

  const positions = [];
  for (const c of entries) {
    if (c.level > toc.depth - 1) {
      positions.push(null);
      continue;
    }
    const indent = c.level * 18;
    const x = doc.page.margins.left + indent;
    const usableW = doc.page.width - x - doc.page.margins.right - reserve;
    // Position VOR dem Write merken. Wenn der Title bei Bedarf auf eine
    // neue TOC-Page umbricht (langer Eintrag in nestered TOC, oder am
    // Page-Bottom), wird die Position dadurch nicht zerschossen, weil
    // pdfkit `lineBreak: false` setzt — Single-Line-Garantie.
    const tocPageIdxBefore = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
    const yBefore = doc.y;
    doc.text(c.title, x, yBefore, {
      width: usableW,
      lineGap: 6,
      ellipsis: true,
      lineBreak: false,
    });
    // Falls der text() trotz lineBreak:false eine neue Page geöffnet hat
    // (Fall: yBefore lag bereits unter writable-area-Bottom), nehmen wir
    // die finale Page-ID nach Write.
    const tocPageIdxAfter = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
    if (tocPageIdxAfter !== tocPageIdxBefore) {
      positions.push({ tocPageIdx: tocPageIdxAfter, y: doc.page.margins.top });
    } else {
      positions.push({ tocPageIdx: tocPageIdxBefore, y: yBefore });
    }
  }
  doc.moveDown(1);
  return positions;
}

module.exports = {
  TOC_PAGENUM_RESERVE,
  _renderCover,
  _renderTitlePage,
  _renderDedicationPage,
  _renderImprintPage,
  _renderToc,
};
