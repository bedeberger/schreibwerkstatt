import { htmlToText, fetchJson, escHtml } from '../utils.js';
import { computeTodayRing } from '../today-ring.js';
import { EXCLUSIVE_CARDS } from '../cards/feature-registry.js';
import { contentRepo } from '../repo/content.js';
import { readDraft, clearDraft } from '../editor/draft-storage.js';
import { setLastPageId, getLastPageId, getFilters } from '../local-prefs.js';

// Karten-Scopes, deren Filter pro Buch im localStorage persistiert werden.
// Defaults werden bei Buchwechsel angewandt; gespeicherte Werte überschreiben
// jeweils nur die genannten Keys. SSoT für persist (app.js-Watcher),
// restore (`_restoreBookPrefs`) und reset (`resetView`).
export const FILTER_SCOPES = [
  ['figurenFilters',      { kapitel: '', seite: '', suche: '' }],
  ['ereignisseFilters',   { figurId: '', kapitel: '', seite: '', suche: '' }],
  ['szenenFilters',       { wertung: '', figurId: '', kapitel: '', ortId: '', suche: '' }],
  ['orteFilters',         { figurId: '', kapitel: '', szeneId: '', suche: '' }],
  ['songsFilters',        { figurId: '', kapitel: '', szeneId: '', genre: '', kontextTyp: '', suche: '' }],
  ['kontinuitaetFilters', { figurId: '', kapitel: '', schwere: '' }],
];

// Generischer Karten-Toggle. Liest Behavior-Felder aus EXCLUSIVE_CARDS-Entry
// (onReclick, requiresBook, loadDeps, auditEvent, extraRefreshOnOpen) und
// kapselt die Open/Close/Refresh-Pfade. Bespoke-Toggles (kapitelReview, ideen,
// chat, tree) leben weiterhin als eigene Methoden.
async function _toggleCardGeneric(entry) {
  if (this[entry.flag]) {
    if (entry.onReclick === 'refresh') {
      window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: entry.refreshName || entry.key } }));
      this._scrollToCardByKey(entry.key);
    } else {
      this[entry.flag] = false;
    }
    return;
  }
  if (entry.requiresBook && !this.selectedBookId) return;
  this._closeOtherMainCards(entry.key);
  if (entry.partial) await this._ensurePartial(entry.partial);
  this[entry.flag] = true;
  this._scrollToCardByKey(entry.key);
  if (entry.auditEvent) this.logAuditEvent?.(entry.auditEvent, { book: this.selectedBookId });
  if (entry.extraRefreshOnOpen) {
    window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: entry.key } }));
  }
  if (entry.loadDeps?.length) {
    const tasks = [];
    for (const dep of entry.loadDeps) {
      const empty = !(this[dep.skipIfNonEmpty]?.length);
      if (empty && typeof this[dep.method] === 'function') {
        tasks.push(this[dep.method](this.selectedBookId));
      }
    }
    if (tasks.length) await Promise.all(tasks);
  }
}

// Auto-generierte Toggle-Methoden — eine pro EXCLUSIVE_CARDS-Eintrag (ausser
// `bespoke: true`). Werden in `appViewMethods` gespreaded, damit Alpine sie
// als reguläre Methoden auf der Root-Component sieht (Templates, Hash-Router,
// Palette rufen `toggleXxxCard()` direkt).
const generatedToggles = {};
for (const entry of EXCLUSIVE_CARDS) {
  if (entry.bespoke || !entry.toggle) continue;
  generatedToggles[entry.toggle] = async function() { return _toggleCardGeneric.call(this, entry); };
}

// View-Steuerung: Exklusivität zwischen Buch-/Seiten-Karten, Seitenauswahl,
// Reset-Logik beim Buch-/Seitenwechsel. Buchebenen-Features und Editor sind
// gegenseitig exklusiv (siehe CLAUDE.md-Regel "Feature-Toggle").
export const appViewMethods = {
  ...generatedToggles,
  async selectPage(p) {
    if (this.currentPage && this.currentPage.id === p.id) {
      // Re-Klick auf bereits offene Seite: SW-Cache umgehen und frischen
      // Server-Stand laden. Aktive Edits nicht überschreiben.
      if (this.editMode || this.editDirty) return;
      this._scrollToEditorCard();
      await this._refetchCurrentPage();
      return;
    }
    if (this.editMode && this.editDirty) {
      if (!confirm(this.t('app.switchPageConfirm'))) return;
    }
    // Alle Buchkarten schliessen + Editor-State resetten – nur eine Ebene
    // (Buch oder Seite) aktiv. Helper deckt alle showXxxCard-Flags ab und
    // ruft resetPage(); kein Argument = nichts behalten.
    this._closeOtherMainCards();
    // Editor + Sub-Partials parallel laden. Sub-Karten (toolbar, find, synonyme,
    // figur-lookup, focus) sind Geschwister-Partials, keine nested children —
    // werden vom Cascade-Helper deshalb nicht automatisch mitgezogen.
    await Promise.all([
      this._ensurePartial('editor-notebook'),
      this._ensurePartial('editor-toolbar'),
      this._ensurePartial('editor-find'),
      this._ensurePartial('editor-figur-lookup'),
      this._ensurePartial('editor-synonyme'),
      this._ensurePartial('editor-focus'),
    ]);
    this.currentPage = p;
    this.showEditorCard = true;
    this.$nextTick(() => this._scrollToEditorCard());

    if (typeof this._trackPageUsage === 'function' && this.selectedBookId) {
      this._trackPageUsage(p.id, this.selectedBookId);
    }
    setLastPageId(this.currentUser?.email, this.selectedBookId, p.id);

    this._loadPageBadgeCounts(p.id);

    // Seiteninhalt laden und als formatiertes HTML rendern
    try {
      let pd = await contentRepo.loadPage(p.id);
      // Stale-Check: Wenn der Tree-Eintrag (`p.updated_at`, kann selbst aus
      // SW-Cache stammen) jünger ist als die Detail-Antwort, hat der SW eine
      // veraltete Version geliefert → einmalig mit __fresh nachziehen.
      if (p.updated_at && pd.updated_at && new Date(pd.updated_at) < new Date(p.updated_at)) {
        pd = await contentRepo.loadPage(p.id, { fresh: true });
      }
      const html = pd.html || '';
      this.originalHtml = html;
      this.renderedPageHtml = html;
      this._updatePageViewHeight();
      // Listing-Cache kann stale sein (Page-Save aktualisiert ihn nicht).
      if (pd.updated_at) p.updated_at = pd.updated_at;
      this.currentPageEmpty = !htmlToText(html).trim();
      this.analysisOut = '';
      this._refreshPendingDraft(p.id, html);
    } catch (e) {
      console.error('[selectPage load-page]', e);
      this.setStatus(this.t('chat.pageLoadFailed'));
    }

    // Prüfen ob ein Lektorat-Check-Job für diese Seite läuft (Server-seitig oder aus früherer Session)
    try {
      const { jobId: activeJobId } = await fetchJson(`/jobs/active?type=check&page_id=${p.id}`);
      if (activeJobId) {
        localStorage.setItem('lektorat_check_job_' + p.id, activeJobId);
        this.checkLoading = true;
        this.checkProgress = 0;
        this.analysisOut = '';
        this.checkStatus = `<span class="spinner"></span>${escHtml(this.t('app.lektoratRunning'))}`;
        this.startCheckPoll(activeJobId);
      } else {
        // Kein aktiver Job → stale localStorage-Eintrag bereinigen
        localStorage.removeItem('lektorat_check_job_' + p.id);
      }
    } catch (e) { console.error('[selectPage active-job check]', e); }

    // Figurenkontext für dieses Kapitel laden (parallel zur History)
    this.loadChapterFigures();
    await this.loadPageHistory(p.id);
  },

  // Scroll-Ziel beim Karten-Öffnen: Mobile (<960px, einspaltig) → Karte
  // ins Viewport, sonst sieht User den Tree statt der frisch geöffneten Karte.
  // Desktop (>=960px, zweispaltig) → Window-Top, da Karten in eigener Spalte.
  _scrollToCardEl(el) {
    const isMobile = window.matchMedia('(max-width: 959.98px)').matches;
    if (isMobile && el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  _scrollToEditorCard() {
    this._scrollToCardEl(document.getElementById('editor-card'));
  },

  // Lädt die aktuell offene Seite neu vom Server (SW-Cache umgangen). Wird
  // beim Re-Klick auf die offene Sidebar-Seite verwendet, damit nach externer
  // Änderung in BookStack kein veralteter Stand stehenbleibt.
  async _refetchCurrentPage() {
    if (!this.currentPage) return;
    const pageId = this.currentPage.id;
    try {
      const pd = await contentRepo.loadPage(pageId, { fresh: true });
      if (this.currentPage?.id !== pageId) return;
      const html = pd.html || '';
      this.originalHtml = html;
      this.renderedPageHtml = html;
      this._updatePageViewHeight();
      if (pd.updated_at) this.currentPage.updated_at = pd.updated_at;
      this.currentPageEmpty = !htmlToText(html).trim();
      this._refreshPendingDraft(pageId, html);
      // Findings/Marks erhalten: ohne Refilter würden Marks beim Refetch
      // (Re-Klick, Collab-Remote-Edit, Revision-Restore) verschwinden, obwohl
      // `checkDone` + `lektoratFindings` noch gesetzt sind.
      if (this.lektoratFindings?.length > 0) {
        this._filterFindingsAfterSave?.(html);
        this.updatePageView();
      }
    } catch (e) {
      console.error('[refetchCurrentPage]', e);
      this.setStatus(this.t('chat.pageLoadFailed'));
    }
  },

  // Inline-Rename des Seitentitels aus dem Editor-Card-Header. Spiegelt den
  // neuen Namen in currentPage, root.pages und root.tree (inkl. Solo-Wrapper +
  // Sub-Kapitel) — Buchorganizer-Pfade pflegen Order-Maps, hier nicht nötig.
  async renameCurrentPage(ev) {
    const newName = (ev?.target?.value || '').trim();
    const page = this.currentPage;
    if (!page || !newName || page.name === newName) {
      if (page && ev?.target) ev.target.value = page?.name || '';
      return;
    }
    const oldName = page.name;
    try {
      await contentRepo.updatePage(page.id, { name: newName });
      page.name = newName;
      const rp = this.pages.find(p => p.id === page.id);
      if (rp) rp.name = newName;
      const renameInTree = (items) => {
        for (const it of items) {
          if (it.type !== 'chapter') continue;
          if (it.solo && it.pages?.[0]?.id === page.id) it.name = newName;
          if (!it.solo) {
            const cp = it.pages?.find(p => p.id === page.id);
            if (cp) cp.name = newName;
          }
          if (it.subchapters?.length) renameInTree(it.subchapters);
        }
      };
      renameInTree(this.tree);
    } catch (e) {
      this.setStatus(this.t('bookOrganizer.saveFailed', { detail: e.message }));
      if (ev?.target) ev.target.value = oldName;
    }
  },

  // Draft-Recovery: nach Page-Load prüfen, ob lokaler Entwurf im localStorage
  // vom Server-HTML abweicht (z. B. nach Server-Crash mid-write + Tab-Reopen).
  // Wenn ja: `pendingDraft`-Banner zeigt User Wiederaufnahme-Option an. Im
  // editMode überspringen — `startEdit` hat den Draft bereits geladen.
  _refreshPendingDraft(pageId, originalHtml) {
    if (this.editMode) { this.pendingDraft = null; return; }
    const draft = readDraft(pageId);
    if (draft && draft.html && draft.html !== originalHtml) {
      this.pendingDraft = { savedAt: draft.savedAt || Date.now() };
    } else {
      // Stale-Draft (= identisch zu Server-HTML) räumen, damit alter Eintrag
      // bei nächster Visit nicht wieder triggert.
      if (draft) { try { clearDraft(pageId); } catch {} }
      this.pendingDraft = null;
    }
  },

  // Banner-Action „Weiterbearbeiten": Edit-Mode öffnen, startEdit lädt Draft
  // automatisch und setzt `editDirty=true`.
  resumeDraft() {
    if (!this.currentPage) return;
    this.pendingDraft = null;
    this.startEdit();
  },

  // Banner-Action „Verwerfen": lokalen Entwurf löschen, Banner schliessen.
  async discardDraft() {
    if (!this.currentPage) return;
    const ok = await this.appConfirm({
      message: this.t('edit.draftRecovery.discardConfirm'),
      confirmLabel: this.t('edit.draftRecovery.discard'),
      danger: true,
    });
    if (!ok) return;
    try { clearDraft(this.currentPage.id); } catch {}
    this.pendingDraft = null;
  },

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

  // Scrollt zur Karte mit `key` (aus EXCLUSIVE_CARDS). Pflicht: vom Aufrufer
  // erst aufrufen, nachdem Partial geladen UND Flag gesetzt ist — sonst hat
  // das `x-show`-Element noch keine DOM-Repräsentation.
  _scrollToCardByKey(key) {
    const target = EXCLUSIVE_CARDS.find(c => c.key === key);
    if (!target || typeof this.$nextTick !== 'function') return;
    this.$nextTick(() => {
      this._scrollToCardEl(document.querySelector(`[x-show="$app.${target.flag}"]`));
    });
  },

  // Lädt Badge-Counts (offene Ideen, Chat-Sessions) für die geöffnete Seite.
  // Race-safe: prüft pageId gegen aktuelle Seite vor Set, falls User schnell wechselt.
  async _loadPageBadgeCounts(pageId) {
    try {
      const [ideen, sessions] = await Promise.all([
        fetchJson(`/ideen?page_id=${pageId}`).catch(() => []),
        fetchJson(`/chat/sessions/${pageId}`).catch(() => []),
      ]);
      if (this.currentPage?.id !== pageId) return;
      const openCount = (Array.isArray(ideen) ? ideen : []).filter(i => !i.erledigt).length;
      this.currentPageIdeenOpenCount = openCount;
      this.currentPageChatSessionCount = (Array.isArray(sessions) ? sessions : []).length;
      // Tree-Indikator mit frischer Wahrheit syncen (z.B. bei Cross-Tab-Edits).
      const next = { ...(this.ideenCounts || {}) };
      if (openCount > 0) next[pageId] = openCount;
      else delete next[pageId];
      this.ideenCounts = next;
    } catch (e) {
      console.error('[loadPageBadgeCounts]', e);
    }
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
    if (!this.selectedBookId) return;
    if (this.showEditorCard) return;
    const anyOpen = EXCLUSIVE_CARDS.some(c => this[c.flag]);
    if (anyOpen) return;
    // Letzte Seite restaurieren, falls vorhanden und im aktuellen Buch noch
    // existiert. Bei explizitem Home-Klick (resetView) übersprungen.
    if (restoreLastPage) {
      const lastId = getLastPageId(this.currentUser?.email, this.selectedBookId);
      if (lastId && Array.isArray(this.pages) && this.pages.length) {
        const page = this.pages.find(p => p.id === lastId);
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
    await this._ensurePartial('ideen');
    this.ideenScope = 'page';
    this.ideenChapterId = null;
    this.showIdeenCard = true;
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
    await this._ensurePartial('ideen');
    this.ideenScope = 'chapter';
    this.ideenChapterId = cid;
    this.showIdeenCard = true;
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
    await this._ensurePartial('chat');
    this.showChatCard = true;
    this.logAuditEvent?.('chatOpened', { book: this.selectedBookId, page: this.currentPage.id });
  },
  // Seitenwechsel: Seiten-Chat resetten (Chat ist pro Seite).
  resetChat() {
    window.dispatchEvent(new CustomEvent('chat:reset'));
  },
  resetBookChat() {
    window.dispatchEvent(new CustomEvent('book-chat:reset'));
  },

  async toggleTreeCard() {
    if (this.showTreeCard) { this.showTreeCard = false; this.resetPage(); return; }
    this._closeOtherMainCards('tree');
    this.showTreeCard = true;
    if (!this.pages.length) await this.loadPages();
    // Prüfen ob bereits ein Batch-Check-Job für dieses Buch läuft
    if (!this._batchPollTimer && !this.batchLoading && this.selectedBookId) {
      try {
        const { jobId } = await fetchJson(`/jobs/active?type=batch-check&book_id=${this.selectedBookId}`);
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

  // Setzt allen Seiten-Level-State zurück (Editor, Lektorat, Chat, History).
  resetPage() {
    // `_checkPollTimer_<pageId>` bewusst NICHT clearen: Poll der verlassenen
    // Seite muss weiterlaufen, damit `onDone` → `markPageChecked` den
    // Sidebar-Status aktualisiert (siehe lektorat.js startCheckPoll). Poll
    // räumt sich nach Job-Abschluss in job-helpers.js selbst auf.
    this.closeSynonymMenu?.();
    this.closeSynonymPicker?.();
    this.closeFigurLookup?.();
    if (this.focusActive) this.exitFocusMode();
    this._stopAutosave?.();
    this._uninstallOnlineRetry?.();
    this.resetChat();
    this.showChatCard = false;
    // Ideen-Karte schliessen — gilt für beide Scopes. Page-Scope sitzt im
    // Editor-Slot, Chapter-Scope ist an Kapitelreview gekoppelt (das via
    // `_closeOtherMainCards` ebenfalls geschlossen wird).
    this.showIdeenCard = false;
    this.ideenChapterId = null;
    this.ideenScope = 'page';
    this._checkDoneBeforeChat = false;
    this.currentPage = null;
    this.currentPageEmpty = false;
    this.currentPageIdeenOpenCount = 0;
    this.currentPageChatSessionCount = 0;
    this.renderedPageHtml = '';
    this.chapterFigures = [];
    this.showChapterFigures = false;
    this.originalHtml = null;
    this.correctedHtml = null;
    this.hasErrors = false;
    this.editMode = false;
    this.editDirty = false;
    this.editSaving = false;
    this.pendingDraft = null;
    this.lastAutosaveAt = null;
    this.lastDraftSavedAt = null;
    this.showEditorCard = false;
    this.analysisOut = '';
    this.status = '';
    this.statusSpinner = false;
    this.lastCheckId = null;
    this.pageHistory = [];
    this.activeHistoryEntryId = null;
    this.lektoratFindings = [];
    this.selectedFindings = [];
    this.appliedOriginals = [];
    this.appliedHistoricCorrections = [];
    this.checkDone = false;
    this.checkLoading = false;
    this.checkProgress = 0;
    this.checkStatus = '';
  },

  // Setzt allen buchbezogenen State zurück. Wird bei Buchwechsel (Combobox,
  // Hash, programmatisch) aufgerufen, bevor `loadPages()` das neue Buch lädt.
  // Karten bleiben sichtbar — `_reloadVisibleBookCards()` füllt sie danach neu.
  // Sub-Komponenten hören auf das `book:changed`-Event und resetten/laden selbst.
  _resetBookScopedState() {
    // Buchwechsel: laufenden bookTree/Stats-/Sub-Load des vorigen Buches
    // sofort abbrechen — bei sehr grossen Büchern hängt der bookTree-Request
    // sonst bis zum 30s-Timeout am Netz und blockiert Browser-Slots, während
    // das neue Buch parallel lädt.
    this._bookLoadAbort?.abort(new DOMException('book switch', 'AbortError'));
    this._bookLoadAbort = null;
    window.dispatchEvent(new CustomEvent('book:changed', {
      detail: { bookId: this.selectedBookId },
    }));
    this._stopCollabPoll?.();
    this.figuren = [];
    this.orte = [];
    this.songs = [];
    this.szenen = [];
    this.globalZeitstrahl = [];
    this.werkstattDrafts = [];
    this.werkstattDraftId = null;
    this.bookReviewHistory = [];
    this.newPageTitle = '';
    this.newPageCreating = false;
    this.newPageError = '';
    this.chapterFigures = [];
    this.pageHistory = [];
    this.activeHistoryEntryId = null;
    this.tokEsts = {};
    this.ideenCounts = {};
    this.chapterIdeenCounts = {};
    this.currentChapterIdeenOpenCount = 0;
    // Chapter-Ideen-Scope verwerfen beim Buchwechsel.
    if (this.ideenScope === 'chapter') {
      this.showIdeenCard = false;
      this.ideenChapterId = null;
      this.ideenScope = 'page';
    }
    this._tokenEstGen++;
    if (typeof this._teardownStatsObserver === 'function') this._teardownStatsObserver();

    this.selectedFigurId = null;
    this.selectedOrtId = null;
    this.selectedSongId = null;
    this.selectedSzeneId = null;
    this.lastCheckId = null;

    this.szenenUpdatedAt = null;
    this.orteUpdatedAt = null;
    this.songsUpdatedAt = null;

    this.recentPageIds = [];
    if (typeof this.loadRecentPages === 'function' && this.selectedBookId) {
      this.loadRecentPages(this.selectedBookId);
    }
    this._restoreBookPrefs(this.selectedBookId);

    // Root-gehaltene Pollers stoppen (zielen sonst auf altes Buch).
    const timers = [
      '_figuresPollTimer',
      '_komplettPollTimer',
    ];
    for (const t of timers) {
      if (this[t]) { clearInterval(this[t]); this[t] = null; }
    }

    // Komplett-Analyse-UI zurücksetzen, damit ein neues Buch eine eigene
    // Komplett-Analyse queuen kann. Der Server-Job des alten Buchs läuft weiter;
    // checkPendingJobs(bookId) reconnectet beim Zurückwechseln automatisch.
    this.alleAktualisierenLoading = false;
    this.alleAktualisierenStatus = '';
    this.alleAktualisierenProgress = 0;
    this.alleAktualisierenTokIn = 0;
    this.alleAktualisierenTokOut = 0;
    this.alleAktualisierenTps = null;
    this.showKomplettStatus = false;
    this.resetDailyProgress();
    if (this.selectedBookId) this.loadDailyProgress(this.selectedBookId);
  },

  // Setzt jeden Filter-Scope zuerst auf Defaults zurück, dann überlagert
  // gespeicherte Werte aus localStorage. Wird bei Buchwechsel und beim
  // initialen Bootstrap aufgerufen.
  _restoreBookPrefs(bookId) {
    const email = this.currentUser?.email;
    for (const [stateKey, defaults] of FILTER_SCOPES) {
      const target = this[stateKey];
      if (!target) continue;
      const saved = bookId ? getFilters(email, bookId, stateKey) : null;
      for (const k of Object.keys(defaults)) {
        target[k] = (saved && Object.prototype.hasOwnProperty.call(saved, k))
          ? saved[k]
          : defaults[k];
      }
    }
  },

  async _reloadVisibleBookCards() {
    // Sub-Komponenten laden selbst per book:changed-Event.
    // `loadPages()` übernimmt den Rest (figuren + bookReviewHistory).
  },

  // Nach Sleep/Wake: in-flight Fetches sind tot, Listen können leer hängen
  // (Tab überlebt im Memory, aber TCP-Sockets sind weg). `/config` triggert
  // 401-Check über globalen Wrapper; Editor-Sessions bleiben unberührt.
  // Bei Netzfehler (DNS noch nicht zurück, TCP timeout) wird via `online`-Event
  // + setTimeout-Backoff ein Retry geplant — sonst bleibt Tree stale, wenn der
  // POST direkt vor dem Disconnect schon serverseitig committed war.
  async _refreshAfterWake() {
    if (this._wakeRefreshInflight) return;
    this._wakeRefreshInflight = true;
    let needsRetry = false;
    const isNetErr = (e) => e && (e.name === 'TypeError' || /Failed to fetch|NetworkError|ERR_/.test(String(e?.message || e)));
    try {
      try { await fetch('/config', { credentials: 'same-origin' }); }
      catch (e) { if (isNetErr(e)) needsRetry = true; }
      if (this.sessionExpired) return;
      if (this.isAdminOnly) return;
      if (this.editMode || this.editDirty) return;
      try {
        if (!this.selectedBookId) {
          await this.loadBooks();
        } else {
          await this.loadBooks({ source: 'wake' });
          await this.loadPages({ source: 'wake' });
        }
      } catch (e) {
        if (isNetErr(e)) needsRetry = true;
      }
      if (!needsRetry) {
        for (const c of EXCLUSIVE_CARDS) {
          if (this[c.flag]) {
            window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: c.key } }));
          }
        }
      }
    } finally {
      this._wakeRefreshInflight = false;
    }
    if (needsRetry) this._scheduleWakeRetry();
  },

  _scheduleWakeRetry() {
    if (this._wakeRetryArmed) return;
    this._wakeRetryArmed = true;
    const fire = () => {
      if (!this._wakeRetryArmed) return;
      this._wakeRetryArmed = false;
      window.removeEventListener('online', fire);
      if (this._wakeRetryTimer) { clearTimeout(this._wakeRetryTimer); this._wakeRetryTimer = null; }
      this._refreshAfterWake();
    };
    window.addEventListener('online', fire, { once: true });
    this._wakeRetryTimer = setTimeout(fire, 8000);
  },

  // Setzt alles zurück: Seiten-Level (via resetPage) + Buch-Level.
  // Sub-Komponenten hören auf `view:reset` und resetten eigenen State.
  async resetView() {
    window.dispatchEvent(new CustomEvent('view:reset'));
    this.resetPage();
    // Kapitel in der Sidebar bleiben geöffnet (kein c.open = false)
    this.showTreeCard = true;
    // Alle Hauptkarten schliessen (Single-Source aus feature-registry).
    for (const c of EXCLUSIVE_CARDS) this[c.flag] = false;
    this.bookReviewHistory = [];
    if (this._batchPollTimer) { clearInterval(this._batchPollTimer); this._batchPollTimer = null; }
    this.batchLoading = false;
    this.batchProgress = 0;
    this.batchStatus = '';
    this.figurenStatus = '';
    this.figurenProgress = 0;
    this.selectedFigurId = null;
    this.globalZeitstrahl = [];
    this.showGlobalZeitstrahl = false;
    this.szenen = [];
    this.szenenUpdatedAt = null;
    this.selectedSzeneId = null;
    this.orte = [];
    this.songs = [];
    this.selectedSongId = null;
    // Filter-Reset einheitlich über FILTER_SCOPES — deckt auch `suche`-Keys
    // ab, die früher nur teilweise gesetzt wurden (drift-freie SSoT).
    for (const [stateKey, defaults] of FILTER_SCOPES) {
      const target = this[stateKey];
      if (!target) continue;
      for (const k of Object.keys(defaults)) target[k] = defaults[k];
    }
    if (this._komplettPollTimer) { clearInterval(this._komplettPollTimer); this._komplettPollTimer = null; }
    this.alleAktualisierenLastRun = null;
    this.alleAktualisierenProgress = 0;
    this.alleAktualisierenTokIn = 0;
    this.alleAktualisierenTokOut = 0;
    this.alleAktualisierenTps = null;
    this.showKomplettStatus = false;
    this.resetBookChat();
    // Default-Home: nach komplettem Reset Übersicht öffnen, falls Buch gewählt.
    // Kein lastPage-Restore — Home-Klick ist expliziter Wunsch nach Overview.
    await this._maybeOpenBookOverview({ restoreLastPage: false });
  },

  // Tages-Schreibziel-Donut im Header. Eigener Loader (statt Book-Overview-
  // Card-State zu spiegeln), damit der Donut auch sichtbar ist, wenn die
  // Overview-Karte nie geoeffnet wurde. Faecht stats + booksettings parallel —
  // is_finished gated die Sichtbarkeit (kein Donut auf abgeschlossenen Buechern,
  // analog zur Book-Overview-Karte). Dedupe via _dailyProgressLoadingBookId;
  // stale Responses (Buch waehrend des Loads gewechselt) werden verworfen.
  async loadDailyProgress(bookId) {
    if (!bookId) return;
    if (this._dailyProgressLoadingBookId === bookId) return;
    this._dailyProgressLoadingBookId = bookId;
    try {
      const [stats, settings] = await Promise.all([
        fetchJson(`/history/book-stats/${bookId}`).catch(() => []),
        fetchJson(`/booksettings/${bookId}`).catch(() => null),
      ]);
      if (this.selectedBookId != bookId) return;
      this.dailyProgressStats = Array.isArray(stats) ? stats : [];
      this.dailyProgressIsFinished = !!settings?.is_finished;
      this.dailyProgressDailyGoalChars = settings?.daily_goal_chars != null ? Number(settings.daily_goal_chars) : null;
      this.dailyProgressBookId = bookId;
    } finally {
      if (this._dailyProgressLoadingBookId === bookId) this._dailyProgressLoadingBookId = null;
    }
  },

  resetDailyProgress() {
    this.dailyProgressStats = [];
    this.dailyProgressIsFinished = false;
    this.dailyProgressDailyGoalChars = null;
    this.dailyProgressBookId = null;
  },

  // Header-Today-Ring: kleiner Donut (r=14). Shared Math mit Overview-Tile in
  // [public/js/today-ring.js] — beide Donuts driften nie auseinander.
  headerTodayRing() {
    return computeTodayRing({
      stats: this.dailyProgressStats,
      tokEsts: this.tokEsts,
      goalChars: this.dailyProgressDailyGoalChars || 1500,
      r: 14,
    });
  },
};
