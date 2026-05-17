// URL-Hash-Permalinks + History-Management.
// Schema: #profil | #admin/<users|settings|usage[/<tab>]> | #book/:bookId[/page/:pageId|/figur/:figId|/ort/:ortId|/werkstatt[/:draftId]|/kapitel[/:chapterId]|/<view>]
// Views: figuren, werkstatt, orte, szenen, ereignisse, kontinuitaet, bewertung, kapitel, chat, stats, stil, fehler, einstellungen, finetune, export
// Admin-Usage-Tabs: users (default, weggelassen) | jobs | chat | summary | features | time
//
// Entwurfsentscheidungen:
// - push vs. replace entscheidet `_hashCategory`: gleiche Kategorie → replace
//   (z.B. Figur↔Figur), Wechsel → push. `figur`/`figuren`, `ort`/`orte` gelten
//   als dieselbe Kategorie.
// - `_updateHash` bündelt mehrere synchrone Alpine-Watcher-Feuer per Microtask
//   zu EINEM History-Eintrag.
// - `_applyHash` setzt `_inHashApply` + `_applyingHash`, damit während der
//   Anwendung getriggerte Watcher keinen Rück-Schreibzyklus starten.
export const appHashRouterMethods = {
  _computeHash() {
    if (this.showUserSettingsCard) return '#profil';
    // Volltextsuche ist book-unabhaengig — eigener Top-Level-Hash.
    if (this.showSearchCard) return '#search';
    if (this.showAdminUsersCard) return '#admin/users';
    if (this.showAdminSettingsCard) return '#admin/settings';
    if (this.showAdminUsageCard) {
      const tab = this.adminUsageTab;
      return '#admin/usage' + (tab && tab !== 'users' ? '/' + tab : '');
    }
    if (this.showAdminCategoriesCard) return '#admin/categories';
    if (this.showAdminBooksCard) return '#admin/books';
    if (!this.selectedBookId) return '';
    const parts = ['book', this.selectedBookId];
    if (this.showEditorCard && this.currentPage?.id) {
      parts.push('page', String(this.currentPage.id));
    } else if (this.showFiguresCard && this.selectedFigurId) {
      parts.push('figur', String(this.selectedFigurId));
    } else if (this.showOrteCard && this.selectedOrtId) {
      parts.push('ort', String(this.selectedOrtId));
    } else if (this.showSzenenCard && this.selectedSzeneId) {
      parts.push('szene', String(this.selectedSzeneId));
    } else if (this.showKapitelReviewCard && this.kapitelReviewChapterId) {
      parts.push('kapitel', String(this.kapitelReviewChapterId));
    } else if (this.showFigurWerkstattCard && this.werkstattDraftId) {
      parts.push('werkstatt', String(this.werkstattDraftId));
    } else if (this.showFiguresCard) parts.push('figuren');
    else if (this.showFigurWerkstattCard) parts.push('werkstatt');
    else if (this.showOrteCard) parts.push('orte');
    else if (this.showSzenenCard) parts.push('szenen');
    else if (this.showEreignisseCard) parts.push('ereignisse');
    else if (this.showKontinuitaetCard) parts.push('kontinuitaet');
    else if (this.showBookReviewCard) parts.push('bewertung');
    else if (this.showKapitelReviewCard) parts.push('kapitel');
    else if (this.showBookChatCard) parts.push('chat');
    else if (this.showBookOverviewCard) parts.push('uebersicht');
    else if (this.showBookStatsCard) parts.push('stats');
    else if (this.showStilCard) parts.push('stil');
    else if (this.showFehlerHeatmapCard) parts.push('fehler');
    else if (this.showBookSettingsCard) parts.push('einstellungen');
    else if (this.showFinetuneExportCard) parts.push('finetune');
    else if (this.showExportCard) parts.push('export');
    else if (this.showPdfExportCard) parts.push('pdf');
    else if (this.showBookOrganizerCard) parts.push('organize');
    else if (this.showBookEditorCard) parts.push('bucheditor');
    return '#' + parts.join('/');
  },

  _hashCategory(hash) {
    if (!hash) return null;
    const parts = hash.replace(/^#/, '').split('/').filter(Boolean);
    if (parts[0] === 'profil') return 'profil';
    if (parts[0] === 'search') return 'search';
    if (parts[0] === 'admin') return 'admin:' + (parts[1] || '');
    if (parts[0] !== 'book' || !parts[1]) return null;
    const bookId = parts[1];
    const view = parts[2] || 'book';
    const kind = view === 'figur' ? 'figuren'
      : view === 'ort' ? 'orte'
      : view === 'szene' ? 'szenen'
      : view;
    return bookId + ':' + kind;
  },

  _writeHash(newHash) {
    const cleanUrl = location.pathname + location.search;
    const firstWrite = !this._hashInitialized;
    this._hashInitialized = true;
    if (!newHash) {
      if (location.hash) history.replaceState(null, '', cleanUrl);
      return;
    }
    if (location.hash === newHash) return;
    if (firstWrite) { history.replaceState(null, '', newHash); return; }
    const oldCat = this._hashCategory(location.hash);
    const newCat = this._hashCategory(newHash);
    if (oldCat && oldCat === newCat) {
      history.replaceState(null, '', newHash);
    } else {
      history.pushState(null, '', newHash);
    }
    // pushState/replaceState feuern kein hashchange → Plausible manuell triggern.
    try { window.plausible?.('pageview'); } catch { /* noop */ }
  },

  // Synchroner URL-Sync ohne neuen History-Eintrag (initial + nach Hash-Apply).
  _syncUrlNow() {
    const newHash = this._computeHash();
    const cleanUrl = location.pathname + location.search;
    if (!newHash) {
      if (location.hash) history.replaceState(null, '', cleanUrl);
    } else if (location.hash !== newHash) {
      history.replaceState(null, '', newHash);
    }
    this._hashInitialized = true;
  },

  // Mehrere synchrone State-Änderungen werden per Microtask zu einem
  // einzigen URL-Update zusammengefasst.
  _updateHash() {
    if (this._applyingHash) return;
    if (this._hashUpdatePending) return;
    this._hashUpdatePending = true;
    queueMicrotask(() => {
      this._hashUpdatePending = false;
      if (this._applyingHash) return;
      this._writeHash(this._computeHash());
    });
  },

  async _applyHash() {
    const hash = (location.hash || '').replace(/^#/, '');
    if (!hash) return;
    const parts = hash.split('/').filter(Boolean);

    if (parts[0] === 'profil') {
      this._applyingHash = true;
      this._inHashApply = true;
      try {
        if (!this.showUserSettingsCard) await this.toggleUserSettingsCard();
      } finally {
        this._applyingHash = false;
        this._inHashApply = false;
      }
      return;
    }

    if (parts[0] === 'search') {
      this._applyingHash = true;
      this._inHashApply = true;
      try {
        if (!this.showSearchCard) await this.toggleSearchCard();
      } finally {
        this._applyingHash = false;
        this._inHashApply = false;
      }
      return;
    }

    if (parts[0] === 'admin') {
      this._applyingHash = true;
      this._inHashApply = true;
      try {
        const sub = parts[1] || 'users';
        if (sub === 'users') {
          if (!this.showAdminUsersCard) await this.toggleAdminUsersCard();
        } else if (sub === 'settings') {
          if (!this.showAdminSettingsCard) await this.toggleAdminSettingsCard();
        } else if (sub === 'usage') {
          if (!this.showAdminUsageCard) await this.toggleAdminUsageCard();
          const tab = parts[2];
          const valid = ['users', 'jobs', 'chat', 'summary', 'features', 'time'];
          if (tab && valid.includes(tab)) this.adminUsageTab = tab;
          else if (!tab) this.adminUsageTab = 'users';
        } else if (sub === 'categories') {
          if (!this.showAdminCategoriesCard) await this.toggleAdminCategoriesCard();
        } else if (sub === 'books') {
          if (!this.showAdminBooksCard) await this.toggleAdminBooksCard();
        }
      } finally {
        this._applyingHash = false;
        this._inHashApply = false;
      }
      return;
    }

    if (parts[0] !== 'book' || !parts[1]) return;
    const targetBookId = parts[1];
    if (!this.books.some(b => String(b.id) === targetBookId)) return;

    this._applyingHash = true;
    this._inHashApply = true;
    try {
      // Beim ersten _applyHash (Deep-Link / Reload) ist selectedBookId in init()
      // bereits aus dem Hash gesetzt und `loadBooks()` hat `loadPages()` schon
      // ausgeführt – nur `book:changed` dispatchen, damit Sub-Karten sich
      // synchronisieren. Kein _resetBookScopedState (würde tokEsts/_tokenEstGen
      // killen → Page-Stats blieben leer) und kein zweites loadPages (Flicker).
      const isInitialApply = !this._initialApplyDone;
      this._initialApplyDone = true;
      if (String(this.selectedBookId) !== targetBookId) {
        this.selectedBookId = targetBookId;
        this._resetBookScopedState();
        await this.loadPages({ source: 'bookSwitch' });
      } else if (isInitialApply) {
        window.dispatchEvent(new CustomEvent('book:changed', {
          detail: { bookId: this.selectedBookId },
        }));
      }

      const view = parts[2];
      const arg = parts[3];
      if (!view) {
        this._closeOtherMainCards('none');
        this._maybeOpenBookOverview();
        return;
      }

      switch (view) {
        case 'page':
          if (arg) {
            const page = this.pages.find(p => String(p.id) === arg);
            if (page) await this.selectPage(page);
          }
          break;
        case 'figur':
          if (arg) await this.openFigurById(arg);
          else {
            this.selectedFigurId = null;
            if (!this.showFiguresCard) await this.toggleFiguresCard();
            else this._closeOtherMainCards('figures');
          }
          break;
        case 'ort':
          if (arg) await this.openOrtById(arg);
          else {
            this.selectedOrtId = null;
            if (!this.showOrteCard) await this.toggleOrteCard();
            else this._closeOtherMainCards('orte');
          }
          break;
        case 'figuren':
          this.selectedFigurId = null;
          if (!this.showFiguresCard) await this.toggleFiguresCard();
          else this._closeOtherMainCards('figures');
          break;
        case 'werkstatt':
          if (!this.showFigurWerkstattCard) await this.toggleFigurWerkstattCard();
          if (arg) {
            // Sub übernimmt Draft-Wechsel via `figur-werkstatt:select`-Event.
            // Bei Deep-Link `#book/X/werkstatt/Y` ist die Sub evtl. noch nicht
            // gemountet — Event wird dann nach loadDrafts via _pendingDraftId
            // verarbeitet.
            window.dispatchEvent(new CustomEvent('figur-werkstatt:select', { detail: { draftId: parseInt(arg) } }));
          } else {
            this.werkstattDraftId = null;
          }
          break;
        case 'orte':
          this.selectedOrtId = null;
          if (!this.showOrteCard) await this.toggleOrteCard();
          else this._closeOtherMainCards('orte');
          break;
        case 'szene':
          if (arg) await this.openSzeneById(arg);
          else {
            this.selectedSzeneId = null;
            if (!this.showSzenenCard) await this.toggleSzenenCard();
            else this._closeOtherMainCards('szenen');
          }
          break;
        case 'szenen':
          this.selectedSzeneId = null;
          if (!this.showSzenenCard) await this.toggleSzenenCard();
          else this._closeOtherMainCards('szenen');
          break;
        case 'ereignisse':
          if (!this.showEreignisseCard) await this.toggleEreignisseCard();
          break;
        case 'kontinuitaet':
          if (!this.showKontinuitaetCard) await this.toggleKontinuitaetCard();
          break;
        case 'bewertung':
          if (!this.showBookReviewCard) await this.toggleBookReviewCard();
          break;
        case 'kapitel':
          if (!this.showKapitelReviewCard) await this.toggleKapitelReviewCard();
          if (arg) {
            // Sub übernimmt den Chapter-Wechsel via `kapitel-review:select`-Event.
            // Bei Deep-Link `#book/X/kapitel/Y` ist die Sub evtl. noch nicht
            // gemountet — Event wird dann vom init()-Listener verarbeitet.
            window.dispatchEvent(new CustomEvent('kapitel-review:select', { detail: { chapterId: String(arg) } }));
          }
          break;
        case 'chat':
          if (!this.showBookChatCard) await this.toggleBookChatCard();
          break;
        case 'uebersicht':
          if (!this.showBookOverviewCard) await this.toggleBookOverviewCard();
          break;
        case 'stats':
          if (!this.showBookStatsCard) await this.toggleBookStatsCard();
          break;
        case 'stil':
          if (!this.showStilCard) await this.toggleStilCard();
          break;
        case 'fehler':
          if (!this.showFehlerHeatmapCard) await this.toggleFehlerHeatmapCard();
          break;
        case 'einstellungen':
          if (!this.showBookSettingsCard) await this.toggleBookSettingsCard();
          break;
        case 'finetune':
          if (!this.showFinetuneExportCard) await this.toggleFinetuneExportCard();
          break;
        case 'export':
          if (!this.showExportCard) await this.toggleExportCard();
          break;
        case 'pdf':
          if (!this.showPdfExportCard) await this.togglePdfExportCard();
          break;
        case 'organize':
          if (!this.showBookOrganizerCard) await this.toggleBookOrganizerCard();
          break;
        case 'bucheditor':
          if (!this.showBookEditorCard) await this.toggleBookEditorCard();
          break;
      }
    } finally {
      this._applyingHash = false;
      this._inHashApply = false;
    }
  },

  _setupHashRouting() {
    // Re-init sammelt sonst mehrfache $watch — bei jedem Property-Change feuern
    // dann doppelte URL-Writes mit doppeltem History-Eintrag. Existierende
    // Teardowns vorab abräumen.
    this._teardownHashRouting();
    const watchers = [
      'selectedBookId', 'currentPage', 'showEditorCard',
      'selectedFigurId', 'selectedOrtId', 'selectedSzeneId',
      'showFiguresCard', 'showFigurWerkstattCard', 'showOrteCard', 'showSzenenCard', 'showEreignisseCard',
      'showKontinuitaetCard', 'showBookReviewCard', 'showBookChatCard',
      'showKapitelReviewCard', 'kapitelReviewChapterId',
      'werkstattDraftId',
      'showBookStatsCard', 'showStilCard', 'showFehlerHeatmapCard',
      'showBookSettingsCard', 'showUserSettingsCard',
      'showAdminUsersCard', 'showAdminSettingsCard', 'showAdminUsageCard', 'adminUsageTab',
      'showAdminCategoriesCard', 'showAdminBooksCard',
      'showFinetuneExportCard',
      'showExportCard',
      'showPdfExportCard',
      'showBookOrganizerCard',
      'showBookEditorCard',
      'showBookOverviewCard',
      'showSearchCard',
    ];
    this._hashWatcherTeardowns = [];
    for (const prop of watchers) {
      const off = this.$watch(prop, () => this._updateHash());
      if (typeof off === 'function') this._hashWatcherTeardowns.push(off);
    }
    window.addEventListener('hashchange', () => this._applyHash(), { signal: this._abortCtrl?.signal });
  },

  _teardownHashRouting() {
    if (Array.isArray(this._hashWatcherTeardowns)) {
      for (const off of this._hashWatcherTeardowns) {
        try { off(); } catch { /* noop */ }
      }
    }
    this._hashWatcherTeardowns = [];
  },
};
