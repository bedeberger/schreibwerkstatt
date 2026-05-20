'use strict';
// Block-Renderer: dispatched walker-Output (heading/paragraph/list/blockquote/
// poem/pre/image/hr) auf die jeweilige pdfkit-Render-Sequenz. Rekursiv für
// list-/blockquote-Sub-Blocks.

const { _renderDropCapParagraph } = require('./dropcap');
const { _renderRuns } = require('./runs');
const { _fetchImage } = require('./images');

async function _renderBlock(doc, block, ctx) {
  const { font, indent = 0, token, imageCache, dropCapHint, firstParaHint, bodyFirstLineIndentPt = 0, columns = 1, columnGap = 0 } = ctx;
  if (block.kind === 'heading') {
    const sizes = font.heading.sizes;
    const sizePt = block.level === 1 ? sizes.h1 : block.level === 2 ? sizes.h2 : sizes.h3;
    const space = block.level === 1 ? 24 : block.level === 2 ? 14 : 8;
    if (doc.y !== doc.page.margins.top) doc.moveDown(0.6);
    doc.font('heading').fontSize(sizePt).fillColor(font.heading.color || '#000000');
    doc.text(block.text, { align: 'left', lineGap: 4, paragraphGap: space });
    // Buchkonvention: erster Absatz nach Heading nicht eingerueckt.
    if (firstParaHint) firstParaHint.pending = true;
    return;
  }
  if (block.kind === 'paragraph') {
    if (dropCapHint?.pending) {
      const ok = await _renderDropCapParagraph(doc, block.runs, font);
      if (ok) {
        dropCapHint.pending = false;
        if (firstParaHint) firstParaHint.pending = false;
        doc.moveDown(0.3);
        return;
      }
    }
    const skipIndent = firstParaHint?.pending;
    if (firstParaHint) firstParaHint.pending = false;
    _renderRuns(doc, block.runs, {
      sizePt: font.body.sizePt,
      lineHeight: font.body.lineHeight,
      align: 'justify',
      textColor: font.body.color || '#000000',
      firstLineIndent: skipIndent ? 0 : bodyFirstLineIndentPt,
      columns, columnGap,
    });
    doc.moveDown(font.body.paragraphGap);
    return;
  }
  if (block.kind === 'list') {
    let i = 1;
    for (const itemBlocks of block.items) {
      const bullet = block.ordered ? `${i++}. ` : '• ';
      doc.font('body').fontSize(font.body.sizePt).fillColor(font.body.color || '#000000');
      doc.text(bullet, { continued: true });
      // Erstes Block-Element des li direkt anschließen, danach moveDown für
      // weitere Sub-Blocks.
      const [first, ...rest] = itemBlocks;
      if (first && first.kind === 'paragraph') {
        _renderRuns(doc, first.runs, {
          sizePt: font.body.sizePt,
          lineHeight: font.body.lineHeight,
          align: 'left',
          textColor: font.body.color || '#000000',
        });
      } else {
        doc.text('', { continued: false });
        if (first) await _renderBlock(doc, first, ctx);
      }
      for (const sub of rest) await _renderBlock(doc, sub, ctx);
    }
    doc.moveDown(0.3);
    return;
  }
  if (block.kind === 'blockquote') {
    // Indent + linker Strich. Page-Break-tauglich: pdfkit resettet bei Auto-
    // Pagebreak `lineWrapper.startX` auf `doc.page.margins.left`. Darum
    // modifizieren wir margins.left per pageAdded-Hook, damit auch
    // Folgeseiten die eingerueckte Spalte erben. Strich wird pro Page-Segment
    // ueber switchToPage gemalt — sonst landet er nach Pagebreak auf falscher
    // Seite (yStart aus Page N, yEnd aus Page N+1).
    const indentPt = 18;
    const origLeft = doc.page.margins.left;
    const enterX = doc.x;
    const indentedLeft = enterX + indentPt;
    const barX = enterX + 2;

    doc.page.margins.left = indentedLeft;
    doc.x = indentedLeft;

    const range0 = doc.bufferedPageRange();
    let segPageIdx = range0.start + range0.count - 1;
    let segY0 = doc.y;
    const segments = [];

    // pdfkit emits 'pageAdded' ohne Argumente; neue Seite ist bereits doc.page.
    // Vorherige Seite hat identisches Format, daher prevBottom aus doc.page ableitbar.
    const onPageAdded = () => {
      const page = doc.page;
      const prevBottom = page.height - page.margins.bottom;
      segments.push({ pageIdx: segPageIdx, y0: segY0, y1: prevBottom });
      segPageIdx += 1;
      page.margins.left = indentedLeft;
      segY0 = page.margins.top;
    };
    doc.on('pageAdded', onPageAdded);

    for (const sub of block.blocks) {
      await _renderBlock(doc, sub, { ...ctx, dropCapHint: { pending: false }, firstParaHint: { pending: false }, bodyFirstLineIndentPt: 0 });
    }

    doc.off('pageAdded', onPageAdded);

    const finalY = doc.y;
    if (finalY > segY0) {
      segments.push({ pageIdx: segPageIdx, y0: segY0, y1: finalY });
    }

    doc.page.margins.left = origLeft;
    doc.x = origLeft;

    if (segments.length) {
      const saveX = doc.x;
      const saveY = doc.y;
      const range1 = doc.bufferedPageRange();
      const lastPageIdx = range1.start + range1.count - 1;
      for (const s of segments) {
        if (s.y1 <= s.y0) continue;
        doc.switchToPage(s.pageIdx);
        doc.save();
        doc.lineWidth(2).strokeColor('#999999');
        doc.moveTo(barX, s.y0).lineTo(barX, s.y1).stroke();
        doc.restore();
      }
      doc.switchToPage(lastPageIdx);
      doc.x = saveX;
      doc.y = saveY;
    }

    doc.moveDown(0.3);
    return;
  }
  if (block.kind === 'poem' || block.kind === 'pre') {
    doc.font(block.kind === 'poem' ? 'body-italic' : 'body').fontSize(font.body.sizePt).fillColor(font.body.color || '#000000');
    for (const line of block.lines) {
      const text = line.map(r => r.text).join('');
      if (text) doc.text(text, { align: 'left', lineGap: (font.body.lineHeight - 1) * font.body.sizePt });
      else doc.moveDown(0.4);
    }
    doc.moveDown(0.4);
    return;
  }
  if (block.kind === 'image') {
    const fetched = await _fetchImage(block.src, token, imageCache);
    if (!fetched) return;
    const maxW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const ratio = fetched.height / fetched.width;
    const w = Math.min(maxW, fetched.width);
    const h = w * ratio;
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
    doc.image(fetched.buffer, doc.x, doc.y, { width: w });
    doc.y += h + 8;
    return;
  }
  if (block.kind === 'hr') {
    const y = doc.y + 6;
    const startX = doc.page.margins.left;
    const endX   = doc.page.width - doc.page.margins.right;
    doc.save();
    doc.lineWidth(0.5).strokeColor('#999999').moveTo(startX, y).lineTo(endX, y).stroke();
    doc.restore();
    doc.y = y + 12;
    return;
  }
}

module.exports = { _renderBlock };
