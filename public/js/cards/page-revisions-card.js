// Alpine.data('pageRevisionsCard') — Phase 2 (BookStack-Exit): App-eigene
// Revisionsliste pro Seite. Lebt unter dem Editor parallel zur
// Lektorat-Verlaufsleiste (pageHistoryCard). Read aus
// GET /content/pages/:id/revisions, Restore via POST .../restore.

import { fetchJson } from '../utils.js';

export function registerPageRevisionsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('pageRevisionsCard', () => ({
    revisions: [],
    open: false,
    loading: false,
    restoringId: null,
    _pageId: null,

    init() {
      const app = window.__app;
      // Initial-Load, falls beim Mount bereits eine Seite offen ist.
      const cur = app?.currentPage?.id || null;
      if (cur) this.loadRevisions(cur);

      this.$watch(() => window.__app?.currentPage?.id, (pid) => {
        if (!pid) { this.reset(); return; }
        this.loadRevisions(pid);
      });

      // Nach erfolgreichem Save fuegt der Server eine neue Revision an —
      // Reload, damit die neue Row sofort sichtbar wird, ohne Page-Reload.
      this._onRevisionsChanged = (e) => {
        const pid = e?.detail?.pageId;
        if (!pid || pid !== this._pageId) return;
        this.loadRevisions(pid);
      };
      window.addEventListener('page-revisions:changed', this._onRevisionsChanged);
    },

    destroy() {
      if (this._onRevisionsChanged) {
        window.removeEventListener('page-revisions:changed', this._onRevisionsChanged);
      }
    },

    reset() {
      this.revisions = [];
      this.open = false;
      this.loading = false;
      this.restoringId = null;
      this._pageId = null;
    },

    async loadRevisions(pageId) {
      if (!pageId) return;
      this._pageId = pageId;
      this.loading = true;
      try {
        const data = await fetchJson(`/content/pages/${pageId}/revisions`);
        this.revisions = Array.isArray(data?.revisions) ? data.revisions : [];
      } catch (e) {
        console.error('[pageRevisions:load]', e);
        this.revisions = [];
      } finally {
        this.loading = false;
      }
    },

    sourceLabel(src) {
      const app = window.__app;
      // i18n-Key pro Source. Fallback: rohe Source als Tag-Text.
      const key = `editor.revisions.source.${src}`;
      const out = app?.t?.(key);
      return out && out !== key ? out : src;
    },

    formatChars(n) {
      const app = window.__app;
      const locale = app?.uiLocale === 'en' ? 'en-US' : 'de-CH';
      return Number(n || 0).toLocaleString(locale);
    },

    async restore(rev) {
      if (!rev?.id || this.restoringId) return;
      const app = window.__app;
      const pageId = app?.currentPage?.id;
      if (!pageId) return;
      const when = app.formatDate ? app.formatDate(rev.created_at) : rev.created_at;
      if (!confirm(app.t('editor.revisions.restoreConfirm', { when }))) return;
      this.restoringId = rev.id;
      try {
        const r = await fetch(`/content/pages/${pageId}/revisions/${rev.id}/restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error_code || `HTTP ${r.status}`);
        }
        // Editor + Stats refreshen
        if (typeof app._refetchCurrentPage === 'function') {
          await app._refetchCurrentPage();
        }
        await this.loadRevisions(pageId);
        app.setStatus?.(app.t('editor.revisions.restored'), false, 4000);
      } catch (e) {
        console.error('[pageRevisions:restore]', e);
        app.setStatus?.(app.t('editor.revisions.restoreFailed') + ' ' + (e.message || ''), true, 6000);
      } finally {
        this.restoringId = null;
      }
    },
  }));
}
