// Alpine.data('folderImportCard') — Folder-Import (ZIP mit YYYY/Monat/Datei).
// Modes: 'new-book' (neues Buch anlegen) und 'merge' (in offenes Buch kippen).
// ZIP-Upload als raw body an /jobs/folder-import. Job-Polling via startPoll.

import { setupCardLifecycle } from './card-lifecycle.js';
import { startPoll, runningJobStatus } from './job-helpers.js';
import { tzOpts, localeTag } from '../utils.js';

export function registerFolderImportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('folderImportCard', () => ({
    mode: 'new-book',
    bookName: '',
    file: null,
    fileName: '',
    fileSize: 0,
    dragOver: false,
    busy: false,
    errorMessage: '',
    jobId: null,
    jobProgress: 0,
    jobStatusText: '',
    jobStatusParams: null,
    jobTokIn: 0,
    jobTokOut: 0,
    jobTokPerSec: null,
    result: null,
    _pollTimer: null,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'folderImport',
        showFlag: 'showFolderImportCard',
        showNeedsBookId: false,
        onShow: () => {
          if (window.__app?.selectedBookId) {
            this.mode = 'merge';
          }
        },
        onViewReset: () => this.reset(),
      });
    },

    destroy() {
      this._lifecycle?.destroy();
      if (this._pollTimer) clearInterval(this._pollTimer);
    },

    reset() {
      this.file = null;
      this.fileName = '';
      this.fileSize = 0;
      this.busy = false;
      this.errorMessage = '';
      this.jobId = null;
      this.jobProgress = 0;
      this.jobStatusText = '';
      this.jobStatusParams = null;
      this.jobTokIn = 0;
      this.jobTokOut = 0;
      this.jobTokPerSec = null;
      this.result = null;
    },

    onFilePick(e) {
      const f = e.target.files?.[0];
      if (f) this.setFile(f);
    },

    onDrop(e) {
      e.preventDefault();
      this.dragOver = false;
      const f = e.dataTransfer?.files?.[0];
      if (f) this.setFile(f);
    },

    setFile(f) {
      const ok = /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed';
      if (!ok) {
        this.errorMessage = window.__app.t('folderImport.error.notZip');
        return;
      }
      this.file = f;
      this.fileName = f.name;
      this.fileSize = f.size;
      this.errorMessage = '';
    },

    get canSubmit() {
      if (!this.file || this.busy) return false;
      if (this.mode === 'new-book' && !this.bookName.trim()) return false;
      if (this.mode === 'merge' && !window.__app.selectedBookId) return false;
      return true;
    },

    get runningStatusHtml() {
      if (!this.jobId) return '';
      return runningJobStatus(
        window.__app.t.bind(window.__app),
        this.jobStatusText,
        this.jobTokIn, this.jobTokOut, 0,
        this.jobProgress, this.jobTokPerSec, this.jobStatusParams,
      );
    },

    async submit() {
      if (!this.canSubmit) return;
      this.busy = true;
      this.errorMessage = '';
      this.result = null;
      const params = new URLSearchParams();
      params.set('mode', this.mode);
      if (this.mode === 'new-book') params.set('book_name', this.bookName.trim());
      else params.set('book_id', String(window.__app.selectedBookId));
      try {
        const buf = await this.file.arrayBuffer();
        const resp = await fetch('/jobs/folder-import?' + params.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/zip' },
          body: buf,
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          this.errorMessage = window.__app.t('folderImport.error.upload', { code: err.error_code || resp.status });
          this.busy = false;
          return;
        }
        const { jobId } = await resp.json();
        this.jobId = jobId;
        this._startPolling();
      } catch (e) {
        this.errorMessage = window.__app.t('folderImport.error.upload', { code: e.message });
        this.busy = false;
      }
    },

    _startPolling() {
      startPoll(this, {
        timerProp: '_pollTimer',
        jobId: this.jobId,
        progressProp: 'jobProgress',
        intervalMs: 1500,
        onProgress: (job) => {
          this.jobStatusText = job.statusText || '';
          this.jobStatusParams = job.statusParams || null;
          this.jobTokIn = job.tokensIn || 0;
          this.jobTokOut = job.tokensOut || 0;
          this.jobTokPerSec = job.tokPerSec || null;
        },
        onNotFound: () => {
          this.busy = false;
          this.errorMessage = window.__app.t('folderImport.error.jobLost');
        },
        onError: (job) => {
          this.busy = false;
          this.errorMessage = window.__app.t('folderImport.error.jobFailed', { msg: job?.error || '' });
        },
        onDone: (job) => {
          this.busy = false;
          this.result = job.result || null;
          if (this.result?.bookId) {
            window.__app.loadBooks?.().then(() => {
              window.__app.selectedBookId = this.result.bookId;
              location.hash = '#book/' + this.result.bookId;
            });
          }
        },
      });
    },
  }));
}
