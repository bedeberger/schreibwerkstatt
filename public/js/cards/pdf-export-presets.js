// Druck-Presets für den Custom-PDF-Export: Trim-Formate, Papiertypen (Rücken-
// breite) und die Amazon-KDP-Vorgaben inkl. Bundsteg-Prüfung. Reine Daten +
// pure Funktionen über ein `config`-Objekt (keine Alpine-/`this`-Bindung) —
// dadurch ohne Browser testbar. Die Card-Methoden sind dünne Wrapper hierüber.

// Druckerei-Trim-Presets (mm). Setzen pageSize='custom' + Masse. Decken die
// gängigen Buchformate ab, die A4/A5/A6/Letter nicht abbilden.
export const TRIM_PRESETS = [
  { value: '125x200', w: 125, h: 200 },
  { value: '135x215', w: 135, h: 215 },
  { value: '155x230', w: 155, h: 230 },
  { value: '170x240', w: 170, h: 240 },
  // Amazon-KDP-Trims (in Zoll definiert, mm gerundet). `label` überschreibt das
  // berechnete cm-Label, weil KDP-Formate nach ihrer Zoll-Bezeichnung bekannt sind.
  { value: 'kdp-5.06x7.81', w: 128.5,  h: 198.4, label: 'KDP 5.06 × 7.81″ (12.85 × 19.84 cm)' },
  { value: 'kdp-5x8',       w: 127,    h: 203.2, label: 'KDP 5 × 8″ (12.7 × 20.32 cm)' },
  { value: 'kdp-5.25x8',    w: 133.35, h: 203.2, label: 'KDP 5.25 × 8″ (13.34 × 20.32 cm)' },
  { value: 'kdp-5.5x8.5',   w: 139.7,  h: 215.9, label: 'KDP 5.5 × 8.5″ (13.97 × 21.59 cm)' },
  { value: 'kdp-6x9',       w: 152.4,  h: 228.6, label: 'KDP 6 × 9″ (15.24 × 22.86 cm)' },
  { value: 'kdp-6.14x9.21', w: 156,    h: 234,   label: 'KDP 6.14 × 9.21″ (15.6 × 23.4 cm)' },
  { value: 'kdp-7x10',      w: 177.8,  h: 254,   label: 'KDP 7 × 10″ (17.78 × 25.4 cm)' },
  { value: 'kdp-8.5x11',    w: 215.9,  h: 279.4, label: 'KDP 8.5 × 11″ (21.59 × 27.94 cm)' },
];

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

// KDP-Mindest-Bundsteg (innen) in mm, abhängig von der Seitenzahl (KDP-Tabelle,
// Zoll → mm gerundet). Aussenränder-Minimum ist konstant 6.35 mm (0.25″).
export const KDP_OUTER_MIN_MM = 6.35;
export function kdpMinGutterMm(pageCount) {
  if (pageCount <= 150) return 9.53;
  if (pageCount <= 300) return 12.7;
  if (pageCount <= 500) return 15.88;
  if (pageCount <= 600) return 19.05;
  return 22.23;
}

// cm-Label mit '.'-Dezimal (Swiss-konform, locale-unabhängig).
export function trimPresetOptions() {
  return TRIM_PRESETS.map(p => ({
    value: p.value,
    label: p.label || `${p.w / 10} × ${p.h / 10} cm`,
  }));
}
export function applyTrimPreset(cfg, value) {
  const p = TRIM_PRESETS.find(x => x.value === value);
  if (!p) return;
  cfg.layout.pageSize = 'custom';
  cfg.layout.customWidthMm = p.w;
  cfg.layout.customHeightMm = p.h;
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
// Aussenränder auf die KDP-Mindestwerte an (Seitenzahl aus dem Cover-Tab).
export function applyKdpPreset(cfg) {
  cfg.print.cropMarks = false;       // KDP-Innenteil ohne Schnittmarken
  cfg.print.padToEvenPages = true;   // gerade Seitenzahl zwingend
  cfg.extras.barcode = false;        // KDP setzt eigenen Barcode
  cfg.layout.mirrorMargins = true;   // Bundsteg (innen = marginsMm.left)
  const pc = Math.max(0, cfg.coverSpec?.pageCount || 0);
  if (pc) {
    const minG = kdpMinGutterMm(pc);
    if (cfg.layout.marginsMm.left < minG) cfg.layout.marginsMm.left = minG;
  }
  for (const edge of ['right', 'top', 'bottom']) {
    if (cfg.layout.marginsMm[edge] < KDP_OUTER_MIN_MM) cfg.layout.marginsMm[edge] = KDP_OUTER_MIN_MM;
  }
}

// Advisory: prüft die aktuellen Ränder gegen die KDP-Minima. ok===null =
// Hinweis (Seitenzahl fehlt), ok===false = Verstoss, ok===true = konform.
export function kdpMarginWarnings(cfg, t) {
  const pc = Math.max(0, cfg.coverSpec?.pageCount || 0);
  if (!pc) return [{ ok: null, text: t('pdfExport.print.kdpWarnPageCount') }];
  const m = cfg.layout.marginsMm;
  const mirror = !!cfg.layout.mirrorMargins;
  const inner = mirror ? m.left : Math.min(m.left, m.right);
  const minG = kdpMinGutterMm(pc);
  const out = [];
  if (inner + 1e-6 < minG) {
    out.push({ ok: false, text: t('pdfExport.print.kdpWarnGutter', { have: inner, min: minG, pages: pc }) });
  }
  const outers = mirror ? [m.right, m.top, m.bottom] : [m.left, m.right, m.top, m.bottom];
  const minOuter = Math.min(...outers);
  if (minOuter + 1e-6 < KDP_OUTER_MIN_MM) {
    out.push({ ok: false, text: t('pdfExport.print.kdpWarnOuter', { have: minOuter, min: KDP_OUTER_MIN_MM }) });
  }
  // KDP-Innenteil darf keine Druckermarken tragen — Schnittmarken sind ein
  // Upload-Verhinderer, auch wenn die Ränder passen.
  if (cfg.print?.cropMarks) {
    out.push({ ok: false, text: t('pdfExport.print.kdpWarnCropMarks') });
  }
  if (!out.length) out.push({ ok: true, text: t('pdfExport.print.kdpOk', { pages: pc }) });
  return out;
}
