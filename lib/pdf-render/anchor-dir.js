'use strict';
// Abbildungs- und Tabellenverzeichnis im Custom-PDF — MIT Seitenzahlen.
//
// WARUM NICHT lib/anchor-directory.js: dieses Modul bedient die Ausgabewege
// ohne Seitenbegriff (HTML, Markdown, TXT, EPUB, DOCX). Im gesetzten Buch
// gehoert die Seitenzahl dazu, und die steht erst fest, wenn der Umbruch
// gelaufen ist. Die EINTRAEGE kommen trotzdem von dort — Reihenfolge, Nummer
// und Beschriftungstext stammen aus demselben Xref-Kontext, der die Legenden im
// Text nummeriert hat. Ein zweiter Zaehlautomat erzeugte genau die Abweichung,
// die ein Verzeichnis unbrauchbar macht: „Abb. 3.2" im Verzeichnis, „Abb. 3.1"
// am Bild.
//
// ZWEIPASS WIE BEIM INHALTSVERZEICHNIS: die Verzeichnisseiten werden VOR dem
// Body gesetzt (sie stehen hinter dem Inhaltsverzeichnis) und merken sich je
// Eintrag ihre Zeilenposition. Welche Buchseite dort hingehoert, meldet der
// Body-Renderer beim Zeichnen der Abbildung; der Stempel-Pass traegt sie
// nachtraeglich per `switchToPage` ein.
//
// OHNE NUMMERN KEIN VERZEICHNIS. Nummeriert das Buch den Typ nicht
// (`book_settings.figure_numbering` / `table_numbering`), traegt der
// Xref-Kontext keine Nummern — dann gibt es nichts aufzulisten, und dieses
// Modul liefert leer. Es gibt bewusst KEINEN eigenen Profil-Schalter dafuer:
// die Nummerierung des Buchs IST der Schalter, genau wie im HTML-, Markdown-
// und EPUB-Export.
//
// Typografie kommt aus der TOC-Rolle des Profils (`font.toc`/`font.tocTitle`,
// `config.toc.leader`, `pageNumReserveMm`). Ein Verzeichnis ist ein
// Verzeichnis; zwei getrennte Schriftbilder im selben Buch waeren ein Fehler,
// kein Freiheitsgrad.

const { MM_TO_PT, _currentPageIdx } = require('./layout');
const { directoryEntries, directoryTitle } = require('../anchor-directory');
const { TOC_PAGENUM_RESERVE_FALLBACK_PT, _wrapTocLines } = require('./pages');

const DIR_KINDS = ['figure', 'table'];

/** Plan der Verzeichnisse: je Typ die Eintraege in Leserichtung.
 *
 *  `bid` ist der Zeiger auf die Seite, die der Body spaeter meldet. Er steckt
 *  nicht in `directoryEntries` (die Ausgabewege ohne Seitenzahlen brauchen ihn
 *  nicht), darum wird er hier aus derselben Map nachgezogen — in derselben
 *  Reihenfolge, aus derselben Quelle.
 *
 *  @returns {Array<{kind:string, title:string, entries:Array}>} leer, wenn es
 *           nichts zu listen gibt. */
function buildAnchorDirPlan(xrefCtx, lang = 'de') {
  if (!xrefCtx) return [];
  const out = [];
  for (const kind of DIR_KINDS) {
    const entries = directoryEntries(xrefCtx, kind, { lang });
    if (!entries.length) continue;
    const map = xrefCtx[kind];
    const bids = [];
    const iter = map instanceof Map ? map.entries() : Object.entries(map || {});
    for (const [bid, v] of iter) { if (v && v.number) bids.push(bid); }
    out.push({
      kind,
      title: directoryTitle(kind, lang),
      entries: entries.map((e, i) => ({ ...e, bid: bids[i] || null, pageIdx: -1 })),
    });
  }
  return out;
}

/** Verzeichnisse setzen. Eine Seite je Typ (laeuft ueber, wenn noetig).
 *
 *  Liefert je Typ eine Positionsliste in der Reihenfolge der Eintraege —
 *  `{ dirPageIdx, y }` je Zeile, Eingabe des Stempel-Passes. */
function renderAnchorDirectories(doc, plan, toc, font) {
  if (!plan.length) return [];

  const tocBody = font?.toc || {};
  const tocTitleFont = font?.tocTitle || {};
  const titleColor = tocTitleFont.color || font?.heading?.color || '#000000';
  const bodyColor = tocBody.color || font?.body?.color || '#000000';
  const titleSize = tocTitleFont.sizePt || 20;
  const bodySize = tocBody.sizePt || 11;
  const lineHeight = tocBody.lineHeight || 1.45;
  const lineGap = Math.max(0, (lineHeight - 1) * bodySize);
  const titleAlign = ['left', 'center', 'right'].includes(toc.titleAlign) ? toc.titleAlign : 'center';
  const showPageNumbers = toc.showPageNumbers !== false;
  const reservePt = showPageNumbers
    ? Math.max(0, (toc.pageNumReserveMm ?? 14) * MM_TO_PT)
    : 0;
  const leader = ['none', 'dots', 'line'].includes(toc.leader) ? toc.leader : 'none';

  const all = [];
  for (const dir of plan) {
    doc.addPage();
    doc.font('toc-title').fontSize(titleSize).fillColor(titleColor)
      .text(dir.title, { align: titleAlign });
    doc.moveDown(1);
    doc.font('toc').fontSize(bodySize).fillColor(bodyColor);

    // Label-Spalte („Abb. 3.10") rechtsbuendig, damit die Beschriftungen aller
    // Eintraege an derselben x-Position beginnen — dieselbe Mechanik wie die
    // Nummern-Spalte des Inhaltsverzeichnisses.
    const maxLabelW = dir.entries.reduce((m, e) => Math.max(m, doc.widthOfString(e.label)), 0);
    const labelGapPt = Math.round(bodySize * 0.6);
    const labelColW = maxLabelW + labelGapPt;

    const lineStepPt = doc.currentLineHeight(true) + lineGap;
    const bottomLimit = doc.page.height - doc.page.margins.bottom;
    const positions = [];

    for (const e of dir.entries) {
      const geom = () => {
        const baseX = doc.page.margins.left;
        const titleX = baseX + labelColW;
        return { baseX, titleX, usableW: doc.page.width - titleX - doc.page.margins.right - reservePt };
      };
      let g = geom();
      let lines = _wrapTocLines(doc, e.title, g.usableW);
      if (doc.y + lines.length * lineStepPt > bottomLimit) {
        doc.addPage();
        g = geom();
        lines = _wrapTocLines(doc, e.title, g.usableW);
      }
      const dirPageIdx = _currentPageIdx(doc);
      const firstY = doc.y;
      const { baseX, titleX, usableW } = g;

      let y = firstY;
      for (const ln of lines) {
        doc.text(ln, titleX, y, { lineBreak: false });
        y += lineStepPt;
      }
      doc.y = y;
      const lastY = firstY + (lines.length - 1) * lineStepPt;

      const yAfterTitle = doc.y;
      doc.text(e.label, baseX, firstY, { width: maxLabelW, align: 'right', lineBreak: false });
      doc.y = yAfterTitle;

      if (leader !== 'none' && showPageNumbers && reservePt > 0) {
        const baselineY = lastY + bodySize * 0.85;
        const titleWidth = Math.min(doc.widthOfString(lines[lines.length - 1]), usableW);
        const leaderStartX = titleX + titleWidth + 4;
        const leaderEndX = doc.page.width - doc.page.margins.right - reservePt - 4;
        if (leaderEndX > leaderStartX) {
          doc.save();
          doc.lineWidth(0.5).strokeColor(bodyColor);
          if (leader === 'dots') doc.dash(1, { space: 2 });
          doc.moveTo(leaderStartX, baselineY).lineTo(leaderEndX, baselineY).stroke();
          if (leader === 'dots') doc.undash();
          doc.restore();
        }
      }
      positions.push({ dirPageIdx, y: lastY });
    }
    all.push(positions);
  }
  return all;
}

/** Stempel-Pass: Buchseite je Eintrag nachtragen.
 *
 *  `anchorPages` ist die Meldung des Body-Renderers (bid → pageIdx), `pageNumByIdx`
 *  die Umrechnung auf die gedruckte Nummer. Ein Eintrag ohne beides bleibt
 *  leer — die Zeile steht dann ohne Zahl da, statt eine falsche zu nennen. */
function stampAnchorDirPageNumbers(doc, { plan, positions, anchorPages, pageNumByIdx, toc, config }) {
  if (!plan.length || toc.showPageNumbers === false) return;
  doc.save();
  const tocFont = config.font.toc || config.font.body;
  doc.font('toc').fontSize(tocFont.sizePt || 11).fillColor(tocFont.color || '#000000');
  const reservePt = (toc.pageNumReserveMm != null)
    ? toc.pageNumReserveMm * MM_TO_PT
    : TOC_PAGENUM_RESERVE_FALLBACK_PT;
  for (let d = 0; d < plan.length; d++) {
    const entries = plan[d].entries;
    const pos = positions[d] || [];
    for (let i = 0; i < entries.length; i++) {
      const p = pos[i];
      const bid = entries[i].bid;
      if (!p || !bid) continue;
      const pageIdx = anchorPages.get(bid);
      if (pageIdx == null) continue;
      const bodyPageNum = pageNumByIdx.get(pageIdx);
      if (bodyPageNum == null) continue;
      doc.switchToPage(p.dirPageIdx);
      const xRight = doc.page.width - doc.page.margins.right - reservePt;
      doc.text(String(bodyPageNum), xRight, p.y, {
        width: reservePt,
        align: 'right',
        lineBreak: false,
      });
    }
  }
  doc.restore();
}

module.exports = { buildAnchorDirPlan, renderAnchorDirectories, stampAnchorDirPageNumbers };
