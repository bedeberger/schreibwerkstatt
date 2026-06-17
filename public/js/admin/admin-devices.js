// AdminDevicesCard-Methods. Wird im adminDevicesCard-Alpine-Scope gespreaded.
// Root-Zugriffe via window.__app. Liest aus /admin/devices (alle Device-Tokens
// der nativen Mac-Focus-Clients: gemeldete Client-Version, Nutzungszaehler,
// letzte Aktivitaet). Read-only — Ausstellen/Widerrufen bleibt beim User unter /me.

import { tzOpts } from '../utils.js';

export const adminDevicesMethods = {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  async devicesEnter() {
    if (this.devicesInitialized) return;
    this.devicesInitialized = true;
    await this._devicesLoad();
  },

  async _devicesLoad() {
    this.devicesLoading = true;
    this.devicesError = '';
    try {
      const r = await fetch('/admin/devices', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      this.devicesList = data.devices || [];
      this.devicesLatestVersion = data.latestVersion || null;
    } catch (e) {
      this.devicesError = e.message;
    } finally {
      this.devicesLoading = false;
    }
  },

  devicesRefresh() {
    this.devicesInitialized = false;
    return this.devicesEnter();
  },

  // ── Format ───────────────────────────────────────────────────────────────
  devicesFmtTs(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(window.__app.uiLocale === 'en' ? 'en-US' : 'de-CH',
      tzOpts({ dateStyle: 'medium', timeStyle: 'short' }));
  },

  // Status-Label: widerrufen / abgelaufen / aktiv.
  devicesStatus(d) {
    if (d.revoked_at) return window.__app.t('admin.devices.statusRevoked');
    if (d.expires_at && d.expires_at < new Date().toISOString()) return window.__app.t('admin.devices.statusExpired');
    return window.__app.t('admin.devices.statusActive');
  },

  // Ist die installierte Version aelter als das neueste Release? (Reiner
  // String-Vergleich der dotted-Version; nur bei sauberem semver aussagekraeftig.)
  devicesIsOutdated(d) {
    if (!this.devicesLatestVersion || !d.client_version) return false;
    return this._devicesCmpVersion(d.client_version, this.devicesLatestVersion) < 0;
  },

  _devicesCmpVersion(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const da = pa[i] || 0, db = pb[i] || 0;
      if (da !== db) return da < db ? -1 : 1;
    }
    return 0;
  },
};
