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
import { locateRange } from '../share-anchor.js';
import { groupThreads } from './comment-threads.js';

const HL_ALL = 'comment-rail-anchor';
const HL_ACTIVE = 'comment-rail-anchor-active';

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
    // Seitenwechsel / Edit↔Read / frisch gerendertes Seiten-HTML → neu auflösen.
    this.$watch(() => window.__app?.currentPage?.id, () => this.scheduleRecompute());
    this.$watch(() => window.__app?.editMode, () => this.scheduleRecompute());
    this.$watch(() => window.__app?.checkDone, () => this.scheduleRecompute());
    this.$watch(() => window.__app?.renderedPageHtml, () => this.scheduleRecompute());
    window.addEventListener('view:reset', () => this._onBookChange(null), { signal: this._railAbort.signal });
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
    if (app) app.pageCommentRailOpen = false;
  },

  async _onBookChange(bookId) {
    this.bookComments = [];
    this.pageThreads = [];
    this.selectedRootId = null;
    this.railVisible = true;
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
      const rendered = !!(document.querySelector('.page-content-view') && app?.renderedPageHtml);
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
    const view = document.querySelector('.page-content-view');
    if (!view) { this.pageThreads = []; clearHighlights(); this._mirrorFlag(); return; }

    const blockIndex = new Map();
    view.querySelectorAll('[data-bid]').forEach((b, i) => blockIndex.set(b.getAttribute('data-bid'), i));

    const onPage = [];
    const ranges = [];
    for (const g of groupThreads(this.bookComments)) {
      const root = g.root;
      if (!root.anchor_bid) continue; // allgemeine Kommentare: Sache der Karte
      const range = locateRange(view, anchorOf(root));
      if (!range) continue;           // gehört nicht auf diese Seite / Stelle weg
      const bi = blockIndex.has(String(root.anchor_bid)) ? blockIndex.get(String(root.anchor_bid)) : 1e6;
      onPage.push({ root, replies: g.replies, _sort: bi * 1e6 + (Number.isInteger(root.anchor_start) ? root.anchor_start : 0) });
      ranges.push(range);
    }
    onPage.sort((a, b) => a._sort - b._sort);
    this.pageThreads = onPage;
    if (this.selectedRootId && !onPage.some(t => t.root.id === this.selectedRootId)) this.selectedRootId = null;

    const api = highlightsApi();
    if (api) {
      try { if (ranges.length) api.set(HL_ALL, new Highlight(...ranges)); else api.delete(HL_ALL); } catch {}
    }
    this._mirrorFlag();
  },

  // Kommentar selektieren: Thread öffnen + Textstelle hervorheben/scrollen.
  selectThread(rootId) {
    this.selectedRootId = this.selectedRootId === rootId ? null : rootId;
    const api = highlightsApi();
    if (this._railActiveTimer) { clearTimeout(this._railActiveTimer); this._railActiveTimer = null; }
    if (api) { try { api.delete(HL_ACTIVE); } catch {} }
    if (!this.selectedRootId) return;
    const thread = this.pageThreads.find(t => t.root.id === rootId);
    const view = document.querySelector('.page-content-view');
    if (!thread || !view) return;
    const range = locateRange(view, anchorOf(thread.root));
    if (!range) return;
    if (api) { try { api.set(HL_ACTIVE, new Highlight(range)); } catch {} }
    const r = range.getBoundingClientRect();
    if (r && r.height) window.scrollTo({ top: window.scrollY + r.top - 140, behavior: 'smooth' });
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
  expandRail() { this.railVisible = true; this._mirrorFlag(); },

  // Root-Flag spiegeln: steuert die Grid-Klasse `comments-split` an
  // .editor-body-wrap (analog checkDone → lektorat-split). window.__app ist der
  // reaktive Alpine-Proxy.
  _mirrorFlag() {
    const app = window.__app;
    if (!app) return;
    app.pageCommentRailOpen = !!(this.railVisible && this.pageThreads.length
      && !app.editMode && !app.checkDone);
  },
};
