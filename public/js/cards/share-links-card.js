// Alpine.data('shareLinksCard') — Sub-Komponente "Geteilte Links".
// Listet alle Share-Links des Users zum aktuellen Buch, zeigt Kommentare,
// erlaubt Create/Revoke/Patch + Comment-Delete. Unread-Badge via
// owner_last_seen_at.

import { setupCardLifecycle } from './card-lifecycle.js';
import { fetchJson } from '../utils.js';

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
        this.copyToClipboard(this.linkUrl(j.token));
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
        this.commentsByToken[token] = (this.commentsByToken[token] || []).filter(c => c.id !== id);
        const link = this.links.find(l => l.token === token);
        if (link && link.comment_count > 0) link.comment_count -= 1;
      } catch (e) {
        this.loadError = e.message;
      }
    },

    async copyToClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch {}
        document.body.removeChild(ta);
      }
    },

    async copyLink(token) {
      await this.copyToClipboard(this.linkUrl(token));
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
