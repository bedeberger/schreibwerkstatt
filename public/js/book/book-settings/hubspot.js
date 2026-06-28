// Teil von bookSettingsMethods (siehe Facade book-settings.js).
import { EVT, fetchJson } from './_shared.js';

export const hubspotMethods = {

  // ─── HubSpot-Sync ────────────────────────────────────────────────────────
  // Sichtbar nur bei buchtyp === 'blog'. State im Card-Init: hubspotConnection,
  // hubspotForm, hubspotBusy/Action/Message/Error, hubspotBlogs, hubspotAuthors,
  // hubspotImportJobId. Job-Status-Polling via job-queue events.

  async loadHubspotStatus() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    try {
      const data = await fetchJson(`/hubspot/${bookId}/status`);
      this.hubspotConnection = data.connection || null;
      if (this.hubspotConnection) {
        this.hubspotForm.blogId   = this.hubspotConnection.blogId || '';
        this.hubspotForm.authorId = this.hubspotConnection.authorId || '';
        // Listen mit dem gespeicherten Token nachladen, damit Combos den
        // aktuellen Wert anzeigen können (Label statt nur ID).
        this.loadHubspotLists().catch(() => { /* still OK ohne Listen */ });
      }
      await this._reattachHubspotJobs(bookId);
    } catch (e) {
      console.error('[hubspot] Status laden fehlgeschlagen:', e);
    }
  },


  async _reattachHubspotJobs(bookId) {
    const probe = async (type) => {
      try {
        const list = await fetchJson(`/jobs/active?book_id=${encodeURIComponent(bookId)}&type=${encodeURIComponent(type)}`);
        return Array.isArray(list) && list.length ? list[0].jobId : null;
      } catch { return null; }
    };
    const [importId, reconcileId] = await Promise.all([
      probe('hubspot-import'), probe('hubspot-reconcile'),
    ]);
    this.hubspotImportJobId = importId;
    this.hubspotReconcileJobId = reconcileId;
  },


  hubspotFormReady() {
    const hasToken = !!this.hubspotForm.token || !!this.hubspotConnection;
    return hasToken && !!this.hubspotForm.blogId && !!this.hubspotForm.authorId;
  },


  _setHubspotBusy(action) {
    this.hubspotBusy = !!action;
    this.hubspotAction = action || null;
    if (action) { this.hubspotMessage = ''; this.hubspotError = ''; }
  },


  hubspotBlogOptions() {
    return (this.hubspotBlogs || []).map(b => ({ value: b.id, label: b.name }));
  },


  hubspotAuthorOptions() {
    return (this.hubspotAuthors || []).map(a => ({
      value: a.id,
      label: a.email ? `${a.name} <${a.email}>` : a.name,
    }));
  },


  async testHubspotConnection() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    this._setHubspotBusy('test');
    try {
      const body = {};
      if (this.hubspotForm.token) body.token = this.hubspotForm.token;
      else if (this.hubspotConnection) body.token = '__keep__';
      const res = await fetch(`/hubspot/${bookId}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error_code || 'HUBSPOT_TEST_FAILED');
      this.hubspotMessage = window.__app.t('hubspot.connect.testOk');
      await this.loadHubspotLists();
    } catch (e) {
      this.hubspotError = window.__app.t('hubspot.error.' + e.message) || e.message;
    } finally {
      this._setHubspotBusy(null);
    }
  },


  async loadHubspotLists() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    const tokenQ = this.hubspotForm.token
      ? `?token=${encodeURIComponent(this.hubspotForm.token)}`
      : '';
    try {
      const [blogs, authors] = await Promise.all([
        fetchJson(`/hubspot/${bookId}/blogs${tokenQ}`),
        fetchJson(`/hubspot/${bookId}/authors${tokenQ}`),
      ]);
      this.hubspotBlogs = blogs.blogs || [];
      this.hubspotAuthors = authors.authors || [];
    } catch (e) {
      console.error('[hubspot] Blogs/Authors laden fehlgeschlagen:', e);
    }
  },


  async saveHubspotConnection() {
    const bookId = window.__app.selectedBookId;
    if (!bookId || !this.hubspotFormReady()) return;
    this._setHubspotBusy('save');
    try {
      const body = {
        blogId: this.hubspotForm.blogId,
        authorId: this.hubspotForm.authorId,
      };
      if (this.hubspotForm.token) body.token = this.hubspotForm.token;
      else if (this.hubspotConnection) body.token = '__keep__';
      const res = await fetch(`/hubspot/${bookId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error_code || 'HUBSPOT_SAVE_FAILED');
      this.hubspotConnection = data.connection;
      this.hubspotForm.token = '';
      this.hubspotMessage = window.__app.t('hubspot.connect.saved');
    } catch (e) {
      this.hubspotError = window.__app.t('hubspot.error.' + e.message) || e.message;
    } finally {
      this._setHubspotBusy(null);
    }
  },


  async disconnectHubspot() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    if (!confirm(window.__app.t('hubspot.connect.disconnectConfirm'))) return;
    this._setHubspotBusy('disconnect');
    try {
      const res = await fetch(`/hubspot/${bookId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('HUBSPOT_DISCONNECT_FAILED');
      this.hubspotConnection = null;
      this.hubspotForm = { token: '', blogId: '', authorId: '' };
      this.hubspotBlogs = [];
      this.hubspotAuthors = [];
      this.hubspotMessage = window.__app.t('hubspot.connect.disconnected');
    } catch (e) {
      this.hubspotError = window.__app.t('hubspot.error.' + e.message) || e.message;
    } finally {
      this._setHubspotBusy(null);
    }
  },


  async startHubspotImport() {
    const bookId = window.__app.selectedBookId;
    if (!bookId || this.hubspotImportJobId) return;
    try {
      const res = await fetch('/jobs/hubspot-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_code || 'HUBSPOT_IMPORT_FAILED');
      this.hubspotImportJobId = data.jobId;
      window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, { detail: { type: 'hubspot-import', jobId: data.jobId } }));
    } catch (e) {
      this.hubspotError = window.__app.t('hubspot.error.' + e.message) || e.message;
    }
  },


  async startHubspotReconcile() {
    const bookId = window.__app.selectedBookId;
    if (!bookId || this.hubspotReconcileJobId) return;
    if (!confirm(window.__app.t('hubspot.action.reconcileConfirm'))) return;
    try {
      const res = await fetch('/jobs/hubspot-reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_code || 'HUBSPOT_RECONCILE_FAILED');
      this.hubspotReconcileJobId = data.jobId;
      window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, { detail: { type: 'hubspot-reconcile', jobId: data.jobId } }));
    } catch (e) {
      this.hubspotError = window.__app.t('hubspot.error.' + e.message) || e.message;
    }
  },
};
