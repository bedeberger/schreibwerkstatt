// Alpine-Sub-Komponente fuer die KI-Parse-Fehler-Karte. Sichtbarkeit ueber
// $app.currentUser.isAdmin; State + Lifecycle hier, Show-Flag
// (`showAdminParseFailsCard`) im Root.

import { adminParseFailsMethods } from '../admin/ai-parse-fails.js';
import { EVT } from '../events.js';

export function registerAdminParseFailsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminParseFailsCard', () => ({
    parseFailsInitialized: false,
    parseFailsLoading: false,
    parseFailsError: '',
    parseFailsFiles: [],
    parseFailsContent: {},
    parseFailsExpanded: {},
    _onViewReset: null,

    init() {
      this.$watch(() => window.__app.showAdminParseFailsCard, async (visible) => {
        if (visible) await this.parseFailsEnter();
        else this._parseFailsLeave();
      });
      this._onViewReset = () => {
        this._parseFailsLeave();
        this.parseFailsFiles = [];
        this.parseFailsContent = {};
        this.parseFailsExpanded = {};
        this.parseFailsError = '';
        this.parseFailsInitialized = false;
      };
      window.addEventListener(EVT.VIEW_RESET, this._onViewReset);
    },

    destroy() {
      this._parseFailsLeave();
      if (this._onViewReset) window.removeEventListener(EVT.VIEW_RESET, this._onViewReset);
    },

    ...adminParseFailsMethods,
  }));
}
