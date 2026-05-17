// Alpine.data('bookStatsCard') — Sub-Komponente der Buchstatistik-Karte.
//
// Chart.js-Instanz + Theme-Observer leben als Modul-State in bookstats.js —
// ein Alpine-Reaktivitäts-Proxy würde die Chart-Instanz beschädigen. destroy()
// räumt beide auf.

import { bookstatsMethods, _destroyStatsChart, _disconnectThemeObserver } from '../book/bookstats.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerBookStatsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookStatsCard', () => ({
    bookStatsData: [],
    bookStatsLoading: false,
    bookStatsSyncStatus: '',
    bookStatsMetric: 'chars',
    bookStatsRange: 0,
    bookStatsCoverage: null,
    bookStatsDelta: null,
    writingTimeData: null,
    lektoratTimeData: null,
    _lifecycle: null,

    init() {
      // Deep-Link aus Overview-Tiles: metric + range vorab setzen, damit der
      // Chart direkt mit dem gewünschten Filter rendert. Daten sind ggf. schon
      // geladen (renderStatsChart() reicht), sonst zieht der showBookStatsCard-
      // Watcher loadBookStats nach.
      const onSelect = (e) => {
        const detail = e.detail || {};
        if (detail.metric) this.bookStatsMetric = detail.metric;
        if (detail.range != null) this.bookStatsRange = detail.range;
        if (this.bookStatsData.length > 0) {
          this.$nextTick(() => this.renderStatsChart());
        }
      };

      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showBookStatsCard',
        load: (root) => this.loadBookStats(root.selectedBookId),
        resetState: {
          bookStatsData: [],
          bookStatsCoverage: null,
          bookStatsDelta: null,
          writingTimeData: null,
          lektoratTimeData: null,
        },
        onViewReset: (e, ctx) => {
          ctx.bookStatsData = [];
          ctx.bookStatsSyncStatus = '';
          ctx.bookStatsCoverage = null;
          ctx.bookStatsDelta = null;
          ctx.writingTimeData = null;
          ctx.lektoratTimeData = null;
          _destroyStatsChart();
        },
        extraListeners: [{ type: 'book-stats:select', handler: onSelect }],
      });
    },

    destroy() {
      this._lifecycle?.destroy();
      _destroyStatsChart();
      _disconnectThemeObserver();
    },

    ...bookstatsMethods,
  }));
}
