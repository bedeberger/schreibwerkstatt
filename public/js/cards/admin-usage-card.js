// Phase 4d (BookStack-Exit, docs/bookstack-exit.md): Alpine-Sub-Komponente
// fuer die Admin-Usage-Karte. Sichtbarkeit ueber $app.currentUser.isAdmin;
// State + Lifecycle hier, Show-Flag (`showAdminUsageCard`) im Root.

import { adminUsageMethods } from '../admin/admin-usage.js';

export function registerAdminUsageCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminUsageCard', () => ({
    adminUsageInitialized: false,
    // adminUsageTab lebt am Root (Hash-Router liest/schreibt es). Getter/Setter
    // halten den Sub-Scope kompatibel, ohne den State zu duplizieren.
    get adminUsageTab() { return window.__app?.adminUsageTab ?? 'users'; },
    set adminUsageTab(v) { if (window.__app) window.__app.adminUsageTab = v; },
    adminUsageLoading: false,
    adminUsageError: '',
    adminUsageFrom: '',
    adminUsageTo: '',

    // Users-Tab
    adminUsageUsersList: [],

    // Filter fuer Jobs/Chat-Drilldown
    adminUsageFilterUser: '',

    // Jobs-Tab
    adminUsageJobsList: [],
    adminUsageJobsTotal: 0,
    adminUsageJobsOffset: 0,

    // Chat-Tab
    adminUsageChatList: [],
    adminUsageChatTotal: 0,
    adminUsageChatOffset: 0,

    // Summary-Tab
    adminUsageSummary: null,

    // Features-Tab
    adminUsageFeatureItems: [],
    adminUsageFeatureTotals: [],

    // Zeit-Tab
    adminUsageTimeItems: [],
    adminUsageTimeSeries: [],
    adminUsageTimeSeriesKey: '',

    _onViewReset: null,

    init() {
      this.$watch(() => window.__app.showAdminUsageCard, async (visible) => {
        if (!visible) return;
        await this.adminUsageEnter();
      });
      this.$watch(() => this.adminUsageFrom, () => { if (window.__app.showAdminUsageCard) this.adminUsageLoadTab(); });
      this.$watch(() => this.adminUsageTo,   () => { if (window.__app.showAdminUsageCard) this.adminUsageLoadTab(); });
      this.$watch(() => this.adminUsageFilterUser, () => {
        this.adminUsageJobsOffset = 0;
        this.adminUsageChatOffset = 0;
        if (this.adminUsageTab === 'jobs' || this.adminUsageTab === 'chat') this.adminUsageLoadTab();
      });
      this._onViewReset = () => {
        this.adminUsageError = '';
        this.adminUsageTimeSeries = [];
        this.adminUsageTimeSeriesKey = '';
      };
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      if (this._onViewReset) window.removeEventListener('view:reset', this._onViewReset);
      if (this._adminUsageCharts) {
        for (const k of Object.keys(this._adminUsageCharts)) {
          try { this._adminUsageCharts[k]?.destroy?.(); } catch {}
        }
        this._adminUsageCharts = null;
      }
    },

    ...adminUsageMethods,
  }));
}
