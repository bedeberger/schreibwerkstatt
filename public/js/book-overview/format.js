import { EVT } from '../events.js';
import { charsToNormseiten } from '../utils.js';
// Format-Helper + Tile-Click-Handler (Cross-Card-Routings).
export const formatMethods = {
  // Zeichen → lokalisierte Normseiten-Zahl (1 Dezimale). Kapselt die
  // CHARS_PER_NORMSEITE-Umrechnung, damit die Formel nicht in jedem Tile
  // inline dupliziert wird.
  _fmtNormseiten(chars) {
    const tag = Alpine.store('shell').uiLocale === 'en' ? 'en-US' : 'de-CH';
    return charsToNormseiten(chars).toLocaleString(tag, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  },

  // Fehler-Typ-Label: i18n-Key versuchen; Fallback humanisiert.
  overviewFehlerLabel(typ) {
    const key = 'fehlerHeatmap.typ.' + typ;
    const app = window.__app;
    const translated = app?.t ? app.t(key) : null;
    if (translated && translated !== key) return translated;
    const s = String(typ || '').replace(/_/g, ' ').replace(/\bvs\b/, 'vs.');
    return s.charAt(0).toUpperCase() + s.slice(1);
  },

  // Initialen für Avatar-Chip: erste Buchstaben aus Vor-/Nachname.
  overviewInitials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  },

  _fmtNum(n) {
    const tag = Alpine.store('shell').uiLocale === 'en' ? 'en-US' : 'de-CH';
    return Number(n || 0).toLocaleString(tag);
  },

  // ── Tile-Click-Handler ───────────────────────────────────────────────────
  _openLengthStats(range = 30, metric = 'chars') {
    window.dispatchEvent(new CustomEvent(EVT.BOOK_STATS_SELECT, { detail: { metric, range } }));
    window.__app?.toggleBookStatsCard?.();
  },

  _openKapitelReview(chapterId) {
    const app = window.__app;
    if (!app) return;
    app.kapitelReviewChapterId = String(chapterId);
    if (!app.showKapitelReviewCard) app.toggleKapitelReviewCard();
  },
};
