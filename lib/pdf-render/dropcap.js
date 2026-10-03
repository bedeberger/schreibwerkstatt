'use strict';
// Initialen-Absatz: der erste Buchstabe gross über N (3, notfalls 2) Zeilen,
// daneben die eingerückten Zeilen, danach der Rest auf voller Breite.
//
// Gesetzt wird über den gemeinsamen Layouter (justify.js): die ersten N Zeilen
// bekommen per `indentFor` den Einzug neben dem Initial, alle Zeilen laufen im
// Blocksatz — auch die letzte neben dem Initial — und Inline-Auszeichnung
// (kursiv/fett/Links) bleibt erhalten. Silbentrennung und Witwen/Waisen wirken
// wie im übrigen Fliesstext.
//
// Ein öffnendes Anführungszeichen („ » « " ' …) bleibt am Initial: allein als
// Initial wäre es ein Satzzeichen in Riesengrösse, getrennt davon stünde es
// verloren vor einem eingerückten Buchstaben.
//
// Absätze mit Notenmarker werden NICHT als Initiale gesetzt (Rückgabe false →
// normaler Absatzpfad): eine Note in den ersten Zeilen würde ihre Reserve mitten
// im gesperrten Initial-Block aufbauen.

const { layoutRuns, drawLayout } = require('./justify');
const { measureText } = require('./measure');

const DROP_LINES = 3;
const DROP_GAP_EM = 0.4;          // Abstand Initial → Text, in Fliesstext-Geviert
const LEADING_QUOTES = /^[„»«"'“”‚‘’‹›(\[]+/;

/** Initial (inkl. führender Anführungszeichen) aus den Runs lösen. Liefert
 *  { initial, runs } — `runs` ist eine Kopie ohne das Initial — oder null. */
function _splitInitial(runs) {
  const out = runs.map(r => ({ ...r }));
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    if (r.text === '\n') return null;
    const t = String(r.text || '');
    const lead = t.length - t.replace(/^\s+/, '').length;
    const rest = t.slice(lead);
    if (!rest) continue;
    const q = (LEADING_QUOTES.exec(rest) || [''])[0];
    const after = rest.slice(q.length);
    const ch = Array.from(after)[0];
    if (!ch || !/[\p{L}\p{N}]/u.test(ch)) return null; // kein Buchstabe am Anfang
    const initial = q + ch;
    r.text = after.slice(ch.length);
    // Leere führende Runs davor fallen weg.
    return { initial, runs: out.slice(i).filter(x => x.text !== '' || x === r) };
  }
  return null;
}

async function _renderDropCapParagraph(doc, runs, font, opts = {}) {
  if (runs.some(r => Number.isInteger(r && r.noteId))) return false;
  const split = _splitInitial(runs);
  if (!split) return false;
  const { initial } = split;

  const sizePt = font.body.sizePt;
  const lineHeight = font.body.lineHeight;
  const gap = sizePt * DROP_GAP_EM;
  const textColor = font.body.color || '#000000';

  doc.font('body').fontSize(sizePt);
  const bodyAscRatio = (doc._font?.ascender || 850) / 1000;
  const bodyCapRatio = (doc._font?.capHeight || 700) / 1000;
  doc.font('heading');
  const headAscRatio = (doc._font?.ascender || 850) / 1000;
  const headCapRatio = (doc._font?.capHeight || 700) / 1000;
  const bodyAsc = bodyAscRatio * sizePt;
  const bodyCapH = bodyCapRatio * sizePt;

  const base = {
    sizePt, lineHeight, align: 'justify', textColor, fontKeyBase: 'body',
    hyphenate: opts.hyphenate || null, firstLineIndent: 0, hangingIndentPt: 0,
  };

  // Cap-Grösse für N Zeilen: Cap-Höhe = Body-Cap-Höhe + (N−1) Zeilenvorschübe.
  const tryN = (N) => {
    const probe = layoutRuns(doc, [{ text: 'X' }], base);
    const capH = bodyCapH + (N - 1) * probe.advance;
    const dropSize = capH / headCapRatio;
    const dropW = measureText(doc, initial, 'heading', dropSize);
    const indent = dropW + gap;
    const indentFor = (li) => (li < N ? indent : 0);
    const layout = layoutRuns(doc, split.runs, { ...base, indentFor });
    return { N, dropSize, dropW, indent, indentFor, layout };
  };

  let res = tryN(DROP_LINES);
  // Zu kurz für drei Zeilen: mit zwei Zeilen neu umbrechen (das Initial wird
  // dann kleiner und schmaler, die Zeilen ändern sich mit).
  if (res.layout.lines.length < DROP_LINES) res = tryN(2);
  if (res.layout.lines.length < 2) return false;
  const N = Math.min(res.N, res.layout.lines.length);

  const { dropSize, indentFor, layout } = res;
  // Cap-Top auf Body-Cap-Top der ersten Zeile: der Text rückt um die Differenz
  // der Oberlängen-Polster nach unten, damit das Initial nicht über den
  // Absatzanfang hinausragt.
  const dropAsc = dropSize * headAscRatio;
  const dropCapH = dropSize * headCapRatio;
  const bodyOffset = Math.max(0, (dropAsc - dropCapH) - (bodyAsc - bodyCapH));

  // Initial + N Zeilen müssen zusammen auf die Seite passen; sonst beides auf
  // die nächste (eine frische Seite nimmt es immer).
  const needed = bodyOffset + (N - 1) * layout.advance + layout.fitHeight;
  const fresh = doc.y <= doc.page.margins.top + 0.5;
  if (!fresh && doc.y + needed > doc.page.maxY()) {
    doc.addPage();
    doc.y = doc.page.margins.top;
  }
  const topY = doc.y;
  const startX = doc.page.margins.left;

  doc.save();
  doc.font('heading').fontSize(dropSize).fillColor(font.heading.color || '#000000');
  doc.text(initial, startX, topY, { lineBreak: false });
  doc.restore();

  doc.y = topY + bodyOffset;
  drawLayout(doc, layout, {
    ...base, indentFor, lockLines: N, widowOrphan: !!opts.widowOrphan,
  });
  doc.x = doc.page.margins.left;
  return true;
}

module.exports = { _renderDropCapParagraph, _splitInitial };
