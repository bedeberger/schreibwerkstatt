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
    _patchSortableOnce(Sortable);
    this._destroySortables();
    // x-ignore auf das Drag-Item setzen, damit der via cloneNode(true) erzeugte
    // Fallback-Ghost im <body> von Alpines MutationObserver übersprungen wird —
    // sonst evaluiert Alpine `:value="page.name"` ausserhalb des x-for-Scopes
    // und wirft "page is not defined". Nach Drag wieder entfernen.
    const markIgnore = (evt) => evt.item?.setAttribute('x-ignore', '');
    const unmarkIgnore = (evt) => evt.item?.removeAttribute('x-ignore');
    // Präzisions-Tuning (gegen "Nachbar verrutscht beim Ziehen"-Bug):
    // - forceFallback: konsistenter Klon-Ghost im <body>, umgeht HTML5-DnD-
    //   Browser-Quirks (sprunghafter Cursor, ungenaue dragover-Targets).
    // - swapThreshold 0.65: Swap erst, wenn Cursor 65% in Ziel-Item — Default
    //   1.0 swappt schon bei minimaler Überlappung, dann "flackern" Nachbarn.
    // - invertSwap: Backward-Drops in nested Listen werden stabil erkannt.
    // - fallbackTolerance 5: 5px Bewegung nötig bevor Drag startet — Klick auf
    //   Handle-Span löst nicht versehentlich Drag aus.
    // - revertOnSpill: Drop außerhalb gültiger Liste (Toolbar, Empty-Bereich)
    //   springt zurück statt Item-Loss.
    // - direction vertical: Sortable optimiert Swap-Berechnung explizit.
    // - chosenClass/ghostClass/dragClass: eigene CSS-Klassen für klares
    //   visuelles Feedback (Pickup-Highlight, Ghost-Slot, Hover-Karte).
    const baseOpts = {
      animation: 0,
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 5,
      swapThreshold: 0.65,
      invertSwap: true,
      direction: 'vertical',
      revertOnSpill: true,
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
        onChoose: markIgnore,
        onUnchoose: unmarkIgnore,
        onMove: (evt) => this._validateChapterMove(evt),
        onEnd: (evt) => { unmarkIgnore(evt); this._onChapterDrop(evt); },
      }));
    }
    const pageLists = this.$root.querySelectorAll('[data-organizer="page-list"]');
    for (const el of pageLists) {
      this._sortables.push(new Sortable(el, {
        ...baseOpts,
        handle: '.organizer-drag-handle',
        draggable: '.organizer-page',
        group: { name: 'pages', pull: true, put: ['pages'] },
        onChoose: markIgnore,
        onUnchoose: unmarkIgnore,
        onEnd: (evt) => { unmarkIgnore(evt); this._onPageDrop(evt); },
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

  // Nimmt Sortables physischen DOM-Move zurück (Node zurück in Quell-Container an
  // alten Index). Pflicht vor jeder Modell-Mutation: SortableJS und Alpine x-for
  // besitzen sonst dieselben <li>/<div>-Nodes doppelt — verschiebt Sortable einen
  // Node über Container-Grenzen, zeigt Alpines key→el-Map einer anderen x-for-
  // Scope weiterhin auf ihn → Orphan/Duplikat-Nodes, driftender DOM, falsche
  // Positionen. Nach Revert ist Alpine alleiniger DOM-Besitzer; das Modell (unten
  // mutiert) ist die Wahrheit, x-for rendert daraus neu.
  _revertSortable(evt) {
    const { item, from, oldIndex } = evt;
    if (!item || !from) return;
    if (item.parentNode === from
        && Array.prototype.indexOf.call(from.children, item) === oldIndex) return;
    const ref = from.children[oldIndex] || null;
    from.insertBefore(item, ref);
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

    this._revertSortable(evt);

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

    this._revertSortable(evt);

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
