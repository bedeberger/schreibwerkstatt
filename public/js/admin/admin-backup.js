// AdminBackupCard-Methods. Wird im adminBackupCard-Alpine-Scope gespreaded.
// Root-Zugriffe via window.__app. Kontoweites DB-Backup (Download eines
// konsistenten SQLite-Snapshots) + Restore (Upload → Validierung → Neustart,
// beim Boot wird die DB geswappt). Backend: routes/admin-backup.js.

export const adminBackupMethods = {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  async backupEnter() {
    if (this.backupInitialized) return;
    this.backupInitialized = true;
    await this._backupLoadInfo();
  },

  async _backupLoadInfo() {
    this.backupLoading = true;
    this.backupError = '';
    try {
      const r = await fetch('/admin/backup/info', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.backupInfoData = await r.json();
    } catch (e) {
      this.backupError = e.message;
    } finally {
      this.backupLoading = false;
    }
  },

  backupRefresh() {
    this.backupInitialized = false;
    return this.backupEnter();
  },

  // ── Download ───────────────────────────────────────────────────────────────
  // Über Browser-Navigation (Auth-Cookie wird mitgeschickt, kein Buffern grosser
  // Dateien im JS-Heap). Der Server streamt gzip direkt in den Download.
  backupDownload() {
    this.backupDownloading = true;
    window.location.assign('/admin/backup/download');
    setTimeout(() => { this.backupDownloading = false; }, 4000);
  },

  // ── Restore ─────────────────────────────────────────────────────────────────
  backupPickFile(e) {
    this.backupFile = e.target.files?.[0] || null;
    this.backupRestoreResult = null;
    this.backupRestoreError = '';
  },

  async backupUploadRestore() {
    if (!this.backupFile || this.backupRestoring) return;
    this.backupRestoring = true;
    this.backupRestoreError = '';
    this.backupRestoreResult = null;
    try {
      const buf = await this.backupFile.arrayBuffer();
      const r = await fetch('/admin/backup/restore', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(this._backupErrLabel(data.error_code) || data.message || `HTTP ${r.status}`);
      this.backupRestoreResult = data;
    } catch (e) {
      this.backupRestoreError = e.message;
    } finally {
      this.backupRestoring = false;
    }
  },

  backupCancelRestore() {
    this.backupFile = null;
    this.backupRestoreResult = null;
    this.backupRestoreError = '';
    const el = this.$refs?.backupFileInput;
    if (el) el.value = '';
  },

  async backupConfirmRestart() {
    if (this.backupRestarting) return;
    this.backupRestarting = true;
    this.backupRestartTimedOut = false;
    try {
      await fetch('/admin/backup/restart', { method: 'POST', credentials: 'same-origin' });
    } catch { /* Server beendet sich — Fehler erwartet */ }
    this._backupWaitForBoot();
  },

  // Pollt /info bis der Server wieder antwortet, dann Reload (frische DB laden).
  _backupWaitForBoot() {
    const start = Date.now();
    const tick = async () => {
      try {
        const r = await fetch('/admin/backup/info', { credentials: 'same-origin', cache: 'no-store' });
        if (r.ok) { window.location.reload(); return; }
      } catch { /* noch nicht oben */ }
      if (Date.now() - start > 180000) { this.backupRestartTimedOut = true; return; }
      setTimeout(tick, 2500);
    };
    setTimeout(tick, 4000);
  },

  // ── Format / Labels ──────────────────────────────────────────────────────
  backupFmtBytes(n) {
    if (n == null || Number.isNaN(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    const loc = Alpine.store('shell').uiLocale === 'en' ? 'en-US' : 'de-CH';
    return `${v.toLocaleString(loc, { maximumFractionDigits: i === 0 ? 0 : 1 })} ${units[i]}`;
  },

  _backupErrLabel(code) {
    if (!code) return '';
    const key = `admin.backup.err.${code}`;
    const t = window.__app.t(key);
    return t === key ? '' : t;
  },
};
