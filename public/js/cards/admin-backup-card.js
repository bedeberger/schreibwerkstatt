// Alpine-Sub-Komponente fuer die Admin-Backup-Karte (kontoweites DB-Backup +
// Restore). Sichtbarkeit ueber $store.session.currentUser.isAdmin; State +
// Lifecycle hier, Show-Flag (`showAdminBackupCard`) im Root.

import { adminBackupMethods } from '../admin/admin-backup.js';
import { EVT } from '../events.js';

export function registerAdminBackupCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminBackupCard', () => ({
    backupInitialized: false,
    backupLoading: false,
    backupError: '',
    backupInfoData: null,
    backupDownloading: false,
    backupFile: null,
    backupRestoring: false,
    backupRestoreResult: null,
    backupRestoreError: '',
    backupRestarting: false,
    backupRestartTimedOut: false,
    _onViewReset: null,
    _onCardRefresh: null,

    init() {
      this.$watch(() => window.__app.showAdminBackupCard, async (visible) => {
        if (visible) await this.backupEnter();
      });
      this._onViewReset = () => {
        this.backupInitialized = false;
        this.backupInfoData = null;
        this.backupError = '';
        this.backupFile = null;
        this.backupRestoreResult = null;
        this.backupRestoreError = '';
      };
      window.addEventListener(EVT.VIEW_RESET, this._onViewReset);
      this._onCardRefresh = (e) => { if (e.detail?.name === 'adminBackup') this.backupRefresh(); };
      window.addEventListener(EVT.CARD_REFRESH, this._onCardRefresh);
    },

    destroy() {
      if (this._onViewReset) window.removeEventListener(EVT.VIEW_RESET, this._onViewReset);
      if (this._onCardRefresh) window.removeEventListener(EVT.CARD_REFRESH, this._onCardRefresh);
    },

    ...adminBackupMethods,
  }));
}
