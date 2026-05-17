// Phase 6 (BookStack-Exit, docs/bookstack-exit.md): Alpine-Sub-Komponente fuer
// den Kategorien-/Tag-Pool (Admin-only). State + Lifecycle hier, Show-Flag
// (`showAdminCategoriesCard`) im Root.

import { adminCategoriesMethods } from '../admin/admin-categories.js';

export function registerAdminCategoriesCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminCategoriesCard', () => ({
    categories: [],
    tags: [],
    loading: false,
    busy: false,
    error: '',
    newCategoryName: '',
    newTagName: '',
    _onViewReset: null,

    init() {
      this.$watch(() => window.__app.showAdminCategoriesCard, async (visible) => {
        if (!visible) return;
        await this.loadAll();
      });
      this._onViewReset = () => { this.error = ''; };
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      if (this._onViewReset) window.removeEventListener('view:reset', this._onViewReset);
    },

    ...adminCategoriesMethods,
  }));
}
