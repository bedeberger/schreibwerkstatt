// Alpine-Sub-Komponente fuer den Kategorien-Pool (Admin-only). State +
// Lifecycle hier, Show-Flag (`showAdminCategoriesCard`) im Root.

import { adminCategoriesMethods } from '../admin/admin-categories.js';
import { EVT } from '../events.js';

export function registerAdminCategoriesCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminCategoriesCard', () => ({
    categories: [],
    loading: false,
    busy: false,
    error: '',
    newCategoryName: '',
    _onViewReset: null,

    init() {
      this.$watch(() => window.__app.showAdminCategoriesCard, async (visible) => {
        if (!visible) return;
        await this.loadAll();
      });
      this._onViewReset = () => { this.error = ''; };
      window.addEventListener(EVT.VIEW_RESET, this._onViewReset);
    },

    destroy() {
      if (this._onViewReset) window.removeEventListener(EVT.VIEW_RESET, this._onViewReset);
    },

    ...adminCategoriesMethods,
  }));
}
