// Alpine.data('pageRevisionsCard') — Phase 2 (BookStack-Exit): App-eigene
// Revisionsliste pro Seite. Lebt unter dem Editor parallel zur
// Lektorat-Verlaufsleiste (pageHistoryCard). Read aus
// GET /content/pages/:id/revisions, Voll-Body aus .../:rev_id, Restore via
// POST .../restore. Viewer ist natives <dialog>: Tabs "Inhalt | Vergleich",
// Diff-Lib lazy.

import { fetchJson } from '../utils.js';
import { loadDiff } from '../lazy-libs.js';
import { renderWordDiff } from '../page-revision-diff.js';

export function registerPageRevisionsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('pageRevisionsCard', () => ({
    revisions: [],
    open: false,
    loading: false,
    restoringId: null,
    _pageId: null,

    // Viewer-State (Phase 2: Inhalt-/Vergleichs-Modal).
    viewerOpen: false,
    viewerRev: null,
    viewerBody: '',
    viewerMode: 'content',     // 'content' | 'diff'
    viewerLoading: false,
    viewerError: '',
    viewerDiffHtml: '',
    viewerDiffUnchanged: false,
    viewerDiffLoading: false,

    init() {
      const app = window.__app;
      const cur = app?.currentPage?.id || null;
      if (cur) this.loadRevisions(cur);

      this.$watch(() => window.__app?.currentPage?.id, (pid) => {
        if (!pid) { this.reset(); return; }
        this.loadRevisions(pid);
      });

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
      this.closeViewer();
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
      const key = `editor.revisions.source.${src}`;
      const out = app?.t?.(key);
      return out && out !== key ? out : src;
    },

    formatChars(n) {
      const app = window.__app;
      const locale = app?.uiLocale === 'en' ? 'en-US' : 'de-CH';
      return Number(n || 0).toLocaleString(locale);
    },

    // ── Viewer ───────────────────────────────────────────────────────────────
    async openViewer(rev) {
      if (!rev?.id) return;
      const app = window.__app;
      const pageId = app?.currentPage?.id;
      if (!pageId) return;

      this.viewerOpen = true;
      this.viewerRev = rev;
      this.viewerMode = 'content';
      this.viewerBody = '';
      this.viewerError = '';
      this.viewerDiffHtml = '';
      this.viewerDiffUnchanged = false;
      this.viewerLoading = true;

      // Natives <dialog> via DOM-Referenz oeffnen.
      this.$nextTick(() => {
        const dlg = this.$refs?.viewerDialog;
        if (dlg && typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
      });

      try {
        const data = await fetchJson(`/content/pages/${pageId}/revisions/${rev.id}`);
        const rev2 = data?.revision || null;
        if (!rev2) throw new Error('REVISION_NOT_FOUND');
        this.viewerBody = String(rev2.body_html || '');
      } catch (e) {
        console.error('[pageRevisions:viewer:load]', e);
        this.viewerError = e.message || 'load failed';
      } finally {
        this.viewerLoading = false;
      }
    },

    closeViewer() {
      this.viewerOpen = false;
      this.viewerRev = null;
      this.viewerBody = '';
      this.viewerMode = 'content';
      this.viewerError = '';
      this.viewerDiffHtml = '';
      this.viewerDiffUnchanged = false;
      const dlg = this.$refs?.viewerDialog;
      if (dlg && dlg.open) dlg.close();
    },

    async setViewerMode(mode) {
      if (mode !== 'content' && mode !== 'diff') return;
      this.viewerMode = mode;
      if (mode === 'diff' && !this.viewerDiffHtml && !this.viewerError) {
        await this._ensureDiff();
      }
    },

    async _ensureDiff() {
      const app = window.__app;
      if (!this.viewerBody) return;
      this.viewerDiffLoading = true;
      try {
        const diffLib = await loadDiff();
        const currentHtml = app?.originalHtml || '';
        const out = renderWordDiff(currentHtml, this.viewerBody, diffLib);
        this.viewerDiffHtml = out.html;
        this.viewerDiffUnchanged = out.unchanged;
      } catch (e) {
        console.error('[pageRevisions:viewer:diff]', e);
        this.viewerError = e.message || 'diff failed';
      } finally {
        this.viewerDiffLoading = false;
      }
    },

    async restoreFromViewer() {
      if (this.viewerRev) await this.restore(this.viewerRev);
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
        if (typeof app._refetchCurrentPage === 'function') {
          await app._refetchCurrentPage();
        }
        await this.loadRevisions(pageId);
        app.setStatus?.(app.t('editor.revisions.restored'), false, 4000);
        this.closeViewer();
      } catch (e) {
        console.error('[pageRevisions:restore]', e);
        app.setStatus?.(app.t('editor.revisions.restoreFailed') + ' ' + (e.message || ''), true, 6000);
      } finally {
        this.restoringId = null;
      }
    },
  }));
}
