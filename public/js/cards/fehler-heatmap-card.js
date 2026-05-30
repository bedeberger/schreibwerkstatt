// Alpine.data('fehlerHeatmapCard') — Sub-Komponente der Fehler-Heatmap.

import { fehlerHeatmapMethods } from '../book/fehler-heatmap.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerFehlerHeatmapCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('fehlerHeatmapCard', () => ({
    fehlerHeatmapData: null,
    fehlerHeatmapLoading: false,
    fehlerHeatmapStatus: '',
    fehlerHeatmapMode: 'open',
    activeFehlerDetailKey: null,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showFehlerHeatmapCard',
        load: () => this.loadFehlerHeatmap(),
        resetStateView: {
          fehlerHeatmapData: null,
          fehlerHeatmapStatus: '',
          fehlerHeatmapLoading: false,
          activeFehlerDetailKey: null,
        },
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...fehlerHeatmapMethods,
  }));
}
