// Alpine-Sub-Komponente fuer die Admin-Geraete-Karte (native Mac-Focus-Clients).
// Sichtbarkeit ueber $app.currentUser.isAdmin; State + Lifecycle hier, Show-Flag
// (`showAdminDevicesCard`) im Root.

import { adminDevicesMethods } from '../admin/admin-devices.js';
import { EVT } from '../events.js';

export function registerAdminDevicesCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminDevicesCard', () => ({
    devicesInitialized: false,
    devicesLoading: false,
    devicesError: '',
    devicesList: [],
    devicesLatestVersion: null,
    _onViewReset: null,
    _onCardRefresh: null,

    init() {
      this.$watch(() => window.__app.showAdminDevicesCard, async (visible) => {
        if (visible) await this.devicesEnter();
      });
      this._onViewReset = () => {
        this.devicesList = [];
        this.devicesError = '';
        this.devicesLatestVersion = null;
        this.devicesInitialized = false;
      };
      window.addEventListener(EVT.VIEW_RESET, this._onViewReset);
      this._onCardRefresh = (e) => { if (e.detail?.name === 'adminDevices') this.devicesRefresh(); };
      window.addEventListener(EVT.CARD_REFRESH, this._onCardRefresh);
    },

    destroy() {
      if (this._onViewReset) window.removeEventListener(EVT.VIEW_RESET, this._onViewReset);
      if (this._onCardRefresh) window.removeEventListener(EVT.CARD_REFRESH, this._onCardRefresh);
    },

    ...adminDevicesMethods,
  }));
}
