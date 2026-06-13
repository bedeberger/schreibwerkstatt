// Alpine.data('pageRevisionsCard') — App-eigene Revisionsliste pro Seite.
// Lebt unter dem Editor parallel zur
// Lektorat-Verlaufsleiste (pageHistoryCard). Read aus
// GET /content/pages/:id/revisions, Voll-Body aus .../:rev_id, Restore via
// POST .../restore. Viewer ist natives <dialog>: Tabs "Inhalt | Vergleich",
// Diff-Lib lazy.

import { fetchJson } from '../utils.js';
import { loadDiff } from '../lazy-libs.js';
import { renderSideBySide } from '../page-revision-diff.js';

export function registerPageRevisionsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('pageRevisionsCard', () => ({
    revisions: [],
    open: false,
    loading: false,
    restoringId: null,
    _pageId: null,

    // Viewer-State (Inhalt-/Vergleichs-Modal).
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
        this.loadRevisions(pid, { fresh: true });
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

    async loadRevisions(pageId, { fresh = false } = {}) {
      if (!pageId) return;
      this._pageId = pageId;
      this.loading = true;
      try {
        const url = `/content/pages/${pageId}/revisions${fresh ? '?__fresh=1' : ''}`;
        const data = await fetchJson(url);
        this.revisions = Array.isArray(data?.revisions) ? data.revisions : [];
      } catch (e) {
        console.error('[pageRevisions:load]', e);
        this.revisions = [];
      } finally {
        this.loading = false;
      }
    },

    isOwnRevision(rev) {
      if (!rev?.user_email) return false;
      const me = window.__app?.currentUser?.email;
      return !!me && String(me).toLowerCase() === String(rev.user_email).toLowerCase();
    },

    sourceLabel(src) {
      const app = window.__app;
      const key = `editor.revisions.source.${src}`;
      const out = app?.t?.(key);
      return out && out !== key ? out : src;
    },

    revisionNumber(rev) {
      if (!rev?.id) return null;
      const idx = this.revisions.findIndex(r => r.id === rev.id);
      if (idx < 0) return null;
      return this.revisions.length - idx;
    },

    formatChars(n) {
      const app = window.__app;
      const locale = app?.uiLocale === 'en' ? 'en-US' : 'de-CH';
      return Number(n || 0).toLocaleString(locale);
    },

    // Liste DESC sortiert (juengste zuerst). Vorgaengerin = revisions[idx+1].
    // Aelteste Revision hat keine Vorgaengerin → null (kein Delta-Tag).
    charsDelta(idx) {
      const cur = this.revisions[idx];
      const prev = this.revisions[idx + 1];
      if (!cur || !prev) return null;
      const a = Number(cur.chars || 0);
      const b = Number(prev.chars || 0);
      return a - b;
    },

    formatDelta(d) {
      if (d == null) return '';
      const app = window.__app;
      const locale = app?.uiLocale === 'en' ? 'en-US' : 'de-CH';
      return Number(d).toLocaleString(locale, { signDisplay: 'exceptZero' });
    },

    // ── Viewer ───────────────────────────────────────────────────────────────
    async openViewer(rev, { keepMode = false } = {}) {
      if (!rev?.id) return;
      const app = window.__app;
      const pageId = app?.currentPage?.id;
      if (!pageId) return;

      const firstOpen = !this.viewerOpen;
      // Bei Prev/Next-Navigation den aktiven Tab beibehalten; beim Frischoeffnen
      // immer mit 'content' starten.
      const mode = keepMode && this.viewerMode === 'diff' ? 'diff' : 'content';
      this.viewerOpen = true;
      this.viewerRev = rev;
      this.viewerMode = mode;
      this.viewerBody = '';
      this.viewerError = '';
      this.viewerDiffHtml = '';
      this.viewerDiffUnchanged = false;
      this.viewerLoading = true;

      if (firstOpen) {
        this.$nextTick(() => {
          const dlg = this.$refs?.viewerDialog;
          if (dlg && typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
        });
      }

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

      // Vergleichs-Tab beibehalten → Diff fuer die neu geladene Revision ziehen.
      if (this.viewerMode === 'diff' && !this.viewerError) await this._ensureDiff();
    },

    // Liste DESC sortiert (juengste zuerst). 'prev' = aelter = idx+1.
    // 'next' = neuer = idx-1.
    _siblingRev(direction) {
      if (!this.viewerRev?.id) return null;
      const idx = this.revisions.findIndex(r => r.id === this.viewerRev.id);
      if (idx < 0) return null;
      const target = direction === 'prev' ? idx + 1 : idx - 1;
      return this.revisions[target] || null;
    },
    hasPrevRev() { return !!this._siblingRev('prev'); },
    hasNextRev() { return !!this._siblingRev('next'); },
    gotoRev(direction) {
      const target = this._siblingRev(direction);
      if (target) this.openViewer(target, { keepMode: true });
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

    // Diff vergleicht aktuelle Revision (rechte Spalte = juenger) gegen
    // Vorgaenger-Revision (linke Spalte = aelter). Aelteste Revision: kein
    // Vorgaenger → leerer String, alles wird als "added" gerendert.
    async _ensureDiff() {
      const app = window.__app;
      if (!this.viewerBody || !this.viewerRev?.id) return;
      this.viewerDiffLoading = true;
      try {
        const diffLib = await loadDiff();
        const prevHtml = await this._loadPrevRevisionBody();
        const skipLabel = (n) => app?.t?.('editor.revisions.viewer.diffSkip', { n }) || `… ${n} …`;
        const out = renderSideBySide(prevHtml, this.viewerBody, diffLib, { skipLabel });
        this.viewerDiffHtml = out.html;
        this.viewerDiffUnchanged = out.unchanged;
      } catch (e) {
        console.error('[pageRevisions:viewer:diff]', e);
        this.viewerError = e.message || 'diff failed';
      } finally {
        this.viewerDiffLoading = false;
      }
    },

    // Liste ist DESC sortiert (juengste zuerst). Vorgaenger der geklickten
    // Revision ist also der NEXT-Index. Keine Vorgaengerin → leerer String.
    async _loadPrevRevisionBody() {
      const idx = this.revisions.findIndex(r => r.id === this.viewerRev?.id);
      if (idx < 0) return '';
      const prev = this.revisions[idx + 1];
      if (!prev?.id) return '';
      const app = window.__app;
      const pageId = app?.currentPage?.id;
      if (!pageId) return '';
      try {
        const data = await fetchJson(`/content/pages/${pageId}/revisions/${prev.id}`);
        return String(data?.revision?.body_html || '');
      } catch (e) {
        console.error('[pageRevisions:viewer:prev]', e);
        return '';
      }
    },

    async restoreFromViewer() {
      if (this.viewerRev) await this.restore(this.viewerRev);
    },

    // Vorgaengerin einer beliebigen Listen-Revision. Liste DESC sortiert
    // (juengste zuerst) → der "Stand davor" ist der naechstaeltere = idx+1.
    _prevRevFor(rev) {
      if (!rev?.id) return null;
      const idx = this.revisions.findIndex(r => r.id === rev.id);
      if (idx < 0) return null;
      return this.revisions[idx + 1] || null;
    },
    hasPrevRevFor(rev) { return !!this._prevRevFor(rev); },

    // "Stand davor wiederherstellen": schreibt die Vorgaenger-Revision zurueck —
    // also den Inhalt, der unmittelbar vor diesem Save existierte. Jede Revision
    // ist der Stand NACH ihrem Save, daher ist Revision N+1 (aelter) bytegenau
    // der Vor-Save-Stand von Revision N.
    async restorePrevious(rev) {
      const prev = this._prevRevFor(rev);
      if (prev) await this.restore(prev);
    },

    async restorePreviousFromViewer() {
      const prev = this._siblingRev('prev');
      if (prev) await this.restore(prev);
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
