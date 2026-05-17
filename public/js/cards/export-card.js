// Alpine.data('exportCard') — Sub-Komponente der Buch-Export-Karte.
// Fachlicher State lebt hier, `showExportCard` + `toggleExportCard` im Root.

import { exportMethods } from '../book/export.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerExportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('exportCard', () => ({
    bookExportLoading: null,
    bookExportError: '',
    exportScope: 'book',
    exportChapterId: null,
    exportPageId: null,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        resetState: {
          bookExportLoading: null,
          bookExportError: '',
          exportScope: 'book',
          exportChapterId: null,
          exportPageId: null,
        },
      });
      this.$watch(() => this.exportScope, () => this._ensurePicked());
      this.$watch(() => window.__app?.currentPage?.id, () => this._ensurePicked());
    },

    _ensurePicked() {
      const app = window.__app;
      const cur = app?.currentPage;
      if (this.exportScope === 'chapter') {
        const opts = this.exportChapterOptions();
        const valid = opts.some(o => o.value === this.exportChapterId);
        if (!valid) this.exportChapterId = cur?.chapter_id || opts[0]?.value || null;
      }
      if (this.exportScope === 'page') {
        const opts = this.exportPageOptions();
        const valid = opts.some(o => o.value === this.exportPageId);
        if (!valid) this.exportPageId = cur?.id || opts[0]?.value || null;
      }
    },

    destroy() { this._lifecycle?.destroy(); },

    ...exportMethods,
  }));
}
