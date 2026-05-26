// Alpine.data('hubspotSyncCard') — HubSpot-Sync-Subsystem (Page-Status,
// Create-as-Draft-Push). Headless display-contents-Anker, via `$hubspot`-Magic
// global im Template erreichbar. Status-Modell minimal: nur 'new' (kein Link)
// und 'pushed' (Link existiert). Re-Push ist blockiert; HubSpot uebernimmt.

export function registerHubspotSyncCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('hubspotSyncCard', () => ({
    connected: false,
    blogId: '',
    linksMap: {},
    pushBusy: {},
    pushProgress: {},
    _pushTimers: {},

    init() {
      window.__hubspotCard = this;
      window.addEventListener('pages:loaded', () => this.loadLinks());
      window.addEventListener('book:changed', () => {
        for (const t of Object.values(this._pushTimers)) clearInterval(t);
        this._pushTimers = {};
        this.connected = false;
        this.blogId = '';
        this.linksMap = {};
        this.pushBusy = {};
        this.pushProgress = {};
      });
      window.addEventListener('job:finished', (ev) => {
        const t = ev?.detail?.type;
        if (t === 'hubspot-import') {
          window.__app?.loadPages?.();
        } else if (t === 'hubspot-push') {
          this.loadLinks();
        }
      });
    },

    destroy() {
      for (const t of Object.values(this._pushTimers)) clearInterval(t);
      this._pushTimers = {};
      if (window.__hubspotCard === this) window.__hubspotCard = null;
    },

    async loadLinks() {
      const bookId = window.__app?.selectedBookId;
      if (!bookId) {
        this.connected = false;
        this.blogId = '';
        this.linksMap = {};
        return;
      }
      try {
        const res = await fetch(`/hubspot/${bookId}/links`);
        if (!res.ok) {
          this.connected = false;
          this.blogId = '';
          this.linksMap = {};
          return;
        }
        const data = await res.json();
        this.connected = !!data.connected;
        this.blogId = data.blogId || '';
        const map = {};
        for (const link of (data.links || [])) map[link.page_id] = link;
        this.linksMap = map;
      } catch (e) {
        console.error('[hubspotSync] Links laden fehlgeschlagen:', e);
      }
    },

    statusFor(page) {
      if (!this.connected || !page) return null;
      return this.linksMap[page.id] ? 'pushed' : 'new';
    },

    statusLabel(status) {
      if (!status) return '';
      const map = {
        new:    'hubspot.status.new',
        pushed: 'hubspot.status.pushed',
      };
      return window.__app?.t(map[status] || '') || '';
    },

    canPush(page) {
      return this.statusFor(page) === 'new';
    },

    async push(pageId) {
      const bookId = window.__app?.selectedBookId;
      if (!bookId) return;
      if (this.pushBusy[pageId]) return;
      this.pushBusy = { ...this.pushBusy, [pageId]: true };
      this.pushProgress = { ...this.pushProgress, [pageId]: 0 };
      try {
        const res = await fetch('/jobs/hubspot-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ book_id: bookId, page_ids: [pageId] }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error_code || 'HUBSPOT_PUSH_FAILED');
        if (data.jobId) {
          window.dispatchEvent(new CustomEvent('job:enqueued', { detail: { type: 'hubspot-push', jobId: data.jobId } }));
          this._pollPush(pageId, data.jobId);
        }
      } catch (e) {
        console.error('[hubspotSync] Push fehlgeschlagen:', e);
        this._clearPushBusy(pageId);
      }
    },

    _pollPush(pageId, jobId) {
      const tick = async () => {
        try {
          const resp = await fetch('/jobs/' + jobId);
          if (resp.status === 404) { this._clearPushBusy(pageId); return; }
          if (!resp.ok) return;
          const job = await resp.json();
          this.pushProgress = { ...this.pushProgress, [pageId]: job.progress || 0 };
          if (job.status === 'running' || job.status === 'queued') return;
          this._clearPushBusy(pageId);
          if (job.status !== 'error' && job.status !== 'cancelled') this.loadLinks();
        } catch (e) { /* swallow; nächster Tick versucht erneut */ }
      };
      if (this._pushTimers[pageId]) clearInterval(this._pushTimers[pageId]);
      this._pushTimers = { ...this._pushTimers, [pageId]: setInterval(tick, 1000) };
      tick();
    },

    _clearPushBusy(pageId) {
      if (this._pushTimers[pageId]) {
        clearInterval(this._pushTimers[pageId]);
        const t = { ...this._pushTimers }; delete t[pageId]; this._pushTimers = t;
      }
      const b = { ...this.pushBusy }; delete b[pageId]; this.pushBusy = b;
      const p = { ...this.pushProgress }; delete p[pageId]; this.pushProgress = p;
    },
  }));
}
