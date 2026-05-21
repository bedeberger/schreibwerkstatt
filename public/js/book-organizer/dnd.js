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
    // Auto-Scroll an Dokument-Scrollbarkeit koppeln: passt alles in den
    // Viewport, deaktivieren — sonst feuert Sortable bei 1-Zeilen-Drags am
    // Window-Rand. Sensitivity + Speed konservativer als die Sortable-Defaults
    // (30/10), damit Auto-Scroll nur am echten Edge greift, nicht schon bei
    // Cursorbewegung mitten auf der Seite.
    const scrollOpts = this._autoScrollOpts();
    // Eine Chapter-Liste pro Tiefe — alle teilen die `chapters`-Gruppe, damit
    // Kapitel zwischen Levels per DnD wandern koennen. Drop-Ziel-Validierung
    // (max-depth, kein-eigener-Subtree) im onAdd/onMove-Hook.
    const chapterLists = this.$root.querySelectorAll('[data-organizer="chapter-list"]');
    for (const el of chapterLists) {
      this._sortables.push(new Sortable(el, {
        handle: '.organizer-drag-handle--chapter',
        animation: 150,
        draggable: '.organizer-chapter',
        group: { name: 'chapters', pull: true, put: ['chapters'] },
        emptyInsertThreshold: 0,
        ...scrollOpts,
        onChoose: markIgnore,
        onUnchoose: unmarkIgnore,
        onMove: (evt) => this._validateChapterMove(evt),
        onEnd: (evt) => { unmarkIgnore(evt); this._onChapterDrop(evt); },
      }));
    }
    const pageLists = this.$root.querySelectorAll('[data-organizer="page-list"]');
    for (const el of pageLists) {
      this._sortables.push(new Sortable(el, {
        handle: '.organizer-drag-handle',
        animation: 150,
        draggable: '.organizer-page',
        group: { name: 'pages', pull: true, put: ['pages'] },
        emptyInsertThreshold: 0,
        ...scrollOpts,
        onChoose: markIgnore,
        onUnchoose: unmarkIgnore,
        onEnd: (evt) => { unmarkIgnore(evt); this._onPageDrop(evt); },
      }));
    }
  },

  _autoScrollOpts() {
    const overflow = document.documentElement.scrollHeight - window.innerHeight;
    return {
      scroll: overflow > 100,
      scrollSensitivity: 12,
      scrollSpeed: 6,
      bubbleScroll: true,
    };
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

  async _onChapterDrop(evt) {
    if (this.organizerSaving) return;
    const sameBucket = evt.from === evt.to;
    if (sameBucket && evt.oldIndex === evt.newIndex) return;
    const before = this._snapshotWorkstate();

    // Existierende Nodes per ID indexieren — Pages + Renames bleiben erhalten,
    // wenn wir den Tree neu aus DOM-Reihenfolge zusammenbauen.
    const nodeById = new Map();
    function collect(list) {
      for (const c of list) {
        nodeById.set(c.id, c);
        collect(c.subchapters || []);
      }
    }
    collect(this.workTree);

    const topContainer = this.$root.querySelector('.organizer-list[data-organizer="chapter-list"]');
    const newWorkTree = topContainer ? this._rebuildFromDom(topContainer, 1, null, nodeById) : this.workTree;

    // Reassignen (statt in-place sort) — Tiefe + parent_id-Felder muessen neu
    // gesetzt sein. Alpine x-for reagiert; SortableJS-DOM-Stand bleibt im Sync,
    // weil wir neu rerendern.
    this.workTree = newWorkTree;
    const ok = await this._persistOrder({ fullReload: !sameBucket });
    if (ok) this._recordReorder(before);
  },

  _rebuildFromDom(containerEl, depth, parentId, nodeById) {
    const out = [];
    for (const chEl of containerEl.children) {
      if (!chEl.classList.contains('organizer-chapter')) continue;
      const id = parseInt(chEl.dataset.chapterId, 10);
      if (!Number.isFinite(id)) continue;
      const existing = nodeById.get(id) || { id, name: '', pages: [], subchapters: [] };
      let subList = null;
      for (const desc of chEl.children) {
        if (desc.classList.contains('organizer-subchapters')) { subList = desc; break; }
      }
      const subs = subList ? this._rebuildFromDom(subList, depth + 1, id, nodeById) : [];
      out.push({
        id,
        name: existing.name,
        pages: existing.pages || [],
        depth,
        parent_id: parentId,
        subchapters: subs,
      });
    }
    return out;
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
    const newOrder = [...evt.to.querySelectorAll(':scope > .organizer-page[data-page-id]')]
      .map(el => parseInt(el.dataset.pageId, 10));
    const targetIdx = newOrder.indexOf(pageId);
    const bucket = this._pagesBucket(toChapId);
    if (!bucket) return;
    bucket.splice(targetIdx >= 0 ? targetIdx : bucket.length, 0, pageObj);
    // Subchapter-Pages koennen tief liegen → fullReload, damit root.tree
    // (flach) konsistent bleibt.
    const fullReload = toChapId !== 0 && this._chapterDepth(toChapId) > 1;
    const affected = [toChapId, fromChapId !== toChapId ? fromChapId : null].filter(v => v != null);
    const ok = await this._persistOrder(fullReload ? { fullReload: true } : { affectedChapters: affected });
    if (ok) this._recordReorder(before);
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
  },
};
