import { EVT } from '../events.js';
// Interne Navigation zwischen Buch-Views. `_beginNavigation/_endNavigation`
// klammern zusammengesetzte Karten-Öffnungen (z.B. openFigurById →
// toggleFiguresCard → scrollIntoView), damit der Hash-Router nur EINEN
// History-Eintrag pro logischer Navigation schreibt statt pro Zwischenschritt.
export const appNavigationMethods = {
  async openFigurById(figId) {
    this._beginNavigation();
    try {
      this.$store.catalogUi.figurenFilters.kapitel = '';
      this.$store.catalogUi.figurenFilters.seite = '';
      if (!this.showFiguresCard) {
        await this.toggleFiguresCard();
      }
      this.$store.catalogUi.selectedFigurId = figId;
      await this.$nextTick();
      document.querySelector(`.figur-item[data-figid="${figId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } finally {
      this._endNavigation();
    }
  },

  async openFigurMitKapitel(figId, kapitelName) {
    this._beginNavigation();
    try {
      this.$store.catalogUi.figurenFilters.kapitel = kapitelName || '';
      this.$store.catalogUi.figurenFilters.seite = '';
      if (!this.showFiguresCard) {
        await this.toggleFiguresCard();
      }
      this.$store.catalogUi.selectedFigurId = figId;
      await this.$nextTick();
      document.querySelector(`.figur-item[data-figid="${figId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } finally {
      this._endNavigation();
    }
  },

  async openOrtById(ortId) {
    this._beginNavigation();
    try {
      this.$store.catalogUi.orteFilters.suche = '';
      this.$store.catalogUi.orteFilters.figurId = '';
      this.$store.catalogUi.orteFilters.kapitel = '';
      this.$store.catalogUi.orteFilters.szeneId = '';
      if (!this.showOrteCard) {
        await this.toggleOrteCard();
      }
      this.$store.catalogUi.selectedOrtId = ortId;
      await this.$nextTick();
      document.querySelector(`[data-ortid="${ortId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } finally {
      this._endNavigation();
    }
  },

  async openOrtMitKapitel(ortId, kapitelName) {
    this._beginNavigation();
    try {
      this.$store.catalogUi.orteFilters.suche = '';
      this.$store.catalogUi.orteFilters.figurId = '';
      this.$store.catalogUi.orteFilters.kapitel = kapitelName || '';
      this.$store.catalogUi.orteFilters.szeneId = '';
      if (!this.showOrteCard) {
        await this.toggleOrteCard();
      }
      this.$store.catalogUi.selectedOrtId = ortId;
      await this.$nextTick();
      document.querySelector(`[data-ortid="${ortId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } finally {
      this._endNavigation();
    }
  },

  async openWerkstattDraftById(draftId) {
    this._beginNavigation();
    try {
      if (!this.showFigurWerkstattCard) {
        await this.toggleFigurWerkstattCard();
      }
      // Sub übernimmt Draft-Wechsel via figur-werkstatt:select. Drafts evtl.
      // noch nicht geladen → Sub parkt _pendingDraftId und löst nach loadDrafts.
      window.dispatchEvent(new CustomEvent(EVT.FIGUR_WERKSTATT_SELECT, {
        detail: { draftId },
      }));
      this.$store.nav.werkstattDraftId = draftId;
    } finally {
      this._endNavigation();
    }
  },

  // Cross-Feature: aus der Figuren-Werkstatt ins Plot-Board springen, gefiltert auf
  // die Beats dieser Werkstatt-Figur. Die Plot-Karte hört `plot:filter-draft-figure`
  // und parkt das Ziel, falls das Board noch nicht geladen ist.
  async openPlotForDraftFigure(draftId) {
    this._beginNavigation();
    try {
      if (!this.showPlotCard) {
        await this.togglePlotCard();
      }
      window.dispatchEvent(new CustomEvent(EVT.PLOT_FILTER_DRAFT_FIGURE, {
        detail: { draftId },
      }));
    } finally {
      this._endNavigation();
    }
  },

  async openSzeneById(szeneId) {
    this._beginNavigation();
    try {
      this.$store.catalogUi.szenenFilters.suche = '';
      this.$store.catalogUi.szenenFilters.wertung = '';
      this.$store.catalogUi.szenenFilters.figurId = '';
      this.$store.catalogUi.szenenFilters.kapitel = '';
      this.$store.catalogUi.szenenFilters.ortId = '';
      if (!this.showSzenenCard) {
        await this.toggleSzenenCard();
      }
      this.$store.catalogUi.selectedSzeneId = szeneId;
      await this.$nextTick();
      document.querySelector(`[data-szeneid="${szeneId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } finally {
      this._endNavigation();
    }
  },

  async openEreignisseMitKapitel(kapitel) {
    this._beginNavigation();
    try {
      if (!this.showEreignisseCard) {
        await this.toggleEreignisseCard();
      }
      this.$store.catalogUi.ereignisseFilters.kapitel = kapitel;
    } finally {
      this._endNavigation();
    }
  },

  async openEreignisseMitFigur(figurId) {
    this._beginNavigation();
    try {
      if (!this.showEreignisseCard) {
        await this.toggleEreignisseCard();
      }
      this.$store.catalogUi.ereignisseFilters.figurId = figurId;
      this.$store.catalogUi.ereignisseFilters.kapitel = '';
      this.$store.catalogUi.ereignisseFilters.seite = '';
      this.$store.catalogUi.ereignisseFilters.suche = '';
    } finally {
      this._endNavigation();
    }
  },

  // Löst Kapitel+Seite (Namen) zu einem Page-Objekt auf. Mehrdeutigkeit in
  // dieser Reihenfolge: Kapitel exakt → exakte Seite → Teilstring-Seite →
  // erste Kapitelseite; ohne Kapitel: globaler Seiten-Fallback.
  _resolvePage(kapitel, seite) {
    const kName = Array.isArray(kapitel) ? kapitel[0] : kapitel;
    if (!kName && !seite) return null;
    const chapters = (this.$store.nav.tree || []).filter(t => t.type === 'chapter' && !t.solo);
    const sLower = seite ? String(seite).toLowerCase() : '';
    if (!kName) {
      return this.$store.nav.pages.find(p => p.name === seite)
        || this.$store.nav.pages.find(p => p.name.toLowerCase() === sLower)
        || null;
    }
    const chapter = chapters.find(c => c.name === kName);
    const pages = chapter?.pages || [];
    if (!pages.length) return null;
    if (seite) {
      const exact = pages.find(p => p.name === seite)
        || pages.find(p => p.name.toLowerCase() === sLower);
      if (exact) return exact;
      const sub = pages.find(p => {
        const n = p.name.toLowerCase();
        return n && (n.includes(sLower) || sLower.includes(n));
      });
      if (sub) return sub;
    }
    return pages[0];
  },

  gotoStelle(kapitel, seite) {
    const page = this._resolvePage(kapitel, seite);
    if (page) this.selectPage(page);
  },

  gotoPageById(pageId) {
    if (!pageId) return;
    const page = this.$store.nav.pages.find(p => String(p.id) === String(pageId));
    if (page) this.selectPage(page);
  },

  gotoChapterById(chapterId) {
    if (!chapterId) return;
    const chapter = (this.$store.nav.tree || []).find(t => t.type === 'chapter' && String(t.id) === String(chapterId));
    const first = chapter?.pages?.[0];
    if (first) this.selectPage(first);
  },

  // Zusammengesetzte Navigationen (z.B. openFigurById → toggleFiguresCard
  // → loadFiguren) erzeugen sonst mehrere History-Einträge. Mit diesem
  // Wrapper werden Zwischen-States unterdrückt, am Ende genau einmal gepusht.
  // Inside _applyHash: unterdrückt alles, URL wird nicht angefasst (Hash
  // hat bereits den Zielzustand vorgegeben).
  _beginNavigation() {
    this._navDepth += 1;
    this._applyingHash = true;
  },
  _endNavigation() {
    this._navDepth = Math.max(0, this._navDepth - 1);
    if (this._navDepth > 0) return;
    if (this._inHashApply) return;
    this._applyingHash = false;
    this._writeHash(this._computeHash());
  },
};
