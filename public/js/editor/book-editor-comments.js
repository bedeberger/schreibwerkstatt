// Kommentar-Leiste des Bucheditors: verankerte Share-Link-Leser-Kommentare des
// GANZEN Buchs als Margin-Rail rechts neben dem Manuskript-Stream. Pendant zur
// Notebook-Read-Modus-Leiste (public/js/editor/comments-rail.js), aber scope =
// ganzer Stream statt einzelner Seite. Owner springt aus der „Geteilte Links"-
// Karte für Buch-/Kapitel-Shares hierher (Event `book-editor:goto-comment`).
//
// Geteilte Bausteine (kein Reinvent): groupThreads, locateRange,
// resolveCurrentQuote, renderInline, loadDiff — dieselben SSoT-Module wie die
// Notebook-Leiste und der Reader. Eigene dünne Glue (Scope = .book-editor-stream,
// Sichtbarkeit an showBookEditorCard). Methoden werden in bookEditorCard
// gespreadet; State-Felder sind dort deklariert.
//
// Ranges NIE im reaktiven State halten (Alpine-Proxy bricht Host-Objekte) —
// pro Aufruf frisch via locateRange lokalisieren.

import { fetchJson } from '../utils.js';
import { loadDiff } from '../lazy-libs.js';
import { renderInline } from '../page-revision-diff.js';
import { locateRange, resolveCurrentQuote } from '../share-anchor.js';
import { groupThreads } from './comment-threads.js';

const HL_ALL = 'book-editor-comment-anchor';
const HL_ACTIVE = 'book-editor-comment-anchor-active';

function anchorOf(root) {
  return { bid: root.anchor_bid, quote: root.anchor_quote, start: root.anchor_start, end: root.anchor_end };
}
function highlightsApi() {
  return (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined') ? CSS.highlights : null;
}
function streamEl() { return document.querySelector('.book-editor-stream'); }

// Plaintext für renderInline als ein <p> verpacken (HTML-Sonderzeichen escapen).
function wrapP(text) {
  const esc = String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<p>${esc}</p>`;
}

export const bookEditorCommentsMethods = {
  // Buch-Kommentare laden (alle Links des Owners zum Buch) + auflösen.
  async _loadBookComments() {
    const app = window.__app;
    const id = app?.selectedBookId;
    if (!id) { this.bookComments = []; this.commentThreads = []; return; }
    this._commentLoadingBookId = id;
    try {
      const rows = await fetchJson(`/share/api/book-comments/${encodeURIComponent(id)}`);
      if (this._commentLoadingBookId !== id) return;
      this.bookComments = Array.isArray(rows) ? rows : [];
    } catch { this.bookComments = []; }
    this._scheduleCommentRecompute();
  },

  // Recompute, sobald der Stream gerendert ist (Blocks via x-init/x-effect
  // imperativ gefüllt — kurz nach blocks-Set).
  _scheduleCommentRecompute() {
    if (this._commentRecomputeRaf) cancelAnimationFrame(this._commentRecomputeRaf);
    let tries = 0;
    const run = () => {
      const ready = !!streamEl() && this.blocks.length > 0;
      if (!ready && tries++ < 20) {
        this._commentRecomputeRaf = requestAnimationFrame(() => setTimeout(run, 80));
        return;
      }
      this._recomputeCommentThreads();
    };
    this._commentRecomputeRaf = requestAnimationFrame(run);
  },

  _recomputeCommentThreads() {
    const root = streamEl();
    if (!root || !this.bookComments.length) {
      this.commentThreads = [];
      this.commentSelectedRootId = null;
      this._clearCommentHL();
      return;
    }
    const blockIndex = new Map();
    root.querySelectorAll('[data-bid]').forEach((b, i) => blockIndex.set(b.getAttribute('data-bid'), i));

    const onStream = [];
    const ranges = [];
    for (const g of groupThreads(this.bookComments)) {
      const r = g.root;
      if (!r.anchor_bid) continue; // allgemeine Kommentare: Sache der Karte
      const sortKey = (bi) => bi * 1e6 + (Number.isInteger(r.anchor_start) ? r.anchor_start : 0);
      const range = locateRange(root, anchorOf(r));
      if (range) {
        const bi = blockIndex.has(String(r.anchor_bid)) ? blockIndex.get(String(r.anchor_bid)) : 1e6;
        onStream.push({ root: r, replies: g.replies, changed: false, currentText: '', _diffHtml: '', _sort: sortKey(bi) });
        ranges.push(range);
        continue;
      }
      // Block da, Quote weg → „Stelle geändert"; Block ganz weg → nicht im Buch.
      const res = resolveCurrentQuote(root, anchorOf(r));
      if (res.status !== 'changed') continue;
      const bi = blockIndex.has(String(r.anchor_bid)) ? blockIndex.get(String(r.anchor_bid)) : 1e6;
      onStream.push({ root: r, replies: g.replies, changed: true, currentText: res.currentText, _diffHtml: undefined, _sort: sortKey(bi) });
    }
    onStream.sort((a, b) => a._sort - b._sort);
    this.commentThreads = onStream;
    if (this.commentSelectedRootId && !onStream.some(t => t.root.id === this.commentSelectedRootId)) this.commentSelectedRootId = null;

    const api = highlightsApi();
    if (api) {
      try { if (ranges.length) api.set(HL_ALL, new Highlight(...ranges)); else api.delete(HL_ALL); } catch {}
    }
    this._computeCommentDiffs();

    if (this._pendingGotoBid) {
      const bid = this._pendingGotoBid;
      this._pendingGotoBid = null;
      this._gotoCommentByBid(bid);
    }
  },

  // „Stelle geändert"-Threads: Quote→aktuell-Diff lazy via jsdiff + renderInline.
  async _computeCommentDiffs() {
    const pending = this.commentThreads.filter(t => t.changed && t._diffHtml === undefined);
    if (!pending.length) return;
    let diffLib;
    try { diffLib = await loadDiff(); } catch { pending.forEach(t => { t._diffHtml = ''; }); return; }
    for (const t of pending) {
      try {
        const out = renderInline(wrapP(t.root.anchor_quote || ''), wrapP(t.currentText || ''), diffLib);
        t._diffHtml = out.unchanged ? '' : out.html;
      } catch { t._diffHtml = ''; }
    }
  },

  // Thread selektieren: Stelle im Stream hervorheben + hinscrollen.
  selectCommentThread(rootId) {
    this.commentSelectedRootId = this.commentSelectedRootId === rootId ? null : rootId;
    const api = highlightsApi();
    if (api) { try { api.delete(HL_ACTIVE); } catch {} }
    if (!this.commentSelectedRootId) return;
    const t = this.commentThreads.find(x => x.root.id === rootId);
    const root = streamEl();
    if (!t || !root) return;
    const range = locateRange(root, anchorOf(t.root));
    if (!range) return;
    if (api) { try { api.set(HL_ACTIVE, new Highlight(range)); } catch {} }
    const r = range.getBoundingClientRect();
    if (r && r.height) window.scrollTo({ top: window.scrollY + r.top - 140, behavior: 'smooth' });
  },

  // Sprung aus der Owner-Karte: Thread zu diesem data-bid öffnen + hinscrollen.
  _gotoCommentByBid(bid) {
    this.commentRailVisible = true;
    const t = this.commentThreads.find(x => String(x.root.anchor_bid) === String(bid));
    if (t) this.selectCommentThread(t.root.id);
  },

  commentAuthorLabel(c) {
    if (c.author_email) return window.__app.t('share.reader.author_badge');
    return c.reader_name || window.__app.t('share.reader.anon');
  },

  async replyToCommentRoot(thread) {
    const rootId = thread.root.id;
    const token = thread.root.share_token;
    const body = (this.commentReplyDrafts[rootId] || '').trim();
    if (!body || !token) return;
    this.commentSavingReply = rootId;
    try {
      const res = await fetch(`/share/api/links/${encodeURIComponent(token)}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_id: rootId, body }),
      });
      if (!res.ok) throw new Error('reply failed');
      const reply = await res.json();
      this.bookComments = [...this.bookComments, reply];
      this.commentReplyDrafts[rootId] = '';
      this._recomputeCommentThreads();
    } catch { /* still in der Leiste */ } finally {
      this.commentSavingReply = null;
    }
  },

  async toggleCommentResolve(comment) {
    const resolved = !comment.resolved_at;
    this.commentSavingResolve = comment.id;
    try {
      const res = await fetch(`/share/api/comments/${comment.id}/resolve`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved }),
      });
      if (!res.ok) throw new Error('resolve failed');
      comment.resolved_at = resolved ? new Date().toISOString() : null;
    } catch { /* no-op */ } finally {
      this.commentSavingResolve = null;
    }
  },

  async deleteBookComment(comment) {
    const ok = await window.__app.appConfirm({
      message: window.__app.t('share.comments.deleteConfirm'),
      confirmLabel: window.__app.t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/share/api/comments/${comment.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete failed');
      await this._loadBookComments();
    } catch { /* no-op */ }
  },

  toggleCommentRail() { this.commentRailVisible = !this.commentRailVisible; },

  _clearCommentHL() {
    const api = highlightsApi();
    if (!api) return;
    try { api.delete(HL_ALL); } catch {}
    try { api.delete(HL_ACTIVE); } catch {}
  },
};
