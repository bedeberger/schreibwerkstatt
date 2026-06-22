// Alpine.data('shareLinksCard') — Sub-Komponente "Geteilte Links".
// Listet alle Share-Links des Users zum aktuellen Buch, zeigt Kommentare,
// erlaubt Create/Revoke/Patch + Comment-Delete. Unread-Badge via
// owner_last_seen_at.

import { setupCardLifecycle } from './card-lifecycle.js';
import { fetchJson } from '../utils.js';
import { copyText } from '../copy-button.js';
import { locateRange } from '../share-anchor.js';

export function registerShareLinksCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('shareLinksCard', () => ({
    links: [],
    commentsByToken: {},
    loadingLinks: false,
    loadError: '',
    // Create-Form-State
    createKind: 'page', // 'page' | 'chapter' | 'book'
    createPageId: '',
    createChapterId: '',
    createIntro: '',
    createExpiresAt: '',
    createShowToc: false,
    creating: false,
    createError: '',
    // Edit-State
    editingToken: null,
    editIntro: '',
    editExpiresAt: '',
    editShowToc: false,
    savingEdit: false,
    // Comment-Liste-Toggle
    openCommentsToken: null,
    // Thread-Reply / Resolve
    replyDrafts: {},
    savingReply: null,
    savingResolve: null,
    // Transienter Timer fürs Jump-Highlight im Editor
    _jumpClearTimer: null,
    // Copy-Feedback
    copiedToken: null,
    _copiedTimer: null,
    _lifecycle: null,
    // Live-Poll: aktualisiert Liste + offenen Thread, während die Karte sichtbar ist
    _pollTimer: null,

    shareKindOptions() {
      const app = window.__app;
      return [
        { value: 'page',    label: app.t('share.create.page') },
        { value: 'chapter', label: app.t('share.create.chapter') },
        { value: 'book',    label: app.t('share.create.book') },
      ];
    },

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'shareLinks',
        showFlag: 'showShareLinksCard',
        load: () => this._loadAndPoll(),
        onShow: () => {
          this._applyPrefill();
          return this._loadAndPoll();
        },
        resetState: {
          links: [],
          commentsByToken: {},
          openCommentsToken: null,
          loadError: '',
          createError: '',
          createPageId: '',
          createChapterId: '',
        },
        timerKeys: ['_pollTimer'],
        extraListeners: [
          { type: 'share:prefill', handler: (e) => {
              const d = e?.detail || {};
              if (d.kind === 'page') {
                this.createKind = 'page';
                this.createPageId = String(d.id || '');
              } else if (d.kind === 'chapter') {
                this.createKind = 'chapter';
                this.createChapterId = String(d.id || '');
              } else if (d.kind === 'book') {
                this.createKind = 'book';
              }
          } },
        ],
      });
      // Poll stoppen, sobald die Karte ausgeblendet wird (Lifecycle-Watch deckt
      // nur die steigende Flanke ab).
      this.$watch(() => window.__app.showShareLinksCard, (visible) => {
        if (!visible) this._stopPolling();
      });
    },

    _applyPrefill() {
      const pf = window.__app?._shareLinksPrefill;
      if (!pf) return;
      if (pf.kind === 'page') {
        this.createKind = 'page';
        this.createPageId = String(pf.id || '');
      } else if (pf.kind === 'chapter') {
        this.createKind = 'chapter';
        this.createChapterId = String(pf.id || '');
      } else if (pf.kind === 'book') {
        this.createKind = 'book';
      }
      window.__app._shareLinksPrefill = null;
    },

    destroy() {
      if (this._copiedTimer) { clearTimeout(this._copiedTimer); this._copiedTimer = null; }
      if (this._jumpClearTimer) { clearTimeout(this._jumpClearTimer); this._jumpClearTimer = null; }
      try { if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete('share-comment-jump'); } catch {}
      this._lifecycle?.destroy();
    },

    async loadLinks() {
      const bookId = window.__app?.selectedBookId;
      if (!bookId) return;
      this.loadingLinks = true;
      this.loadError = '';
      try {
        const rows = await fetchJson(`/share/api/links?book_id=${encodeURIComponent(bookId)}`);
        this.links = Array.isArray(rows) ? rows : [];
        // Falls aktuelles Page-Target preselected werden soll
        if (!this.createPageId && window.__app?.currentPage?.id) {
          this.createPageId = String(window.__app.currentPage.id);
        }
      } catch (e) {
        this.loadError = e.message || 'load failed';
      } finally {
        this.loadingLinks = false;
      }
    },

    // ── Live-Poll ─────────────────────────────────────────────────────────────
    // Erst-Load (mit Loading-State) plus Start des stillen Polls. Wird sowohl
    // beim Öffnen der Karte als auch nach Buchwechsel (Lifecycle cfg.load)
    // aufgerufen — `_startPolling` ist idempotent.
    async _loadAndPoll() {
      this._startPolling();
      return this.loadLinks();
    },

    _startPolling() {
      this._stopPolling();
      this._pollTimer = setInterval(() => this._quietRefresh(), 5000);
    },

    _stopPolling() {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    },

    // Stiller Refresh ohne Loading-Flicker: aktualisiert Counts/Unread in-place
    // und lädt den offenen Thread nach. Reviewer-Kommentare (Buch/Kapitel/Seite)
    // erscheinen so binnen ~5 s beim Owner.
    async _quietRefresh() {
      if (typeof document !== 'undefined' && document.hidden) return;
      const bookId = window.__app?.selectedBookId;
      if (!bookId) return;
      let rows;
      try {
        rows = await fetchJson(`/share/api/links?book_id=${encodeURIComponent(bookId)}`);
      } catch { return; }
      if (!Array.isArray(rows)) return;
      const byToken = new Map(this.links.map(l => [l.token, l]));
      const sameSet = rows.length === this.links.length && rows.every(r => byToken.has(r.token));
      if (sameSet) {
        // In-place Merge → keine vollständige x-for-Neuzeichnung
        for (const r of rows) {
          const cur = byToken.get(r.token);
          if (!cur) continue;
          cur.view_count = r.view_count;
          cur.comment_count = r.comment_count;
          // Offener Thread gilt als gesehen — Unread lokal auf 0 halten.
          cur.unread_count = (this.openCommentsToken === r.token) ? 0 : r.unread_count;
        }
      } else {
        if (this.openCommentsToken) {
          const open = rows.find(r => r.token === this.openCommentsToken);
          if (open) open.unread_count = 0;
        }
        this.links = rows;
      }
      if (this.openCommentsToken) await this._quietReloadComments(this.openCommentsToken);
    },

    // Reload des offenen Threads (mark_seen=1, damit Unread bei aktiver Ansicht
    // 0 bleibt). Nur ersetzen, wenn sich etwas geändert hat — sonst kein Reflow,
    // der die Reply-Textareas stört.
    async _quietReloadComments(token) {
      let rows;
      try {
        rows = await fetchJson(`/share/api/links/${encodeURIComponent(token)}/comments?mark_seen=1`);
      } catch { return; }
      if (!Array.isArray(rows)) return;
      const sig = (arr) => arr.map(c => `${c.id}:${c.resolved_at || ''}`).join(',');
      if (sig(this.commentsByToken[token] || []) === sig(rows)) return;
      this.commentsByToken[token] = rows;
    },

    linkUrl(token) {
      return `${location.origin}/share/${token}`;
    },

    linkStatus(link) {
      if (link.revoked_at) return 'revoked';
      if (link.expires_at && new Date(link.expires_at) < new Date()) return 'expired';
      return 'active';
    },

    targetLabel(link) {
      if (link.kind === 'page') return link.page_name || `Page #${link.page_id}`;
      if (link.kind === 'book') return link.book_name || window.__app.selectedBookName || window.__app.t('share.target.book');
      return link.chapter_name || `Chapter #${link.chapter_id}`;
    },

    pageOptions() {
      const tree = window.__app?.tree || [];
      const out = [];
      const walk = (items, prefix) => {
        for (const it of items) {
          if (it.type !== 'chapter') continue;
          const label = prefix ? `${prefix} › ${it.name}` : it.name;
          for (const p of (it.pages || [])) {
            out.push({ value: String(p.id), label: `${label} / ${p.name}` });
          }
          if (it.subchapters?.length) walk(it.subchapters, label);
        }
      };
      walk(tree, '');
      return out;
    },

    chapterOptions() {
      const tree = window.__app?.tree || [];
      const out = [];
      const walk = (items, depth) => {
        for (const it of items) {
          if (it.type !== 'chapter' || it.solo) continue;
          out.push({ value: String(it.id), label: '— '.repeat(depth) + it.name });
          if (it.subchapters?.length) walk(it.subchapters, depth + 1);
        }
      };
      walk(tree, 0);
      return out;
    },

    async createLink() {
      this.createError = '';
      const body = {
        kind: this.createKind,
        intro: this.createIntro || null,
        expires_at: this.createExpiresAt || null,
        show_toc: this.createKind !== 'page' && this.createShowToc,
      };
      if (this.createKind === 'page') {
        body.page_id = parseInt(this.createPageId, 10);
        if (!body.page_id) { this.createError = window.__app.t('share.error.pageRequired'); return; }
      } else if (this.createKind === 'chapter') {
        body.chapter_id = parseInt(this.createChapterId, 10);
        if (!body.chapter_id) { this.createError = window.__app.t('share.error.chapterRequired'); return; }
      } else {
        body.book_id = parseInt(window.__app.selectedBookId, 10);
        if (!body.book_id) { this.createError = window.__app.t('share.error.bookRequired'); return; }
      }
      this.creating = true;
      try {
        const res = await fetch('/share/api/links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await res.json();
        if (!res.ok) {
          this.createError = window.__app.t('share.error.' + (j.error_code || 'generic'));
          return;
        }
        this.links = [j, ...this.links];
        this.createIntro = '';
        this.createExpiresAt = '';
        this.createShowToc = false;
        copyText(this.linkUrl(j.token));
        this.copiedToken = j.token;
        if (this._copiedTimer) clearTimeout(this._copiedTimer);
        this._copiedTimer = setTimeout(() => { this.copiedToken = null; }, 2500);
      } catch (e) {
        this.createError = e.message || 'create failed';
      } finally {
        this.creating = false;
      }
    },

    async revokeLink(token) {
      const ok = await window.__app.appConfirm({
        message: window.__app.t('share.revoke.confirm'),
        confirmLabel: window.__app.t('share.revoke'),
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await fetch(`/share/api/links/${encodeURIComponent(token)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('revoke failed');
        await this.loadLinks();
      } catch (e) {
        this.loadError = e.message;
      }
    },

    startEdit(link) {
      this.editingToken = link.token;
      this.editIntro = link.intro || '';
      this.editExpiresAt = link.expires_at ? link.expires_at.slice(0, 16) : '';
      this.editShowToc = !!link.show_toc;
    },

    cancelEdit() {
      this.editingToken = null;
      this.editIntro = '';
      this.editExpiresAt = '';
      this.editShowToc = false;
    },

    async saveEdit(token) {
      this.savingEdit = true;
      try {
        const res = await fetch(`/share/api/links/${encodeURIComponent(token)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            intro: this.editIntro || null,
            expires_at: this.editExpiresAt || null,
            show_toc: this.editShowToc,
          }),
        });
        if (!res.ok) throw new Error('patch failed');
        await this.loadLinks();
        this.cancelEdit();
      } catch (e) {
        this.loadError = e.message;
      } finally {
        this.savingEdit = false;
      }
    },

    async toggleComments(token) {
      if (this.openCommentsToken === token) {
        this.openCommentsToken = null;
        return;
      }
      this.openCommentsToken = token;
      try {
        const rows = await fetchJson(`/share/api/links/${encodeURIComponent(token)}/comments?mark_seen=1`);
        this.commentsByToken[token] = Array.isArray(rows) ? rows : [];
        // Unread-Count lokal nullen
        const link = this.links.find(l => l.token === token);
        if (link) link.unread_count = 0;
      } catch (e) {
        this.commentsByToken[token] = [];
        this.loadError = e.message;
      }
    },

    // Kommentare eines Tokens als Threads gruppieren (Root + Antworten).
    // Verankerte zuerst, dann allgemeine; innerhalb nach Zeit (neueste zuerst).
    threadsFor(token) {
      const rows = this.commentsByToken[token] || [];
      const repliesByParent = {};
      for (const c of rows) {
        if (c.parent_id) (repliesByParent[c.parent_id] = repliesByParent[c.parent_id] || []).push(c);
      }
      return rows
        .filter(c => !c.parent_id)
        .map(root => ({
          root,
          replies: (repliesByParent[root.id] || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
        }))
        .sort((a, b) => {
          const aa = a.root.anchor_bid ? 0 : 1;
          const bb = b.root.anchor_bid ? 0 : 1;
          if (aa !== bb) return aa - bb;
          return new Date(b.root.created_at) - new Date(a.root.created_at);
        });
    },

    commentAuthorLabel(c) {
      if (c.author_email) return window.__app.t('share.reader.author_badge');
      return c.reader_name || window.__app.t('share.reader.anon');
    },

    // Der Link, dessen Kommentare im Seiten-Panel angezeigt werden (oder null).
    commentPanelLink() {
      return this.openCommentsToken ? this.links.find(l => l.token === this.openCommentsToken) || null : null;
    },

    // ── Sprung zur kommentierten Stelle im Notebook-Editor ────────────────────
    // Öffnet die betroffene Seite und markiert die Textstelle transient.
    async gotoComment(link, comment) {
      if (!comment.anchor_bid) return;
      const app = window.__app;
      if (!app) return;
      // Seite ermitteln: Page-Share = link.page_id; Chapter-Share = Block per
      // bid serverseitig der Seite zuordnen (Anker speichert keine page_id).
      let pageId = link.page_id;
      if (link.kind === 'chapter' || link.kind === 'book') {
        try {
          const r = await fetchJson(`/share/api/links/${encodeURIComponent(link.token)}/locate?bid=${encodeURIComponent(comment.anchor_bid)}`);
          pageId = r && r.page_id;
        } catch { pageId = null; }
      }
      if (!pageId) { this.loadError = window.__app.t('share.comments.pageGone'); return; }
      app.gotoPageById(pageId);
      this._highlightInEditor({
        bid: comment.anchor_bid, quote: comment.anchor_quote,
        start: comment.anchor_start, end: comment.anchor_end,
      });
    },

    // Wartet, bis die Seite im Editor gerendert ist, markiert die Stelle per
    // CSS Custom Highlight (transient) und scrollt hin.
    _highlightInEditor(anchor) {
      const ok = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
      let tries = 0;
      const tick = () => {
        const view = document.querySelector('.page-content-view');
        const block = view && anchor.bid
          ? (() => { try { return view.querySelector(`[data-bid="${CSS.escape(anchor.bid)}"]`); } catch { return null; } })()
          : null;
        if (view && block) {
          if (ok) {
            const range = locateRange(view, anchor);
            if (range) {
              CSS.highlights.set('share-comment-jump', new Highlight(range));
              clearTimeout(this._jumpClearTimer);
              this._jumpClearTimer = setTimeout(() => { try { CSS.highlights.delete('share-comment-jump'); } catch {} }, 6000);
              const r = range.getBoundingClientRect();
              if (r && r.height) { window.scrollTo({ top: window.scrollY + r.top - 140, behavior: 'smooth' }); return; }
            }
          }
          block.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        if (tries++ < 40) setTimeout(tick, 100); // bis ~4s auf Render warten
      };
      setTimeout(tick, 150);
    },

    async reloadComments(token) {
      try {
        const rows = await fetchJson(`/share/api/links/${encodeURIComponent(token)}/comments`);
        this.commentsByToken[token] = Array.isArray(rows) ? rows : [];
      } catch (e) {
        this.loadError = e.message;
      }
    },

    async replyToComment(token, rootId) {
      const body = (this.replyDrafts[rootId] || '').trim();
      if (!body) return;
      this.savingReply = rootId;
      try {
        const res = await fetch(`/share/api/links/${encodeURIComponent(token)}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parent_id: rootId, body }),
        });
        if (!res.ok) throw new Error('reply failed');
        const reply = await res.json();
        this.commentsByToken[token] = [...(this.commentsByToken[token] || []), reply];
        this.replyDrafts[rootId] = '';
        const link = this.links.find(l => l.token === token);
        if (link) link.comment_count = (link.comment_count || 0) + 1;
      } catch (e) {
        this.loadError = e.message;
      } finally {
        this.savingReply = null;
      }
    },

    async toggleResolve(token, comment) {
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
        window.__app.refreshShareCommentCounts();
      } catch (e) {
        this.loadError = e.message;
      } finally {
        this.savingResolve = null;
      }
    },

    async deleteComment(token, id) {
      const ok = await window.__app.appConfirm({
        message: window.__app.t('share.comments.deleteConfirm'),
        confirmLabel: window.__app.t('common.delete'),
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await fetch(`/share/api/comments/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('delete failed');
        // Root-Delete kascadiert Antworten serverseitig — neu laden für korrekten Stand.
        await this.reloadComments(token);
        const link = this.links.find(l => l.token === token);
        if (link) link.comment_count = (this.commentsByToken[token] || []).length;
      } catch (e) {
        this.loadError = e.message;
      }
    },

    async copyLink(token) {
      await copyText(this.linkUrl(token));
      this.copiedToken = token;
      if (this._copiedTimer) clearTimeout(this._copiedTimer);
      this._copiedTimer = setTimeout(() => { this.copiedToken = null; }, 2500);
    },

    formatExpires(iso) {
      if (!iso) return '';
      try {
        const d = new Date(iso);
        return d.toLocaleString(window.__app?.uiLocale === 'en' ? 'en-US' : 'de-CH', {
          timeZone: window.__app?.appTimezone || 'Europe/Zurich',
          dateStyle: 'medium',
          timeStyle: 'short',
        });
      } catch { return iso; }
    },
  }));
}
