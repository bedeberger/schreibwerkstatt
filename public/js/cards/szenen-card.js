// Alpine.data('szenenCard') — Sub-Komponente der Szenen-Karte.
//
// Eigener State: Meta-Flags (Loading/Progress/Status/PollTimer).
// Root behält:
//   - `szenen` (im Store, als $root-Getter verfügbar)
//   - `szenenFilters` (Cross-Cutting via Alpine-Scope-Resolution)
//   - `loadSzenen`, `szenenFiltered`, `szenenNachKapitel`, `szenenNachSeite`
//     (Root-Spread; von komplett-Job und anderen genutzt)
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerSzenenCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('szenenCard', () => ({
    szenenLoading: false,
    szenenProgress: 0,
    szenenStatus: '',
    szenenUebersichtOpen: false,
    viewMode: localStorage.getItem('szenen.viewMode') === 'grid' ? 'grid' : 'list', // 'list' | 'grid'
    _szenenPollTimer: null,
    _lifecycle: null,

    init() {
      this.$watch('viewMode', (v) => localStorage.setItem('szenen.viewMode', v));
      this._lifecycle = setupCardLifecycle(this, {
        name: 'szenen',
        showFlag: 'showSzenenCard',
        timerKeys: ['_szenenPollTimer'],
        resetState: { szenenLoading: false, szenenProgress: 0, szenenStatus: '' },
        load: (root) => root.loadSzenen(root.selectedBookId),
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },
  }));
}
