// Root-seitige Einstiegspunkte für die Kapitel-Bewertung (Sidebar + Hash-Router).
// Job-Flow, Render, State + History leben in Alpine.data('kapitelReviewCard').

export const kapitelReviewMethods = {
  async toggleKapitelReviewCard() {
    if (this.showKapitelReviewCard) {
      this.showKapitelReviewCard = false;
      // Kapitel-Ideen-Karte lebt neben der Kapitelreview-Karte und schliesst
      // gemeinsam mit ihr.
      if (this.ideenScope === 'chapter' && this.showIdeenCard) {
        this.showIdeenCard = false;
      }
      return;
    }
    this._closeOtherMainCards('kapitelReview');
    await this._ensurePartial('kapitelreview');
    this.showKapitelReviewCard = true;
    this._scrollToCardByKey('kapitelReview');
  },

  async openKapitelReviewForChapter(chapterId) {
    if (!chapterId) return;
    const opts = this.kapitelReviewChapterOptions();
    if (!opts.some(c => String(c.id) === String(chapterId))) return;
    // chapterId am Root-SSoT zuerst setzen, dann toggle awaiten — vor dem
    // Partial-Load gibt es keinen Listener für ein `kapitel-review:select`-Event.
    this.kapitelReviewChapterId = String(chapterId);
    if (!this.showKapitelReviewCard) {
      await this.toggleKapitelReviewCard();
    }
  },

  // Klick auf Kapitel-Badge in Listen (figuren/orte/szenen): Kapitel-Review
  // öffnen, falls das Buch dafür qualifiziert. Sonst Fallback auf erste
  // Kapitelseite. Match per exaktem Namen, dann case-insensitive.
  async openKapitelByName(name) {
    if (!name) return;
    const chapters = (this.$store.nav.tree || []).filter(i => i.type === 'chapter' && !i.solo);
    const lc = String(name).toLowerCase();
    const ch = chapters.find(c => c.name === name)
      || chapters.find(c => c.name.toLowerCase() === lc);
    if (ch && this._bookQualifiesForChapterReview()) {
      const opts = this.kapitelReviewChapterOptions();
      if (opts.some(c => String(c.id) === String(ch.id))) {
        await this.openKapitelReviewForChapter(ch.id);
        return;
      }
    }
    this.gotoStelle(name, null);
  },

  // Sobald mindestens ein Kapitel mehrere Seiten hat, lohnt sich das Kapitel-
  // Review — dann gibt es eine Kapiteleinheit, die als Ganzes bewertet werden
  // kann (unabhängig von der Kapitelanzahl). Bücher aus lauter Ein-Seiten-
  // Kapiteln bzw. reinen Solo-Seiten deckt das Seiten-Lektorat ab.
  _bookQualifiesForChapterReview() {
    const chapters = (this.$store.nav.tree || []).filter(i => i.type === 'chapter' && !i.solo);
    return chapters.some(c => c.pages.length > 1);
  },

  kapitelReviewChapterOptions() {
    if (!this._bookQualifiesForChapterReview()) return [];
    const tree = this.$store.nav.tree || [];
    const hasSub = (id) => tree.some(i =>
      i.type === 'chapter' && !i.solo && String(i.parent_id) === String(id)
    );
    return tree
      .filter(i => i.type === 'chapter' && !i.solo && (i.pages.length > 0 || hasSub(i.id)))
      .map(c => ({ id: c.id, name: c.name, pageCount: c.pages.length }));
  },
};
