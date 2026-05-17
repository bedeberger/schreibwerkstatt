// Alpine.data('stilCard') — Sub-Komponente der Stil-Heatmap.

import { stilMethods } from '../book/stil-heatmap.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerStilCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('stilCard', () => ({
    stilData: null,
    stilLoading: false,
    stilSyncing: false,
    stilStatus: '',
    activeStilDetailKey: null,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showStilCard',
        load: async (root) => {
          await this.loadStilStats(root.selectedBookId);
          if (this._stilNeedsSync()) await this.runStilSync();
        },
        onBookChanged: (e, ctx, root) => {
          if (!root.showStilCard) return;
          const bookId = e.detail?.bookId || root.selectedBookId;
          if (bookId) ctx.loadStilStats(bookId);
        },
        resetStateView: {
          stilData: null,
          stilStatus: '',
          stilLoading: false,
          stilSyncing: false,
          activeStilDetailKey: null,
        },
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...stilMethods,
  }));
}
