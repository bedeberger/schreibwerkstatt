// Persistenter Collapse-State des Sidebar-Trees pro (User, Buch) + Chapter-Header-
// Aktivierung. `this` = die Alpine-Komponente.

export const treeOpenStateMethods = {
  async _onChapterHeaderActivate(item) {
    if (this.pageSearch) return;
    // Leeres Kapitel → kapitel-review-card öffnen, damit User direkt eine
    // erste Seite anlegen kann. openKapitelReviewForChapter filtert 0-Seiten-
    // Kapitel via kapitelReviewChapterOptions() raus, deswegen direkt setzen.
    // chapterId zuerst am Root setzen, dann toggle awaiten — toggle lädt das
    // Partial via `_ensurePartial`; ohne await bleibt die Karte leer.
    if (item.pages.length === 0 && !item.hasChildren) {
      this.kapitelReviewChapterId = String(item.id);
      if (!this.showKapitelReviewCard) await this.toggleKapitelReviewCard();
      else this._closeOtherMainCards('kapitelReview');
      return;
    }
    // Parent-Kapitel ohne direkte Pages, aber mit Sub-Kapiteln, öffnen das
    // Review (include_subchapters greift dann automatisch, siehe kapitelReviewIncludeSubchapters).
    if (this._bookQualifiesForChapterReview()) await this.openKapitelReviewForChapter(item.id);
    else this.toggleChapterOpen(item);
  },

  // Persistenter Collapse-State des Sidebar-Trees pro (User, Buch). Default
  // ist `open: true` (Erstaufruf). Solo-Items werden nicht persistiert —
  // sie sind reine Page-Wrapper ohne Toggle.
  _treeOpenStorageKey(bookId) {
    if (!bookId) return '';
    return `sw:treeOpen:${this.$store.session.currentUser?.email || ''}:${bookId}`;
  },
  _loadTreeOpenState(bookId) {
    try {
      const key = this._treeOpenStorageKey(bookId);
      if (!key) return {};
      const raw = localStorage.getItem(key);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch { return {}; }
  },
  _persistTreeOpenState() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) return;
    try {
      const key = this._treeOpenStorageKey(bookId);
      if (!key) return;
      const state = {};
      for (const item of this.$store.nav.tree) {
        if (item.type === 'chapter' && !item.solo) state[item.id] = !!item.open;
      }
      localStorage.setItem(key, JSON.stringify(state));
    } catch { /* quota / disabled storage — ignore */ }
  },
  setChapterOpen(item, value) {
    if (!item || item.solo) return;
    item.open = !!value;
    this._persistTreeOpenState();
  },
  toggleChapterOpen(item) {
    if (!item || item.solo) return;
    this.setChapterOpen(item, !item.open);
  },
  setAllChaptersOpen(value) {
    for (const item of this.$store.nav.tree) {
      if (item.type === 'chapter' && !item.solo) item.open = !!value;
    }
    this._persistTreeOpenState();
  },
};
