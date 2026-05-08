// Alpine.data('exportCard') — Sub-Komponente der Buch-Export-Karte.
// Fachlicher State lebt hier, `showExportCard` + `toggleExportCard` im Root.

import { exportMethods } from '../export.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerExportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('exportCard', () => ({
    bookExportLoading: null,
    bookExportError: '',
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        resetState: { bookExportLoading: null, bookExportError: '' },
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...exportMethods,
  }));
}
