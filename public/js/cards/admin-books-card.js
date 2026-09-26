// Admin-Karte: Buecher-Uebersicht + Owner-Zuweisung. Sub-Komponente; Show-Flag
// `showAdminBooksCard` und Toggle `toggleAdminBooksCard` leben im Root.

import { adminBooksMethods } from '../admin/admin-books.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerAdminBooksCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminBooksCard', () => ({
    books: [],
    users: [],
    assignTarget: {},
    loading: false,
    busy: false,
    error: '',
    _lifecycle: null,

    init() {
      this.$watch(() => window.__app.showAdminBooksCard, async (visible) => {
        if (!visible) return;
        await this.loadAll();
      });
      this._lifecycle = setupCardLifecycle(this, {
        onViewReset: () => { this.error = ''; },
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    ...adminBooksMethods,
  }));
}
