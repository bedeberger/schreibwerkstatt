// Phase 4c (BookStack-Exit, docs/bookstack-exit.md): Alpine-Sub-Komponente
// fuer Admin-Settings. Sichtbarkeit ueber $app.currentUser.role; State +
// Lifecycle hier, Show-Flag (`showAdminSettingsCard`) im Root.

import { adminSettingsMethods } from '../admin-settings.js';

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
    adminSettingsTestResult: null,

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
