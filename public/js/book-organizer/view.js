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
};
