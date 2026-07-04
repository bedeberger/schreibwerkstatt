'use strict';
// Header/Footer-Stempler. Wird im zweiten Pass nach Body-Render über
// bufferedPageRange auf jede Body-Page angewandt. Token-Replacement für
// {title}/{author}/{chapter}/{pageTitle}/{page}/{pages}.

// Tokens für Header/Footer:
//   {title}     – Buchtitel (book.name)
//   {author}    – Autorname
//   {chapter}   – Aktueller Kapitelname (textuell)
//   {pageTitle} – Aktueller BookStack-Seitenname (textuell), Fallback Kapitel
//   {page}      – Aktuelle Seitenzahl (Zahl, ab pageNumberStart)
//   {pages}     – Gesamtanzahl Body-Seiten (Zahl)
function _replaceTokens(s, ctx) {
  return String(s || '')
    .replace(/\{title\}/g,     ctx.title || '')
    .replace(/\{author\}/g,    ctx.author || '')
    .replace(/\{chapter\}/g,   ctx.chapter || '')
    .replace(/\{pageTitle\}/g, ctx.pageTitle || ctx.chapter || '')
    .replace(/\{page\}/g,      ctx.page != null ? String(ctx.page) : '')
    .replace(/\{pages\}/g,     ctx.pages != null ? String(ctx.pages) : '');
}

// pdfkit prüft bei jedem text()-Call, ob `doc.y` ausserhalb der writable area
// (margins.top..page.height-margins.bottom) liegt; falls ja, wird automatisch
// eine neue Seite eingefügt. Header (im Top-Margin) und Footer (im
// Bottom-Margin) liegen genau dort. Lösung: Margins für die Header-/Footer-
// Phase auf 0 setzen, schreiben, dann zurücksetzen.
// fonts (optional): { header: { key, size, color }, footer: { key, size, color } }
// — Schriftbild pro Zeile. Fehlt es, gilt der Default (body-Font, 9pt, #666666).
// Kopf- und Fusszeile dürfen unterschiedliche Schrift/Grösse/Farbe tragen; die
// Breitenmessung (widthOfString) muss darum je Zeile die passende Font aktiv haben.
function _drawHeaderFooter(doc, layout, ctx, outerMargins, fonts) {
  const skipHeader = !!ctx.skipHeader;
  const skipFooter = !!ctx.skipFooter;
  if (skipHeader && skipFooter) return;
  const DEFAULT_SPEC = { key: 'body', size: 9, color: '#666666' };
  const headerSpec = (fonts && fonts.header) || DEFAULT_SPEC;
  const footerSpec = (fonts && fonts.footer) || DEFAULT_SPEC;
  const applySpec = (spec) => doc.font(spec.key).fontSize(spec.size).fillColor(spec.color);
  const { width } = doc.page;
  const pageW = width;
  // outerMargins beschreibt die Seitenränder OHNE Body-Inset. Header/Footer
  // muss am äusseren Rand stehen, auch wenn die Body-Page mit Inset-Margins
  // gerendert wurde.
  const origMargins = outerMargins ? { ...outerMargins } : { ...doc.page.margins };
  doc.save();
  doc.page.margins = { top: 0, right: origMargins.right, bottom: 0, left: origMargins.left };

  // Verso/Recto-Slot-Pick: bei isVerso & vorhandenen verso-Slots diese
  // verwenden, sonst Default (recto) Slots. Erlaubt unterschiedliche Inhalte
  // pro Seitenseite (klassisch: verso=Buchtitel, recto=Kapitel).
  const isVerso = !!ctx.isVerso;
  // Verso-Key: 'Verso' steht zwischen Prefix und Position (headerVersoLeft),
  // nicht am Ende — muss zur Config-/Frontend-Konvention passen.
  const versoKey = (key) => key.replace(/^(header|footer)/, '$1Verso');
  const pick = (key) => {
    const vk = versoKey(key);
    if (isVerso && layout[vk] != null && String(layout[vk]).length > 0) {
      return layout[vk];
    }
    return layout[key];
  };
  const headerL = pick('headerLeft');
  const headerC = pick('headerCenter');
  const headerR = pick('headerRight');
  const footerL = pick('footerLeft');
  const footerC = pick('footerCenter');
  const footerR = pick('footerRight');

  const innerW = pageW - origMargins.left - origMargins.right;
  const headerY = origMargins.top - 22;
  const footerY = doc.page.height - origMargins.bottom + 10;
  const GAP = 12;

  // 3-Spalten-Layout mit Kollisionsschutz: messe natürliche Breiten der drei
  // Slots; passt Σ + 2*GAP in innerW, bekommt jeder Slot natürliche Breite +
  // anteiligen Rest. Sonst gleichmässig dritteln + ellipsis-Truncation.
  const layoutRow = (l, c, r) => {
    const lt = l ? _replaceTokens(l, ctx) : '';
    const ct = c ? _replaceTokens(c, ctx) : '';
    const rt = r ? _replaceTokens(r, ctx) : '';
    const lw = lt ? doc.widthOfString(lt) : 0;
    const cw = ct ? doc.widthOfString(ct) : 0;
    const rw = rt ? doc.widthOfString(rt) : 0;
    const filled = (lt ? 1 : 0) + (ct ? 1 : 0) + (rt ? 1 : 0);
    const gaps = Math.max(0, filled - 1) * GAP;
    const fits = lw + cw + rw + gaps <= innerW;
    let leftW, centerW, rightW;
    if (fits) {
      const slack = (innerW - lw - cw - rw - gaps) / Math.max(1, filled);
      leftW   = lw + (lt ? slack : 0);
      centerW = cw + (ct ? slack : 0);
      rightW  = rw + (rt ? slack : 0);
    } else {
      const colW = (innerW - 2 * GAP) / 3;
      leftW = centerW = rightW = colW;
    }
    return { lt, ct, rt, leftW, centerW, rightW };
  };

  const writeRow = (l, c, r, y, spec) => {
    applySpec(spec); // Font/Grösse/Farbe VOR der Breitenmessung in layoutRow setzen.
    const { lt, ct, rt, leftW, centerW, rightW } = layoutRow(l, c, r);
    const opts = { lineBreak: false, ellipsis: true };
    if (lt) doc.text(lt, origMargins.left, y, { ...opts, width: leftW, align: 'left' });
    if (ct) {
      const cx = origMargins.left + (innerW - centerW) / 2;
      doc.text(ct, cx, y, { ...opts, width: centerW, align: 'center' });
    }
    if (rt) {
      const rx = origMargins.left + innerW - rightW;
      doc.text(rt, rx, y, { ...opts, width: rightW, align: 'right' });
    }
  };

  if (!skipHeader) writeRow(headerL, headerC, headerR, headerY, headerSpec);
  if (!skipFooter) writeRow(footerL, footerC, footerR, footerY, footerSpec);

  if ((!skipHeader && layout.headerRule) || (!skipFooter && layout.footerRule)) {
    doc.save();
    doc.lineWidth(0.5).strokeColor('#999999');
    if (!skipHeader && layout.headerRule) {
      const y = headerY + 14;
      doc.moveTo(origMargins.left, y).lineTo(origMargins.left + innerW, y).stroke();
    }
    if (!skipFooter && layout.footerRule) {
      const y = footerY - 4;
      doc.moveTo(origMargins.left, y).lineTo(origMargins.left + innerW, y).stroke();
    }
    doc.restore();
  }

  doc.page.margins = origMargins;
  doc.restore();
}

module.exports = { _drawHeaderFooter, _replaceTokens };
