// View-Slice: UI-State (collapse, search, jump) + Filter-Getter + Helper für
// die Move-Combobox. Keine Daten-Mutation — alles, was Server-State ändert,
// lebt in dnd/persist/crud.
//
// chapterOpen ist ein per-chapter-id Object-Map. Beim ersten Snapshot wird
// COLLAPSE_THRESHOLD geprüft: > N Kapitel → alle zu, sonst alle auf. Inkremen-
// telle Re-Snapshots (z.B. nach pages:loaded) übernehmen den User-Zustand und
// ergänzen nur neue/entfernte IDs.

const COLLAPSE_THRESHOLD = 8;
const MAX_CHAPTER_DEPTH = 3; // SSoT in db/book-order.js — Frontend-Mirror.

function _walkAllIds(chapters, out = []) {
  for (const c of chapters) {
    out.push(c.id);
    _walkAllIds(c.subchapters || [], out);
  }
  return out;
}

export const viewMethods = {
  _recomputeInitialOpenState() {
    const ids = _walkAllIds(this.workTree);
    const knownKeys = Object.keys(this.chapterOpen);
    if (knownKeys.length === 0) {
      const wantOpen = ids.length <= COLLAPSE_THRESHOLD;
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
    for (const id of _walkAllIds(this.workTree)) next[id] = true;
    this.chapterOpen = next;
  },

  collapseAll() {
    const next = {};
    for (const id of _walkAllIds(this.workTree)) next[id] = false;
    this.chapterOpen = next;
  },

  // Rekursiver Suchfilter: zeigt Kapitel, wenn Name-Match ODER ein Sub-/Page
  // tief drunter matched. Sub-Tree bleibt fuer Kontext sichtbar (alle Pages des
  // matched Kapitels, alle matchenden Pages sonst).
  _filterChapter(ch, q) {
    const nameMatch = ch.name.toLowerCase().includes(q);
    const pages = nameMatch ? ch.pages : ch.pages.filter(p => p.name.toLowerCase().includes(q));
    const subs = (ch.subchapters || [])
      .map(s => this._filterChapter(s, q))
      .filter(Boolean);
    if (!nameMatch && pages.length === 0 && subs.length === 0) return null;
    return { ...ch, pages, subchapters: subs };
  },

  filteredWorkTree() {
    const q = (this.organizerSearch || '').trim().toLowerCase();
    if (!q) return this.workTree;
    return this.workTree.map(ch => this._filterChapter(ch, q)).filter(Boolean);
  },

  filteredSoloPages() {
    const q = (this.organizerSearch || '').trim().toLowerCase();
    if (!q) return this.soloPages;
    return this.soloPages.filter(p => p.name.toLowerCase().includes(q));
  },

  // Findet ein Kapitel im workTree (rekursiv) + liefert Pfad fuer Parent-Lookups.
  _findChapter(id) {
    const stack = [{ list: this.workTree, parent: null, parentList: null }];
    while (stack.length) {
      const { list, parent, parentList } = stack.pop();
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c.id === id) return { node: c, parent, parentList: list, index: i };
        if (c.subchapters?.length) stack.push({ list: c.subchapters, parent: c, parentList: list });
      }
    }
    return null;
  },

  // Sammelt alle Nachfahren-Kapitel-IDs eines Knotens (Cycle-Prevention bei DnD).
  _descendantIdsOf(ch) {
    const ids = new Set();
    function walk(node) {
      for (const sub of (node.subchapters || [])) {
        ids.add(sub.id);
        walk(sub);
      }
    }
    walk(ch);
    return ids;
  },

  // Maximale Tiefe im Subtree (1 = nur dieses Kapitel, keine Subs).
  _subtreeDepth(ch) {
    if (!ch.subchapters?.length) return 1;
    return 1 + Math.max(...ch.subchapters.map(s => this._subtreeDepth(s)));
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
    // Alle Vorfahren oeffnen, damit das Kapitel sichtbar ist.
    const found = this._findChapter(chId);
    if (found) {
      const opens = { ...this.chapterOpen, [chId]: true };
      let cur = found.parent;
      while (cur) {
        opens[cur.id] = true;
        const up = this._findChapter(cur.id);
        cur = up?.parent || null;
      }
      this.chapterOpen = opens;
    } else {
      this.chapterOpen = { ...this.chapterOpen, [chId]: true };
    }
    await this.$nextTick();
    const el = this.$root.querySelector(`[data-chapter-id="${chId}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.jumpToChapterId = '';
  },

  // Options-Array für Move-Combobox pro Page. Listet alle Kapitel rekursiv mit
  // Einrueckungspraefix, damit die Hierarchie im Picker erkennbar bleibt.
  chapterMoveOptions(currentChId) {
    const root = window.__app;
    const opts = [];
    if (currentChId !== 0) opts.push({ value: 0, label: root.t('bookOrganizer.soloHeader') });
    function walk(list, depth) {
      for (const ch of list) {
        if (ch.id !== currentChId) {
          const prefix = depth > 1 ? '— '.repeat(depth - 1) : '';
          opts.push({ value: ch.id, label: prefix + ch.name });
        }
        walk(ch.subchapters || [], depth + 1);
      }
    }
    walk(this.workTree, 1);
    return opts;
  },

  // Alle Top-Level-Kapitel als Optionen fuer die Jump-Combobox (rekursiv).
  jumpChapterOptions() {
    const opts = [];
    function walk(list, depth) {
      for (const ch of list) {
        const prefix = depth > 1 ? '— '.repeat(depth - 1) : '';
        opts.push({ value: ch.id, label: prefix + ch.name });
        walk(ch.subchapters || [], depth + 1);
      }
    }
    walk(this.workTree, 1);
    return opts;
  },

  // Promote-Validierung: Kapitel auf Top-Level (depth=1) hat keinen Parent.
  canPromoteChapter(id) {
    const found = this._findChapter(id);
    return !!(found && found.node.depth > 1);
  },

  // Demote-Validierung: Vor-Geschwister muss existieren UND subtreeDepth + 1 darf
  // MAX_CHAPTER_DEPTH nicht ueberschreiten.
  canDemoteChapter(id) {
    const found = this._findChapter(id);
    if (!found) return false;
    if (found.index === 0) return false; // kein Vor-Geschwister
    const movingSubtreeDepth = this._subtreeDepth(found.node);
    const newDepth = found.node.depth + 1;
    return (newDepth + movingSubtreeDepth - 1) <= MAX_CHAPTER_DEPTH;
  },

  // Tab / Shift+Tab im Kapitel-Input: bei moeglicher Aktion preventDefault +
  // promote/demote; sonst native Tab durchlassen (Fokus-Move).
  onChapterTab(ev, id) {
    if (ev.shiftKey) {
      if (this.canPromoteChapter(id)) {
        ev.preventDefault();
        this.promoteChapter(id);
      }
    } else {
      if (this.canDemoteChapter(id)) {
        ev.preventDefault();
        this.demoteChapter(id);
      }
    }
  },

  // ── Blog-Sync (WordPress) ────────────────────────────────────────────────

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
