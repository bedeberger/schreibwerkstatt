'use strict';
// Inline-Run-Renderer: rendert eine Sequenz von Text-Runs (bold/italic/underline/link)
// als ein zusammenhängendes Paragraph via pdfkit's `continued`-Mechanik.

const { _runFontKey } = require('./fonts');

function _renderRuns(doc, runs, opts) {
  const { sizePt, lineHeight, align = 'justify', linkColor = '#1a4d8f', textColor = '#000000', columns = 1, columnGap = 0, firstLineIndent = 0, hyphenate = null } = opts;
  // pdfkit `text` mit `continued: true` für inline-runs. `\n`-Runs (aus
  // `<br>`/Shift-Enter, vom html-walker emittiert) brechen die continued-Kette
  // und teilen das Paragraph in Segmente — pdfkit schluckt `\n` sonst in
  // justified Text.
  const segments = [[]];
  for (const r of runs) {
    if (r.text === '\n') { segments.push([]); continue; }
    segments[segments.length - 1].push(r);
  }
  segments.forEach((seg, segIdx) => {
    const isFirstSegment = segIdx === 0;
    if (seg.length === 0) {
      // Defensiv: `<br><br>` wird normalerweise von html-clean entfernt.
      doc.moveDown(0.5);
      return;
    }
    for (let i = 0; i < seg.length; i++) {
      const r = seg[i];
      const isLast = i === seg.length - 1;
      doc.font(_runFontKey(r)).fontSize(sizePt);
      const textOpts = {
        continued: !isLast,
        align,
        lineGap: (lineHeight - 1) * sizePt,
        underline: !!r.underline,
      };
      if (i === 0 && isFirstSegment && firstLineIndent > 0) {
        textOpts.indent = firstLineIndent;
      }
      if (columns > 1) {
        textOpts.columns = columns;
        textOpts.columnGap = columnGap;
      }
      if (r.link) {
        doc.fillColor(linkColor);
        textOpts.link = r.link;
      } else {
        doc.fillColor(textColor);
      }
      const text = (hyphenate && !r.link) ? hyphenate(r.text) : r.text;
      doc.text(text, textOpts);
    }
  });
  doc.fillColor(textColor);
}

module.exports = { _renderRuns };
