'use strict';
// Inline-Run-Renderer: rendert eine Sequenz von Text-Runs (bold/italic/underline/link)
// als ein zusammenhängendes Paragraph via pdfkit's `continued`-Mechanik.

const { _runFontKey } = require('./fonts');

function _renderRuns(doc, runs, opts) {
  const { sizePt, lineHeight, align = 'justify', linkColor = '#1a4d8f', textColor = '#000000', columns = 1, columnGap = 0 } = opts;
  // pdfkit `text` mit `continued: true` für inline-runs.
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const isLast = i === runs.length - 1;
    doc.font(_runFontKey(r)).fontSize(sizePt);
    const textOpts = {
      continued: !isLast,
      align,
      lineGap: (lineHeight - 1) * sizePt,
      underline: !!r.underline,
    };
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
    doc.text(r.text, textOpts);
  }
  doc.fillColor(textColor);
}

module.exports = { _renderRuns };
