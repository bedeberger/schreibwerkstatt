// Teil von bookSettingsMethods (siehe Facade book-settings.js).
import { EVT, fetchJson } from './_shared.js';

export const blogMethods = {

  // ── Blog-Sync (WordPress) ─────────────────────────────────────────────────
  // Methoden + Hilfsfunktionen für den Blog-Verbindungs-Tab im BookSettings-Card.
  // Sichtbar nur bei buchtyp === 'blog'. State lebt im Card-Init (blogForm,
  // blogConnection, blogBusy, blogAction, blogMessage, blogError, blogImportJobId,
  // blogPullJobId). Job-Status-Polling läuft via root job-queue events.

  async loadBlogStatus() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    try {
      const data = await fetchJson(`/blog/${bookId}/status`);
      this.blogConnection = data.connection || null;
      if (this.blogConnection) {
        this.blogForm.baseUrl       = this.blogConnection.baseUrl || '';
        this.blogForm.username      = this.blogConnection.username || '';
        this.blogForm.defaultStatus = this.blogConnection.defaultStatus || 'draft';
      }
      await this._rehydrateBlogJobs(bookId);
    } catch (e) {
      console.error('[blog] Status laden fehlgeschlagen:', e);
    }
  },


  // Reload/Tab-Reopen: lokales blogImportJobId/blogPullJobId neu binden, falls
  // serverseitig noch ein Job für (book, user) läuft — sonst zeigt der Button
  // weder Spinner noch Disable, bis User erneut klickt.
  async _rehydrateBlogJobs(bookId) {
    const probe = async (type) => {
      try {
        const { jobId, status } = await fetchJson(`/jobs/active?type=${type}&book_id=${bookId}`);
        return (jobId && (status === 'running' || status === 'queued')) ? jobId : null;
      } catch { return null; }
    };
    const [importId, pullId, reconcileId] = await Promise.all([
      probe('blog-import'), probe('blog-pull'), probe('blog-reconcile'),
    ]);
    this.blogImportJobId = importId;
    this.blogPullJobId = pullId;
    this.blogReconcileJobId = reconcileId;
  },


  blogStatusOptions() {
    const app = window.__app;
    return [
      { value: 'draft',   label: app.t('blog.status.draft') },
      { value: 'publish', label: app.t('blog.status.publish') },
      { value: 'private', label: app.t('blog.status.private') },
    ];
  },


  blogFormReady() {
    return !!(this.blogForm.baseUrl && this.blogForm.username
              && (this.blogForm.password || this.blogConnection));
  },


  _setBlogBusy(action) {
    this.blogBusy = !!action;
    this.blogAction = action || null;
    if (action) { this.blogMessage = ''; this.blogError = ''; }
  },


  async testBlogConnection() {
    const bookId = window.__app.selectedBookId;
    if (!bookId || !this.blogFormReady()) return;
    this._setBlogBusy('test');
    try {
      const res = await fetch(`/blog/${bookId}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: this.blogForm.baseUrl.trim(),
          username: this.blogForm.username.trim(),
          password: this.blogForm.password,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error_code || 'BLOG_TEST_FAILED');
      this.blogMessage = window.__app.t('blog.connect.testOk', { name: data.name || this.blogForm.username });
    } catch (e) {
      this.blogError = window.__app.t('blog.error.' + e.message) || e.message;
    } finally {
      this._setBlogBusy(null);
    }
  },


  async saveBlogConnection() {
    const bookId = window.__app.selectedBookId;
    if (!bookId || !this.blogFormReady()) return;
    this._setBlogBusy('save');
    try {
      const body = {
        baseUrl: this.blogForm.baseUrl.trim(),
        username: this.blogForm.username.trim(),
        defaultStatus: this.blogForm.defaultStatus || 'draft',
      };
      if (this.blogForm.password) body.password = this.blogForm.password;
      else if (this.blogConnection) body.password = '__keep__';
      const res = await fetch(`/blog/${bookId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error_code || 'BLOG_SAVE_FAILED');
      this.blogConnection = data.connection;
      this.blogForm.password = '';
      this.blogMessage = window.__app.t('blog.connect.saved');
    } catch (e) {
      this.blogError = window.__app.t('blog.error.' + e.message) || e.message;
    } finally {
      this._setBlogBusy(null);
    }
  },


  async disconnectBlog() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    if (!confirm(window.__app.t('blog.connect.disconnectConfirm'))) return;
    this._setBlogBusy('disconnect');
    try {
      const res = await fetch(`/blog/${bookId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('BLOG_DISCONNECT_FAILED');
      this.blogConnection = null;
      this.blogForm.password = '';
      this.blogMessage = window.__app.t('blog.connect.disconnected');
    } catch (e) {
      this.blogError = window.__app.t('blog.error.' + e.message) || e.message;
    } finally {
      this._setBlogBusy(null);
    }
  },


  async startBlogImport() {
    const bookId = window.__app.selectedBookId;
    if (!bookId || this.blogImportJobId) return;
    try {
      const res = await fetch('/jobs/blog-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_code || 'BLOG_IMPORT_FAILED');
      this.blogImportJobId = data.jobId;
      window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, { detail: { type: 'blog-import', jobId: data.jobId } }));
    } catch (e) {
      this.blogError = window.__app.t('blog.error.' + e.message) || e.message;
    }
  },


  async startBlogPull() {
    const bookId = window.__app.selectedBookId;
    if (!bookId || this.blogPullJobId) return;
    try {
      const res = await fetch('/jobs/blog-pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_code || 'BLOG_PULL_FAILED');
      this.blogPullJobId = data.jobId;
      window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, { detail: { type: 'blog-pull', jobId: data.jobId } }));
    } catch (e) {
      this.blogError = window.__app.t('blog.error.' + e.message) || e.message;
    }
  },


  async startBlogReconcile() {
    const bookId = window.__app.selectedBookId;
    if (!bookId || this.blogReconcileJobId) return;
    if (!confirm(window.__app.t('blog.action.reconcileConfirm'))) return;
    try {
      const res = await fetch('/jobs/blog-reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_code || 'BLOG_RECONCILE_FAILED');
      this.blogReconcileJobId = data.jobId;
      window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, { detail: { type: 'blog-reconcile', jobId: data.jobId } }));
    } catch (e) {
      this.blogError = window.__app.t('blog.error.' + e.message) || e.message;
    }
  },
};
