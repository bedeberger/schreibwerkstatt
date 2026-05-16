// Phase 8 (BookStack-Exit, docs/bookstack-exit.md): Admin-Karte fuer den
// bookstack→localdb-Bulk-Copy. State + Lifecycle hier; Show-Flag
// (`showAdminBackendMigrationCard`) im Root (SSoT fuer Hash-Router + Exklusivitaet).
//
// UI-Flow:
//   1. Status-Block: aktueller Backend + Read-Only-Marker (poll alle 2s waehrend Job laeuft).
//   2. Form: Source/Target (read-only fixiert), optionales Buch-Filter, Checkboxen.
//   3. Start-Button → POST /jobs/backend-migrate. Job-Polling via startPoll.

import { startPoll, runningJobStatus } from './job-helpers.js';
import { escHtml, fetchJson } from '../utils.js';

const _LS_KEY = 'admin_backend_migration_job';

export function registerAdminBackendMigrationCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminBackendMigrationCard', () => ({
    loading: false,
    error: '',
    statusHtml: '',
    progress: 0,
    result: null,

    currentBackend: '',
    sourceReadOnly: null,
    statusPolling: false,
    _statusTimer: null,
    _jobTimer: null,

    formSource: 'bookstack',
    formTarget: 'localdb',
    formBookId: '',
    formSetReadOnly: true,
    formCutover: true,

    get canStart() {
      if (!this.currentBackend) return false;
      return this.currentBackend === this.formSource;
    },
    get startBlockedReason() {
      if (!this.currentBackend) return '';
      if (this.currentBackend !== this.formSource) {
        return window.__app.t('admin.migrate.blocked.notSource', {
          source: this.formSource,
          current: this.currentBackend,
        });
      }
      return '';
    },

    init() {
      this.$watch(() => window.__app.showAdminBackendMigrationCard, async (visible) => {
        if (visible) {
          await this.loadStatus();
          this._resumeIfRunning();
        } else {
          this._stopStatusPoll();
        }
      });
    },

    destroy() {
      this._stopStatusPoll();
      if (this._jobTimer) { clearInterval(this._jobTimer); this._jobTimer = null; }
    },

    async loadStatus() {
      try {
        const data = await fetchJson('/jobs/backend-migrate/status');
        this.currentBackend = data.currentBackend || '';
        this.sourceReadOnly = data.sourceReadOnly || null;
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    _startStatusPoll() {
      if (this._statusTimer) return;
      this._statusTimer = setInterval(() => this.loadStatus(), 2500);
    },
    _stopStatusPoll() {
      if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null; }
    },

    async _resumeIfRunning() {
      const stored = localStorage.getItem(_LS_KEY);
      if (!stored) return;
      try {
        const resp = await fetch('/jobs/' + stored);
        if (!resp.ok) { localStorage.removeItem(_LS_KEY); return; }
        const job = await resp.json();
        if (job.status === 'running' || job.status === 'queued') {
          this.loading = true;
          this._startStatusPoll();
          this._pollJob(stored);
        } else {
          localStorage.removeItem(_LS_KEY);
        }
      } catch { localStorage.removeItem(_LS_KEY); }
    },

    async start() {
      if (this.loading) return;
      const t = window.__app.t.bind(window.__app);
      const message = this.formCutover
        ? t('admin.migrate.confirm.cutover', { source: this.formSource, target: this.formTarget })
        : t('admin.migrate.confirm.copy', { source: this.formSource, target: this.formTarget });
      const ok = await window.__app.appConfirm({ message, danger: this.formCutover });
      if (!ok) return;

      this.loading = true;
      this.error = '';
      this.result = null;
      this.progress = 0;
      this.statusHtml = `<span class="spinner"></span>${escHtml(t('admin.migrate.status.starting'))}`;

      const payload = {
        source: this.formSource,
        target: this.formTarget,
        setSourceReadOnly: this.formSetReadOnly,
        cutover: this.formCutover,
      };
      if (this.formBookId && Number(this.formBookId) > 0) payload.bookId = Number(this.formBookId);

      try {
        const resp = await fetch('/jobs/backend-migrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          const code = data.error_code || '';
          const key = `admin.migrate.error.${code}`;
          const translated = t(key, { current: this.currentBackend, source: this.formSource });
          this.error = translated !== key
            ? translated
            : (data.detail ? `HTTP ${resp.status}: ${data.detail}` : `HTTP ${resp.status}`);
          this.loading = false;
          this.statusHtml = '';
          return;
        }
        if (data.existing) {
          this.statusHtml = `<span class="spinner"></span>${escHtml(t('admin.migrate.status.alreadyRunning'))}`;
        }
        localStorage.setItem(_LS_KEY, data.jobId);
        this._startStatusPoll();
        this._pollJob(data.jobId);
      } catch (e) {
        this.loading = false;
        this.error = e.message || String(e);
        this.statusHtml = '';
      }
    },

    _pollJob(jobId) {
      const t = window.__app.t.bind(window.__app);
      startPoll(this, {
        timerProp: '_jobTimer',
        jobId,
        lsKey: _LS_KEY,
        progressProp: 'progress',
        onProgress: (job) => {
          this.statusHtml = runningJobStatus(
            (k, p) => t(k, p),
            job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
            job.progress, job.tokensPerSec, job.statusParams,
          );
        },
        onNotFound: () => {
          this.loading = false;
          this.statusHtml = `<span class="error-msg">${escHtml(t('admin.migrate.status.lost'))}</span>`;
          this._stopStatusPoll();
        },
        onError: (job) => {
          this.loading = false;
          this.statusHtml = `<span class="error-msg">${escHtml(t(job.error || 'job.error.generic', job.errorParams))}</span>`;
          this._stopStatusPoll();
          this.loadStatus();
        },
        onDone: async (job) => {
          this.loading = false;
          this.result = job.result || null;
          this.statusHtml = `<span class="success-msg">${escHtml(t('admin.migrate.status.done'))}</span>`;
          this._stopStatusPoll();
          await this.loadStatus();
        },
      });
    },

    async clearReadOnly() {
      const t = window.__app.t.bind(window.__app);
      const ok = await window.__app.appConfirm({
        message: t('admin.migrate.confirm.clearReadOnly'),
        danger: true,
      });
      if (!ok) return;
      try {
        await fetchJson('/jobs/backend-migrate/clear-readonly', { method: 'POST' });
        await this.loadStatus();
      } catch (e) {
        this.error = e.message || String(e);
      }
    },
  }));
}
