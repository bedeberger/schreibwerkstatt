// View-Slice: UI-State (collapse, search, jump) + Filter-Getter + Helper für
// die Move-Combobox. Keine Daten-Mutation — alles, was Server-State ändert,
// lebt in dnd/persist/crud.
//
// chapterOpen ist ein per-chapter-id Object-Map. Beim ersten Snapshot wird
// COLLAPSE_THRESHOLD geprüft: > N Kapitel → alle zu, sonst alle auf. Inkremen-
// telle Re-Snapshots (z.B. nach pages:loaded) übernehmen den User-Zustand und
// ergänzen nur neue/entfernte IDs.

const COLLAPSE_THRESHOLD = 8;

export const viewMethods = {
  _recomputeInitialOpenState() {
    const ids = this.workTree.map(c => c.id);
    const knownKeys = Object.keys(this.chapterOpen);
    if (knownKeys.length === 0) {
      const wantOpen = this.workTree.length <= COLLAPSE_THRESHOLD;
      const next = {};
      for (const id of ids) next[id] = wantOpen;
      this.chapterOpen = next;
      return;
    }
    const next = { ...this.chapterOpen };
    for (const id of ids) if (next[id] === undefined) next[id] = false;
    for (const k of knownKeys) {
      const id = parseInt(k, 10);
      if (!ids.includes(id)) delete next[k];
    }
    this.chapterOpen = next;
  },

  toggleChapter(id) {
    this.chapterOpen = { ...this.chapterOpen, [id]: !this.chapterOpen[id] };
  },

  expandAll() {
    const next = {};
    for (const c of this.workTree) next[c.id] = true;
    this.chapterOpen = next;
  },

  collapseAll() {
    const next = {};
    for (const c of this.workTree) next[c.id] = false;
    this.chapterOpen = next;
  },

  // Methoden statt ES-Getter — beim {...viewMethods}-Spread in der Facade
  // würden Getter aufgerufen (this=POJO, workTree=undefined) und das Ergebnis
  // als statisches Property eingefroren. Methoden bleiben durch Spread erhalten.
  filteredWorkTree() {
    const q = (this.organizerSearch || '').trim().toLowerCase();
    if (!q) return this.workTree;
    return this.workTree.map(ch => {
      const nameMatch = ch.name.toLowerCase().includes(q);
      const pages = nameMatch ? ch.pages : ch.pages.filter(p => p.name.toLowerCase().includes(q));
      if (!nameMatch && pages.length === 0) return null;
      return { ...ch, pages };
    }).filter(Boolean);
  },

  filteredSoloPages() {
    const q = (this.organizerSearch || '').trim().toLowerCase();
    if (!q) return this.soloPages;
    return this.soloPages.filter(p => p.name.toLowerCase().includes(q));
  },

  // SortableJS bei aktiver Suche disablen — gefilterter DOM-Zustand würde
  // Reorder verfälschen. Wird via $watch('organizerSearch') und nach jedem
  // _initSortables-Lauf getriggert.
  _refreshSortableDisabled() {
    const disabled = !!(this.organizerSearch || '').trim();
    for (const s of (this._sortables || [])) {
      try { s.option('disabled', disabled); } catch {}
    }
  },

  async jumpToChapter(chIdRaw) {
    const chId = parseInt(chIdRaw, 10);
    if (!chId) return;
    this.chapterOpen = { ...this.chapterOpen, [chId]: true };
    await this.$nextTick();
    const el = this.$root.querySelector(`[data-chapter-id="${chId}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.jumpToChapterId = '';
  },

  // Options-Array für Move-Combobox pro Page. Inline im x-effect aufrufbar,
  // weil die gelesenen Reactive-Felder (workTree, ch.name) Alpine-getrackt sind.
  chapterMoveOptions(currentChId) {
    const root = window.__app;
    const opts = [];
    if (currentChId !== 0) opts.push({ value: 0, label: root.t('bookOrganizer.soloHeader') });
    for (const ch of this.workTree) {
      if (ch.id === currentChId) continue;
      opts.push({ value: ch.id, label: ch.name });
    }
    return opts;
  },

  // ── Blog-Sync (WordPress) ────────────────────────────────────────────────

  // Endpoint /blog/:book_id/links liefert `connected: false`, wenn Buchtyp
  // != 'blog' oder keine Connection gespeichert ist — kein zusaetzlicher
  // Client-Gate noetig.
  async loadBlogLinks() {
    const bookId = window.__app.selectedBookId;
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
      console.error('[bookOrganizer] Blog-Links laden fehlgeschlagen:', e);
    }
  },

  // Liefert Badge-Status für eine Page (oder null = kein Badge).
  // 'new'        — kein Link → wurde lokal angelegt, noch nie zu WP gepusht.
  // 'conflict'   — beide Seiten haben Änderungen, conflict_state='detected'.
  // 'push-needed' — Page lokal geändert seit last_pulled_at/last_pushed_at.
  // 'synced'     — Stand identisch zum WP-Snapshot.
  blogStatusFor(page) {
    if (!this.blogConnected) return null;
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
    return window.__app.t(map[status] || '');
  },

  canBlogPush(page) {
    const s = this.blogStatusFor(page);
    return s === 'new' || s === 'push-needed';
  },

  async pushPageToBlog(pageId) {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    if (this.blogPushBusy[pageId]) return;
    this.blogPushBusy = { ...this.blogPushBusy, [pageId]: true };
    try {
      const res = await fetch('/jobs/blog-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, page_ids: [pageId] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_code || 'BLOG_PUSH_FAILED');
    } catch (e) {
      console.error('[bookOrganizer] Push fehlgeschlagen:', e);
      const next = { ...this.blogPushBusy };
      delete next[pageId];
      this.blogPushBusy = next;
    }
  },

  // Konflikt-Diff öffnen: WP-Version laden und in Modal anzeigen.
  async openBlogConflict(pageId) {
    const bookId = window.__app.selectedBookId;
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
      console.error('[bookOrganizer] Konflikt-Diff laden fehlgeschlagen:', e);
      this.blogConflictOpen = null;
    }
  },

  closeBlogConflict() {
    this.blogConflictOpen = null;
    this.blogConflictData = null;
  },

  async resolveBlogConflict(side) {
    if (!this.blogConflictOpen) return;
    const bookId = window.__app.selectedBookId;
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
      if (side === 'wp') window.__app.loadPages?.();
    } catch (e) {
      console.error('[bookOrganizer] Resolve fehlgeschlagen:', e);
    }
  },
};
