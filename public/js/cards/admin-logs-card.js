// Alpine-Sub-Komponente fuer die Admin-Logs-Karte. Sichtbarkeit ueber
// $app.currentUser.isAdmin; State + Lifecycle hier, Show-Flag
// (`showAdminLogsCard`) im Root.

import { adminLogsMethods, ADMIN_LOGS_LEVELS } from '../admin/admin-logs.js';

export function registerAdminLogsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminLogsCard', () => ({
    adminLogsInitialized: false,
    adminLogsLoading: false,
    adminLogsError: '',
    adminLogsEntries: [],
    adminLogsFiles: [],
    adminLogsFilter: { level: '', scope: '', user: '', book: '', q: '' },
    adminLogsLiveTail: true,
    adminLogsEventSource: null,
    adminLogsStreamError: false,
    adminLogsRotatedHint: false,
    adminLogsHasMore: true,
    adminLogsOldestTs: null,
    adminLogsExpanded: {},
    adminLogsLevels: ADMIN_LOGS_LEVELS,
    _onViewReset: null,
    _onBookChanged: null,

    init() {
      this.$watch(() => window.__app.showAdminLogsCard, async (visible) => {
        if (visible) {
          await this.adminLogsEnter();
        } else {
          this._adminLogsLeave();
        }
      });
      this._onViewReset = () => {
        this._adminLogsLeave();
        this.adminLogsEntries = [];
        this.adminLogsError = '';
        this.adminLogsExpanded = {};
        this.adminLogsInitialized = false;
      };
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      this._adminLogsLeave();
      if (this._onViewReset) window.removeEventListener('view:reset', this._onViewReset);
    },

    ...adminLogsMethods,
  }));
}
