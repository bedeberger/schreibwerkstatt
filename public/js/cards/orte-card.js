// Alpine.data('orteCard') — Sub-Komponente der Schauplatz-Karte.
//
// Eigener State: Meta-Flags (Loading/Progress/Status/PollTimer).
// Root behält:
//   - `orte` (im Store, als $root-Getter verfügbar)
//   - `orteFilters` (app-navigation.js schreibt darauf)
//   - `selectedOrtId` (Hash-Router)
//   - `loadOrte`, `saveOrte`, `orteFiltered` (Root-Spread; von komplett-Job,
//     Szenen-Trigger und _reloadVisibleBookCards genutzt)
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerOrteCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('orteCard', () => ({
    orteLoading: false,
    orteProgress: 0,
    orteStatus: '',
    viewMode: localStorage.getItem('orte.viewMode') === 'grid' ? 'grid' : 'list', // 'list' | 'grid'
    _ortePollTimer: null,
    _lifecycle: null,

    init() {
      this.$watch('viewMode', (v) => localStorage.setItem('orte.viewMode', v));
      this._lifecycle = setupCardLifecycle(this, {
        name: 'orte',
        showFlag: 'showOrteCard',
        timerKeys: ['_ortePollTimer'],
        resetState: { orteLoading: false, orteProgress: 0, orteStatus: '' },
        load: (root) => root.loadOrte(root.selectedBookId),
        onShow: async (root) => {
          const tasks = [root.loadOrte(root.selectedBookId)];
          if (!root.szenen.length) tasks.push(root.loadSzenen(root.selectedBookId));
          await Promise.all(tasks);
        },
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },
  }));
}
