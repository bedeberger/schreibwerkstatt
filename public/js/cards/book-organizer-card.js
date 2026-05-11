// Alpine.data('bookOrganizerCard') — Sub-Komponente Buchorganizer.
//
// Reorder/Move (DnD via SortableJS, lazy), Create/Rename/Delete für Kapitel +
// Seiten. Keine KI, keine Job-Queue — direkter BookStack-API-Zugriff via
// Root-bsGet/bsPut/bsPost/bsDelete-Helper.
//
// Speicher-Strategie: nach jeder erfolgreichen Mutation patchen wir den
// Root-Tree IN-PLACE. Kein `loadPages()` (würde root.pages + root.tree
// reassignen → ganze App-UI re-rendert, sichtbarer Flicker). Sidebar liest
// dieselben Items, die wir mutieren, und re-rendert nur die betroffenen Stellen
// via Alpine-Deep-Reactivity.
//
// Re-Snapshot der Card-Visualisierung passiert ausschliesslich über das
// `pages:loaded`-Event aus tree.js (echte Server-Reloads, z.B. Buchwechsel) —
// nicht über einen $watch der Tree-Identität, sonst würden eigene
// Reassignments im Tree (nicht der Fall mehr, aber als Safety) zur
// Selbst-Reentry führen.

import { setupCardLifecycle } from './card-lifecycle.js';
import { loadSortable } from '../lazy-libs.js';

export function registerBookOrganizerCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookOrganizerCard', () => ({
    organizerSaving: false,
    organizerStatus: '',
    organizerProgress: 0,
    workTree: [],      // [{ id, name, pages: [{ id, name, chapter_id }] }]
    soloPages: [],     // [{ id, name, chapter_id: 0 }]
    _sortables: [],
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'bookOrganizer',
        showFlag: 'showBookOrganizerCard',
        resetState: { workTree: [], soloPages: [], organizerStatus: '', organizerProgress: 0, organizerSaving: false },
        onShow: async () => {
          await loadSortable();
          await this._rerender();
        },
        // book:changed feuert VOR loadPages — Sortable cleanen + State leeren,
        // der pages:loaded-Listener unten greift, sobald loadPages fertig ist.
        onBookChanged: (e, ctx) => {
          ctx._destroySortables();
          Object.assign(ctx, { workTree: [], soloPages: [], organizerStatus: '', organizerProgress: 0, organizerSaving: false });
        },
        onCardRefresh: async (e, ctx, root) => {
          await root.loadPages(); // pages:loaded triggert _rerender
        },
        onViewReset: (e, ctx) => {
          ctx._destroySortables();
          Object.assign(ctx, { workTree: [], soloPages: [] });
        },
        extraListeners: [
          { type: 'pages:loaded', handler: async () => {
            if (!window.__app.showBookOrganizerCard) return;
            await loadSortable();
            await this._rerender();
          } },
        ],
      });
    },

    destroy() {
      this._destroySortables();
      this._lifecycle?.destroy();
    },

    async _rerender() {
      this._destroySortables();
      this._snapshotFromRoot();
      await this.$nextTick();
      this._initSortables();
    },

    _snapshotFromRoot() {
      const root = window.__app;
      const tree = root.tree || [];
      this.workTree = tree
        .filter(it => it.type === 'chapter' && !it.solo)
        .map(c => ({
          id: c.id,
          name: c.name,
          pages: (c.pages || []).map(p => ({ id: p.id, name: p.name, chapter_id: p.chapter_id })),
        }));
      this.soloPages = tree
        .filter(it => it.type === 'chapter' && it.solo)
        .map(it => it.pages[0])
        .filter(Boolean)
        .map(p => ({ id: p.id, name: p.name, chapter_id: 0 }));
    },

    _destroySortables() {
      for (const s of this._sortables) { try { s.destroy(); } catch {} }
      this._sortables = [];
    },

    _initSortables() {
      const Sortable = window.Sortable;
      if (!Sortable) return;
      this._destroySortables();
      const chapterListEl = this.$root.querySelector('[data-organizer="chapter-list"]');
      if (chapterListEl) {
        this._sortables.push(new Sortable(chapterListEl, {
          handle: '.organizer-drag-handle--chapter',
          animation: 150,
          draggable: '.organizer-chapter',
          onEnd: (evt) => this._onChapterDrop(evt),
        }));
      }
      const pageLists = this.$root.querySelectorAll('[data-organizer="page-list"]');
      for (const el of pageLists) {
        this._sortables.push(new Sortable(el, {
          handle: '.organizer-drag-handle',
          animation: 150,
          draggable: '.organizer-page',
          group: { name: 'pages', pull: true, put: true },
          onEnd: (evt) => this._onPageDrop(evt),
        }));
      }
    },

    _parseChapterIdAttr(el) {
      const raw = el?.dataset?.chapterId;
      if (raw == null || raw === '' || raw === 'null' || raw === '0') return 0;
      return parseInt(raw, 10) || 0;
    },

    async _onChapterDrop(evt) {
      if (this.organizerSaving) return;
      if (evt.oldIndex === evt.newIndex) return;
      const ids = [...evt.to.querySelectorAll('.organizer-chapter[data-chapter-id]')]
        .map(el => parseInt(el.dataset.chapterId, 10));
      const idxOf = new Map(ids.map((id, i) => [id, i]));
      // In-place sort: kein Reassignment, sonst rendert Alpine x-for neu und
      // konkurriert mit Sortable's bereits gesetzter DOM-Reihenfolge.
      this.workTree.sort((a, b) => (idxOf.get(a.id) ?? 0) - (idxOf.get(b.id) ?? 0));
      await this._renumberChapters();
    },

    async _onPageDrop(evt) {
      if (this.organizerSaving) return;
      if (evt.from === evt.to && evt.oldIndex === evt.newIndex) return;
      const fromChapId = this._parseChapterIdAttr(evt.from);
      const toChapId = this._parseChapterIdAttr(evt.to);
      const pageId = parseInt(evt.item.dataset.pageId, 10);
      const pageObj = this._removePageFromBucket(fromChapId, pageId);
      if (!pageObj) return;
      pageObj.chapter_id = toChapId;
      const newOrder = [...evt.to.querySelectorAll('.organizer-page[data-page-id]')]
        .map(el => parseInt(el.dataset.pageId, 10));
      const targetIdx = newOrder.indexOf(pageId);
      const bucket = toChapId === 0 ? this.soloPages : this.workTree.find(c => c.id === toChapId)?.pages;
      if (!bucket) return;
      bucket.splice(targetIdx >= 0 ? targetIdx : bucket.length, 0, pageObj);
      await this._renumberPages(toChapId, fromChapId !== toChapId ? fromChapId : null);
    },

    _removePageFromBucket(chapId, pageId) {
      const bucket = chapId === 0 ? this.soloPages : this.workTree.find(c => c.id === chapId)?.pages;
      if (!bucket) return null;
      const idx = bucket.findIndex(p => p.id === pageId);
      return idx >= 0 ? bucket.splice(idx, 1)[0] : null;
    },

    _findPage(id) {
      for (const c of this.workTree) {
        const p = c.pages.find(p => p.id === id);
        if (p) return p;
      }
      return this.soloPages.find(p => p.id === id) || null;
    },

    async _runMutation(fn, errKey = 'bookOrganizer.saveFailed') {
      const root = window.__app;
      this.organizerSaving = true;
      try {
        await fn();
      } catch (e) {
        root.setStatus(root.t(errKey, { detail: e.message }));
        // Bei Fehler einmal voll resynchronisieren — Server-Zustand könnte
        // partiell mutiert sein.
        await root.loadPages();
      } finally {
        this.organizerSaving = false;
        this.organizerProgress = 0;
        this.organizerStatus = '';
      }
    },

    async _renumberChapters() {
      const root = window.__app;
      const total = this.workTree.length;
      if (!total) return;
      await this._runMutation(async () => {
        this.organizerProgress = 0;
        this.organizerStatus = root.t('bookOrganizer.savingChapters', { done: 0, total });
        for (let i = 0; i < this.workTree.length; i++) {
          const c = this.workTree[i];
          await root.bsPut('chapters/' + c.id, { name: c.name, priority: i + 1 });
          this.organizerProgress = Math.round(((i + 1) / total) * 100);
          this.organizerStatus = root.t('bookOrganizer.savingChapters', { done: i + 1, total });
        }
        this._mirrorChapterOrderInRoot();
      });
    },

    async _renumberPages(toChapId, fromChapId) {
      const root = window.__app;
      const collect = (chapId) => {
        const list = chapId === 0 ? this.soloPages : (this.workTree.find(c => c.id === chapId)?.pages || []);
        return list.map((p, i) => ({ id: p.id, chapter_id: chapId, priority: i + 1, name: p.name }));
      };
      const targets = [
        ...collect(toChapId),
        ...(fromChapId != null ? collect(fromChapId) : []),
      ];
      const total = targets.length;
      if (!total) return;
      await this._runMutation(async () => {
        this.organizerProgress = 0;
        this.organizerStatus = root.t('bookOrganizer.savingPages', { done: 0, total });
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          await root.bsPut('pages/' + t.id, { name: t.name, priority: t.priority, chapter_id: t.chapter_id });
          this.organizerProgress = Math.round(((i + 1) / total) * 100);
          this.organizerStatus = root.t('bookOrganizer.savingPages', { done: i + 1, total });
        }
        this._mirrorPageMembershipInRoot([toChapId, fromChapId].filter(v => v != null));
      });
    },

    onRenameChapter(id, ev) {
      const newName = (ev?.target?.value || '').trim();
      const ch = this.workTree.find(c => c.id === id);
      if (!ch || !newName || ch.name === newName) {
        if (ch && ev?.target) ev.target.value = ch.name;
        return;
      }
      this._doRenameChapter(id, newName, ev.target);
    },

    async _doRenameChapter(id, newName, inputEl) {
      const root = window.__app;
      try {
        await root.bsPut('chapters/' + id, { name: newName });
        const ch = this.workTree.find(c => c.id === id);
        if (ch) ch.name = newName;
        // In-place mirror: chapter entry in root.tree + _chapterOrderMap.
        for (const it of root.tree) {
          if (it.type === 'chapter' && !it.solo && it.id === id) it.name = newName;
        }
        this._rebuildChapterOrderMap();
      } catch (e) {
        root.setStatus(root.t('bookOrganizer.saveFailed', { detail: e.message }));
        const ch = this.workTree.find(c => c.id === id);
        if (ch && inputEl) inputEl.value = ch.name;
      }
    },

    onRenamePage(id, ev) {
      const newName = (ev?.target?.value || '').trim();
      const page = this._findPage(id);
      if (!page || !newName || page.name === newName) {
        if (page && ev?.target) ev.target.value = page.name;
        return;
      }
      this._doRenamePage(id, newName, ev.target);
    },

    async _doRenamePage(id, newName, inputEl) {
      const root = window.__app;
      try {
        await root.bsPut('pages/' + id, { name: newName });
        const page = this._findPage(id);
        if (page) page.name = newName;
        // In-place mirror: page in root.pages + ggf. solo-Tree-Entry.
        const rp = root.pages.find(p => p.id === id);
        if (rp) rp.name = newName;
        for (const it of root.tree) {
          if (it.type === 'chapter' && it.solo && it.pages?.[0]?.id === id) {
            it.name = newName;
          }
        }
        // Pages-Maps neu aufbauen (Reihenfolge unverändert, aber Name-Index drin).
        this._rebuildPageOrderMaps();
      } catch (e) {
        root.setStatus(root.t('bookOrganizer.saveFailed', { detail: e.message }));
        const page = this._findPage(id);
        if (page && inputEl) inputEl.value = page.name;
      }
    },

    async createChapter() {
      const root = window.__app;
      const name = await root.appPrompt({
        message: root.t('bookOrganizer.promptChapterName'),
        placeholder: root.t('bookOrganizer.placeholderChapterName'),
        confirmLabel: root.t('bookOrganizer.create'),
      });
      if (!name) return;
      await this._runMutation(async () => {
        const created = await root.bsPost('chapters', {
          book_id: parseInt(root.selectedBookId, 10),
          name,
        });
        if (!created?.id) return;
        await root.bsRegisterChapterLocally(created);
        const treeEntry = {
          type: 'chapter',
          id: created.id,
          name: created.name || name,
          priority: created.priority ?? Number.MAX_SAFE_INTEGER,
          open: true,
          solo: false,
          url: root.bookstackUrl && created.book_slug && created.slug
            ? `${root.bookstackUrl}/books/${created.book_slug}/chapter/${created.slug}`
            : null,
          pages: [],
        };
        root.tree.push(treeEntry);
        root.tree.sort((a, b) => a.priority - b.priority);
        this._rebuildChapterOrderMap();
        if (typeof root._refreshChapterStats === 'function') root._refreshChapterStats();
        await this._rerender();
      }, 'bookOrganizer.createFailed');
    },

    async createPage(chapterId) {
      const root = window.__app;
      const name = await root.appPrompt({
        message: root.t('bookOrganizer.promptPageName'),
        placeholder: root.t('bookOrganizer.placeholderPageName'),
        confirmLabel: root.t('bookOrganizer.create'),
      });
      if (!name) return;
      const body = {
        book_id: parseInt(root.selectedBookId, 10),
        name,
        // BookStack legt mit leerem html-Feld evtl. einen Draft an, der nicht
        // in GET /pages auftaucht. `<p></p>` erzwingt eine reguläre Seite.
        html: '<p></p>',
      };
      if (chapterId) body.chapter_id = chapterId;
      await this._runMutation(async () => {
        const created = await root.bsPost('pages', body);
        if (!created?.id) return;
        const chapName = chapterId
          ? root.tree.find(it => it.type === 'chapter' && !it.solo && String(it.id) === String(chapterId))?.name || null
          : null;
        await root.bsRegisterPageLocally(created, chapterId ? { id: chapterId, name: chapName } : null);
        const newPage = {
          ...created,
          chapterName: chapName,
          url: root.bookstackUrl && created.book_slug && created.slug
            ? `${root.bookstackUrl}/books/${created.book_slug}/page/${created.slug}`
            : null,
        };
        root.pages.push(newPage);
        if (chapterId) {
          const treeCh = root.tree.find(it => it.type === 'chapter' && !it.solo && String(it.id) === String(chapterId));
          if (treeCh) {
            // Reassignment statt push: Alpine-Reaktivität greift bei nested
            // Arrays nicht immer zuverlässig, wenn das Parent-Item kürzlich
            // selbst gepusht wurde (neu erstelltes Kapitel). Property-Set
            // auf `.pages` triggert die Watcher in jedem Fall.
            treeCh.pages = [...treeCh.pages, newPage];
            treeCh.open = true;
          }
        } else {
          root.tree.push({
            type: 'chapter',
            id: 'solo-' + newPage.id,
            name: newPage.name,
            priority: newPage.priority ?? Number.MAX_SAFE_INTEGER,
            open: true,
            solo: true,
            url: null,
            pages: [newPage],
          });
          root.tree.sort((a, b) => a.priority - b.priority);
        }
        root.tokEsts[newPage.id] = { tok: 0, words: 0, chars: 0 };
        this._rebuildPageOrderMaps();
        if (typeof root._refreshChapterStats === 'function') root._refreshChapterStats();
        await this._rerender();
      }, 'bookOrganizer.createFailed');
    },

    async deleteChapter(id) {
      const root = window.__app;
      const ch = this.workTree.find(c => c.id === id);
      if (!ch) return;
      if (ch.pages.length > 0) {
        root.setStatus(root.t('bookOrganizer.chapterNotEmpty', { name: ch.name, n: ch.pages.length }));
        return;
      }
      if (root.currentPage && root.currentPage.chapter_id === id) {
        root.setStatus(root.t('bookOrganizer.pageInEditorWarn'));
        return;
      }
      const ok = await root.appConfirm({
        message: root.t('bookOrganizer.confirmDeleteChapter', { name: ch.name }),
        confirmLabel: root.t('common.delete'),
        cancelLabel: root.t('common.cancel'),
        danger: true,
      });
      if (!ok) return;
      await this._runMutation(async () => {
        await root.bsDelete('chapters/' + id);
        // BookStack-Cascade: Kapitel + dessen Seiten landen im Papierkorb.
        const deletedPageIds = new Set(ch.pages.map(p => p.id));
        for (let i = root.pages.length - 1; i >= 0; i--) {
          if (deletedPageIds.has(root.pages[i].id)) root.pages.splice(i, 1);
        }
        for (let i = root.tree.length - 1; i >= 0; i--) {
          if (root.tree[i].type === 'chapter' && !root.tree[i].solo && root.tree[i].id === id) {
            root.tree.splice(i, 1);
          }
        }
        const wIdx = this.workTree.findIndex(c => c.id === id);
        if (wIdx >= 0) this.workTree.splice(wIdx, 1);
        this._rebuildChapterOrderMap();
        this._rebuildPageOrderMaps();
        if (typeof root._refreshChapterStats === 'function') root._refreshChapterStats();
        await this.$nextTick();
        this._destroySortables();
        this._initSortables();
      }, 'bookOrganizer.deleteFailed');
    },

    async deletePage(id) {
      const root = window.__app;
      if (root.currentPage && root.currentPage.id === id) {
        root.setStatus(root.t('bookOrganizer.pageInEditorWarn'));
        return;
      }
      const page = this._findPage(id);
      if (!page) return;
      const ok = await root.appConfirm({
        message: root.t('bookOrganizer.confirmDeletePage', { name: page.name }),
        confirmLabel: root.t('common.delete'),
        cancelLabel: root.t('common.cancel'),
        danger: true,
      });
      if (!ok) return;
      await this._runMutation(async () => {
        await root.bsDelete('pages/' + id);
        // Aus root.pages entfernen.
        const pi = root.pages.findIndex(p => p.id === id);
        if (pi >= 0) root.pages.splice(pi, 1);
        // Aus Kapitel-Tree-Pages bzw. Solo-Tree-Eintrag entfernen.
        for (let i = root.tree.length - 1; i >= 0; i--) {
          const it = root.tree[i];
          if (it.type === 'chapter') {
            if (it.solo && it.pages?.[0]?.id === id) {
              root.tree.splice(i, 1);
            } else if (!it.solo) {
              const j = it.pages.findIndex(p => p.id === id);
              if (j >= 0) it.pages.splice(j, 1);
            }
          }
        }
        // Aus workTree/soloPages entfernen.
        for (const c of this.workTree) {
          const j = c.pages.findIndex(p => p.id === id);
          if (j >= 0) c.pages.splice(j, 1);
        }
        const si = this.soloPages.findIndex(p => p.id === id);
        if (si >= 0) this.soloPages.splice(si, 1);
        this._rebuildPageOrderMaps();
        if (typeof root._refreshChapterStats === 'function') root._refreshChapterStats();
      }, 'bookOrganizer.deleteFailed');
    },

    // ─── In-Place-Mirror-Helpers ─────────────────────────────────────────────

    _mirrorChapterOrderInRoot() {
      const root = window.__app;
      const newPrio = new Map(this.workTree.map((c, i) => [c.id, i + 1]));
      for (const it of root.tree) {
        if (it.type === 'chapter' && !it.solo) {
          const p = newPrio.get(it.id);
          if (p !== undefined) it.priority = p;
        }
      }
      root.tree.sort((a, b) => a.priority - b.priority);
      this._rebuildChapterOrderMap();
      this._resortRootPages();
      this._rebuildPageOrderMaps();
      if (typeof root._refreshChapterStats === 'function') root._refreshChapterStats();
    },

    _mirrorPageMembershipInRoot(affectedChapterIds) {
      const root = window.__app;
      // Für jede betroffene Page in workTree/soloPages: chapter_id + priority + name auf root.pages spiegeln.
      const updates = new Map();
      for (const c of this.workTree) {
        for (let i = 0; i < c.pages.length; i++) {
          updates.set(c.pages[i].id, { chapter_id: c.id, priority: i + 1, name: c.pages[i].name });
        }
      }
      for (let i = 0; i < this.soloPages.length; i++) {
        updates.set(this.soloPages[i].id, { chapter_id: 0, priority: i + 1, name: this.soloPages[i].name });
      }
      for (const p of root.pages) {
        const u = updates.get(p.id);
        if (!u) continue;
        p.chapter_id = u.chapter_id || 0;
        p.priority = u.priority;
        p.name = u.name;
        if (u.chapter_id) {
          const treeCh = root.tree.find(it => it.type === 'chapter' && !it.solo && it.id === u.chapter_id);
          p.chapterName = treeCh?.name || p.chapterName;
        } else {
          p.chapterName = null;
        }
      }
      // Betroffene Kapitel: pages-Array im Tree-Eintrag aus root.pages neu filtern.
      for (const chapId of new Set(affectedChapterIds)) {
        if (chapId === 0) continue;
        const treeCh = root.tree.find(it => it.type === 'chapter' && !it.solo && it.id === chapId);
        if (!treeCh) continue;
        treeCh.pages = root.pages
          .filter(p => p.chapter_id === chapId)
          .sort((a, b) => (a.priority || 0) - (b.priority || 0));
      }
      // Solo-Entries: rebuild (Pages, die jetzt root-level sind bzw. waren).
      this._rebuildSoloEntries();
      this._resortRootPages();
      this._rebuildPageOrderMaps();
      if (typeof root._refreshChapterStats === 'function') root._refreshChapterStats();
    },

    _rebuildSoloEntries() {
      const root = window.__app;
      // Existing solo entries entfernen.
      for (let i = root.tree.length - 1; i >= 0; i--) {
        if (root.tree[i].type === 'chapter' && root.tree[i].solo) root.tree.splice(i, 1);
      }
      // Frisch nach soloPages-Reihenfolge anlegen.
      for (const sp of this.soloPages) {
        const rp = root.pages.find(p => p.id === sp.id);
        if (!rp) continue;
        root.tree.push({
          type: 'chapter',
          id: 'solo-' + sp.id,
          name: sp.name,
          priority: rp.priority || 9999,
          open: true,
          solo: true,
          url: null,
          pages: [rp],
        });
      }
      root.tree.sort((a, b) => a.priority - b.priority);
    },

    _resortRootPages() {
      const root = window.__app;
      const chapterPrio = new Map();
      for (const it of root.tree) {
        if (it.type === 'chapter' && !it.solo) chapterPrio.set(it.id, it.priority || 0);
      }
      root.pages.sort((a, b) => {
        const aO = a.chapter_id ? (chapterPrio.get(a.chapter_id) ?? 999) : -1;
        const bO = b.chapter_id ? (chapterPrio.get(b.chapter_id) ?? 999) : -1;
        if (aO !== bO) return aO - bO;
        return (a.priority || 0) - (b.priority || 0);
      });
    },

    _rebuildChapterOrderMap() {
      const root = window.__app;
      const map = new Map();
      let idx = 0;
      for (const it of root.tree) {
        if (it.type === 'chapter' && !it.solo) map.set(it.name, idx++);
      }
      root._chapterOrderMap = map;
    },

    _rebuildPageOrderMaps() {
      const root = window.__app;
      const nameMap = new Map();
      const idMap = new Map();
      for (let i = 0; i < root.pages.length; i++) {
        const p = root.pages[i];
        if (!nameMap.has(p.name)) nameMap.set(p.name, i);
        idMap.set(p.id, i);
      }
      root._pageOrderMap = nameMap;
      root._pageIdOrderMap = idMap;
    },

  }));
}
