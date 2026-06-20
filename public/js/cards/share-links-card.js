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
    createKind: 'page', // 'page' | 'chapter'
    createPageId: '',
    createChapterId: '',
    createIntro: '',
    createExpiresAt: '',
    creating: false,
    createError: '',
    // Edit-State
    editingToken: null,
    editIntro: '',
    editExpiresAt: '',
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

    shareKindOptions() {
      const app = window.__app;
      return [
        { value: 'page',    label: app.t('share.create.page') },
        { value: 'chapter', label: app.t('share.create.chapter') },
      ];
    },

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'shareLinks',
        showFlag: 'showShareLinksCard',
        load: () => this.loadLinks(),
        onShow: () => {
          this._applyPrefill();
          return this.loadLinks();
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
        extraListeners: [
          { type: 'share:prefill', handler: (e) => {
              const d = e?.detail || {};
              if (d.kind === 'page') {
                this.createKind = 'page';
                this.createPageId = String(d.id || '');
              } else if (d.kind === 'chapter') {
                this.createKind = 'chapter';
                this.createChapterId = String(d.id || '');
              }
          } },
        ],
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
      };
      if (this.createKind === 'page') {
        body.page_id = parseInt(this.createPageId, 10);
        if (!body.page_id) { this.createError = window.__app.t('share.error.pageRequired'); return; }
      } else {
        body.chapter_id = parseInt(this.createChapterId, 10);
        if (!body.chapter_id) { this.createError = window.__app.t('share.error.chapterRequired'); return; }
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
    },

    cancelEdit() {
      this.editingToken = null;
      this.editIntro = '';
      this.editExpiresAt = '';
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

    // ── Sprung zur kommentierten Stelle im Notebook-Editor ────────────────────
    // Öffnet die betroffene Seite und markiert die Textstelle transient.
    async gotoComment(link, comment) {
      if (!comment.anchor_bid) return;
      const app = window.__app;
      if (!app) return;
      // Seite ermitteln: Page-Share = link.page_id; Chapter-Share = Block per
      // bid serverseitig der Seite zuordnen (Anker speichert keine page_id).
      let pageId = link.page_id;
      if (link.kind === 'chapter') {
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
