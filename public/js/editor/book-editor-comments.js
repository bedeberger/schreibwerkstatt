// Kommentar-Leiste des Bucheditors: verankerte Share-Link-Leser-Kommentare des
// GANZEN Buchs als Margin-Rail rechts neben dem Manuskript-Stream. Pendant zur
// Notebook-Read-Modus-Leiste (public/js/editor/comments-rail.js), aber scope =
// ganzer Stream statt einzelner Seite. Owner springt aus der „Geteilte Links"-
// Karte für Buch-/Kapitel-Shares hierher (Event `book-editor:goto-comment`).
//
// Verhalten (Laden, Re-Anchoring, Diff, Reply/Resolve/Delete, Goto-by-bid) kommt
// aus dem geteilten Kern public/js/editor/comment-rail-core.js (SSoT mit der
// Notebook-Leiste). Hier bleibt nur die Bucheditor-Glue: Scope =
// .book-editor-stream, eigene Highlight-Namen, Stream-Ready-Check, Window-Scroll.
// Methoden werden in bookEditorCard gespreadet; State-Felder sind dort deklariert.

import { createCommentRail } from './comment-rail-core.js';
import { locateRange } from '../share-anchor.js';

function streamEl() { return document.querySelector('.book-editor-stream'); }
function layerEl() { return document.querySelector('.book-editor-comments__layer'); }
function anchorOf(root) {
  return { bid: root.anchor_bid, quote: root.anchor_quote, start: root.anchor_start, end: root.anchor_end };
}

// Lückenabstand zwischen kollidierenden Karten (px). Vertikales Verankern
// folgt dem Google-Docs-Modell: jede Karte will auf der Höhe ihrer Textstelle
// schweben; überlappende Karten werden nach unten weggeschoben.
const CARD_GAP = 10;
// Unter diesem Viewport die Leiste flach (statische Liste) rendern — die
// dritte Spalte stapelt sich dann unter den Stream (siehe book-editor.css).
const FLAT_BELOW = '(max-width: 800px)';

const rail = createCommentRail({
  scopeEl: streamEl,
  hlAll: 'book-editor-comment-anchor',
  hlActive: 'book-editor-comment-anchor-active',
  keys: {
    comments: 'bookComments', threads: 'commentThreads', selectedRootId: 'commentSelectedRootId',
    railVisible: 'commentRailVisible', replyDrafts: 'commentReplyDrafts', savingReply: 'commentSavingReply',
    savingResolve: 'commentSavingResolve', loadingBookId: '_commentLoadingBookId',
    recomputeRaf: '_commentRecomputeRaf', pendingGotoBid: '_pendingGotoBid',
    generalThreads: 'commentGeneralThreads',
  },
  // Bucheditor = ganzes Buch: alle allgemeinen (nicht-verankerten) Kommentare jedes
  // Link-Scopes (Buch/Kapitel/Seite) gehören in diese Leiste.
  generalFilter: () => true,
  // Bucheditor ist immer „Stream-Modus" — kein Read/Edit-Guard.
  idle: () => false,
  // Recompute, sobald der Stream gerendert ist (Blocks via x-init/x-effect
  // imperativ gefüllt — kurz nach blocks-Set).
  shouldWait: (ctx) => !(streamEl() && ctx.blocks.length > 0),
  // Nach jedem Thread-Set die vertikale Verankerung neu berechnen (post-render,
  // weil Kartenhöhen gemessen werden müssen).
  afterRecompute: (ctx) => ctx._scheduleCommentLayout(),
  scrollToRange: (range) => {
    const r = range.getBoundingClientRect();
    if (r && r.height) window.scrollTo({ top: window.scrollY + r.top - 140, behavior: 'smooth' });
  },
  // Gegenrichtung (Klick im Text → Leiste): das passende Thread-Item in der
  // Leiste sichtbar scrollen. block:'nearest' scrollt den Leisten-Container, nicht
  // das Fenster. rAF, damit die Auswahl-DOM-Änderung (Foot aufgeklappt) gesetzt ist.
  scrollRailToThread: (rootId) => {
    requestAnimationFrame(() => {
      const sel = `.book-editor-comments .comment-rail__thread[data-root-id="${CSS.escape(String(rootId))}"]`;
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  },
});

export const bookEditorCommentsMethods = {
  ...rail,

  // Partial-/Card-erwartete Methodennamen → geteilter Kern.
  _loadBookComments(bookId) { return this._railLoad(bookId); },
  _scheduleCommentRecompute() { return this._railSchedule(); },
  _recomputeCommentThreads() { return this._railRecompute(); },
  selectCommentThread(rootId) {
    this._railSelect(rootId);
    // Auswahl pinnt die aktive Karte auf ihre exakte Anker-Höhe und schiebt die
    // übrigen darum herum → Layout neu rechnen.
    this._scheduleCommentLayout();
  },
  replyToCommentRoot(thread) { return this._railReply(thread); },
  toggleCommentResolve(comment) { return this._railResolve(comment); },
  deleteBookComment(comment) { return this._railDelete(comment); },

  toggleCommentRail() {
    this.commentRailVisible = !this.commentRailVisible;
    // Highlights folgen der Sichtbarkeit: einblenden = neu lokalisieren+markieren,
    // ausblenden = Anker-Markierung im Stream entfernen.
    if (this.commentRailVisible) this._recomputeCommentThreads();
    else this._railClearHL();
  },

  // Klick in den Manuskript-Stream: liegt der Klick auf einer markierten
  // Kommentarstelle, den zugehörigen Thread in der Leiste anspringen. Nur wenn die
  // Kommentar-Leiste sichtbar ist (sonst existieren keine Highlights/Ranges).
  onStreamCommentClick(ev) {
    if (!this.commentRailVisible || !this.commentThreads.length) return;
    const rootId = this._railHitTest(ev.clientX, ev.clientY);
    if (rootId != null) this._railSelectFromText(rootId);
  },

  // Alias für die Card-Lifecycle/destroy (historischer Name).
  _clearCommentHL() { return this._railClearHL(); },

  // ── Vertikale Verankerung (Google-Docs-Modell) ───────────────────────────
  // Stream und Kommentar-Spalte teilen denselben Scroll-Container (Fenster bzw.
  // Karte im Vollbild) und beginnen in derselben Grid-Zeile auf gleicher Höhe.
  // Der Abstand „Textstelle → Spalten-Oberkante" ist deshalb scroll-invariant —
  // wir messen ihn nur bei Layout-Änderungen (Render, Resize, Edit, Auswahl),
  // NICHT bei jedem Scroll.

  // Observer einrichten (aus Card-init). Re-Layout bei Stream-Reflow (Edits,
  // Font-Load) via ResizeObserver + bei Viewport-Resize.
  _initCommentLayout() {
    // Ein Observer für Stream UND Karten: Stream-Reflow (Edits/Font) und
    // Karten-Höhenwachstum (async geladener „Stelle geändert"-Diff, aufgeklappte
    // Reply-Form) lösen beide ein Re-Layout aus. Loop-sicher, weil das Layout nur
    // `top` setzt, nie die Höhe der beobachteten Elemente.
    if (typeof ResizeObserver !== 'undefined') {
      this._commentResizeObs = new ResizeObserver(() => this._scheduleCommentLayout());
    }
    this._commentObserved = new Set();
    this._commentResizeHandler = () => this._scheduleCommentLayout();
    window.addEventListener('resize', this._commentResizeHandler);
  },
  // Element einmalig beobachten (Set verhindert das Re-Fire bei erneutem observe).
  _observeForLayout(el) {
    if (!el || !this._commentResizeObs || this._commentObserved.has(el)) return;
    try { this._commentResizeObs.observe(el); this._commentObserved.add(el); } catch {}
  },
  _teardownCommentLayout() {
    try { this._commentResizeObs?.disconnect(); } catch {}
    this._commentResizeObs = null;
    this._commentObserved = null;
    if (this._commentResizeHandler) window.removeEventListener('resize', this._commentResizeHandler);
    this._commentResizeHandler = null;
    if (this._commentLayoutRaf) { cancelAnimationFrame(this._commentLayoutRaf); this._commentLayoutRaf = null; }
  },

  _scheduleCommentLayout() {
    if (this._commentLayoutRaf) cancelAnimationFrame(this._commentLayoutRaf);
    // Doppel-rAF: erstes wartet auf Alpines x-for-Render der Threads, zweites
    // misst die dann existierenden Karten.
    this._commentLayoutRaf = requestAnimationFrame(() => {
      this._commentLayoutRaf = requestAnimationFrame(() => {
        this._commentLayoutRaf = null;
        this._layoutCommentCards();
      });
    });
  },

  // Anker-Y einer Karte relativ zur Layer-Oberkante. Verankerte Threads über die
  // lokalisierte Range; „Stelle geändert"-Threads (kein Range) über die
  // Block-Oberkante; sonst null.
  _commentAnchorY(thread, view, layerTop) {
    if (!thread.changed) {
      const range = locateRange(view, anchorOf(thread.root));
      if (range) { const r = range.getBoundingClientRect(); if (r.height || r.width) return r.top - layerTop; }
    }
    const bid = thread.root.anchor_bid;
    if (bid) {
      let blk = null;
      try { blk = view.querySelector(`[data-bid="${CSS.escape(String(bid))}"]`); } catch {}
      if (blk) return blk.getBoundingClientRect().top - layerTop;
    }
    return null;
  },

  _layoutCommentCards() {
    if (!this.commentRailVisible) return;
    // Flach-Modus (Mobile): Karten stapeln statisch, keine Verankerung.
    if (typeof window !== 'undefined' && window.matchMedia?.(FLAT_BELOW).matches) {
      this.commentStackHeight = 0;
      for (const t of this.commentThreads) { t._anchorY = null; t._railTop = null; }
      return;
    }
    const layer = layerEl();
    const view = streamEl();
    if (!layer || !view) return;
    this._observeForLayout(view);

    const threads = this.commentThreads;
    if (!threads.length) { this.commentStackHeight = 0; return; }
    const layerTop = layer.getBoundingClientRect().top;

    // 1) Anker-Y + gemessene Kartenhöhe pro Thread.
    const items = threads.map((t) => {
      const y = this._commentAnchorY(t, view, layerTop);
      t._anchorY = y; // SSoT für Marker-Position (echte Stelle, vor Kollision)
      const el = layer.querySelector(`.comment-rail__thread[data-root-id="${CSS.escape(String(t.root.id))}"]`);
      this._observeForLayout(el);
      return { t, y, h: el ? el.offsetHeight : 0 };
    });

    const located = items.filter((it) => it.y != null).sort((a, b) => a.y - b.y);
    const floating = items.filter((it) => it.y == null);

    // 2) Kollisions-Auflösung → Wunsch-Positionen. Bei Auswahl die aktive Karte
    //    auf ihre echte Höhe pinnen und die übrigen darum herum legen; sonst
    //    greedy top-down. Beide Zweige liefern nur Wunsch-Tops; die garantierte
    //    Überlappungsfreiheit erzwingt der Vorwärts-Sweep darunter.
    const pin = located.find((it) => it.t.root.id === this.commentSelectedRootId);
    if (pin) {
      const pi = located.indexOf(pin);
      pin.t._railTop = Math.max(0, pin.y);
      let cur = pin.t._railTop + pin.h + CARD_GAP;
      for (const it of located.slice(pi + 1)) {
        const top = Math.max(it.y, cur); it.t._railTop = top; cur = top + it.h + CARD_GAP;
      }
      let curBottom = pin.t._railTop - CARD_GAP;
      for (const it of located.slice(0, pi).reverse()) {
        let top = Math.min(it.y, curBottom - it.h);
        if (top < 0) top = 0;
        it.t._railTop = top; curBottom = top - CARD_GAP;
      }
    } else {
      let cur = 0;
      for (const it of located) { const top = Math.max(it.y, cur); it.t._railTop = top; cur = top + it.h + CARD_GAP; }
    }

    // 2b) Finaler Vorwärts-Sweep über die Wunsch-Tops erzwingt
    //     Überlappungsfreiheit. Nötig, weil der Pin-Aufwärtszweig bei zu wenig
    //     Platz oberhalb der gepinnten Karte mehrere Karten auf top:0 klemmt —
    //     die würden sich sonst gegenseitig überdecken. Reicht der Platz, ist der
    //     Sweep ein No-op (die Karten enden bereits >= CARD_GAP voneinander, der
    //     Pin bleibt auf seiner Ankerhöhe).
    located.sort((a, b) => a.t._railTop - b.t._railTop);
    let prevBottom = -Infinity;
    for (const it of located) {
      const top = Math.max(it.t._railTop, prevBottom + CARD_GAP, 0);
      it.t._railTop = top; prevBottom = top + it.h;
    }

    // 3) Nicht lokalisierbare (Fallback, in der Praxis leer) unten anhängen.
    let bottom = located.reduce((m, it) => Math.max(m, it.t._railTop + it.h), 0);
    for (const it of floating) { it.t._railTop = bottom + CARD_GAP; bottom = it.t._railTop + it.h; }

    this.commentStackHeight = Math.max(0, Math.round(bottom));
  },
};
