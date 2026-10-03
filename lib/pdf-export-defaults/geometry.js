'use strict';
// Satzspiegel-Mindestmass + Ueberschriften-Kette der PDF-Export-Profile.
//
// Beides sind Querbeziehungen zwischen Feldern, die einzeln korrekt geclampt
// sein koennen und zusammen trotzdem kein brauchbares Layout ergeben: vier
// Raender à 80 mm auf einem A6-Blatt lassen eine negative Satzbreite uebrig,
// und ein h3 groesser als h2 dreht die Gliederung um. Der Validator laeuft
// darum nach dem Feld-Clamping noch einmal ueber diese Beziehungen.
//
// Frontend-Pendant (Warnung VOR dem Speichern, gleiche Masse):
// public/js/cards/pdf-export-geometry.js — Drift-Test in
// tests/unit/pdf-export-defaults.test.js.

// Endformate in mm (Breite, Hoehe). Gleiche Werte wie lib/pdf-render/layout.js
// (dort in pt).
const PAGE_DIMS_MM = {
  A4:     [210, 297],
  A5:     [148, 210],
  A6:     [105, 148],
  Letter: [215.9, 279.4],
};

// Kleinster Satzspiegel, den der Renderer noch sinnvoll fuellen kann: 30 mm
// sind gut ein Dutzend Zeichen in 10 pt, 40 mm eine Handvoll Zeilen.
const MIN_TEXT_WIDTH_MM  = 30;
const MIN_TEXT_HEIGHT_MM = 40;
const MARGIN_MIN_MM = 5;

function pageDimsMm(layout) {
  if (layout?.pageSize === 'custom') return [Number(layout.customWidthMm) || 0, Number(layout.customHeightMm) || 0];
  return PAGE_DIMS_MM[layout?.pageSize] || PAGE_DIMS_MM.A4;
}

/** Netto-Satzspiegel (mm) nach Raendern und Body-Inset. */
function textBlockMm(layout) {
  const [w, h] = pageDimsMm(layout);
  const m = layout.marginsMm || {};
  const i = layout.bodyInsetMm || {};
  return {
    width:  w - (m.left || 0) - (m.right || 0) - (i.left || 0) - (i.right || 0),
    height: h - (m.top || 0) - (m.bottom || 0) - (i.top || 0) - (i.bottom || 0),
  };
}

// Eine Achse (horizontal oder vertikal) proportional einkuerzen, bis
// `available` reicht. Raender behalten ihr Minimum von 5 mm; was danach noch
// fehlt, geben die Body-Insets her (Minimum 0).
function _fitAxis(margins, insets, keys, available) {
  const total = keys.reduce((s, k) => s + margins[k] + insets[k], 0);
  if (total <= available + 1e-9) return;
  const f = Math.max(0, available) / total;
  for (const k of keys) {
    margins[k] = Math.max(MARGIN_MIN_MM, margins[k] * f);
    insets[k] = insets[k] * f;
  }
  let over = keys.reduce((s, k) => s + margins[k] + insets[k], 0) - available;
  if (over <= 1e-9) return;
  const insetSum = keys.reduce((s, k) => s + insets[k], 0);
  if (insetSum > 0) {
    const g = Math.max(0, insetSum - over) / insetSum;
    for (const k of keys) insets[k] = insets[k] * g;
  }
}

const _r2 = (n) => Math.round(n * 100) / 100;

/** Raender + Insets so kuerzen, dass der Satzspiegel das Mindestmass haelt.
 *  Mutiert und liefert `layout` (bereits feld-validiert). */
function enforceMinTextBlock(layout) {
  const [w, h] = pageDimsMm(layout);
  const m = { ...layout.marginsMm };
  const i = { ...layout.bodyInsetMm };
  _fitAxis(m, i, ['left', 'right'], w - MIN_TEXT_WIDTH_MM);
  _fitAxis(m, i, ['top', 'bottom'], h - MIN_TEXT_HEIGHT_MM);
  for (const k of ['top', 'right', 'bottom', 'left']) {
    if (m[k] !== layout.marginsMm[k]) layout.marginsMm[k] = _r2(m[k]);
    if (i[k] !== layout.bodyInsetMm[k]) layout.bodyInsetMm[k] = _r2(i[k]);
  }
  return layout;
}

// Obergrenze der Kette: das Feld-Maximum von h1. Steht der Fliesstext darueber
// (body bis 72 pt erlaubt), haelt die Kette bei 60 pt an — ein Fall, in dem
// ohnehin kein Buch mehr entsteht.
const HEADING_CHAIN_CAP = 60;
const HEADING_LEVELS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

/** Ueberschriften-Kette absteigend halten: h1 ≥ h2 ≥ … ≥ h6 ≥ body. Von unten
 *  nach oben angehoben — wer den Fliesstext groesser stellt, will ihn nicht
 *  zurueckgestutzt sehen, sondern die Ueberschriften mitwachsen lassen.
 *  Mutiert und liefert `sizes`. */
function enforceHeadingChain(sizes, bodySizePt) {
  let floor = Math.min(HEADING_CHAIN_CAP, Number(bodySizePt) || 0);
  for (let idx = HEADING_LEVELS.length - 1; idx >= 0; idx--) {
    const k = HEADING_LEVELS[idx];
    if (sizes[k] < floor) sizes[k] = floor;
    floor = Math.min(HEADING_CHAIN_CAP, sizes[k]);
  }
  return sizes;
}

module.exports = {
  PAGE_DIMS_MM, MIN_TEXT_WIDTH_MM, MIN_TEXT_HEIGHT_MM, HEADING_LEVELS,
  pageDimsMm, textBlockMm, enforceMinTextBlock, enforceHeadingChain,
};
