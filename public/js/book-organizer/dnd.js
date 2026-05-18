// DnD-Slice: Sortable-Setup, Page-/Chapter-Drop-Handler.
//
// Sortable v1.15.6-Patch: `_onDragOver` kann auf einer destroyten Instanz
// (this.el === null) feuern, wenn Alpine x-for nach einem Drop neu reconciliated.
// Native dragover-Listener wird in destroy() vor el=null entfernt, aber zwischen
// Alpine-Reordering und Sortable-State-Update treten gelegentlich stale Refs
// auf. No-op auf null el statt zu crashen.
function _patchSortableOnce(Sortable) {
  if (Sortable.prototype._dragOverGuarded) return;
  const orig = Sortable.prototype._onDragOver;
  Sortable.prototype._onDragOver = function (evt) {
    if (!this.el) return;
    return orig.call(this, evt);
  };
  Sortable.prototype._dragOverGuarded = true;
}

export const dndMethods = {
  _destroySortables() {
    for (const s of this._sortables) { try { s.destroy(); } catch {} }
    this._sortables = [];
  },

  _initSortables() {
    const Sortable = window.Sortable;
    if (!Sortable) return;
    _patchSortableOnce(Sortable);
    this._destroySortables();
    // x-ignore auf das Drag-Item setzen, damit der via cloneNode(true) erzeugte
    // Fallback-Ghost im <body> von Alpines MutationObserver übersprungen wird —
    // sonst evaluiert Alpine `:value="page.name"` ausserhalb des x-for-Scopes
    // und wirft "page is not defined". Nach Drag wieder entfernen.
    const markIgnore = (evt) => evt.item?.setAttribute('x-ignore', '');
    const unmarkIgnore = (evt) => evt.item?.removeAttribute('x-ignore');
    const chapterListEl = this.$root.querySelector('[data-organizer="chapter-list"]');
    if (chapterListEl) {
      this._sortables.push(new Sortable(chapterListEl, {
        handle: '.organizer-drag-handle--chapter',
        animation: 150,
        draggable: '.organizer-chapter',
        emptyInsertThreshold: 0,
        onChoose: markIgnore,
        onUnchoose: unmarkIgnore,
        onEnd: (evt) => { unmarkIgnore(evt); this._onChapterDrop(evt); },
      }));
    }
    const pageLists = this.$root.querySelectorAll('[data-organizer="page-list"]');
    for (const el of pageLists) {
      this._sortables.push(new Sortable(el, {
        handle: '.organizer-drag-handle',
        animation: 150,
        draggable: '.organizer-page',
        group: { name: 'pages', pull: true, put: true },
        emptyInsertThreshold: 0,
        onChoose: markIgnore,
        onUnchoose: unmarkIgnore,
        onEnd: (evt) => { unmarkIgnore(evt); this._onPageDrop(evt); },
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
    const before = this._snapshotWorkstate();
    const ids = [...evt.to.querySelectorAll('.organizer-chapter[data-chapter-id]')]
      .map(el => parseInt(el.dataset.chapterId, 10));
    const idxOf = new Map(ids.map((id, i) => [id, i]));
    // In-place sort: kein Reassignment, sonst rendert Alpine x-for neu und
    // konkurriert mit Sortable's bereits gesetzter DOM-Reihenfolge.
    this.workTree.sort((a, b) => (idxOf.get(a.id) ?? 0) - (idxOf.get(b.id) ?? 0));
    const ok = await this._persistOrder();
    if (ok) this._recordReorder(before);
  },

  async _onPageDrop(evt) {
    if (this.organizerSaving) return;
    if (evt.from === evt.to && evt.oldIndex === evt.newIndex) return;
    const before = this._snapshotWorkstate();
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
    const affected = [toChapId, fromChapId !== toChapId ? fromChapId : null].filter(v => v != null);
    const ok = await this._persistOrder({ affectedChapters: affected });
    if (ok) this._recordReorder(before);
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

  // Move-Pfad ohne Drag — Combobox „Verschieben nach …". Nutzt dieselbe
  // Mutations- und Persist-Sequenz wie _onPageDrop, inklusive History-Push.
  async movePageToChapter(pageId, targetChIdRaw) {
    if (this.organizerSaving) return;
    const targetChId = parseInt(targetChIdRaw, 10) || 0;
    const page = this._findPage(pageId);
    if (!page) return;
    const fromChapId = page.chapter_id || 0;
    if (fromChapId === targetChId) return;
    const before = this._snapshotWorkstate();
    const removed = this._removePageFromBucket(fromChapId, pageId);
    if (!removed) return;
    removed.chapter_id = targetChId;
    const bucket = targetChId === 0
      ? this.soloPages
      : this.workTree.find(c => c.id === targetChId)?.pages;
    if (!bucket) {
      const src = fromChapId === 0
        ? this.soloPages
        : this.workTree.find(c => c.id === fromChapId)?.pages;
      src?.push(removed);
      return;
    }
    bucket.push(removed);
    const ok = await this._persistOrder({ affectedChapters: [fromChapId, targetChId] });
    if (ok) this._recordReorder(before);
  },
};
