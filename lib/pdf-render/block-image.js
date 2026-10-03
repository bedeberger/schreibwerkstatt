'use strict';
// Bild-Block: Grösse, Seitenumbruch und Legende.
//
// Grösse: natürliche Druckbreite aus Pixelbreite und dpi-Angabe der Quelle
// (images.js: nie grösser als bei 150 dpi — darunter wird es pixelig), höchstens
// Satzspiegelbreite. Ist das Bild dann höher als der Satzspiegel (Hochformat-
// Scan, Diagramm-Langformat), wird es seitenverhältnistreu auf die Rahmenhöhe
// geklemmt — sonst ragte es über den Seitenfuss oder erzeugte auf einer schon
// frischen Seite einen Leerumbruch. Gezählt in `stats.oversizeImages`.
//
// Legende: folgt dem Bild eine Bildunterschrift (`figCaption` aus dem Walker),
// muss sie mit dem Bild auf derselben Seite stehen; ihr Platz geht in die
// Umbruchentscheidung und in die Höhenklemme ein.

const { layoutRuns } = require('./justify');

const IMAGE_GAP_AFTER_PT = 8;

function _captionHeight(doc, next, ctx) {
  if (!next || next.kind !== 'paragraph' || !next.figCaption) return 0;
  const body = ctx.font.body;
  const lay = layoutRuns(doc, next.runs, {
    sizePt: body.sizePt, lineHeight: body.lineHeight, fontKeyBase: 'body', hyphenate: ctx.hyphenate || null,
  });
  return lay.lines.length * lay.advance + (body.paragraphGap || 0) * lay.fitHeight;
}

async function renderImage(doc, block, ctx, next, fetchImage) {
  const { imageCache, dpiWarnThreshold = 0, dpiWarnings = null, footnotes = null } = ctx;
  const fetched = await fetchImage(block.src, imageCache, ctx.imageOpts);
  if (!fetched || !fetched.width || !fetched.height) return;
  const maxW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const ratio = fetched.height / fetched.width;
  const natural = Number.isFinite(fetched.naturalWidthPt) ? fetched.naturalWidthPt : fetched.width;
  let w = Math.min(maxW, natural);
  let h = w * ratio;

  const capH = _captionHeight(doc, next, ctx);
  // Rahmenhöhe einer FRISCHEN Seite: die Fussnoten-Reserve der aktuellen Seite
  // zählt nicht mit — auf der Folgeseite gibt es sie nicht.
  const reserve = footnotes && typeof footnotes.reserveOf === 'function'
    ? footnotes.reserveOf(doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1)
    : 0;
  const frameH = doc.page.height - doc.page.margins.top - (doc.page.margins.bottom - reserve);
  const maxH = Math.max(24, frameH - capH - IMAGE_GAP_AFTER_PT);
  if (h > maxH) {
    h = maxH;
    w = h / ratio;
    if (ctx.stats) ctx.stats.oversizeImages = (ctx.stats.oversizeImages || 0) + 1;
  }

  // Effektive Druckauflösung: Quell-Pixelbreite / Druckbreite (pt = 1/72 Zoll).
  const srcW = fetched.srcWidth || fetched.width;
  if (dpiWarnThreshold > 0 && dpiWarnings && w > 0) {
    const effDpi = srcW * 72 / w;
    if (effDpi < dpiWarnThreshold) {
      dpiWarnings.push({ src: block.src, dpi: Math.round(effDpi), px: srcW });
    }
  }

  const fresh = doc.y <= doc.page.margins.top + 0.5;
  if (!fresh && doc.y + h + capH > doc.page.maxY()) {
    doc.addPage();
    doc.y = doc.page.margins.top;
  }
  // Seite melden, auf der die Abbildung TATSAECHLICH steht — nach dem
  // moeglichen Umbruch, vor dem Zeichnen (Abbildungsverzeichnis, anchor-dir.js).
  if (block.bid) ctx.onAnchorStart?.(block.bid);
  doc.image(fetched.buffer, doc.page.margins.left, doc.y, { width: w, height: h });
  doc.y += h + IMAGE_GAP_AFTER_PT;
  doc.x = doc.page.margins.left;
}

module.exports = { renderImage, IMAGE_GAP_AFTER_PT };
