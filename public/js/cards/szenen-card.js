// Alpine.data('szenenCard') — Sub-Komponente der Szenen-Karte.
//
// Eigener State: Meta-Flags (Loading/Progress/Status/PollTimer).
// Root behält:
//   - `szenen` (im Store, als $root-Getter verfügbar)
//   - `szenenFilters` (Cross-Cutting via Alpine-Scope-Resolution)
//   - `loadSzenen`, `szenenNachKapitel`, `szenenNachSeite`
//     (Root-Spread; von komplett-Job und anderen genutzt)
import { setupCardLifecycle } from './card-lifecycle.js';
import { applySzenenFilters } from '../app/app-ui.js';

export function registerSzenenCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('szenenCard', () => ({
    szenenLoading: false,
    szenenProgress: 0,
    szenenStatus: '',
    viewMode: localStorage.getItem('szenen.viewMode') === 'grid' ? 'grid' : 'list', // 'list' | 'grid'
    _szenenPollTimer: null,
    _lifecycle: null,

    // Gefilterte + sortierte Szenen für Liste/Grid. Filter-State + Kapitel-/
    // Seiten-Order leben am Root, darum via window.__app gelesen.
    get szenenFiltered() {
      const root = window.__app;
      return applySzenenFilters(root.$store.catalog.szenen, root.szenenFilters).sort((a, b) => {
        const c = root._chapterIdx(a.kapitel) - root._chapterIdx(b.kapitel);
        if (c !== 0) return c;
        const p = root._pageIdx(a.seite) - root._pageIdx(b.seite);
        if (p !== 0) return p;
        return (a.titel || '').localeCompare(b.titel || '', 'de');
      });
    },

    init() {
      this.$watch('viewMode', (v) => localStorage.setItem('szenen.viewMode', v));
      this._lifecycle = setupCardLifecycle(this, {
        name: 'szenen',
        showFlag: 'showSzenenCard',
        timerKeys: ['_szenenPollTimer'],
        resetState: { szenenLoading: false, szenenProgress: 0, szenenStatus: '' },
        load: (root) => root.loadSzenen(Alpine.store('nav').selectedBookId),
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },
  }));
}
