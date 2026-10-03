// Befunde eines PDF-Exports als Liste — statt eines einzelnen 8-s-Toasts, der
// nur den ersten Befund zeigte und verschwand, bevor man ihn lesen konnte.
//
// Eingang ist das Job-Result von /jobs/pdf-export (routes/jobs/pdf-export.js):
// `renderWarnings` (Renderer-Befunde) plus die Norm-Felder `pdfa`/`pdfx` und die
// älteren Top-Level-Felder (`lowResImages`, `hyphenationDisabled`,
// `coverInInterior`), die ältere Server-Stände noch allein liefern. Jede Form
// wird toleriert (Zahl ODER Array, Bool ODER Familienliste), damit Server und
// Client nicht im Gleichschritt deployt werden müssen.
//
// Reine Funktion, keine Alpine-Bindung. Texte kommen ausschliesslich über `t`
// und werden im Partial per x-text gerendert (kein x-html-Sink).

const _count = (v) => (Array.isArray(v) ? v.length : (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0));

/** @returns {{ id: string, level: 'warn'|'info', text: string }[]} */
export function buildRenderWarnings(result, t) {
  const r = result || {};
  const rw = r.renderWarnings || {};
  const out = [];
  const push = (id, level, key, params) => out.push({ id, level, text: t(key, params) });

  // ── Norm ───────────────────────────────────────────────────────────────
  if (r.pdfa?.requested) {
    if (!r.pdfa.validatorAvailable) push('pdfaNoValidator', 'info', 'pdfExport.warn.pdfaNoValidator');
    else if (r.pdfa.passed === false) push('pdfaFailed', 'warn', 'pdfExport.warn.pdfaFailed');
  }
  if (r.pdfx?.requested && !r.pdfx.applied) push('pdfxNotApplied', 'warn', 'pdfExport.warn.pdfxNotApplied');

  // ── Satz ───────────────────────────────────────────────────────────────
  // Silbentrennung: neue Form Bool, alte Form Familienliste (Top-Level).
  const hyphFams = Array.isArray(r.hyphenationDisabled) ? r.hyphenationDisabled
    : (Array.isArray(rw.hyphenationDisabled) ? rw.hyphenationDisabled : []);
  if (hyphFams.length) push('hyphenation', 'warn', 'pdfExport.warn.hyphenationFonts', { fonts: hyphFams.join(', ') });
  else if (rw.hyphenationDisabled === true) push('hyphenation', 'warn', 'pdfExport.warn.hyphenation');

  const fallbacks = Array.isArray(rw.fontFallbacks) ? rw.fontFallbacks : [];
  for (const [i, f] of fallbacks.entries()) {
    push('fontFallback' + i, 'warn', 'pdfExport.warn.fontFallback', {
      role: f?.role ? t('pdfExport.font.' + f.role) : '?',
      requested: f?.requested || '?',
      used: f?.used || '?',
    });
  }

  if (rw.footnoteFallback) push('footnoteFallback', 'warn', 'pdfExport.warn.footnoteFallback');
  const fnOver = _count(rw.footnoteOverflowPages);
  if (fnOver) push('footnoteOverflow', 'warn', 'pdfExport.warn.footnoteOverflow', { count: fnOver });

  const xref = _count(rw.xrefUnresolved);
  if (xref) push('xrefUnresolved', 'warn', 'pdfExport.warn.xrefUnresolved', { count: xref });

  // ── Bilder ─────────────────────────────────────────────────────────────
  const lowRes = rw.dpiWarnings != null ? _count(rw.dpiWarnings) : _count(r.lowResImages);
  if (lowRes) {
    push('lowRes', 'warn', 'pdfExport.warn.lowRes', { count: lowRes, dpi: r.dpiThreshold || 300 });
  }
  const oversize = _count(rw.oversizeImages);
  if (oversize) push('oversizeImages', 'info', 'pdfExport.warn.oversizeImages', { count: oversize });

  // ── Druck ──────────────────────────────────────────────────────────────
  if (r.coverInInterior) push('coverInInterior', 'info', 'pdfExport.warn.coverInInterior');

  return out;
}
