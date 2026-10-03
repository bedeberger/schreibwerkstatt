// Druck-Presets für den Custom-PDF-Export: Trim-Formate, Papiertypen (Rücken-
// breite) und die Amazon-KDP-Vorgaben inkl. Bundsteg-Prüfung. Reine Daten +
// pure Funktionen über ein `config`-Objekt (keine Alpine-/`this`-Bindung) —
// dadurch ohne Browser testbar. Die Card-Methoden sind dünne Wrapper hierüber.

// Druckerei-Trim-Presets (mm). Setzen pageSize='custom' + Masse. Decken die
// gängigen Buchformate ab, die A4/A5/A6/Letter nicht abbilden. `group` ordnet
// sie in der Combobox nach Dienst (i18n `pdfExport.layout.trimGroup.<group>`).
// `m` (optional) = zum Format passende Ränder (left = Bund, right = aussen —
// mirrorMargins tauscht sie auf Verso). Ohne `m` bleiben die Ränder des
// Profils stehen.
const _M_SMALL  = { top: 15, right: 13, bottom: 20, left: 18 };  // bis ~13.5 cm Breite
const _M_MEDIUM = { top: 20, right: 16, bottom: 25, left: 20 };  // bis ~17 cm
const _M_LARGE  = { top: 25, right: 18, bottom: 30, left: 22 };  // ab ~19 cm
export const TRIM_PRESETS = [
  { value: '125x200', w: 125, h: 200, group: 'generic' },
  { value: '135x215', w: 135, h: 215, group: 'generic' },
  { value: '155x230', w: 155, h: 230, group: 'generic' },
  { value: '170x240', w: 170, h: 240, group: 'generic' },
  // Amazon-KDP-Trims (in Zoll definiert, mm gerundet). `label` überschreibt das
  // berechnete cm-Label, weil KDP-Formate nach ihrer Zoll-Bezeichnung bekannt sind.
  { value: 'kdp-5.06x7.81', w: 128.5,  h: 198.4, group: 'kdp', label: 'KDP 5.06 × 7.81″ (12.85 × 19.84 cm)' },
  { value: 'kdp-5x8',       w: 127,    h: 203.2, group: 'kdp', label: 'KDP 5 × 8″ (12.7 × 20.32 cm)' },
  { value: 'kdp-5.25x8',    w: 133.35, h: 203.2, group: 'kdp', label: 'KDP 5.25 × 8″ (13.34 × 20.32 cm)' },
  { value: 'kdp-5.5x8.5',   w: 139.7,  h: 215.9, group: 'kdp', label: 'KDP 5.5 × 8.5″ (13.97 × 21.59 cm)' },
  { value: 'kdp-6x9',       w: 152.4,  h: 228.6, group: 'kdp', label: 'KDP 6 × 9″ (15.24 × 22.86 cm)' },
  { value: 'kdp-6.14x9.21', w: 156,    h: 234,   group: 'kdp', label: 'KDP 6.14 × 9.21″ (15.6 × 23.4 cm)' },
  { value: 'kdp-7x10',      w: 177.8,  h: 254,   group: 'kdp', label: 'KDP 7 × 10″ (17.78 × 25.4 cm)' },
  { value: 'kdp-8.5x11',    w: 215.9,  h: 279.4, group: 'kdp', label: 'KDP 8.5 × 11″ (21.59 × 27.94 cm)' },
  // Books on Demand (BoD).
  { value: 'bod-120x190', w: 120, h: 190, group: 'bod', m: _M_SMALL },
  { value: 'bod-135x215', w: 135, h: 215, group: 'bod', m: _M_SMALL },
  { value: 'bod-148x210', w: 148, h: 210, group: 'bod', m: _M_MEDIUM, label: '14.8 × 21 cm (A5)' },
  { value: 'bod-155x220', w: 155, h: 220, group: 'bod', m: _M_MEDIUM },
  { value: 'bod-170x220', w: 170, h: 220, group: 'bod', m: _M_MEDIUM },
  { value: 'bod-190x270', w: 190, h: 270, group: 'bod', m: _M_LARGE },
  { value: 'bod-210x297', w: 210, h: 297, group: 'bod', m: _M_LARGE, label: '21 × 29.7 cm (A4)' },
  // epubli.
  { value: 'epubli-120x190', w: 120, h: 190, group: 'epubli', m: _M_SMALL },
  { value: 'epubli-135x215', w: 135, h: 215, group: 'epubli', m: _M_SMALL },
  { value: 'epubli-148x210', w: 148, h: 210, group: 'epubli', m: _M_MEDIUM, label: '14.8 × 21 cm (A5)' },
  { value: 'epubli-170x220', w: 170, h: 220, group: 'epubli', m: _M_MEDIUM },
  { value: 'epubli-210x297', w: 210, h: 297, group: 'epubli', m: _M_LARGE, label: '21 × 29.7 cm (A4)' },
  // tredition.
  { value: 'tredition-120x190', w: 120, h: 190, group: 'tredition', m: _M_SMALL },
  { value: 'tredition-135x215', w: 135, h: 215, group: 'tredition', m: _M_SMALL },
  { value: 'tredition-155x220', w: 155, h: 220, group: 'tredition', m: _M_MEDIUM },
  { value: 'tredition-170x220', w: 170, h: 220, group: 'tredition', m: _M_MEDIUM },
  { value: 'tredition-210x297', w: 210, h: 297, group: 'tredition', m: _M_LARGE, label: '21 × 29.7 cm (A4)' },
  // IngramSpark (US-Trims in Zoll).
  { value: 'ingram-5x8',     w: 127,    h: 203.2, group: 'ingram', m: _M_SMALL,  label: '5 × 8″ (12.7 × 20.32 cm)' },
  { value: 'ingram-5.25x8',  w: 133.35, h: 203.2, group: 'ingram', m: _M_SMALL,  label: '5.25 × 8″ (13.34 × 20.32 cm)' },
  { value: 'ingram-5.5x8.5', w: 139.7,  h: 215.9, group: 'ingram', m: _M_MEDIUM, label: '5.5 × 8.5″ (13.97 × 21.59 cm)' },
  { value: 'ingram-6x9',     w: 152.4,  h: 228.6, group: 'ingram', m: _M_MEDIUM, label: '6 × 9″ (15.24 × 22.86 cm)' },
];
export const TRIM_GROUPS = ['generic', 'kdp', 'bod', 'epubli', 'tredition', 'ingram'];

// Endformate der benannten Seitengrössen (mm) — Spiegel von
// lib/pdf-export-defaults/geometry.js#PAGE_DIMS_MM (Drift-Test dort).
const NAMED_DIMS_MM = { A4: [210, 297], A5: [148, 210], A6: [105, 148], Letter: [215.9, 279.4] };
const TRIM_TOL_MM = 0.3;

// Papiertyp-Vorlagen für die Rückenbreite. `bulk` = mm Rückenstärke je 1000
// Innenseiten (= coverSpec.paperBulkMmPer1000). Die KDP-Werte stammen aus deren
// offiziellen Papier-Kennwerten (Seiten pro Zoll umgerechnet); die restlichen
// sind Richtwerte für gängiges Buchpapier — im Zweifel das Papierdatenblatt der
// Druckerei nutzen. `labelKey` → i18n.
export const PAPER_PRESETS = [
  { value: 'kdp-white',      bulk: 57.2, labelKey: 'pdfExport.cover.paper.kdpWhite' },
  { value: 'kdp-cream',      bulk: 63.5, labelKey: 'pdfExport.cover.paper.kdpCream' },
  { value: 'kdp-color-std',  bulk: 59.6, labelKey: 'pdfExport.cover.paper.kdpColorStd' },
  { value: 'kdp-color-prem', bulk: 66.0, labelKey: 'pdfExport.cover.paper.kdpColorPrem' },
  { value: 'offset-80',      bulk: 60.0, labelKey: 'pdfExport.cover.paper.offset80' },
  { value: 'bulk-90',        bulk: 81.0, labelKey: 'pdfExport.cover.paper.bulk90' },
];

// KDP-Mindest-Bundsteg (innen) in mm, abhängig von der Seitenzahl (KDP-Tabelle
// „Margins": 24–150 S. 0.375″, 151–300 0.5″, 301–500 0.625″, 501–700 0.75″,
// 701–828 0.875″; Zoll → mm gerundet). Aussenrand-Minimum: 0.25″ ohne
// Beschnitt, 0.375″ mit Beschnitt (KDP misst dann ab der Anschnittkante).
export const KDP_OUTER_MIN_MM = 6.35;
export const KDP_OUTER_MIN_BLEED_MM = 9.53;
export function kdpMinGutterMm(pageCount) {
  if (pageCount <= 150) return 9.53;
  if (pageCount <= 300) return 12.7;
  if (pageCount <= 500) return 15.88;
  if (pageCount <= 700) return 19.05;
  return 22.23;
}
export function kdpOuterMinMm(cfg) {
  return (cfg?.print?.bleedMm || 0) > 0 ? KDP_OUTER_MIN_BLEED_MM : KDP_OUTER_MIN_MM;
}

// cm-Label mit '.'-Dezimal (Swiss-konform, locale-unabhängig). `t` (optional)
// liefert die Gruppen-Überschrift der Combobox (opt.group).
export function trimPresetOptions(t) {
  return TRIM_PRESETS.map(p => ({
    value: p.value,
    label: p.label || `${p.w / 10} × ${p.h / 10} cm`,
    ...(t ? { group: t('pdfExport.layout.trimGroup.' + p.group) } : {}),
  }));
}
export function applyTrimPreset(cfg, value) {
  const p = TRIM_PRESETS.find(x => x.value === value);
  if (!p) return;
  cfg.layout.pageSize = 'custom';
  cfg.layout.customWidthMm = p.w;
  cfg.layout.customHeightMm = p.h;
  if (p.m) cfg.layout.marginsMm = { ...cfg.layout.marginsMm, ...p.m };
}

// Welches Preset beschreibt das aktuelle Endformat? Spiegelt die Combobox auf
// den echten Zustand (auch nach Profilwechsel, Vorlage oder Handeingabe der
// Masse). `preferred` = zuletzt gewählter Wert: mehrere Dienste teilen sich
// dasselbe Format (12 × 19 cm bei BoD, epubli, tredition), der gewählte Dienst
// soll stehen bleiben, solange er noch passt. Kein Treffer → 'custom'.
export function matchTrimPreset(cfg, preferred = '') {
  const lay = cfg?.layout;
  if (!lay) return '';
  const [w, h] = lay.pageSize === 'custom'
    ? [Number(lay.customWidthMm) || 0, Number(lay.customHeightMm) || 0]
    : (NAMED_DIMS_MM[lay.pageSize] || NAMED_DIMS_MM.A4);
  const fits = (p) => Math.abs(p.w - w) <= TRIM_TOL_MM && Math.abs(p.h - h) <= TRIM_TOL_MM;
  const pref = TRIM_PRESETS.find(p => p.value === preferred);
  if (pref && fits(pref)) return pref.value;
  return TRIM_PRESETS.find(fits)?.value || 'custom';
}

export function paperPresetOptions(t) {
  return PAPER_PRESETS.map(p => ({ value: p.value, label: t(p.labelKey) }));
}
export function applyPaperPreset(cfg, value) {
  const p = PAPER_PRESETS.find(x => x.value === value);
  if (!p) return;
  cfg.coverSpec.paperBulkMmPer1000 = p.bulk;
}

// Setzt die bindungs-/druckrelevanten Flags für Amazon KDP und hebt Bund-/
// Aussenränder auf die KDP-Mindestwerte an. Seitenzahl aus dem Cover-Tab (nach
// einem Ganzbuch-Export echt), sonst `estimatedPages` (vor dem ersten Export
// aus der Zeichenzahl geschätzt, pdf-export-geometry.js#estimatePageCount).
export function applyKdpPreset(cfg, estimatedPages = 0) {
  cfg.print.cropMarks = false;       // KDP-Innenteil ohne Schnittmarken
  cfg.print.padToEvenPages = true;   // gerade Seitenzahl zwingend
  cfg.extras.barcode = false;        // KDP setzt eigenen Barcode
  cfg.layout.mirrorMargins = true;   // Bundsteg (innen = marginsMm.left)
  const pc = Math.max(0, cfg.coverSpec?.pageCount || 0) || Math.max(0, estimatedPages || 0);
  if (pc) {
    const minG = kdpMinGutterMm(pc);
    if (cfg.layout.marginsMm.left < minG) cfg.layout.marginsMm.left = minG;
  }
  const minOuter = kdpOuterMinMm(cfg);
  for (const edge of ['right', 'top', 'bottom']) {
    if (cfg.layout.marginsMm[edge] < minOuter) cfg.layout.marginsMm[edge] = minOuter;
  }
}

// Advisory: prüft die aktuellen Ränder gegen die KDP-Minima. ok===null =
// Hinweis (Seitenzahl fehlt), ok===false = Verstoss, ok===true = konform.
// Ohne echte Seitenzahl (coverSpec.pageCount, erst nach einem Ganzbuch-Export)
// prüft sie gegen `estimatedPages` und kennzeichnet das als Schätzung.
export function kdpMarginWarnings(cfg, t, estimatedPages = 0) {
  const real = Math.max(0, cfg.coverSpec?.pageCount || 0);
  const est = Math.max(0, Math.round(estimatedPages || 0));
  const pc = real || est;
  if (!pc) return [{ ok: null, text: t('pdfExport.print.kdpWarnPageCount') }];
  const pages = real ? pc : t('pdfExport.print.pagesEstimated', { n: pc });
  const m = cfg.layout.marginsMm;
  const mirror = !!cfg.layout.mirrorMargins;
  const inner = mirror ? m.left : Math.min(m.left, m.right);
  const minG = kdpMinGutterMm(pc);
  const out = [];
  if (inner + 1e-6 < minG) {
    out.push({ ok: false, text: t('pdfExport.print.kdpWarnGutter', { have: inner, min: minG, pages }) });
  }
  const outers = mirror ? [m.right, m.top, m.bottom] : [m.left, m.right, m.top, m.bottom];
  const minOuter = Math.min(...outers);
  const needOuter = kdpOuterMinMm(cfg);
  if (minOuter + 1e-6 < needOuter) {
    out.push({ ok: false, text: t('pdfExport.print.kdpWarnOuter', { have: minOuter, min: needOuter }) });
  }
  // KDP-Innenteil darf keine Druckermarken tragen — Schnittmarken sind ein
  // Upload-Verhinderer, auch wenn die Ränder passen.
  if (cfg.print?.cropMarks) {
    out.push({ ok: false, text: t('pdfExport.print.kdpWarnCropMarks') });
  }
  if (!out.length) out.push({ ok: true, text: t('pdfExport.print.kdpOk', { pages }) });
  if (!real) out.push({ ok: null, text: t('pdfExport.print.kdpEstimateHint') });
  return out;
}
