// Alpine.data('exportCard') — Sub-Komponente der Buch-Export-Karte.
// Fachlicher State lebt hier, `showExportCard` + `toggleExportCard` im Root.

import { exportMethods } from '../export.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerExportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('exportCard', () => ({
    bookExportLoading: null,
    bookExportError: '',
    exportScope: 'book',
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        resetState: { bookExportLoading: null, bookExportError: '', exportScope: 'book' },
      });
      // Wenn aktuelle Auswahl (Page/Chapter) entfaellt, Scope auf naechst-
      // weiteres Granulat zurueckfallen lassen.
      this.$watch(() => window.__app?.currentPage?.id, () => this._reconcileScope());
      this.$watch(() => window.__app?.currentPage?.chapter_id, () => this._reconcileScope());
    },

    _reconcileScope() {
      const valid = this.exportScopeOptions().map(o => o.value);
      if (!valid.includes(this.exportScope)) this.exportScope = 'book';
    },

    destroy() { this._lifecycle?.destroy(); },

    ...exportMethods,
  }));
}
