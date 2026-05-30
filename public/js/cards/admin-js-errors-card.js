// Alpine-Sub-Komponente fuer die Client-JS-Fehler-Karte. Sichtbarkeit ueber
// $app.currentUser.isAdmin; State + Lifecycle hier, Show-Flag
// (`showAdminJsErrorsCard`) im Root.

import { adminJsErrorsMethods } from '../admin/js-errors.js';

export function registerAdminJsErrorsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminJsErrorsCard', () => ({
    jsErrorsInitialized: false,
    jsErrorsLoading: false,
    jsErrorsError: '',
    jsErrorsList: [],
    jsErrorsExpanded: {},
    _onViewReset: null,

    init() {
      this.$watch(() => window.__app.showAdminJsErrorsCard, async (visible) => {
        if (visible) await this.jsErrorsEnter();
        else this._jsErrorsLeave();
      });
      this._onViewReset = () => {
        this._jsErrorsLeave();
        this.jsErrorsList = [];
        this.jsErrorsExpanded = {};
        this.jsErrorsError = '';
        this.jsErrorsInitialized = false;
      };
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      this._jsErrorsLeave();
      if (this._onViewReset) window.removeEventListener('view:reset', this._onViewReset);
    },

    ...adminJsErrorsMethods,
  }));
}
