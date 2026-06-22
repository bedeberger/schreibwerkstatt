// Methoden + pure Helfer für die Kommentar-Leiste der Leseansicht
// (Notebook-Editor, Read-Modus). Zeigt verankerte Share-Link-Leser-Kommentare
// als Margin-Rail rechts neben dem Seitentext (Google-Docs-Stil): selektieren
// hebt die Textstelle hervor, antworten/erledigt/löschen laufen über die
// bestehenden Owner-Endpoints in routes/share.js. Nicht-verankerte (allgemeine)
// Kommentare bleiben der „Geteilte Links"-Karte vorbehalten.
//
// Re-Anchoring via share-anchor.js (locateRange) — gleiche SSoT wie Reader +
// Owner-Karte. Ranges werden NIE im (reaktiven) Karten-State gehalten, sondern
// pro Aufruf frisch lokalisiert: ein in einen Alpine-Proxy gewrapptes Range
// bricht (Host-Objekt, siehe block-merge/TTS-Proxy-Erfahrung).

import { fetchJson } from '../utils.js';
import { loadDiff } from '../lazy-libs.js';
import { renderInline } from '../page-revision-diff.js';
import { locateRange, resolveCurrentQuote } from '../share-anchor.js';
import { groupThreads } from './comment-threads.js';

// Plaintext für renderInline (block-/wort-basiert) als ein <p> verpacken;
// HTML-Sonderzeichen escapen, damit der DOMParser sie als Text liest.
function _wrapP(text) {
  const esc = String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<p>${esc}</p>`;
}

const HL_ALL = 'comment-rail-anchor';
const HL_ACTIVE = 'comment-rail-anchor-active';

// Read-Modus-Seitenansicht. Scope auf `.page-view-wrap`, weil der Edit-Modus
// ein zweites, früher im DOM stehendes `.page-content-view--editing` (leerer
// contenteditable) führt — ein nacktes querySelector('.page-content-view')
// träfe das und fände nie die data-bid-Blöcke der gerenderten Leseansicht.
function readView() {
  return document.querySelector('.page-view-wrap .page-content-view');
}

function anchorOf(root) {
  return { bid: root.anchor_bid, quote: root.anchor_quote, start: root.anchor_start, end: root.anchor_end };
}

function highlightsApi() {
  return (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined') ? CSS.highlights : null;
}

function clearHighlights() {
  const api = highlightsApi();
  if (!api) return;
  try { api.delete(HL_ALL); } catch {}
  try { api.delete(HL_ACTIVE); } catch {}
}

export const editorCommentsRailMethods = {
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
    // Initial laden, falls schon ein Buch offen ist.
    const id = window.__app?.selectedBookId;
    if (id) this._onBookChange(id);
  },

  destroy() {
    this._railAbort?.abort();
    if (this._recomputeRaf) { cancelAnimationFrame(this._recomputeRaf); this._recomputeRaf = null; }
    if (this._railActiveTimer) { clearTimeout(this._railActiveTimer); this._railActiveTimer = null; }
    clearHighlights();
    const app = window.__app;
    if (app) { app.pageCommentRailOpen = false; app.pageCommentCount = 0; }
  },

  async _onBookChange(bookId) {
    this.bookComments = [];
    this.pageThreads = [];
    this.selectedRootId = null;
    this.railVisible = false;
    clearHighlights();
    this._mirrorFlag();
    if (!bookId) return;
    await this.loadBookComments(bookId);
  },

  async loadBookComments(bookId) {
    const id = bookId || window.__app?.selectedBookId;
    if (!id) return;
    this._loadingBookId = id;
    try {
      const rows = await fetchJson(`/share/api/book-comments/${encodeURIComponent(id)}`);
      // Buch in der Zwischenzeit gewechselt? Verwerfen.
      if (this._loadingBookId !== id) return;
      this.bookComments = Array.isArray(rows) ? rows : [];
    } catch {
      this.bookComments = [];
    }
    this.scheduleRecompute();
  },

  // Recompute debouncen + auf Seiten-Render warten (.page-content-view wird erst
  // nach x-html befüllt). Mehrere Versuche, dann aufgeben.
  scheduleRecompute() {
    if (this._recomputeRaf) cancelAnimationFrame(this._recomputeRaf);
    this._recomputeTries = 0;
    const run = () => {
      const app = window.__app;
      const idle = !app || app.editMode || app.checkDone || !app.currentPage;
      const rendered = !!(readView() && app?.renderedPageHtml);
      if (!idle && !rendered && (this._recomputeTries = (this._recomputeTries || 0) + 1) < 20) {
        this._recomputeRaf = requestAnimationFrame(() => setTimeout(run, 80));
        return;
      }
      this.recomputePageThreads();
    };
    this._recomputeRaf = requestAnimationFrame(run);
  },

  recomputePageThreads() {
    const app = window.__app;
    if (!app || app.editMode || app.checkDone || !this.bookComments.length) {
      this.pageThreads = [];
      this.selectedRootId = null;
      clearHighlights();
      this._mirrorFlag();
      return;
    }
    const view = readView();
    if (!view) { this.pageThreads = []; clearHighlights(); this._mirrorFlag(); return; }

    const blockIndex = new Map();
    view.querySelectorAll('[data-bid]').forEach((b, i) => blockIndex.set(b.getAttribute('data-bid'), i));

    const onPage = [];
    const ranges = [];
    for (const g of groupThreads(this.bookComments)) {
      const root = g.root;
      if (!root.anchor_bid) continue; // allgemeine Kommentare: Sache der Karte
      const sortKey = (bi) => bi * 1e6 + (Number.isInteger(root.anchor_start) ? root.anchor_start : 0);
      const range = locateRange(view, anchorOf(root));
      if (range) {
        const bi = blockIndex.has(String(root.anchor_bid)) ? blockIndex.get(String(root.anchor_bid)) : 1e6;
        onPage.push({ root, replies: g.replies, changed: false, currentText: '', _diffHtml: '', _sort: sortKey(bi) });
        ranges.push(range);
        continue;
      }
      // Kein Range: entweder andere Seite (bid weg) ODER Stelle seit dem
      // Kommentar geändert. resolveCurrentQuote trennt beides.
      const res = resolveCurrentQuote(view, anchorOf(root));
      if (res.status !== 'changed') continue; // 'gone' = nicht diese Seite
      const bi = blockIndex.has(String(root.anchor_bid)) ? blockIndex.get(String(root.anchor_bid)) : 1e6;
      onPage.push({ root, replies: g.replies, changed: true, currentText: res.currentText, _diffHtml: undefined, _sort: sortKey(bi) });
      // kein Highlight (Stelle nicht mehr lokalisierbar)
    }
    onPage.sort((a, b) => a._sort - b._sort);
    this.pageThreads = onPage;
    if (this.selectedRootId && !onPage.some(t => t.root.id === this.selectedRootId)) this.selectedRootId = null;

    const api = highlightsApi();
    if (api) {
      try { if (ranges.length) api.set(HL_ALL, new Highlight(...ranges)); else api.delete(HL_ALL); } catch {}
    }
    this._mirrorFlag();
    this._computeChangedDiffs();
  },

  // Für „Stelle geändert"-Threads den Quote-vs-aktuell-Diff lazy berechnen
  // (jsdiff lazy geladen). Setzt thread._diffHtml reaktiv → Re-Render.
  async _computeChangedDiffs() {
    const pending = this.pageThreads.filter(t => t.changed && t._diffHtml === undefined);
    if (!pending.length) return;
    let diffLib;
    try { diffLib = await loadDiff(); } catch { pending.forEach(t => { t._diffHtml = ''; }); return; }
    for (const t of pending) {
      try {
        const out = renderInline(_wrapP(t.root.anchor_quote || ''), _wrapP(t.currentText || ''), diffLib);
        t._diffHtml = out.unchanged ? '' : out.html;
      } catch { t._diffHtml = ''; }
    }
  },

  // Kommentar selektieren: Thread öffnen + Textstelle hervorheben/scrollen.
  selectThread(rootId) {
    this.selectedRootId = this.selectedRootId === rootId ? null : rootId;
    const api = highlightsApi();
    if (this._railActiveTimer) { clearTimeout(this._railActiveTimer); this._railActiveTimer = null; }
    if (api) { try { api.delete(HL_ACTIVE); } catch {} }
    if (!this.selectedRootId) return;
    const thread = this.pageThreads.find(t => t.root.id === rootId);
    const view = readView();
    if (!thread || !view) return;
    const range = locateRange(view, anchorOf(thread.root));
    if (!range) return;
    if (api) { try { api.set(HL_ACTIVE, new Highlight(range)); } catch {} }
    this._scrollRangeIntoView(range);
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

  commentAuthorLabel(c) {
    if (c.author_email) return window.__app.t('share.reader.author_badge');
    return c.reader_name || window.__app.t('share.reader.anon');
  },

  async replyToRoot(thread) {
    const rootId = thread.root.id;
    const token = thread.root.share_token;
    const body = (this.replyDrafts[rootId] || '').trim();
    if (!body || !token) return;
    this.savingReply = rootId;
    try {
      const res = await fetch(`/share/api/links/${encodeURIComponent(token)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_id: rootId, body }),
      });
      if (!res.ok) throw new Error('reply failed');
      const reply = await res.json();
      this.bookComments = [...this.bookComments, reply];
      this.replyDrafts[rootId] = '';
      this.recomputePageThreads();
    } catch { /* still in der Leiste; Karte zeigt Fehler granular */ } finally {
      this.savingReply = null;
    }
  },

  async toggleResolve(comment) {
    const resolved = !comment.resolved_at;
    this.savingResolve = comment.id;
    try {
      const res = await fetch(`/share/api/comments/${comment.id}/resolve`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved }),
      });
      if (!res.ok) throw new Error('resolve failed');
      comment.resolved_at = resolved ? new Date().toISOString() : null;
    } catch { /* no-op */ } finally {
      this.savingResolve = null;
    }
  },

  async deleteComment(comment) {
    const ok = await window.__app.appConfirm({
      message: window.__app.t('share.comments.deleteConfirm'),
      confirmLabel: window.__app.t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/share/api/comments/${comment.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete failed');
      // Root-Delete kaskadiert serverseitig — Buch-Kommentare neu laden.
      await this.loadBookComments();
    } catch { /* no-op */ }
  },

  collapseRail() { this.railVisible = false; this._mirrorFlag(); },
  toggleRail() { this.railVisible = !this.railVisible; this._mirrorFlag(); },

  // Root-Flag spiegeln: steuert die Grid-Klasse `comments-split` an
  // .editor-body-wrap (analog checkDone → lektorat-split). Zusätzlich die
  // verankerte Thread-Anzahl spiegeln (Badge + Sichtbarkeit des Toggle-Buttons
  // in den Seiten-Actions). window.__app ist der reaktive Alpine-Proxy.
  _mirrorFlag() {
    const app = window.__app;
    if (!app) return;
    const onPage = !app.editMode && !app.checkDone ? this.pageThreads.length : 0;
    app.pageCommentCount = onPage;
    app.pageCommentRailOpen = !!(this.railVisible && onPage);
  },
};
