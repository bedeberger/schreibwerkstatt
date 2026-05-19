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
    this._refreshSortablesAfterTick();
  },

  expandAll() {
    const next = {};
    for (const id of _walkAllIds(this.workTree)) next[id] = true;
    this.chapterOpen = next;
    this._refreshSortablesAfterTick();
  },

  collapseAll() {
    const next = {};
    for (const id of _walkAllIds(this.workTree)) next[id] = false;
    this.chapterOpen = next;
    this._refreshSortablesAfterTick();
  },

  // Pages-UL ist x-if-gated: nach Open/Close erscheinen/verschwinden ULs im DOM,
  // Sortable muss daher neu gebunden werden. Debounce via nextTick.
  _refreshSortablesAfterTick() {
    this.$nextTick(() => {
      this._destroySortables();
      this._initSortables();
      this._refreshSortableDisabled();
    });
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
};
