// DnD-Slice: Sortable-Setup, Page-/Chapter-Drop-Handler.
//
// Geteilter SortableJS-Kern (Patch, Revert, Tuning, x-ignore) liegt in
// [public/js/sortable-dnd.js] — beim Sortable-Bump dort verifizieren.

import {
  patchSortableOnce,
  revertSortable,
  markDragIgnore,
  unmarkDragIgnore,
  BASE_SORTABLE_OPTS,
} from '../sortable-dnd.js';

export const dndMethods = {
  _destroySortables() {
    for (const s of this._sortables) { try { s.destroy(); } catch {} }
    this._sortables = [];
  },

  // Nach jedem erfolgreichen Drop: Sortable-Instanzen frisch an aktuelles DOM
  // binden. Alpine-x-for rekonziliert nach workTree-Reassignment (Chapter-Drop)
  // bzw. loadPages-Reload (Cross-Level) und kann Container-Elemente austauschen
  // — Sortable-Refs zeigen sonst auf stale Nodes und folgende Drops verschieben
  // Items in unsichtbaren alten Listen.
  async _reattachSortables() {
    this._destroySortables();
    await this.$nextTick();
    this._initSortables();
    this._refreshSortableDisabled();
  },

  _initSortables() {
    const Sortable = window.Sortable;
    if (!Sortable) return;
    patchSortableOnce(Sortable);
    this._destroySortables();
    // Geteiltes Präzisions-Tuning aus BASE_SORTABLE_OPTS (forceFallback-Ghost,
    // swapThreshold 0.65 gegen Nachbar-Flackern, invertSwap für stabile Backward-
    // Drops in nested Listen, revertOnSpill gegen Item-Loss). Board-spezifisch:
    // - emptyInsertThreshold 8: restriktiverer Trefferradius als das Plot-Board.
    // - scroll false: Organizer-Listen scrollen nicht beim Drag am Rand.
    // - chosenClass/ghostClass/dragClass: eigene CSS-Klassen für klares
    //   visuelles Feedback (Pickup-Highlight, Ghost-Slot, Hover-Karte).
    const baseOpts = {
      ...BASE_SORTABLE_OPTS,
      emptyInsertThreshold: 8,
      scroll: false,
      chosenClass: 'organizer-chosen',
      ghostClass: 'organizer-ghost',
      dragClass: 'organizer-drag-active',
    };
    // Eine Chapter-Liste pro Tiefe — alle teilen die `chapters`-Gruppe, damit
    // Kapitel zwischen Levels per DnD wandern koennen. Drop-Ziel-Validierung
    // (max-depth, kein-eigener-Subtree) im onMove-Hook.
    const chapterLists = this.$root.querySelectorAll('[data-organizer="chapter-list"]');
    for (const el of chapterLists) {
      this._sortables.push(new Sortable(el, {
        ...baseOpts,
        handle: '.organizer-drag-handle--chapter',
        draggable: '.organizer-chapter',
        group: { name: 'chapters', pull: true, put: ['chapters'] },
        onChoose: markDragIgnore,
        onUnchoose: unmarkDragIgnore,
        onMove: (evt) => this._validateChapterMove(evt),
        onEnd: (evt) => { unmarkDragIgnore(evt); this._onChapterDrop(evt); },
      }));
    }
    const pageLists = this.$root.querySelectorAll('[data-organizer="page-list"]');
    for (const el of pageLists) {
      this._sortables.push(new Sortable(el, {
        ...baseOpts,
        handle: '.organizer-drag-handle',
        draggable: '.organizer-page',
        group: { name: 'pages', pull: true, put: ['pages'] },
        onChoose: markDragIgnore,
        onUnchoose: unmarkDragIgnore,
        onEnd: (evt) => { unmarkDragIgnore(evt); this._onPageDrop(evt); },
      }));
    }
  },

  // Sortable.onMove: blockt Drops, die max-depth verletzen oder ein Kapitel in
  // seinen eigenen Subtree (oder sich selbst) ziehen wuerden. Return false →
  // Drop wird nicht akzeptiert.
  _validateChapterMove(evt) {
    const movedId = parseInt(evt.dragged?.dataset?.chapterId, 10);
    if (!Number.isFinite(movedId)) return true;
    const toEl = evt.to;
    const targetDepth = parseInt(toEl?.dataset?.organizerDepth, 10) || 1;
    const targetParentId = parseInt(toEl?.dataset?.parentChapterId, 10) || null;
    // Kein Drop in sich selbst.
    if (targetParentId === movedId) return false;
    const found = this._findChapter(movedId);
    if (!found) return true;
    // Kein Drop in eigenen Subtree.
    const descIds = this._descendantIdsOf(found.node);
    if (targetParentId != null && descIds.has(targetParentId)) return false;
    // Max-Depth-Check: targetDepth + (subtreeDepth - 1) <= 3.
    const subDepth = this._subtreeDepth(found.node);
    if (targetDepth + subDepth - 1 > 3) return false;
    return true;
  },

  _parseChapterIdAttr(el) {
    const raw = el?.dataset?.chapterId;
    if (raw == null || raw === '' || raw === 'null' || raw === '0') return 0;
    return parseInt(raw, 10) || 0;
  },

  _setSubtreeDepth(node, depth) {
    node.depth = depth;
    for (const sub of (node.subchapters || [])) this._setSubtreeDepth(sub, depth + 1);
  },

  async _onChapterDrop(evt) {
    if (this.organizerSaving) return;
    const sameBucket = evt.from === evt.to;
    if (sameBucket && evt.oldIndex === evt.newIndex) return;
    const movedId = parseInt(evt.item?.dataset?.chapterId, 10);
    if (!Number.isFinite(movedId)) return;
    const before = this._snapshotWorkstate();

    revertSortable(evt);

    const toParentId = parseInt(evt.to?.dataset?.parentChapterId, 10) || null;
    const targetDepth = parseInt(evt.to?.dataset?.organizerDepth, 10) || 1;
    const newIndex = Number.isFinite(evt.newIndex) ? evt.newIndex : 0;

    const found = this._findChapter(movedId);
    if (!found) return;
    const node = found.node;
    found.parentList.splice(found.index, 1);

    let targetList;
    if (toParentId == null) {
      targetList = this.workTree;
    } else {
      const parent = this._findChapter(toParentId)?.node;
      if (!parent) { found.parentList.splice(found.index, 0, node); return; } // Rollback
      if (!parent.subchapters) parent.subchapters = [];
      targetList = parent.subchapters;
    }
    node.parent_id = toParentId;
    this._setSubtreeDepth(node, targetDepth);
    targetList.splice(Math.max(0, Math.min(newIndex, targetList.length)), 0, node);

    const ok = await this._persistOrder({ fullReload: !sameBucket });
    if (ok) this._recordReorder(before);
  },

  async _onPageDrop(evt) {
    if (this.organizerSaving) return;
    if (evt.from === evt.to && evt.oldIndex === evt.newIndex) return;
    const before = this._snapshotWorkstate();
    const fromChapId = this._parseChapterIdAttr(evt.from);
    const toChapId = this._parseChapterIdAttr(evt.to);
    const pageId = parseInt(evt.item.dataset.pageId, 10);

    revertSortable(evt);

    const pageObj = this._removePageFromBucket(fromChapId, pageId);
    if (!pageObj) return;
    pageObj.chapter_id = toChapId;
    const bucket = this._pagesBucket(toChapId);
    if (!bucket) { this._pagesBucket(fromChapId)?.push(pageObj); return; } // Rollback
    // Ziel-Index aus Sortable-Event (Position unter .organizer-page), nicht aus
    // dem DOM lesen — DOM wurde gerade revertet und ist nicht mehr massgeblich.
    const targetIdx = Number.isFinite(evt.newIndex) ? evt.newIndex : bucket.length;
    bucket.splice(Math.max(0, Math.min(targetIdx, bucket.length)), 0, pageObj);
    // Subchapter-Pages koennen tief liegen → fullReload, damit root.tree
    // (flach) konsistent bleibt.
    const fullReload = toChapId !== 0 && this._chapterDepth(toChapId) > 1;
    const affected = [toChapId, fromChapId !== toChapId ? fromChapId : null].filter(v => v != null);
    const ok = await this._persistOrder(fullReload ? { fullReload: true } : { affectedChapters: affected });
    if (ok) this._recordReorder(before);
    if (fullReload) await this._reattachSortables();
  },

  _pagesBucket(chapId) {
    if (chapId === 0) return this.soloPages;
    const found = this._findChapter(chapId);
    return found?.node?.pages || null;
  },

  _chapterDepth(chapId) {
    const found = this._findChapter(chapId);
    return found?.node?.depth || 1;
  },

  _removePageFromBucket(chapId, pageId) {
    const bucket = this._pagesBucket(chapId);
    if (!bucket) return null;
    const idx = bucket.findIndex(p => p.id === pageId);
    return idx >= 0 ? bucket.splice(idx, 1)[0] : null;
  },

  _findPage(id) {
    function walk(list) {
      for (const c of list) {
        const p = c.pages.find(pp => pp.id === id);
        if (p) return p;
        const deep = walk(c.subchapters || []);
        if (deep) return deep;
      }
      return null;
    }
    return walk(this.workTree) || this.soloPages.find(p => p.id === id) || null;
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
    const bucket = this._pagesBucket(targetChId);
    if (!bucket) {
      const src = this._pagesBucket(fromChapId);
      src?.push(removed);
      return;
    }
    bucket.push(removed);
    const fullReload = (targetChId !== 0 && this._chapterDepth(targetChId) > 1)
                   || (fromChapId !== 0 && this._chapterDepth(fromChapId) > 1);
    const ok = await this._persistOrder(fullReload
      ? { fullReload: true }
      : { affectedChapters: [fromChapId, targetChId] });
    if (ok) this._recordReorder(before);
    if (fullReload) await this._reattachSortables();
  },
};
