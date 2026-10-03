'use strict';
// Inline-Run-Renderer: Einstieg für jeden Textabsatz. Im Einspaltensatz geht
// ALLES (Blocksatz, linksbündig, zentriert) durch den eigenen Layouter in
// justify.js — ein Textpfad, damit Silbentrennung, Notbruch, Fussnoten und
// Witwen/Waisen überall gleich wirken. Nur der Zweispaltensatz läuft über
// pdfkit's `continued`-Mechanik: pdfkit paginiert die Spalten selbst, und der
// eigene Layouter kennt keine Spalten (Fussnoten fallen dort ohnehin auf den
// Kapitelapparat zurück, siehe index.js).

const { _runFontKey } = require('./fonts');
const { _renderRunsJustified, _sizeFor, SUP_RISE } = require('./justify');

// pdfkit verschluckt im `continued`+`justify`-Modus führende Whitespaces eines
// Folge-Fragments: steht zwischen zwei Runs (z. B. Fliesstext → Link/`<strong>`/
// `<em>` → Fliesstext) das trennende Leerzeichen am ANFANG des rechten Runs, geht
// es verloren — die Wörter kleben aneinander und die fehlgezählte Wortzahl bläht
// den Blocksatz auf. Fix: führenden Whitespace jedes Runs (ausser dem ersten) in
// ein eigenständiges, stil-neutrales Space-Fragment auslagern — das behält pdfkit.
function _normalizeRunWhitespace(runs) {
  const out = [];
  for (const r of runs) {
    if (r.text === '\n') { out.push(r); continue; }
    const m = /^(\s+)([\s\S]*)$/.exec(r.text);
    const prev = out[out.length - 1];
    if (m && prev && prev.text !== '\n') {
      // Doppelraum vermeiden, falls der Vorgänger bereits auf Whitespace endet.
      if (!/\s$/.test(prev.text)) out.push({ text: m[1] });
      if (m[2]) out.push({ ...r, text: m[2] });
    } else {
      out.push(r);
    }
  }
  return out;
}

function _renderRuns(doc, rawRuns, opts) {
  if ((opts.columns || 1) === 1) return _renderRunsJustified(doc, rawRuns, opts);
  // Zweispalter: ein Listen-Marker steht vor dem Text (der Layouter-Marker im
  // Einzug existiert hier nicht).
  const withMarker = opts.marker && opts.marker.text
    ? [{ text: opts.marker.text + ' ' }, ...rawRuns]
    : rawRuns;
  const runs = _normalizeRunWhitespace(withMarker);
  const { sizePt, lineHeight, align = 'justify', linkColor = '#1a4d8f', textColor = '#000000', columns = 1, columnGap = 0, firstLineIndent = 0, hyphenate = null, fontKeyBase = 'body' } = opts;
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
      // Hochgestellt (Notenziffer, siehe justify.js): kleinere Schrift plus
      // angehobene Grundlinie. pdfkit rechnet ohne `baseline` den Ursprung aus
      // der Oberlaenge der AKTUELLEN Groesse — bei verkleinerter Schrift saesse
      // die Ziffer damit zu tief. Der numerische `baseline`-Wert setzt den
      // Ursprung stattdessen absolut: gewuenscht ist die Grundlinie des
      // Fliesstextes, um SUP_RISE angehoben. `lineGap` bleibt an der
      // Basisgroesse — eine Note darf den Zeilenabstand nicht veraendern.
      const runSize = _sizeFor(r, sizePt);
      doc.font(opts.plainFont ? fontKeyBase : _runFontKey(r, fontKeyBase)).fontSize(runSize);
      const textOpts = {
        continued: !isLast,
        align,
        lineGap: (lineHeight - 1) * sizePt,
        underline: !!r.underline,
      };
      if (r.sup) {
        const asc = Number.isFinite(doc?._font?.ascender) ? doc._font.ascender / 1000 : 0.75;
        textOpts.baseline = -(asc * sizePt - SUP_RISE * sizePt);
      }
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
  doc.font(fontKeyBase).fontSize(sizePt);
}

module.exports = { _renderRuns, _normalizeRunWhitespace };
