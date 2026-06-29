// Fehler-Heatmap: aggregiert Fehlertypen × Kapitel aus jüngstem page_check pro Seite.
// Daten kommen live aus /history/fehler-heatmap/:book_id — kein KI-Call, keine Sync-Phase.
// Methoden werden in Alpine.data('fehlerHeatmapCard') gespreadet; Root-Zugriffe via window.__app.

import { fetchJson, formatNumber, heatmapCellVars, minMaxBy } from '../utils.js';

// Cluster-Gruppierung der Typen-Spalten. Reihenfolge in den Cluster-Arrays = Spalten-Reihenfolge.
// Muss mit VALID_TYPEN in routes/jobs/lektorat.js kompatibel sein.
const FEHLER_CLUSTERS = [
  { key: 'sprache',    typen: ['rechtschreibung', 'grammatik', 'dialogformat'] },
  { key: 'wort',       typen: ['wiederholung', 'schwaches_verb', 'fuellwort', 'filterwort'] },
  { key: 'stil',       typen: ['stil', 'satzbau', 'pleonasmus', 'klischee', 'ki_geruch', 'passiv'] },
  { key: 'erzaehlung', typen: ['show_vs_tell', 'perspektivbruch', 'tempuswechsel'] },
  { key: 'welt',       typen: ['namenskonsistenz', 'figurenmerkmal', 'schauplatzmerkmal', 'anrede'] },
];
const FEHLER_TYPEN = FEHLER_CLUSTERS.flatMap(c => c.typen);

const MODES = ['open', 'applied', 'all'];

export const fehlerHeatmapMethods = {
  get fehlerHeatmapTypen() { return FEHLER_TYPEN; },
  get fehlerHeatmapClusters() { return FEHLER_CLUSTERS; },
  // Spalten-Indizes der jeweils ersten Spalte eines Clusters (für Trennlinien).
  // Erstes Cluster startet bei 0 – wird ignoriert (keine Trennlinie ganz links).
  get fehlerHeatmapClusterStarts() {
    const starts = [];
    let cursor = 0;
    for (const c of FEHLER_CLUSTERS) { starts.push(cursor); cursor += c.typen.length; }
    return starts.slice(1);
  },

  async loadFehlerHeatmap() {
    if (!Alpine.store('nav').selectedBookId) return;
    this.fehlerHeatmapLoading = true;
    this.fehlerHeatmapStatus = '';
    try {
      const mode = MODES.includes(this.fehlerHeatmapMode) ? this.fehlerHeatmapMode : 'open';
      const data = await fetchJson(`/history/fehler-heatmap/${Alpine.store('nav').selectedBookId}?mode=${mode}`);
      this.fehlerHeatmapData = data;
    } catch (e) {
      console.error('[loadFehlerHeatmap]', e);
      this.fehlerHeatmapStatus = window.__app.t('common.errorColon') + (e.message || '');
    } finally {
      this.fehlerHeatmapLoading = false;
    }
  },

  async setFehlerHeatmapMode(mode) {
    if (!MODES.includes(mode)) return;
    if (this.fehlerHeatmapMode === mode) return;
    this.fehlerHeatmapMode = mode;
    this.activeFehlerDetailKey = null;
    await this.loadFehlerHeatmap();
  },

  fehlerHeatmapChapterKey(ch) {
    return ch.chapter_id == null ? '__uncat__' : String(ch.chapter_id);
  },

  fehlerHeatmapChapterName(ch) {
    return ch.chapter_name || window.__app.t('fehlerHeatmap.unassigned');
  },

  fehlerHeatmapCoveragePct(ch) {
    if (!ch.pages_total) return 0;
    return Math.round((ch.pages_checked / ch.pages_total) * 100);
  },

  fehlerHeatmapCellValue(chapterKey, typ) {
    const cell = this.fehlerHeatmapData?.matrix?.[chapterKey]?.[typ];
    return cell ? cell.count : null;
  },

  fehlerHeatmapCellCount(chapterKey, typ) {
    const cell = this.fehlerHeatmapData?.matrix?.[chapterKey]?.[typ];
    return cell ? cell.count : 0;
  },

  // Skala pro Typ über alle Kapitel. Rot = hoch, Grün = niedrig.
  fehlerHeatmapRange(typ) {
    const chapters = this.fehlerHeatmapData?.chapters || [];
    return minMaxBy(chapters, (ch) => {
      const key = this.fehlerHeatmapChapterKey(ch);
      return this.fehlerHeatmapData?.matrix?.[key]?.[typ]?.count;
    });
  },

  // Welche Zell-Variante (→ CSS-Klasse) und welche CSS-Variablen. Split,
  // damit Alpine das :class separat vom :style binden kann und keine
  // Inline-Style-Strings ins DOM landen.
  fehlerHeatmapCellKind(chapterKey, typ, coveragePct) {
    const value = this.fehlerHeatmapCellValue(chapterKey, typ);
    if (value == null) return coveragePct === 0 ? 'empty' : 'neutral';
    const { min, max } = this.fehlerHeatmapRange(typ);
    if (max === min) return coveragePct < 100 ? 'faded' : 'neutral';
    return 'tinted';
  },

  fehlerHeatmapCellVars(chapterKey, typ, coveragePct) {
    const value = this.fehlerHeatmapCellValue(chapterKey, typ);
    if (value == null) return {};
    const opacity = coveragePct < 100 ? (0.5 + (coveragePct / 200)) : 1;
    const { min, max } = this.fehlerHeatmapRange(typ);
    if (max === min) return coveragePct < 100 ? { '--heatmap-opacity': String(opacity) } : {};
    const t = (value - min) / (max - min);
    return heatmapCellVars(t, opacity);
  },

  fehlerHeatmapCellTooltip(chapterKey, typ) {
    const cell = this.fehlerHeatmapData?.matrix?.[chapterKey]?.[typ];
    if (!cell || !cell.count) return '';
    return window.__app.t('fehlerHeatmap.cellTooltip', {
      count: cell.count,
      pages: cell.pages,
      per1k: formatNumber(cell.per1k, Alpine.store('shell').uiLocale, 1),
    });
  },

  fehlerHeatmapCellLabel(chapterKey, typ) {
    const cell = this.fehlerHeatmapData?.matrix?.[chapterKey]?.[typ];
    if (!cell || !cell.count) return '–';
    return formatNumber(cell.count, Alpine.store('shell').uiLocale, 0);
  },

  toggleFehlerHeatmapDetail(chapterKey, typ) {
    const key = `${chapterKey}:${typ}`;
    const cell = this.fehlerHeatmapData?.matrix?.[chapterKey]?.[typ];
    if (!cell || !cell.count) return;
    this.activeFehlerDetailKey = (this.activeFehlerDetailKey === key) ? null : key;
  },

  fehlerHeatmapActiveDetail() {
    const key = this.activeFehlerDetailKey;
    if (!key) return null;
    const [chapterKey, typ] = key.split(':');
    const pages = this.fehlerHeatmapData?.details?.[key] || [];
    const chapter = (this.fehlerHeatmapData?.chapters || []).find(c => this.fehlerHeatmapChapterKey(c) === chapterKey);
    return {
      key,
      chapterKey,
      typ,
      chapterName: chapter ? this.fehlerHeatmapChapterName(chapter) : '',
      pages,
    };
  },

  fehlerHeatmapTotal(typ) {
    return this.fehlerHeatmapData?.totals?.[typ] || 0;
  },

  async fehlerHeatmapJumpToPage(pageId) {
    const page = (Alpine.store('nav').pages || []).find(p => p.id === pageId);
    if (!page) return;
    window.__app.showFehlerHeatmapCard = false;
    this.activeFehlerDetailKey = null;
    await window.__app.selectPage(page);
    // Jüngsten Lektorat-Eintrag öffnen, damit die Findings direkt sichtbar sind.
    // Wenn gerade ein Check-Job läuft, ist pageHistory evtl. leer – dann nichts tun.
    const latest = (window.__app.pageHistory || [])[0];
    if (latest && window.__app.activeHistoryEntryId !== latest.id) {
      await window.__app.loadHistoryEntry(latest);
    }
  },

  async fehlerHeatmapJumpToChapter(ch) {
    if (!ch || ch.chapter_id == null) return;
    const root = window.__app;
    const chapterId = ch.chapter_id;
    const opts = root.kapitelReviewChapterOptions ? root.kapitelReviewChapterOptions() : [];
    this.activeFehlerDetailKey = null;
    if (opts.some(c => String(c.id) === String(chapterId))) {
      root.showFehlerHeatmapCard = false;
      await root.openKapitelReviewForChapter(chapterId);
      return;
    }
    const chapterNode = (Alpine.store('nav').tree || []).find(i => i.type === 'chapter' && String(i.id) === String(chapterId));
    const firstPage = chapterNode?.pages?.[0];
    if (firstPage) {
      root.showFehlerHeatmapCard = false;
      await root.selectPage(firstPage);
    }
  },
};
