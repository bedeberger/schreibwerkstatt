// Admin-Karte: Buecher-Uebersicht + Owner-Zuweisung. Sub-Komponente; Show-Flag
// `showAdminBooksCard` und Toggle `toggleAdminBooksCard` leben im Root.

import { adminBooksMethods } from '../admin/admin-books.js';
import { EVT } from '../events.js';

export function registerAdminBooksCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminBooksCard', () => ({
    books: [],
    users: [],
    assignTarget: {},
    loading: false,
    busy: false,
    error: '',
    _onViewReset: null,

    init() {
      this.$watch(() => window.__app.showAdminBooksCard, async (visible) => {
        if (!visible) return;
        await this.loadAll();
      });
      this._onViewReset = () => { this.error = ''; };
      window.addEventListener(EVT.VIEW_RESET, this._onViewReset);
    },

    destroy() {
      if (this._onViewReset) window.removeEventListener(EVT.VIEW_RESET, this._onViewReset);
    },

    ...adminBooksMethods,
  }));
}
