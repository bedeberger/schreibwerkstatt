// Geteilter Kern der zwei Kommentar-Leisten (Notebook-Read-Modus + Bucheditor).
// Beide zeigen verankerte Share-Link-Leser-Kommentare als Margin-Rail neben dem
// Text; sie unterscheiden sich nur im Scope-Element, den Highlight-Namen, den
// State-Feldnamen und ein paar Verhaltens-Hooks (Read-Modus-Guard, Mirror auf
// Root-Flags, Scroll-Container). Die eigentliche Logik — Laden, Thread-Gruppieren,
// Re-Anchoring, Diff der „Stelle geändert"-Threads, Reply/Resolve/Delete — ist
// identisch und lebt hier (SSoT). Die CSS/DOM-Klassen der zwei Editoren bleiben
// getrennt (Editor-Entkopplung); geteilt wird nur das Verhalten.
//
// `createCommentRail(cfg)` liefert ein Methoden-Bündel (`_rail*`), das die
// Editor-Module spreaden und unter ihren Partial-erwarteten Namen aliasen.
// Ranges werden NIE im (reaktiven) Karten-State gehalten — ein in einen
// Alpine-Proxy gewrapptes Range bricht (Host-Objekt) —, sondern pro Aufruf
// frisch via locateRange lokalisiert.

import { fetchJson } from '../utils.js';
import { loadDiff } from '../lazy-libs.js';
import { renderInline } from '../page-revision-diff.js';
import { locateRange, resolveCurrentQuote } from '../share-anchor.js';
import { groupThreads } from './comment-threads.js';

function anchorOf(root) {
  return { bid: root.anchor_bid, quote: root.anchor_quote, start: root.anchor_start, end: root.anchor_end };
}

function highlightsApi() {
  return (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined') ? CSS.highlights : null;
}

// Klick-Koordinaten → (Textknoten, Offset). Highlights (CSS Custom Highlight API)
// sind nicht klickbar — darum den Caret-Punkt unter dem Klick auflösen und gegen
// die Kommentar-Ranges testen. Zwei Browser-APIs (Standard + WebKit-Legacy).
function caretPosFromPoint(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) return { node: p.offsetNode, offset: p.offset };
  }
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) return { node: r.startContainer, offset: r.startOffset };
  }
  return null;
}

// Plaintext für renderInline (block-/wort-basiert) als ein <p> verpacken;
// HTML-Sonderzeichen escapen, damit der DOMParser sie als Text liest.
function wrapP(text) {
  const esc = String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<p>${esc}</p>`;
}

// cfg:
//   scopeEl()              → Element|null (Wurzel mit den data-bid-Blöcken)
//   hlAll, hlActive        → CSS-Custom-Highlight-Namen (pro Editor eindeutig)
//   keys                   → Mapping abstrakter Felder auf die Karten-State-Namen:
//     { comments, threads, selectedRootId, railVisible, replyDrafts,
//       savingReply, savingResolve, loadingBookId, recomputeRaf,
//       pendingGotoBid?, generalThreads? }
//   generalFilter(root, app) → optional. Liefert true ⇒ dieser nicht-verankerte
//     (allgemeine) Kommentar gehört in diese Leiste. Nur ausgewertet, wenn
//     keys.generalThreads gesetzt ist; ohne Filter werden allgemeine Kommentare
//     verworfen (altes Verhalten). Notebook: nur Page-Share der offenen Seite;
//     Bucheditor: alle (ganzes Buch).
//   idle(app)              → true ⇒ keine Threads zeigen (z.B. Notebook-Edit-Modus). Default: false
//   shouldWait(ctx, app)   → true ⇒ Recompute verschieben (Render noch nicht da)
//   afterRecompute(ctx)    → optionaler Hook nach Thread-Set (z.B. Root-Flags spiegeln)
//   scrollToRange(range, ctx) → Range in den Sichtbereich scrollen
export function createCommentRail(cfg) {
  const K = cfg.keys;

  const clearHL = () => {
    const api = highlightsApi();
    if (!api) return;
    try { api.delete(cfg.hlAll); } catch {}
    try { api.delete(cfg.hlActive); } catch {}
  };

  return {
    _railClearHL: clearHL,

    // Buch-Kommentare laden (alle Links des Owners zum Buch) + auflösen.
    async _railLoad(bookId) {
      const id = bookId || window.__app?.selectedBookId;
      if (!id) { this[K.comments] = []; this[K.threads] = []; return; }
      this[K.loadingBookId] = id;
      try {
        const rows = await fetchJson(`/share/api/book-comments/${encodeURIComponent(id)}`);
        // Buch in der Zwischenzeit gewechselt? Verwerfen.
        if (this[K.loadingBookId] !== id) return;
        this[K.comments] = Array.isArray(rows) ? rows : [];
      } catch {
        this[K.comments] = [];
      }
      this._railSchedule();
    },

    // Recompute debouncen + auf Seiten-/Stream-Render warten (Container wird erst
    // nach x-html/x-init befüllt). Mehrere Versuche, dann aufgeben.
    _railSchedule() {
      if (this[K.recomputeRaf]) cancelAnimationFrame(this[K.recomputeRaf]);
      let tries = 0;
      const run = () => {
        if (cfg.shouldWait(this, window.__app) && tries++ < 20) {
          this[K.recomputeRaf] = requestAnimationFrame(() => setTimeout(run, 80));
          return;
        }
        this._railRecompute();
      };
      this[K.recomputeRaf] = requestAnimationFrame(run);
    },

    _railRecompute() {
      const app = window.__app;
      const view = cfg.scopeEl();
      if (cfg.idle?.(app) || !this[K.comments]?.length || !view) {
        this[K.threads] = [];
        if (K.generalThreads) this[K.generalThreads] = [];
        this[K.selectedRootId] = null;
        clearHL();
        cfg.afterRecompute?.(this);
        return;
      }

      const blockIndex = new Map();
      view.querySelectorAll('[data-bid]').forEach((b, i) => blockIndex.set(b.getAttribute('data-bid'), i));

      const onView = [];
      const general = [];
      const ranges = [];
      for (const g of groupThreads(this[K.comments])) {
        const root = g.root;
        if (!root.anchor_bid) {
          // Allgemeine (nicht-verankerte) Kommentare: in den General-Bucket, wenn
          // diese Leiste sie führt (Notebook: Page-Share der Seite; Bucheditor: alle).
          if (K.generalThreads && cfg.generalFilter?.(root, app)) general.push({ root, replies: g.replies });
          continue;
        }
        const sortKey = (bi) => bi * 1e6 + (Number.isInteger(root.anchor_start) ? root.anchor_start : 0);
        const bi = blockIndex.has(String(root.anchor_bid)) ? blockIndex.get(String(root.anchor_bid)) : 1e6;
        const range = locateRange(view, anchorOf(root));
        if (range) {
          onView.push({ root, replies: g.replies, changed: false, currentText: '', _diffHtml: '', _sort: sortKey(bi) });
          ranges.push(range);
          continue;
        }
        // Kein Range: Block da, Quote weg → „Stelle geändert"; Block ganz weg →
        // nicht auf dieser Seite / nicht im Stream. resolveCurrentQuote trennt beides.
        const res = resolveCurrentQuote(view, anchorOf(root));
        if (res.status !== 'changed') continue;
        onView.push({ root, replies: g.replies, changed: true, currentText: res.currentText, _diffHtml: undefined, _sort: sortKey(bi) });
        // kein Highlight (Stelle nicht mehr lokalisierbar)
      }
      onView.sort((a, b) => a._sort - b._sort);
      this[K.threads] = onView;
      // Allgemeine zuletzt zugefügt zuerst (neueste oben) — analog zur alten Karte.
      if (K.generalThreads) {
        general.sort((a, b) => new Date(b.root.created_at) - new Date(a.root.created_at));
        this[K.generalThreads] = general;
      }
      const inView = (id) => onView.some(t => t.root.id === id) || general.some(t => t.root.id === id);
      if (this[K.selectedRootId] && !inView(this[K.selectedRootId])) this[K.selectedRootId] = null;

      // Anker-Highlights nur bei sichtbarer Leiste — eingeklappt = Kommentare aus,
      // also auch keine markierten Stellen im Text.
      const api = highlightsApi();
      if (api) {
        try { if (this[K.railVisible] && ranges.length) api.set(cfg.hlAll, new Highlight(...ranges)); else api.delete(cfg.hlAll); } catch {}
      }
      cfg.afterRecompute?.(this);
      this._railComputeDiffs();

      // Sprung aus der Owner-Karte: Thread zu diesem data-bid öffnen.
      if (K.pendingGotoBid && this[K.pendingGotoBid]) {
        const bid = this[K.pendingGotoBid];
        this[K.pendingGotoBid] = null;
        const t = onView.find(x => String(x.root.anchor_bid) === String(bid));
        if (t) this._railSelect(t.root.id);
      }
    },

    // „Stelle geändert"-Threads: Quote→aktuell-Diff lazy via jsdiff + renderInline.
    async _railComputeDiffs() {
      const pending = this[K.threads].filter(t => t.changed && t._diffHtml === undefined);
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

    // Thread selektieren: Stelle hervorheben + hinscrollen (Toggle).
    _railSelect(rootId) {
      this[K.selectedRootId] = this[K.selectedRootId] === rootId ? null : rootId;
      const api = highlightsApi();
      if (api) { try { api.delete(cfg.hlActive); } catch {} }
      if (!this[K.selectedRootId]) return;
      // Verankerte Threads hervorheben; allgemeine (General-Bucket, kein Anker)
      // klappen nur ihre Aktionen auf — kein Range zum Markieren/Scrollen.
      const thread = this[K.threads].find(t => t.root.id === rootId);
      const view = cfg.scopeEl();
      if (!thread || !view) return;
      const range = locateRange(view, anchorOf(thread.root));
      if (!range) return;
      if (api) { try { api.set(cfg.hlActive, new Highlight(range)); } catch {} }
      cfg.scrollToRange(range, this);
    },

    // Klick im Text → rootId des verankerten Threads, dessen Range den Klickpunkt
    // enthält (oder null). „Stelle geändert"-Threads haben keine Range → übersprungen.
    _railHitTest(clientX, clientY) {
      const view = cfg.scopeEl();
      if (!view) return null;
      const pos = caretPosFromPoint(clientX, clientY);
      if (!pos || !pos.node) return null;
      for (const t of (this[K.threads] || [])) {
        if (t.changed) continue;
        const range = locateRange(view, anchorOf(t.root));
        if (!range) continue;
        try { if (range.isPointInRange(pos.node, pos.offset)) return t.root.id; } catch {}
      }
      return null;
    },

    // Auswahl ausgehend vom Text-Klick: immer selektieren (kein Toggle), Stelle
    // hervorheben und die LEISTE zum Thread scrollen (Gegenrichtung zu _railSelect,
    // das den Text scrollt — der User ist hier schon an der Textstelle).
    _railSelectFromText(rootId) {
      this[K.selectedRootId] = rootId;
      const api = highlightsApi();
      if (api) { try { api.delete(cfg.hlActive); } catch {} }
      const thread = this[K.threads].find(t => t.root.id === rootId);
      const view = cfg.scopeEl();
      if (thread && view) {
        const range = locateRange(view, anchorOf(thread.root));
        if (range && api) { try { api.set(cfg.hlActive, new Highlight(range)); } catch {} }
      }
      cfg.scrollRailToThread?.(rootId, this);
    },

    commentAuthorLabel(c) {
      if (c.author_email) return window.__app.t('share.reader.author_badge');
      return c.reader_name || window.__app.t('share.reader.anon');
    },

    // Avatar-Daten für die Meta-Zeile (Google-Docs-Optik): Label + Initialen-Pip
    // mit deterministischer Hue pro Person (wiederverwendet die presence-pip-Optik,
    // DESIGN.md). Leser haben keine Email → Initialen/Hue leiten sich aus dem
    // Anzeigenamen ab; Owner-Antworten nutzen author_display_name (Fallback Badge).
    commentAvatar(c) {
      const app = window.__app;
      const isAuthor = !!c.author_email;
      const label = isAuthor
        ? (c.author_display_name || app.t('share.reader.author_badge'))
        : (c.reader_name || app.t('share.reader.anon'));
      const seed = isAuthor ? (c.author_email || label) : (c.reader_name || 'anon');
      const tokens = String(label).split(/[\s._@-]+/).filter(Boolean);
      const initials = tokens.length
        ? ((tokens[0][0] || '') + (tokens.length > 1 ? (tokens[1][0] || '') : '')).toUpperCase().slice(0, 2)
        : '?';
      return { label, initials, hue: app.userAvatarHue(seed) };
    },

    async _railReply(thread) {
      const rootId = thread.root.id;
      const token = thread.root.share_token;
      const body = (this[K.replyDrafts][rootId] || '').trim();
      if (!body || !token) return;
      this[K.savingReply] = rootId;
      try {
        const res = await fetch(`/share/api/links/${encodeURIComponent(token)}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parent_id: rootId, body }),
        });
        if (!res.ok) throw new Error('reply failed');
        const reply = await res.json();
        this[K.comments] = [...this[K.comments], reply];
        this[K.replyDrafts][rootId] = '';
        this._railRecompute();
      } catch { /* still in der Leiste; Owner-Karte zeigt Fehler granular */ } finally {
        this[K.savingReply] = null;
      }
    },

    async _railResolve(comment) {
      const resolved = !comment.resolved_at;
      this[K.savingResolve] = comment.id;
      try {
        const res = await fetch(`/share/api/comments/${comment.id}/resolve`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resolved }),
        });
        if (!res.ok) throw new Error('resolve failed');
        comment.resolved_at = resolved ? new Date().toISOString() : null;
        // Tree-/Seiten-Badge (offene Reviewer-Kommentare) syncen — Resolve ändert
        // die Pro-Seite-Zählung.
        window.__app?.refreshShareCommentCounts?.();
      } catch { /* no-op */ } finally {
        this[K.savingResolve] = null;
      }
    },

    async _railDelete(comment) {
      const ok = await window.__app.appConfirm({
        message: window.__app.t('share.comments.deleteConfirm'),
        confirmLabel: window.__app.t('common.delete'),
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await fetch(`/share/api/comments/${comment.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('delete failed');
        // Root-Delete kaskadiert serverseitig — Buch-Kommentare neu laden + Badge syncen.
        await this._railLoad();
        window.__app?.refreshShareCommentCounts?.();
      } catch { /* no-op */ }
    },
  };
}
