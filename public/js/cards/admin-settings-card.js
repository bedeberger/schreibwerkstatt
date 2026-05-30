// Alpine-Sub-Komponente fuer Admin-Settings. Sichtbarkeit ueber $app.currentUser.role;
// State + Lifecycle hier, Show-Flag (`showAdminSettingsCard`) im Root.

import { adminSettingsMethods } from '../admin/admin-settings.js';

export function registerAdminSettingsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminSettingsCard', () => ({
    adminSettingsMap: {},
    adminSettingsForm: {},
    adminSettingsLoading: false,
    adminSettingsSaving: false,
    adminSettingsSaved: false,
    adminSettingsSavedCount: 0,
    adminSettingsError: '',
    adminSettingsTab: 'auth',
    adminSettingsProviderSubtab: 'claude',
    adminSettingsTestResult: null,

    // ── API-Tokens (Tab `api`) — Prometheus/HA/Grafana-Scraper ──────────────
    adminApiTokensList: [],
    adminApiTokensLoading: false,
    adminApiTokensLoaded: false,
    adminApiTokensError: '',
    adminApiTokensCreating: false,
    adminApiTokensNewName: '',
    adminApiTokensNewExpiresAt: '',
    adminApiTokensJustCreated: null,
    adminApiTokensCopiedAt: 0,
    adminSnippetPrometheusOpen: false,
    adminSnippetHomeAssistantOpen: false,

    _onViewReset: null,

    init() {
      this.$watch(() => window.__app.showAdminSettingsCard, async (visible) => {
        if (!visible) return;
        await this.adminSettingsLoad();
      });
      this._onViewReset = () => {
        this.adminSettingsError = '';
        this.adminSettingsTestResult = null;
      };
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      if (this._onViewReset) window.removeEventListener('view:reset', this._onViewReset);
    },

    ...adminSettingsMethods,
  }));
}
