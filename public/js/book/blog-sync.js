// Root-Slice: Blog-Sync (WordPress) State + Methoden.
//
// Wird in den Root-Scope (`lektorat`) gespreaded, damit sowohl Buchorganizer
// als auch Editor-Karte Badge + Push-Button rendern können. Der Sync-Status
// gilt pro Page und ist von Tree-Sicht unabhängig.
//
// State:
//   blogConnected: false        — Buchtyp 'blog' + Connection vorhanden.
//   blogLinksMap:  {}           — pageId → { wp_post_id, wp_modified_at, last_pulled_at, last_pushed_at, conflict_state }.
//   blogPushBusy:  {}           — pageId → bool (Push läuft).
//   blogPushProgress: {}        — pageId → number (0..100, live aus /jobs/:id).
//   blogConflictOpen: null      — pageId des im Konflikt-Diff offenen Seiten.
//   blogConflictData: null      — { pageId, local:{name,html}, remote:{title,html,modifiedAt} }.

export function blogState() {
  return {
    blogConnected: false,
    blogLinksMap: {},
    blogPushBusy: {},
    blogPushProgress: {},
    _blogPushTimers: {},
    blogConflictOpen: null,
    blogConflictData: null,
    _blogSyncInstalled: false,
  };
}

export const blogSyncMethods = {
  setupBlogSync() {
    if (this._blogSyncInstalled) return;
    this._blogSyncInstalled = true;
    window.addEventListener('pages:loaded', () => this.loadBlogLinks());
    window.addEventListener('book:changed', () => {
      for (const t of Object.values(this._blogPushTimers)) clearInterval(t);
      this._blogPushTimers = {};
      this.blogConnected = false;
      this.blogLinksMap = {};
      this.blogPushBusy = {};
      this.blogPushProgress = {};
      this.blogConflictOpen = null;
      this.blogConflictData = null;
    });
    window.addEventListener('job:finished', (ev) => {
      const t = ev?.detail?.type;
      if (t !== 'blog-import' && t !== 'blog-pull' && t !== 'blog-push') return;
      if (t === 'blog-import' || t === 'blog-pull') {
        this.loadPages?.();
      } else {
        this.loadBlogLinks();
      }
    });
  },

  // Endpoint /blog/:book_id/links liefert `connected: false`, wenn Buchtyp
  // != 'blog' oder keine Connection gespeichert ist — kein zusätzlicher
  // Client-Gate nötig.
  async loadBlogLinks() {
    const bookId = this.selectedBookId;
    if (!bookId) {
      this.blogConnected = false;
      this.blogLinksMap = {};
      return;
    }
    try {
      const res = await fetch(`/blog/${bookId}/links`);
      if (!res.ok) {
        this.blogConnected = false;
        this.blogLinksMap = {};
        return;
      }
      const data = await res.json();
      this.blogConnected = !!data.connected;
      const map = {};
      for (const link of (data.links || [])) map[link.page_id] = link;
      this.blogLinksMap = map;
    } catch (e) {
      console.error('[blogSync] Blog-Links laden fehlgeschlagen:', e);
    }
  },

  // Badge-Status für eine Page (oder null = kein Badge).
  // 'new'         — kein Link → lokal angelegt, noch nie zu WP gepusht.
  // 'conflict'    — beide Seiten geändert, conflict_state='detected'.
  // 'push-needed' — Page lokal geändert seit last_pulled_at/last_pushed_at.
  // 'synced'      — Stand identisch zum WP-Snapshot.
  blogStatusFor(page) {
    if (!this.blogConnected || !page) return null;
    const link = this.blogLinksMap[page.id];
    if (!link) return 'new';
    if (link.conflict_state === 'detected') return 'conflict';
    const lastSync = link.last_pushed_at || link.last_pulled_at || '';
    const pageUpdated = page.updated_at || '';
    if (pageUpdated && lastSync && pageUpdated > lastSync) return 'push-needed';
    return 'synced';
  },

  blogStatusLabel(status) {
    if (!status) return '';
    const map = {
      synced: 'blog.status.synced',
      'push-needed': 'blog.status.pushNeeded',
      conflict: 'blog.status.conflict',
      new: 'blog.status.newLocal',
    };
    return this.t(map[status] || '');
  },

  canBlogPush(page) {
    const s = this.blogStatusFor(page);
    return s === 'new' || s === 'push-needed';
  },

  async pushPageToBlog(pageId) {
    const bookId = this.selectedBookId;
    if (!bookId) return;
    if (this.blogPushBusy[pageId]) return;
    this.blogPushBusy = { ...this.blogPushBusy, [pageId]: true };
    this.blogPushProgress = { ...this.blogPushProgress, [pageId]: 0 };
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
        this._pollBlogPush(pageId, data.jobId);
      }
    } catch (e) {
      console.error('[blogSync] Push fehlgeschlagen:', e);
      this._clearBlogPushBusy(pageId);
    }
  },

  _pollBlogPush(pageId, jobId) {
    const tick = async () => {
      try {
        const resp = await fetch('/jobs/' + jobId);
        if (resp.status === 404) { this._clearBlogPushBusy(pageId); return; }
        if (!resp.ok) return;
        const job = await resp.json();
        const next = { ...this.blogPushProgress, [pageId]: job.progress || 0 };
        this.blogPushProgress = next;
        if (job.status === 'running' || job.status === 'queued') return;
        this._clearBlogPushBusy(pageId);
        if (job.status !== 'error' && job.status !== 'cancelled') this.loadBlogLinks();
      } catch (e) { /* swallow; nächster Tick versucht erneut */ }
    };
    if (this._blogPushTimers[pageId]) clearInterval(this._blogPushTimers[pageId]);
    this._blogPushTimers = { ...this._blogPushTimers, [pageId]: setInterval(tick, 1000) };
    tick();
  },

  _clearBlogPushBusy(pageId) {
    if (this._blogPushTimers[pageId]) {
      clearInterval(this._blogPushTimers[pageId]);
      const t = { ...this._blogPushTimers }; delete t[pageId]; this._blogPushTimers = t;
    }
    const b = { ...this.blogPushBusy }; delete b[pageId]; this.blogPushBusy = b;
    const p = { ...this.blogPushProgress }; delete p[pageId]; this.blogPushProgress = p;
  },

  async openBlogConflict(pageId) {
    const bookId = this.selectedBookId;
    if (!bookId) return;
    this.blogConflictOpen = pageId;
    this.blogConflictData = null;
    try {
      const { contentRepo } = await import('../repo/content.js');
      const [remoteRes, localPage] = await Promise.all([
        fetch(`/blog/${bookId}/pages/${pageId}/remote`).then(r => r.ok ? r.json() : Promise.reject(r)),
        contentRepo.loadPage(pageId),
      ]);
      this.blogConflictData = {
        pageId,
        local: { name: localPage.name || localPage.page_name || '', html: localPage.html || localPage.body_html || '' },
        remote: { title: remoteRes.title || '', html: remoteRes.html || '', modifiedAt: remoteRes.modifiedAt || '' },
      };
    } catch (e) {
      console.error('[blogSync] Konflikt-Diff laden fehlgeschlagen:', e);
      this.blogConflictOpen = null;
    }
  },

  closeBlogConflict() {
    this.blogConflictOpen = null;
    this.blogConflictData = null;
  },

  async resolveBlogConflict(side) {
    if (!this.blogConflictOpen) return;
    const bookId = this.selectedBookId;
    const pageId = this.blogConflictOpen;
    try {
      const res = await fetch(`/blog/${bookId}/pages/${pageId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolve: side }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_code || 'BLOG_RESOLVE_FAILED');
      this.closeBlogConflict();
      await this.loadBlogLinks();
      if (side === 'wp') this.loadPages?.();
    } catch (e) {
      console.error('[blogSync] Resolve fehlgeschlagen:', e);
    }
  },
};
