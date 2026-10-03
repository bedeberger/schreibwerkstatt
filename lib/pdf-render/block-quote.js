'use strict';
// Eingerückte Blöcke: Blockzitat (mit senkrechtem Strich), Gedicht und
// Codeblock. Alle drei laufen über den Einzugs-Stapel der Seitengeometrie
// (page-geometry.js#pushIndent): der Einzug gilt relativ zum Rand der JEWEILIGEN
// Seite — nach einem Recto→Verso-Wechsel also relativ zum gespiegelten Rand —
// und wird beim Verlassen exakt zurückgenommen.

const { _currentPageIdx } = require('./layout');
const { _renderRuns } = require('./runs');
const { measureText } = require('./measure');
const { flowGeometry } = require('./page-geometry');

// Blockzitat: Einzug und Strich.
const QUOTE_INDENT_PT = 18;
const QUOTE_BAR_OFFSET_PT = 2;   // Strich sitzt so weit rechts vom Zitat-Aussenrand
const QUOTE_BAR_WIDTH_PT = 2;
const QUOTE_BAR_COLOR = '#999999';
// Schriftgrad-Faktor für das belegte Blockzitat (`<blockquote data-src>`). Kein
// Profil-Knopf: der Wert ist Satzkonvention, nicht Geschmack.
const CITED_QUOTE_SIZE_SCALE = 0.94;
const BLOCK_GAP_AFTER_LINES = 0.3;

// Gedicht: Einzug wie das Blockzitat (18 pt), Strophenabstand fast eine volle
// Leerzeile — mit dem Absatzabstand von 0.4 eines Fliesstext-Absatzes
// verwechselt man die Strophengrenze sonst mit einem Versumbruch. Bricht ein
// Vers um, läuft die Folgezeile um ein Geviert eingerückt (Satzkonvention: die
// Umbruchzeile ist als Fortsetzung erkennbar, nicht als neuer Vers).
const POEM_INDENT_PT = 18;
const STANZA_GAP_LINES = 0.8;
const PRE_BLANK_GAP_LINES = 0.4;
const VERSE_GAP_AFTER_LINES = 0.4;
const TAB_SPACES = 4;

async function renderBlockquote(doc, block, ctx, renderBlock) {
  const { font, textRole = 'body' } = ctx;
  const roleCfg = (textRole !== 'body' && font[textRole]) ? font[textRole] : font.body;
  const geo = flowGeometry(doc, ctx);
  geo.pushIndent(QUOTE_INDENT_PT);

  // Strich pro Seiten-Segment: über einen Umbruch hinweg wird er auf jeder
  // Seite einzeln gemalt, an der x-Position, die auf DIESER Seite gilt (bei
  // Spiegelung verschieden). `y1: null` = bis zur Satzspiegel-Unterkante dieser
  // Seite — bestimmt erst beim Zeichnen, weil der Fussnotenapparat
  // `margins.bottom` pro Seite unterschiedlich aufbläht.
  const barXNow = () => doc.page.margins.left - QUOTE_INDENT_PT + QUOTE_BAR_OFFSET_PT;
  const segments = [];
  let seg = { pageIdx: _currentPageIdx(doc), y0: doc.y, barX: barXNow() };
  // Läuft NACH dem Geometrie-Hook (der hängt seit dem Render-Start): der
  // Einzug ist auf der neuen Seite bereits aufgetragen.
  const onPageAdded = () => {
    segments.push({ ...seg, y1: null });
    seg = { pageIdx: _currentPageIdx(doc), y0: doc.page.margins.top, barX: barXNow() };
  };
  doc.on('pageAdded', onPageAdded);

  // Belegtes Blockzitat: wissenschaftliche Konvention ist der kleinere Grad.
  // Umgesetzt über eine verkleinerte Kopie der aktiven Textrolle — unter
  // demselben Schlüssel, damit sie die Sub-Blöcke wirklich erreicht.
  const quoteRole = (textRole !== 'body' && font[textRole]) ? textRole : 'body';
  const subFont = block.cited
    ? { ...font, [quoteRole]: { ...roleCfg, sizePt: Math.max(6, roleCfg.sizePt * CITED_QUOTE_SIZE_SCALE) } }
    : font;
  try {
    const subs = block.blocks || [];
    for (let i = 0; i < subs.length; i++) {
      await renderBlock(doc, subs[i], {
        ...ctx, font: subFont, dropCapHint: { pending: false }, firstParaHint: { pending: false }, bodyFirstLineIndentPt: 0,
      }, subs[i + 1]);
    }
  } finally {
    doc.off('pageAdded', onPageAdded);
    geo.popIndent();
  }
  if (doc.y > seg.y0) segments.push({ ...seg, y1: doc.y });

  if (segments.length) {
    const saveX = doc.x;
    const saveY = doc.y;
    const lastPageIdx = _currentPageIdx(doc);
    for (const s of segments) {
      doc.switchToPage(s.pageIdx);
      const y1 = s.y1 == null ? doc.page.height - doc.page.margins.bottom : s.y1;
      if (y1 <= s.y0) continue;
      doc.save();
      doc.lineWidth(QUOTE_BAR_WIDTH_PT).strokeColor(QUOTE_BAR_COLOR);
      doc.moveTo(s.barX, s.y0).lineTo(s.barX, y1).stroke();
      doc.restore();
    }
    doc.switchToPage(lastPageIdx);
    doc.x = saveX;
    doc.y = saveY;
  }
  doc.moveDown(BLOCK_GAP_AFTER_LINES);
}

// Gedicht und Codeblock: jede Zeile ist ein eigener linksbündiger Absatz im
// Layouter — Auszeichnung (der Walker liefert Verse kursiv), Notenmarker und
// Notbruch laufen wie im Fliesstext. Silbentrennung bleibt aus: ein getrennter
// Vers ist kein Vers mehr, und Code darf nicht verändert werden.
async function renderVerse(doc, block, ctx) {
  const { font, footnotes = null, columns = 1, columnGap = 0, widowOrphanControl = true } = ctx;
  const body = font.body;
  const isPoem = block.kind === 'poem';
  const geo = flowGeometry(doc, ctx);
  if (isPoem) geo.pushIndent(POEM_INDENT_PT);
  try {
    const blankGap = isPoem ? STANZA_GAP_LINES : PRE_BLANK_GAP_LINES;
    for (const line of block.lines || []) {
      let runs = line;
      let lead = 0;
      if (!isPoem) {
        // Code: führende Einrückung bleibt sichtbar — als fester Einzug, weil
        // der Layouter Leerraum am Zeilenanfang sonst verwirft.
        const text = line.map(r => r.text).join('').replace(/\t/g, ' '.repeat(TAB_SPACES)).replace(/\s+$/, '');
        const m = /^ +/.exec(text);
        if (m) lead = measureText(doc, m[0], 'body', body.sizePt);
        runs = text.trim() ? [{ text: text.trimStart() }] : [];
      }
      if (!runs.length || !runs.some(r => String(r.text || '').trim())) { doc.moveDown(blankGap); continue; }
      _renderRuns(doc, runs, {
        sizePt: body.sizePt,
        lineHeight: body.lineHeight,
        align: 'left',
        textColor: body.color || '#000000',
        firstLineIndent: lead,
        hangingIndentPt: isPoem ? body.sizePt : lead,
        fontKeyBase: 'body',
        columns, columnGap, hyphenate: null,
        footnotes,
        // Ein Vers mit zwei Umbruchzeilen soll nicht über den Seitenwechsel reissen.
        widowOrphan: widowOrphanControl && columns === 1,
      });
    }
  } finally {
    if (isPoem) geo.popIndent();
  }
  doc.moveDown(VERSE_GAP_AFTER_LINES);
}

module.exports = { renderBlockquote, renderVerse, QUOTE_INDENT_PT, POEM_INDENT_PT, CITED_QUOTE_SIZE_SCALE };
