'use strict';
// Seiten-Geometrie-Controller: Recto/Verso-Margin-Spiegelung, Body-Inset,
// Einzugs-Stapel (Blockzitat/Gedicht/Liste), TrimBox/BleedBox bei Beschnitt und
// Recto/Verso-Paritäts-Padding. Kapselt die pageAdded-gebundene Margin-Mutation
// samt Reihenfolge (Mirror → Boxes → Inset → Einzüge) und das insetActive-
// Umschalten zwischen Titelei und Body an einem Ort — die Add/Subtract-
// Arithmetik muss sich exakt paaren, sonst erben Folgeseiten den falschen Rand.
//
// SSoT für „wo liegt der Rand DIESER Seite": `marginsFor(pageIdx)` (Aussenränder
// ohne Inset/Einzug, gespiegelt nach Seitenparität) für alles, was nach dem Body
// auf fertige Seiten stempelt (Kopf-/Fusszeile, Fussnotenapparat), und
// `doc.page.margins` für alles im Fluss — die ist auf jeder Seite (auch nach
// einem Auto-Umbruch mitten in einem Blockzitat) bereits gespiegelt + eingerückt,
// weil der Einzugs-Stapel im selben Hook nachgezogen wird. Ein Konsument, der
// sich den linken Rand der START-Seite merkt, liegt nach einem Recto→Verso-
// Wechsel um die Bundsteg-Differenz daneben.

const { MM_TO_PT, _currentPageIdx, _nextPageIdx, _isVersoPageIdx } = require('./layout');

/**
 * @param {PDFDocument} doc
 * @param {object} args
 * @param {object} args.layout   - config.layout (liest bodyInsetMm)
 * @param {object} args.margins  - Basis-Ränder in pt { top,right,bottom,left } (inkl. Bleed)
 * @param {number} args.bleedPt  - Beschnitt in pt (0 = kein Beschnitt)
 * @param {boolean} args.mirror  - mirrorMargins aktiv
 * @param {boolean} args.frontMatterAllowed - Recto/Verso-Padding nur bei scope='book'
 * @param {Set<number>} args.blankPageIdxs  - eingeschobene Leerseiten werden hier registriert
 */
function createPageGeometry(doc, { layout, margins, bleedPt, mirror, frontMatterAllowed, blankPageIdxs }) {
  const insetMm = layout.bodyInsetMm || { top: 0, right: 0, bottom: 0, left: 0 };
  const insetPt = {
    top:    (insetMm.top    || 0) * MM_TO_PT,
    right:  (insetMm.right  || 0) * MM_TO_PT,
    bottom: (insetMm.bottom || 0) * MM_TO_PT,
    left:   (insetMm.left   || 0) * MM_TO_PT,
  };
  const hasInset = !!(insetPt.top || insetPt.right || insetPt.bottom || insetPt.left);
  let insetActive = false;
  // Einzugs-Stapel: jeder Eintrag schiebt den linken Rand um `pt` nach innen.
  // Gilt auf der aktuellen Seite sofort und wird auf JEDER neuen Seite relativ
  // zum frisch gespiegelten Rand neu aufgetragen.
  const indentStack = [];
  let indentSum = 0;

  const _applyMirror = () => {
    if (!mirror) return;
    // Full-bleed-Pages (Cover) haben margins=0 — keine Spiegelung anwenden.
    if (doc.page.margins.top === 0 && doc.page.margins.left === 0 && doc.page.margins.right === 0) return;
    const pageIdx = _currentPageIdx(doc);
    doc.page.margins.left  = _isVersoPageIdx(pageIdx) ? margins.right : margins.left;
    doc.page.margins.right = _isVersoPageIdx(pageIdx) ? margins.left : margins.right;
  };
  // TrimBox (Endformat) + BleedBox (Medienkante) ins Page-Dictionary. Selbst-
  // guardend: no-op ohne Beschnitt. Die Druckerei beschneidet auf die TrimBox.
  const setPageBoxes = () => {
    if (bleedPt <= 0) return;
    const w = doc.page.width, h = doc.page.height;
    doc.page.dictionary.data.TrimBox  = [bleedPt, bleedPt, w - bleedPt, h - bleedPt];
    doc.page.dictionary.data.BleedBox = [0, 0, w, h];
  };
  const _clampCursor = () => {
    if (doc.x < doc.page.margins.left) doc.x = doc.page.margins.left;
    if (doc.y < doc.page.margins.top)  doc.y = doc.page.margins.top;
  };
  const onPageAdded = () => {
    _applyMirror();
    setPageBoxes();
    if (insetActive) {
      doc.page.margins.top    += insetPt.top;
      doc.page.margins.right  += insetPt.right;
      doc.page.margins.bottom += insetPt.bottom;
      doc.page.margins.left   += insetPt.left;
    }
    if (indentSum) doc.page.margins.left += indentSum;
    // Frisch angelegte Seite: pdfkit hat doc.x/doc.y in addPage() auf den
    // BASIS-Rand gesetzt, BEVOR dieser Hook lief. _applyMirror kann margins.left
    // aber verkleinern (Verso-Seite: left := outer). Cursor deshalb auf den
    // finalen (gespiegelten + Inset-)Rand nachziehen — sonst startet der Text
    // (und damit die aus doc.x abgeleitete Zeilenbreite) auf dem alten Recto-
    // Innenrand. Ein reines Hochklammern (_clampCursor) griffe hier nicht, weil
    // der Rand geschrumpft statt gewachsen ist.
    doc.x = doc.page.margins.left;
    doc.y = doc.page.margins.top;
  };
  const enableBodyInset = () => {
    if (!hasInset || insetActive) return;
    insetActive = true;
    doc.page.margins.top    += insetPt.top;
    doc.page.margins.right  += insetPt.right;
    doc.page.margins.bottom += insetPt.bottom;
    doc.page.margins.left   += insetPt.left;
    _clampCursor();
  };
  const disableBodyInset = () => {
    if (!hasInset || !insetActive) return;
    insetActive = false;
    doc.page.margins.top    -= insetPt.top;
    doc.page.margins.right  -= insetPt.right;
    doc.page.margins.bottom -= insetPt.bottom;
    doc.page.margins.left   -= insetPt.left;
  };
  // Recto/Verso-Paritätspflege: steht die nächste Seite auf der falschen
  // Buchseite, eine leere Seite (ohne Header/Footer/Nummer) einschieben. recto =
  // gerader 0-basierter Index. Nur bei scope='book' (frontMatterAllowed).
  const padToSide = (wantRecto) => {
    if (!frontMatterAllowed) return;
    if ((_nextPageIdx(doc) % 2 === 0) === wantRecto) return;
    doc.addPage();
    setPageBoxes();
    blankPageIdxs.add(_currentPageIdx(doc));
  };

  // Aussenränder einer Seite (ohne Body-Inset, ohne Einzüge), gespiegelt nach
  // ihrer Parität. Reine Rechnung — liest nichts aus `doc.page`, darf also auch
  // nach dem Body und auf beliebigen Seiten benutzt werden.
  const marginsFor = (pageIdx) => {
    const verso = mirror && _isVersoPageIdx(pageIdx);
    return {
      top: margins.top,
      bottom: margins.bottom,
      left: verso ? margins.right : margins.left,
      right: verso ? margins.left : margins.right,
    };
  };

  const pushIndent = (pt) => {
    const v = Number.isFinite(pt) ? pt : 0;
    indentStack.push(v);
    indentSum += v;
    doc.page.margins.left += v;
    doc.x = doc.page.margins.left;
  };
  const popIndent = () => {
    if (!indentStack.length) return;
    const v = indentStack.pop();
    indentSum -= v;
    doc.page.margins.left -= v;
    doc.x = doc.page.margins.left;
  };
  const indentDepth = () => indentStack.length;

  // Der Hook hängt immer: auch ohne Spiegelung/Inset/Beschnitt braucht der
  // Einzugs-Stapel ihn, damit ein Blockzitat über einen Seitenwechsel seinen
  // Einzug behält. Kosten: ein Funktionsaufruf pro Seite.
  const attach = () => { doc.on('pageAdded', onPageAdded); };
  const detach = () => { doc.removeListener('pageAdded', onPageAdded); };

  return { hasInset, setPageBoxes, enableBodyInset, disableBodyInset, padToSide, attach, detach, marginsFor, pushIndent, popIndent, indentDepth };
}

// Rückfall für Aufrufer ohne Render-Kontext (Block-Renderer direkt im Test):
// eine Geometrie ohne Spiegelung, deren Basisränder die der aktuellen Seite
// sind. Eine pro Dokument, damit verschachtelte Einzüge denselben Stapel teilen.
const _fallbacks = new WeakMap();
function flowGeometry(doc, ctx) {
  if (ctx && ctx.geo) return ctx.geo;
  let g = _fallbacks.get(doc);
  if (!g) {
    g = createPageGeometry(doc, {
      layout: {}, margins: { ...doc.page.margins }, bleedPt: 0, mirror: false,
      frontMatterAllowed: false, blankPageIdxs: new Set(),
    });
    g.attach();
    _fallbacks.set(doc, g);
  }
  return g;
}

module.exports = { createPageGeometry, flowGeometry };
