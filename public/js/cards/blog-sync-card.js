// Alpine.data('blogSyncCard') — WordPress-Sync-Subsystem (Status pro Page,
// Push-Job + Progress-Polling, Konflikt-Diff). Lebt als headless display-
// contents-Anker in index.html und ist via `$blog`-Magic global erreichbar.
// Root-Zugriffe (selectedBookId, loadPages, t) gehen über window.__app.

export function registerBlogSyncCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('blogSyncCard', () => ({
    connected: false,
    baseUrl: '',
    linksMap: {},
    pushBusy: {},
    pushProgress: {},
    _pushTimers: {},
    conflictOpen: null,
    conflictData: null,

    init() {
      window.__blogCard = this;
      window.addEventListener('pages:loaded', () => this.loadLinks());
      window.addEventListener('book:changed', () => {
        for (const t of Object.values(this._pushTimers)) clearInterval(t);
        this._pushTimers = {};
        this.connected = false;
        this.baseUrl = '';
        this.linksMap = {};
        this.pushBusy = {};
        this.pushProgress = {};
        this.conflictOpen = null;
        this.conflictData = null;
      });
      window.addEventListener('job:finished', (ev) => {
        const t = ev?.detail?.type;
        if (t !== 'blog-import' && t !== 'blog-pull' && t !== 'blog-push') return;
        if (t === 'blog-import' || t === 'blog-pull') {
          window.__app?.loadPages?.();
        } else {
          this.loadLinks();
        }
      });
    },

    destroy() {
      for (const t of Object.values(this._pushTimers)) clearInterval(t);
      this._pushTimers = {};
      if (window.__blogCard === this) window.__blogCard = null;
    },

    // Endpoint /blog/:book_id/links liefert `connected: false`, wenn Buchtyp
    // != 'blog' oder keine Connection gespeichert ist — kein zusätzlicher
    // Client-Gate nötig.
    async loadLinks() {
      const bookId = window.__app?.selectedBookId;
      if (!bookId) {
        this.connected = false;
        this.baseUrl = '';
        this.linksMap = {};
        return;
      }
      try {
        const res = await fetch(`/blog/${bookId}/links`);
        if (!res.ok) {
          this.connected = false;
          this.baseUrl = '';
          this.linksMap = {};
          return;
        }
        const data = await res.json();
        this.connected = !!data.connected;
        this.baseUrl = data.baseUrl || '';
        const map = {};
        for (const link of (data.links || [])) map[link.page_id] = link;
        this.linksMap = map;
      } catch (e) {
        console.error('[blogSync] Blog-Links laden fehlgeschlagen:', e);
      }
    },

    // WordPress-Frontend-URL fuer eine verlinkte Page (`?p=ID` funktioniert
    // unabhaengig vom Permalink-Setup; bei Drafts liefert WP eine
    // Preview-/Login-Seite, je nach Session des Browsers).
    viewUrl(page) {
      if (!page || !this.baseUrl) return '';
      const link = this.linksMap[page.id];
      if (!link || !link.wp_post_id) return '';
      const base = this.baseUrl.replace(/\/$/, '');
      return `${base}/?p=${link.wp_post_id}`;
    },

    // Badge-Status für eine Page (oder null = kein Badge).
    // 'new'         — kein Link → lokal angelegt, noch nie zu WP gepusht.
    // 'conflict'    — beide Seiten geändert, conflict_state='detected'.
    // 'push-needed' — Page lokal geändert seit last_pulled_at/last_pushed_at.
    // 'synced'      — Stand identisch zum WP-Snapshot.
    statusFor(page) {
      if (!this.connected || !page) return null;
      const link = this.linksMap[page.id];
      if (!link) return 'new';
      if (link.conflict_state === 'detected') return 'conflict';
      const lastSync = link.last_pushed_at || link.last_pulled_at || '';
      const pageUpdated = page.updated_at || '';
      if (pageUpdated && lastSync && pageUpdated > lastSync) return 'push-needed';
      return 'synced';
    },

    statusLabel(status) {
      if (!status) return '';
      const map = {
        synced: 'blog.status.synced',
        'push-needed': 'blog.status.pushNeeded',
        conflict: 'blog.status.conflict',
        new: 'blog.status.newLocal',
      };
      return window.__app?.t(map[status] || '') || '';
    },

    canPush(page) {
      const s = this.statusFor(page);
      return s === 'new' || s === 'push-needed';
    },

    async push(pageId) {
      const bookId = window.__app?.selectedBookId;
      if (!bookId) return;
      if (this.pushBusy[pageId]) return;
      this.pushBusy = { ...this.pushBusy, [pageId]: true };
      this.pushProgress = { ...this.pushProgress, [pageId]: 0 };
      try {
        const res = await fetch('/jobs/blog-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ book_id: bookId, page_ids: [pageId] }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error_code || 'BLOG_PUSH_FAILED');
        if (data.jobId) {
          window.dispatchEvent(new CustomEvent('job:enqueued', { detail: { type: 'blog-push', jobId: data.jobId } }));
          this._pollPush(pageId, data.jobId);
        }
      } catch (e) {
        console.error('[blogSync] Push fehlgeschlagen:', e);
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
          const next = { ...this.pushProgress, [pageId]: job.progress || 0 };
          this.pushProgress = next;
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

    async openConflict(pageId) {
      const bookId = window.__app?.selectedBookId;
      if (!bookId) return;
      this.conflictOpen = pageId;
      this.conflictData = null;
      try {
        const { contentRepo } = await import('../repo/content.js');
        const [remoteRes, localPage] = await Promise.all([
          fetch(`/blog/${bookId}/pages/${pageId}/remote`).then(r => r.ok ? r.json() : Promise.reject(r)),
          contentRepo.loadPage(pageId),
        ]);
        this.conflictData = {
          pageId,
          local: { name: localPage.name || localPage.page_name || '', html: localPage.html || localPage.body_html || '' },
          remote: { title: remoteRes.title || '', html: remoteRes.html || '', modifiedAt: remoteRes.modifiedAt || '' },
        };
      } catch (e) {
        console.error('[blogSync] Konflikt-Diff laden fehlgeschlagen:', e);
        this.conflictOpen = null;
      }
    },

    closeConflict() {
      this.conflictOpen = null;
      this.conflictData = null;
    },

    async resolveConflict(side) {
      if (!this.conflictOpen) return;
      const bookId = window.__app?.selectedBookId;
      const pageId = this.conflictOpen;
      try {
        const res = await fetch(`/blog/${bookId}/pages/${pageId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resolve: side }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error_code || 'BLOG_RESOLVE_FAILED');
        this.closeConflict();
        await this.loadLinks();
        if (side === 'wp') window.__app?.loadPages?.();
      } catch (e) {
        console.error('[blogSync] Resolve fehlgeschlagen:', e);
      }
    },
  }));
}
