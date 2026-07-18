// Teil von appViewMethods (siehe Facade app-view.js).
import { EVT, EXCLUSIVE_CARDS, _toggleCardGeneric, fetchJson, generatedToggles, getLastPageId } from './_shared.js';

export const cardsMethods = {

  // Schliesst die anderen Hauptkarten (nicht Tree – der bleibt immer aktiv).
  // Bewertung, Figuren, Entwicklung und Buch-Chat sind exklusiv.
  // Beim Öffnen einer Buchkarte wird auch die offene Seite geschlossen.
  // Scroll-zur-Karte gehört NICHT hierher: zum Zeitpunkt dieses Aufrufs ist
  // das Ziel-Partial bei Cold-Open meist noch leer (Selector findet nichts).
  // Caller scrollt explizit via `_scrollToCardByKey(key)` nach `await _ensurePartial`
  // + Flag-Set.
  _closeOtherMainCards(keep) {
    for (const c of EXCLUSIVE_CARDS) {
      if (keep !== c.key) this[c.flag] = false;
    }
    this.resetPage();
  },


  // Sprung Overview-Rückblick-Heatmap → Tagebuch-Rückblick-Karte mit
  // vorausgewähltem Zeitraum (kein Auto-Run). `rueckblick:select` versorgt den
  // warmen Fall (Karte schon offen); für den Cold-Open hält
  // `$store.nav.pendingRueckblickZeitraum` den Wert, bis der onOpen-Hook der Karte
  // ihn übernimmt. Scroll-to + Partial-Load erledigt der generische Toggle-Pfad.
  openRueckblickFor(zeitraum) {
    if (!zeitraum) return;
    this.$store.nav.pendingRueckblickZeitraum = zeitraum;
    window.dispatchEvent(new CustomEvent(EVT.RUECKBLICK_SELECT, { detail: { zeitraum } }));
    if (!this.showTagebuchRueckblickCard) this.toggleTagebuchRueckblickCard();
    else this._scrollToCardByKey('tagebuchRueckblick');
  },


  // Root-Trigger (Welcome-CTA + Buchwahl-Combobox-Footer "+ Neues Buch") → das
  // Buch-Erstellungs-Modal. Der Dialog ist eine eigene Karte (bookCreateCard) und
  // hört auf `book-create:open`; State/Logik leben dort, nicht am Root.
  openCreateBook() {
    window.dispatchEvent(new CustomEvent(EVT.BOOK_CREATE_OPEN));
  },


  // Karten-Toggles für alle Hauptkarten werden aus EXCLUSIVE_CARDS generiert
  // (siehe `_toggleCardGeneric` + `generatedToggles` oben). Hier nur die
  // Bespoke-Toggles, die nicht ins Schema passen:
  // - `_maybeOpenBookOverview` (Default-Landing)
  // - `toggleIdeenCard`/`toggleChatCard` (Mutex im Slot neben Editor)
  // - `toggleTreeCard` (active-job-check + resetPage on close)
  // `toggleKapitelReviewCard` lebt in book/kapitel-review.js (eigene Logik).

  // Default-Landing: öffnet Übersicht, wenn Buch gewählt ist und keine andere
  // Hauptkarte/Editor aktiv. Wird beim Buchwechsel + bei `#book/:id`-Deeplink
  // ohne View aufgerufen.
  async _maybeOpenBookOverview({ restoreLastPage = true } = {}) {
    if (!this.$store.nav.selectedBookId) return;
    if (this.showEditorCard) return;
    const anyOpen = EXCLUSIVE_CARDS.some(c => this[c.flag]);
    if (anyOpen) return;
    // Letzte Seite restaurieren, falls vorhanden und im aktuellen Buch noch
    // existiert. Bei explizitem Home-Klick (resetView) übersprungen.
    if (restoreLastPage) {
      const lastId = getLastPageId(this.$store.session.currentUser?.email, this.$store.nav.selectedBookId);
      if (lastId && Array.isArray(this.$store.nav.pages) && this.$store.nav.pages.length) {
        const page = this.$store.nav.pages.find(p => p.id === lastId);
        if (page) {
          await this.selectPage(page);
          return;
        }
      }
    }
    await this._ensurePartial('bookoverview');
    this.showBookOverviewCard = true;
  },


  // Seiten-Ideen: lebt parallel zum Editor wie Seiten-Chat. Mutually exclusive
  // mit Chat — nur eines kann gleichzeitig aktiv sein (gleicher Slot).
  async toggleIdeenCard() {
    if (this.showIdeenCard && this.ideenScope === 'page') {
      this.showIdeenCard = false;
      return;
    }
    if (!this.currentPage) return;
    if (this.showChatCard) {
      this.showChatCard = false;
      if (this._checkDoneBeforeChat && this.lektoratFindings?.length > 0) {
        this.checkDone = true;
        this._checkDoneBeforeChat = false;
      }
    }
    if (this.showReferenceCard) this.showReferenceCard = false;
    await this._ensurePartial('ideen');
    this.ideenScope = 'page';
    this.ideenChapterId = null;
    this.showIdeenCard = true;
  },

  // „Ähnliche Stellen zu dieser Figur/Szene/Seite" (semantische Suche): öffnet
  // die Such-Karte und stösst dort die Entity-Ähnlichkeitssuche an. Von den
  // Entity-Karten (Figuren/Szenen) via `$app.findSimilar(...)` gerufen. No-op,
  // wenn das Embedding-Backend nicht konfiguriert ist.
  async findSimilar(kind, id, label) {
    if (!this.$store.config?.semanticSearchEnabled) return;
    if (!this.showSearchCard) await this.toggleSearchCard();
    else await this._ensurePartial('search');
    await this.$nextTick();
    window.dispatchEvent(new CustomEvent('search:similar', { detail: { kind, id, label: label || '' } }));
  },

  // Kapitel-Ideen: lebt parallel zur Kapitelreview-Karte (gleicher Slot wie
  // Page-Modus). Kein _closeOtherMainCards — Kapitelreview bleibt offen.
  async toggleChapterIdeenCard(chapterId) {
    const cid = parseInt(chapterId, 10);
    if (!cid) return;
    if (this.showIdeenCard && this.ideenScope === 'chapter' && this.ideenChapterId === cid) {
      this.showIdeenCard = false;
      return;
    }
    if (this.showChatCard) this.showChatCard = false;
    if (this.showReferenceCard) this.showReferenceCard = false;
    await this._ensurePartial('ideen');
    this.ideenScope = 'chapter';
    this.ideenChapterId = cid;
    this.showIdeenCard = true;
  },

  // Sprung von einem Seiten-Indikator (Sidebar/Editor) in die Recherche-Karte,
  // vorgefiltert auf die verknüpften Schnipsel dieser Seite. Recherche ist eine
  // exklusive Hauptkarte → öffnen schliesst den Editor (anders als Ideen-Slot).
  async openRechercheForPage(pageId) {
    const pid = parseInt(pageId ?? this.currentPage?.id, 10);
    if (!pid) return;
    await this._ensurePartial('recherche');
    // Filter-Event VOR dem Sichtbar-Schalten: bei frischem Öffnen liest der
    // Lifecycle-Load (rising edge) den schon gesetzten Filter → ein Fetch.
    window.dispatchEvent(new CustomEvent(EVT.RECHERCHE_FILTER_PAGE, { detail: { pageId: pid } }));
    if (!this.showRechercheCard) {
      this._closeOtherMainCards('recherche');
      this.showRechercheCard = true;
    }
    this._scrollToCardByKey('recherche');
  },

  // Sprung vom Kapitel-Indikator im Pagetree: Recherche-Karte öffnen und auf die
  // mit diesem Kapitel verknüpften Schnipsel filtern (analog openRechercheForPage).
  async openRechercheForChapter(chapterId) {
    const cid = parseInt(chapterId, 10);
    if (!cid) return;
    await this._ensurePartial('recherche');
    window.dispatchEvent(new CustomEvent(EVT.RECHERCHE_FILTER_CHAPTER, { detail: { chapterId: cid } }));
    if (!this.showRechercheCard) {
      this._closeOtherMainCards('recherche');
      this.showRechercheCard = true;
    }
    this._scrollToCardByKey('recherche');
  },

  // Sprung vom Plot-Indikator (Editor-Action-Menü + Kapitelansicht): Plot-
  // Werkstatt öffnen. Das Board ist buchweit (kein Seiten-/Kapitel-Filter) →
  // reines Öffnen, kein Toggle.
  async openPlotBoard() {
    await this._ensurePartial('plot');
    if (!this.showPlotCard) {
      this._closeOtherMainCards('plot');
      this.showPlotCard = true;
    }
    this._scrollToCardByKey('plot');
  },

  // Sprung vom Ideen-Indikator im Pagetree: Seite öffnen (Page-Ideen sitzen im
  // Editor-Slot) und die Ideen-Karte aufklappen. Kein Toggle — ist sie schon
  // offen, bleibt sie offen.
  async openIdeenForPage(pageId) {
    const pid = parseInt(pageId, 10);
    if (!pid) return;
    if (this.currentPage?.id !== pid) {
      const page = (this.$store.nav.pages || []).find(p => p.id === pid);
      if (!page) return;
      await this.selectPage(page);
    }
    if (!(this.showIdeenCard && this.ideenScope === 'page')) {
      await this.toggleIdeenCard();
    }
  },

  // Seiten-Chat: lebt neben dem Editor, schließt NICHT den Editor. Toggle
  // merkt sich checkDone-Snapshot (Chat soll Findings temporär verbergen).
  // checkDoneBeforeChat wird in chat-base beim onVisible gesetzt.
  // Mutually exclusive mit Ideen — gleicher Slot neben Editor.
  async toggleChatCard() {
    if (this.showChatCard) {
      this.showChatCard = false;
      if (this._checkDoneBeforeChat && this.lektoratFindings?.length > 0) {
        this.checkDone = true;
        this._checkDoneBeforeChat = false;
      }
      return;
    }
    if (!this.currentPage) return;
    if (this.showIdeenCard) this.showIdeenCard = false;
    if (this.showReferenceCard) this.showReferenceCard = false;
    await this._ensurePartial('chat');
    this.showChatCard = true;
    this.logAuditEvent?.('chatOpened', { book: this.$store.nav.selectedBookId, page: this.currentPage.id });
  },

  // Referenz-Slot: read-only Begleitpanel (Figuren/Orte/Szenen/Ereignisse/
  // Recherche), Mutex mit Seiten-Chat + Ideen im selben Slot neben dem Editor.
  // Kein currentPage-Zwang — der Buch-Scope funktioniert auch ohne offene Seite;
  // erreichbar ist der Toggle ohnehin nur aus der Editor-Toolbar.
  async toggleReferenceCard() {
    if (this.showReferenceCard) {
      this.showReferenceCard = false;
      return;
    }
    if (this.showChatCard) this.showChatCard = false;
    if (this.showIdeenCard) this.showIdeenCard = false;
    await this._ensurePartial('reference');
    this.showReferenceCard = true;
  },

  // Seitenwechsel: Seiten-Chat resetten (Chat ist pro Seite).
  resetChat() {
    window.dispatchEvent(new CustomEvent(EVT.CHAT_RESET));
  },

  resetBookChat() {
    window.dispatchEvent(new CustomEvent(EVT.BOOK_CHAT_RESET));
  },


  async toggleTreeCard() {
    if (this.showTreeCard) { this.showTreeCard = false; this.resetPage(); return; }
    this._closeOtherMainCards('tree');
    this.showTreeCard = true;
    if (!this.$store.nav.pages.length) await this.loadPages();
    // Prüfen ob bereits ein Batch-Check-Job für dieses Buch läuft
    if (!this._batchPollTimer && !this.batchLoading && this.$store.nav.selectedBookId) {
      try {
        const { jobId } = await fetchJson(`/jobs/active?type=batch-check&book_id=${this.$store.nav.selectedBookId}`);
        if (jobId) {
          this.batchLoading = true;
          this.batchProgress = 0;
          this.batchStatus = this._runningJobStatus(this.t('common.analysisAlreadyRunning'), 0, 0);
          this.startBatchPoll(jobId);
        }
      } catch (e) {
        console.error('[toggleTreeCard] active-job check:', e);
      }
    }
  },
};
