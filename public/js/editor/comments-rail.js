// Kommentar-Leiste der Leseansicht (Notebook-Editor, Read-Modus). Zeigt
// verankerte Share-Link-Leser-Kommentare als Margin-Rail rechts neben dem
// Seitentext (Google-Docs-Stil): selektieren hebt die Textstelle hervor,
// antworten/erledigt/löschen laufen über die bestehenden Owner-Endpoints in
// routes/share.js. Nicht-verankerte (allgemeine) Kommentare bleiben der
// „Geteilte Links"-Karte vorbehalten.
//
// Verhalten (Laden, Re-Anchoring, Diff, Reply/Resolve/Delete) kommt aus dem
// geteilten Kern public/js/editor/comment-rail-core.js (SSoT mit der Bucheditor-
// Leiste). Hier bleibt nur die Notebook-spezifische Glue: Scope =
// .page-view-wrap, Read-Modus-Guard, Root-Flag-Mirror (Grid-Split + Toggle-Badge)
// und der Split-Pane-Scroll.

import { createCommentRail } from './comment-rail-core.js';

// Read-Modus-Seitenansicht. Scope auf `.page-view-wrap`, weil der Edit-Modus
// ein zweites, früher im DOM stehendes `.page-content-view--editing` (leerer
// contenteditable) führt — ein nacktes querySelector('.page-content-view')
// träfe das und fände nie die data-bid-Blöcke der gerenderten Leseansicht.
function readView() {
  return document.querySelector('.page-view-wrap .page-content-view');
}

const rail = createCommentRail({
  scopeEl: readView,
  hlAll: 'comment-rail-anchor',
  hlActive: 'comment-rail-anchor-active',
  keys: {
    comments: 'bookComments', threads: 'pageThreads', selectedRootId: 'selectedRootId',
    railVisible: 'railVisible', replyDrafts: 'replyDrafts', savingReply: 'savingReply',
    savingResolve: 'savingResolve', loadingBookId: '_loadingBookId', recomputeRaf: '_recomputeRaf',
    pendingGotoBid: '_pendingGotoBid', generalThreads: 'generalThreads',
  },
  // Allgemeine (nicht-verankerte) Kommentare gehören in diese Seitenleiste, wenn der
  // Link ein Page-Share genau der offenen Seite ist — Buch-/Kapitel-Share-Allgemeines
  // hat keine eindeutige Seite und lebt im Bucheditor.
  generalFilter: (root, app) =>
    root.link_kind === 'page' && String(root.link_page_id) === String(app?.currentPage?.id ?? ''),
  // Rail nur im Read-Modus (kein Edit, kein Lektorat-Split). Kein App-Root → idle.
  idle: (app) => !app || app.editMode || app.checkDone,
  // Recompute verschieben, bis die Read-View gerendert ist (.page-content-view
  // wird erst nach x-html befüllt). Im Idle-Zustand nicht warten — recompute
  // räumt dann auf.
  shouldWait: (ctx, app) => {
    const idle = !app || app.editMode || app.checkDone || !app.currentPage;
    const rendered = !!(readView() && app?.renderedPageHtml);
    return !idle && !rendered;
  },
  afterRecompute: (ctx) => ctx._mirrorFlag(),
  scrollToRange: (range, ctx) => ctx._scrollRangeIntoView(range),
});

export const editorCommentsRailMethods = {
  ...rail,

  // Partial-erwartete Methodennamen → geteilter Kern.
  loadBookComments(bookId) { return this._railLoad(bookId); },
  scheduleRecompute() { return this._railSchedule(); },
  recomputePageThreads() { return this._railRecompute(); },
  selectThread(rootId) { return this._railSelect(rootId); },
  replyToRoot(thread) { return this._railReply(thread); },
  toggleResolve(comment) { return this._railResolve(comment); },
  deleteComment(comment) { return this._railDelete(comment); },

  init() {
    this._railAbort = new AbortController();
    // Buchwechsel: State leeren + Kommentare des neuen Buchs laden.
    this.$watch(() => window.__app?.selectedBookId, (id) => this._onBookChange(id));
    // Seitenwechsel: Leiste einklappen (Toggle ist pro Seite — sonst „folgt" der
    // offene Zustand auf die nächste Seite, die zufällig Kommentare hat) + neu
    // auflösen. Edit↔Read / frisch gerendertes Seiten-HTML nur neu auflösen.
    this.$watch(() => window.__app?.currentPage?.id, () => { this.railVisible = false; this.scheduleRecompute(); });
    this.$watch(() => window.__app?.editMode, () => this.scheduleRecompute());
    this.$watch(() => window.__app?.checkDone, () => this.scheduleRecompute());
    this.$watch(() => window.__app?.renderedPageHtml, () => this.scheduleRecompute());
    window.addEventListener('view:reset', () => this._onBookChange(null), { signal: this._railAbort.signal });
    // Toggle-Button in den Seiten-Actions (Root-Scope) steuert die Sichtbarkeit
    // per Window-Event (Trampolin, da der Button nicht im Karten-Scope liegt).
    window.addEventListener('comments-rail:toggle', () => this.toggleRail(), { signal: this._railAbort.signal });
    // Sprung aus der „Geteilte Links"-Karte (Seiten-Share): Leiste öffnen + Thread
    // zu diesem data-bid selektieren (Pendant zum Bucheditor-Sprung).
    window.addEventListener('comments-rail:goto', (e) => {
      this.railVisible = true;
      this._pendingGotoBid = e.detail?.bid || null;
      this.scheduleRecompute();
    }, { signal: this._railAbort.signal });
    // Initial laden, falls schon ein Buch offen ist.
    const id = window.__app?.selectedBookId;
    if (id) this._onBookChange(id);
  },

  destroy() {
    this._railAbort?.abort();
    if (this._recomputeRaf) { cancelAnimationFrame(this._recomputeRaf); this._recomputeRaf = null; }
    this._railClearHL();
    const app = window.__app;
    if (app) { app.pageCommentRailOpen = false; app.pageCommentCount = 0; }
  },

  async _onBookChange(bookId) {
    this.bookComments = [];
    this.pageThreads = [];
    this.generalThreads = [];
    this.selectedRootId = null;
    this.railVisible = false;
    this._pendingGotoBid = null;
    this._railClearHL();
    this._mirrorFlag();
    if (!bookId) return;
    await this.loadBookComments(bookId);
  },

  // Im Desktop-Split scrollt .editor-preview-wrap selbst (overflow-y:auto,
  // height:100%) — window.scrollTo greift dort nicht. Gestapelt (<1100px)
  // scrollt das Fenster. Scroll-Container daher dynamisch wählen.
  _scrollRangeIntoView(range) {
    const r = range.getBoundingClientRect();
    if (!r || !r.height) return;
    const pane = document.querySelector('.editor-preview-wrap');
    if (pane && pane.scrollHeight > pane.clientHeight + 1) {
      const paneRect = pane.getBoundingClientRect();
      pane.scrollTo({ top: pane.scrollTop + (r.top - paneRect.top) - 80, behavior: 'smooth' });
      return;
    }
    window.scrollTo({ top: window.scrollY + r.top - 140, behavior: 'smooth' });
  },

  collapseRail() { this.railVisible = false; this._railClearHL(); this._mirrorFlag(); },
  toggleRail() {
    this.railVisible = !this.railVisible;
    // Highlights folgen der Sichtbarkeit: einblenden = neu lokalisieren+markieren,
    // ausblenden = Anker-Markierung im Seitentext entfernen.
    if (this.railVisible) this.recomputePageThreads();
    else { this._railClearHL(); this._mirrorFlag(); }
  },

  // Root-Flag spiegeln: steuert die Grid-Klasse `comments-split` an
  // .editor-body-wrap (analog checkDone → lektorat-split). Zusätzlich die
  // verankerte Thread-Anzahl spiegeln (Badge + Sichtbarkeit des Toggle-Buttons
  // in den Seiten-Actions). window.__app ist der reaktive Alpine-Proxy.
  _mirrorFlag() {
    const app = window.__app;
    if (!app) return;
    // Verankerte + allgemeine (Page-Share dieser Seite) Threads zählen.
    const onPage = !app.editMode && !app.checkDone
      ? this.pageThreads.length + (this.generalThreads?.length || 0) : 0;
    app.pageCommentCount = onPage;
    app.pageCommentRailOpen = !!(this.railVisible && onPage);
  },
};
