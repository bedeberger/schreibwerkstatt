// Alpine.data('bookOrganizerCard') — Sub-Komponente Buchorganizer.
//
// Reorder/Move (DnD via SortableJS, lazy), Create/Rename/Delete für Kapitel +
// Seiten. Keine KI, keine Job-Queue — direkter BookStack-API-Zugriff via
// Root-bsGet/bsPut/bsPost/bsDelete-Helper.
//
// Eigener State: lokale Arbeitskopien (`workTree`, `soloPages`) als
// Drop-Target für Sortable; Sortable-Instanzen für Cleanup.
// Root behält: Wahrheits-`pages`/`tree` (loadPages refresht nach jeder
// erfolgreichen Mutation).

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
        // book:changed feuert VOR loadPages — Snapshot von altem tree wäre
        // stale. Nur State + Sortable cleanen; der tree-Watch unten greift,
        // sobald loadPages das neue tree gesetzt hat.
        onBookChanged: (e, ctx) => {
          ctx._destroySortables();
          Object.assign(ctx, { workTree: [], soloPages: [], organizerStatus: '', organizerProgress: 0, organizerSaving: false });
        },
        onCardRefresh: async (e, ctx, root) => {
          await root.loadPages();
        },
        onViewReset: (e, ctx) => {
          ctx._destroySortables();
          Object.assign(ctx, { workTree: [], soloPages: [] });
        },
      });

      // Tree-Watch ist die SSoT für „UI ist synchron mit BookStack". Greift bei
      // (a) initialem loadPages, (b) Buchwechsel nach loadPages, (c) eigenen
      // Mutationen nach _refresh(), (d) externen Refreshes durch andere Karten.
      this.$watch(() => window.__app.tree, async () => {
        if (!window.__app.showBookOrganizerCard) return;
        await loadSortable();
        await this._rerender();
      });
    },

    async _rerender() {
      this._destroySortables();
      this._snapshotFromRoot();
      await this.$nextTick();
      this._initSortables();
    },

    destroy() {
      this._destroySortables();
      this._lifecycle?.destroy();
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
          handle: '.organizer-drag-handle',
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
      const ids = [...evt.to.querySelectorAll('.organizer-chapter[data-chapter-id]')]
        .map(el => parseInt(el.dataset.chapterId, 10));
      const byId = new Map(this.workTree.map(c => [c.id, c]));
      this.workTree = ids.map(id => byId.get(id)).filter(Boolean);
      await this._renumberChapters();
    },

    async _onPageDrop(evt) {
      if (this.organizerSaving) return;
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

    async _renumberChapters() {
      const root = window.__app;
      const total = this.workTree.length;
      if (!total) return;
      this.organizerSaving = true;
      this.organizerProgress = 0;
      this.organizerStatus = root.t('bookOrganizer.savingChapters', { done: 0, total });
      try {
        for (let i = 0; i < this.workTree.length; i++) {
          const c = this.workTree[i];
          await root.bsPut('chapters/' + c.id, { name: c.name, priority: i + 1 });
          this.organizerProgress = Math.round(((i + 1) / total) * 100);
          this.organizerStatus = root.t('bookOrganizer.savingChapters', { done: i + 1, total });
        }
        await this._refresh();
      } catch (e) {
        root.setStatus(root.t('bookOrganizer.saveFailed', { detail: e.message }));
        await this._refresh();
      } finally {
        this.organizerSaving = false;
        this.organizerProgress = 0;
        this.organizerStatus = '';
      }
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
      this.organizerSaving = true;
      this.organizerProgress = 0;
      this.organizerStatus = root.t('bookOrganizer.savingPages', { done: 0, total });
      try {
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          await root.bsPut('pages/' + t.id, { name: t.name, priority: t.priority, chapter_id: t.chapter_id });
          this.organizerProgress = Math.round(((i + 1) / total) * 100);
          this.organizerStatus = root.t('bookOrganizer.savingPages', { done: i + 1, total });
        }
        await this._refresh();
      } catch (e) {
        root.setStatus(root.t('bookOrganizer.saveFailed', { detail: e.message }));
        await this._refresh();
      } finally {
        this.organizerSaving = false;
        this.organizerProgress = 0;
        this.organizerStatus = '';
      }
    },

    async _refresh() {
      // tree-Watch im init() re-rendert die Karte automatisch, sobald
      // loadPages den Tree neu zugewiesen hat.
      await window.__app.loadPages();
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
        await root.loadPages();
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
        await root.loadPages();
      } catch (e) {
        root.setStatus(root.t('bookOrganizer.saveFailed', { detail: e.message }));
        const page = this._findPage(id);
        if (page && inputEl) inputEl.value = page.name;
      }
    },

    async createChapter() {
      const root = window.__app;
      const name = window.prompt(root.t('bookOrganizer.promptChapterName'));
      const trimmed = (name || '').trim();
      if (!trimmed) return;
      try {
        await root.bsPost('chapters', { book_id: parseInt(root.selectedBookId, 10), name: trimmed });
        await this._refresh();
      } catch (e) {
        root.setStatus(root.t('bookOrganizer.createFailed', { detail: e.message }));
      }
    },

    async createPage(chapterId) {
      const root = window.__app;
      const name = window.prompt(root.t('bookOrganizer.promptPageName'));
      const trimmed = (name || '').trim();
      if (!trimmed) return;
      const body = {
        book_id: parseInt(root.selectedBookId, 10),
        name: trimmed,
        html: '',
      };
      if (chapterId) body.chapter_id = chapterId;
      try {
        await root.bsPost('pages', body);
        await this._refresh();
      } catch (e) {
        root.setStatus(root.t('bookOrganizer.createFailed', { detail: e.message }));
      }
    },

    async deleteChapter(id) {
      const root = window.__app;
      const ch = this.workTree.find(c => c.id === id);
      if (!ch) return;
      if (root.currentPage && root.currentPage.chapter_id === id) {
        root.setStatus(root.t('bookOrganizer.pageInEditorWarn'));
        return;
      }
      const ok = await root.appConfirm({
        message: root.t('bookOrganizer.confirmDeleteChapter', { name: ch.name, n: ch.pages.length }),
        confirmLabel: root.t('common.delete'),
        cancelLabel: root.t('common.cancel'),
        danger: true,
      });
      if (!ok) return;
      try {
        await root.bsDelete('chapters/' + id);
        await this._refresh();
      } catch (e) {
        root.setStatus(root.t('bookOrganizer.deleteFailed', { detail: e.message }));
      }
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
      try {
        await root.bsDelete('pages/' + id);
        await this._refresh();
      } catch (e) {
        root.setStatus(root.t('bookOrganizer.deleteFailed', { detail: e.message }));
      }
    },
  }));
}
