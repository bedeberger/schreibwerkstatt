// Satzspiegel-Geometrie für die PDF-Export-Karte: Warnungen vor dem Speichern,
// Seitenzahl-Schätzung vor dem ersten Export und die Koordinaten der
// Satzspiegel-Vorschau (Doppelseite). Reine Funktionen über ein `config`-Objekt,
// keine Alpine-/`this`-Bindung — wie pdf-export-presets.js, ohne Browser testbar.
//
// Die Masse spiegeln lib/pdf-export-defaults/geometry.js (Server-Seite, die
// beim Speichern dieselben Grenzen erzwingt) — Drift-Test in
// tests/unit/pdf-export-defaults.test.js.

export const PAGE_DIMS_MM = {
  A4:     [210, 297],
  A5:     [148, 210],
  A6:     [105, 148],
  Letter: [215.9, 279.4],
};
export const MIN_TEXT_WIDTH_MM  = 30;
export const MIN_TEXT_HEIGHT_MM = 40;
export const HEADING_LEVELS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

const PT_PER_MM = 72 / 25.4;
const MM_PER_PT = 25.4 / 72;

export function pageDimsMm(layout) {
  if (layout?.pageSize === 'custom') return [Number(layout.customWidthMm) || 0, Number(layout.customHeightMm) || 0];
  return PAGE_DIMS_MM[layout?.pageSize] || PAGE_DIMS_MM.A4;
}

const _n = (v) => Number(v) || 0;

/** Netto-Satzspiegel (mm) nach Rändern und Body-Inset. */
export function textBlockMm(layout) {
  const [w, h] = pageDimsMm(layout);
  const m = layout?.marginsMm || {};
  const i = layout?.bodyInsetMm || {};
  return {
    width:  w - _n(m.left) - _n(m.right) - _n(i.left) - _n(i.right),
    height: h - _n(m.top) - _n(m.bottom) - _n(i.top) - _n(i.bottom),
  };
}

/** Satzspiegel unter dem Mindestmass? Der Server kürzt die Ränder beim
 *  Speichern proportional — die Warnung sagt das vorher. */
export function geometryWarnings(cfg, t) {
  const lay = cfg?.layout;
  if (!lay) return [];
  const tb = textBlockMm(lay);
  const out = [];
  if (tb.width < MIN_TEXT_WIDTH_MM) {
    out.push(t('pdfExport.layout.warnTextWidth', { have: Math.round(tb.width * 10) / 10, min: MIN_TEXT_WIDTH_MM }));
  }
  if (tb.height < MIN_TEXT_HEIGHT_MM) {
    out.push(t('pdfExport.layout.warnTextHeight', { have: Math.round(tb.height * 10) / 10, min: MIN_TEXT_HEIGHT_MM }));
  }
  return out;
}

/** Verstösse gegen die absteigende Überschriften-Kette h1 ≥ … ≥ h6 ≥ body.
 *  Liefert Paare { upper, lower } (lower ist grösser als upper). */
export function headingChainViolations(cfg) {
  const sizes = cfg?.font?.heading?.sizes;
  const body = _n(cfg?.font?.body?.sizePt);
  if (!sizes) return [];
  const out = [];
  for (let i = 1; i < HEADING_LEVELS.length; i++) {
    const up = HEADING_LEVELS[i - 1], lo = HEADING_LEVELS[i];
    if (_n(sizes[lo]) > _n(sizes[up])) out.push({ upper: up, lower: lo });
  }
  if (_n(sizes.h6) < body) out.push({ upper: 'h6', lower: 'body' });
  return out;
}

// Mittlere Zeichenbreite in em. Für Buchschriften in Fliesstext liegt sie bei
// 0.45–0.52; 0.5 trifft die Whitelist im Mittel und ist bewusst eher vorsichtig
// (lieber eine Seite zu viel geschätzt als einen zu schmalen Bundsteg).
const AVG_CHAR_EM = 0.5;
// Füllgrad einer Textseite: Absatzenden, Witwen-/Waisen-Umbrüche, Leerzeilen.
const FILL = 0.9;

/** Zeichen pro Textseite für das aktuelle Layout (Schätzung). */
export function charsPerPage(cfg) {
  const lay = cfg?.layout, body = cfg?.font?.body;
  if (!lay || !body) return 0;
  const tb = textBlockMm(lay);
  if (tb.width <= 0 || tb.height <= 0) return 0;
  const size = Math.max(4, _n(body.sizePt) || 11);
  const lineH = size * Math.max(0.8, _n(body.lineHeight) || 1.4);
  const cols = _n(lay.columns) === 2 ? 2 : 1;
  const usableW = tb.width - (cols === 2 ? _n(lay.columnGapMm) : 0);
  const cpl = (usableW * PT_PER_MM) / (size * AVG_CHAR_EM);
  // Absatzabstand in Zeilen, verteilt auf einen Absatz je ~6 Zeilen.
  const lpp = Math.floor((tb.height * PT_PER_MM) / lineH) / (1 + (_n(body.paragraphGap) / 6));
  return Math.max(0, cpl * lpp * FILL);
}

/** Seitenzahl des ganzen Buchs, geschätzt aus der Zeichenzahl (Sidebar-Σ,
 *  `tokTotals.chars`) und dem Layout — für die KDP-/Druckprüfung, solange kein
 *  Ganzbuch-Export die echte Zahl geliefert hat. `chapters` = Anzahl Kapitel
 *  (Kapitelanfang + Umbruch kosten je Kapitel Platz). 0 = keine Basis. */
export function estimatePageCount(cfg, { chars = 0, chapters = 0 } = {}) {
  const cpp = charsPerPage(cfg);
  if (!(chars > 0) || !(cpp > 0)) return 0;
  const ch = Math.max(0, chapters | 0);
  const tb = textBlockMm(cfg.layout);
  const chap = cfg.chapter || {};
  // Kapitelkopf: Vorschlag + Titelzeile verdrängen Text auf der ersten Seite.
  const headShare = tb.height > 0 ? Math.min(1, (_n(chap.spaceBeforeMm) + 15) / tb.height) : 0;
  // Umbruch vor jedem Kapitel: im Mittel eine halbe Seite Rest; auf Recto
  // zusätzlich eine halbe Leerseite.
  const breakCost = chap.breakBefore === 'none' ? 0 : (chap.breakBefore === 'right-page' ? 1 : 0.5);
  let pages = chars / cpp + ch * (headShare + breakCost + (chap.blankPageAfter ? 1 : 0));
  // Titelei: Titelseite + Impressum, Inhaltsverzeichnis (~30 Einträge je Seite,
  // auf Recto), dazu die Recto-Ausrichtung des ersten Kapitels.
  pages += 2;
  if (cfg.toc?.enabled) pages += 1 + Math.ceil(Math.max(1, ch) / 30);
  if (cfg.cover?.enabled) pages += 1;
  let n = Math.ceil(pages);
  if (cfg.print?.padToEvenPages && n % 2) n += 1;
  return n;
}

// ── Satzspiegel-Vorschau (SVG) ───────────────────────────────────────────────
// Feste viewBox (Literal im Markup — ein gebundenes :viewBox schreibt der
// HTML-Parser klein, SVG ignoriert es): die Geometrie wird hier in diese
// Einheiten skaliert. Drift-Test pinnt die Zahlen gegen das Partial.
export const PREVIEW_VB = { w: 320, h: 200, pad: 10 };

// Kopf-/Fusszeilen-Lage wie lib/pdf-render/chrome.js: Kopf 22 pt über dem
// Satzspiegel, Fuss 10 pt darunter.
const HEADER_OFFSET_MM = 22 * MM_PER_PT;
const FOOTER_OFFSET_MM = 10 * MM_PER_PT;

const _r = (n) => Math.round(n * 100) / 100;

function _hasAny(lay, zone) {
  return ['Left', 'Center', 'Right'].some(p => (lay[zone + p] || '') !== '' || (lay[zone + 'Verso' + p] || '') !== '');
}

/** Koordinaten der Doppelseite (Verso links, Recto rechts) in viewBox-Einheiten. */
export function satzspiegelPreview(cfg) {
  const lay = cfg?.layout;
  if (!lay) return null;
  const [W, H] = pageDimsMm(lay);
  if (!(W > 0 && H > 0)) return null;
  const b = Math.max(0, _n(cfg.print?.bleedMm));
  const { w: vw, h: vh, pad } = PREVIEW_VB;
  const s = Math.min((vw - 2 * pad) / (2 * W + 2 * b), (vh - 2 * pad) / (H + 2 * b));
  const spreadW = 2 * W * s, pageH = H * s;
  const x0 = (vw - spreadW) / 2, y0 = (vh - pageH) / 2;
  const m = lay.marginsMm || {}, ins = lay.bodyInsetMm || {};
  const mirror = !!lay.mirrorMargins;
  const fs = cfg.font || {};
  const hdrH = Math.max(1, _n(fs.header?.sizePt) || 9) * MM_PER_PT;
  const ftrH = Math.max(1, _n(fs.footer?.sizePt) || 9) * MM_PER_PT;
  const cols = _n(lay.columns) === 2;
  const gap = cols ? _n(lay.columnGapMm) : 0;

  const page = (isVerso) => {
    const px = isVerso ? x0 : x0 + W * s;
    // Recto: left = Bund (innen). Verso mit Spiegelung: Bund rechts.
    const left = (isVerso && mirror) ? _n(m.right) : _n(m.left);
    const right = (isVerso && mirror) ? _n(m.left) : _n(m.right);
    const tx = left + _n(ins.left), ty = _n(m.top) + _n(ins.top);
    const tw = W - left - right - _n(ins.left) - _n(ins.right);
    const th = H - _n(m.top) - _n(m.bottom) - _n(ins.top) - _n(ins.bottom);
    const frame = { x: _r(px + left * s), y: _r(y0 + _n(m.top) * s), w: _r(Math.max(0, W - left - right) * s), h: _r(Math.max(0, H - _n(m.top) - _n(m.bottom)) * s) };
    const text = { x: _r(px + tx * s), y: _r(y0 + ty * s), w: _r(Math.max(0, tw) * s), h: _r(Math.max(0, th) * s) };
    return {
      key: isVerso ? 'verso' : 'recto',
      x: _r(px), y: _r(y0), w: _r(W * s), h: _r(pageH),
      frame, text,
      header: { x: frame.x, y: _r(y0 + (_n(m.top) - HEADER_OFFSET_MM - hdrH) * s), w: frame.w, h: _r(hdrH * s) },
      footer: { x: frame.x, y: _r(y0 + (H - _n(m.bottom) + FOOTER_OFFSET_MM) * s), w: frame.w, h: _r(ftrH * s) },
      gap: cols && tw > gap ? { x: _r(text.x + ((tw - gap) / 2) * s), y: text.y, w: _r(gap * s), h: text.h } : null,
    };
  };

  const tb = textBlockMm(lay);
  const body = fs.body || {};
  const size = Math.max(4, _n(body.sizePt) || 11);
  const cpl = tb.width > 0 ? Math.round(((tb.width - gap) / (cols ? 2 : 1)) * PT_PER_MM / (size * AVG_CHAR_EM)) : 0;
  return {
    bleed: b > 0 ? { x: _r(x0 - b * s), y: _r(y0 - b * s), w: _r(spreadW + 2 * b * s), h: _r(pageH + 2 * b * s) } : null,
    pages: [page(true), page(false)],
    fold: { x: _r(x0 + W * s), y1: _r(y0), y2: _r(y0 + pageH) },
    hasHeader: _hasAny(lay, 'header'),
    hasFooter: _hasAny(lay, 'footer'),
    textWidthMm: _r(tb.width),
    textHeightMm: _r(tb.height),
    charsPerLine: Math.max(0, cpl),
  };
}
