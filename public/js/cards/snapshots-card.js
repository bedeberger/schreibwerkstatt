// Alpine.data('snapshotsCard') — Manuskript-Meilensteine („Fassung 1/2/3").
// Hauptkarte auf Buchebene. Liste aller Fassungen + „Neue Fassung erstellen"
// (Capture des ganzen Buchs) + Vergleich zweier Fassungen (Buch-Level-Diff via
// book-snapshot-diff.js, Seiten-Diff via page-revision-diff.js#renderSideBySide).
// v1 ist Lese-/Diff-only — kein ganz-Buch-Restore.

import { fetchJson } from '../utils.js';
import { loadDiff } from '../lazy-libs.js';
import { renderSideBySide } from '../page-revision-diff.js';
import { diffSnapshots } from '../book-snapshot-diff.js';

export function registerSnapshotsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('snapshotsCard', () => ({
    snapshots: [],
    loading: false,
    capturing: false,
    deletingId: null,
    newLabel: '',
    newDescription: '',
    _bookId: null,

    // Vergleich.
    compareFrom: '',
    compareTo: '',
    diff: null,            // { summary, entries }
    diffLoading: false,
    diffError: '',
    showUnchanged: false,
    expanded: {},          // srcId -> rendered side-by-side HTML (lazy)
    expandLoading: {},     // srcId -> bool

    init() {
      const app = window.__app;
      if (app?.selectedBookId && app?.showSnapshotsCard) this.loadSnapshots(app.selectedBookId);

      this.$watch(() => window.__app?.showSnapshotsCard, (on) => {
        if (on && window.__app?.selectedBookId) this.loadSnapshots(window.__app.selectedBookId);
      });

      this._onRefresh = (e) => {
        if (e?.detail?.name !== 'snapshots') return;
        if (window.__app?.selectedBookId) this.loadSnapshots(window.__app.selectedBookId, { fresh: true });
      };
      this._onBookChanged = () => this.reset();
      this._onViewReset = () => this.reset();
      window.addEventListener('card:refresh', this._onRefresh);
      window.addEventListener('book:changed', this._onBookChanged);
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      window.removeEventListener('card:refresh', this._onRefresh);
      window.removeEventListener('book:changed', this._onBookChanged);
      window.removeEventListener('view:reset', this._onViewReset);
    },

    reset() {
      this.snapshots = [];
      this.loading = false;
      this.capturing = false;
      this.deletingId = null;
      this.newLabel = '';
      this.newDescription = '';
      this._bookId = null;
      this._resetCompare();
    },

    _resetCompare() {
      this.compareFrom = '';
      this.compareTo = '';
      this.diff = null;
      this.diffLoading = false;
      this.diffError = '';
      this.expanded = {};
      this.expandLoading = {};
    },

    async loadSnapshots(bookId, { fresh = false } = {}) {
      if (!bookId) return;
      this._bookId = bookId;
      this.loading = true;
      try {
        const url = `/snapshots/${bookId}${fresh ? '?__fresh=1' : ''}`;
        const data = await fetchJson(url);
        this.snapshots = Array.isArray(data?.snapshots) ? data.snapshots : [];
        this._autoSelectCompare();
      } catch (e) {
        console.error('[snapshots:load]', e);
        this.snapshots = [];
      } finally {
        this.loading = false;
      }
    },

    // Default: juengste vs. zweitjuengste Fassung (Liste ist DESC sortiert).
    _autoSelectCompare() {
      if (this.snapshots.length >= 2) {
        this.compareTo = String(this.snapshots[0].id);
        this.compareFrom = String(this.snapshots[1].id);
      } else {
        this.compareFrom = '';
        this.compareTo = '';
      }
      this.diff = null;
      this.expanded = {};
    },

    // ── Capture ─────────────────────────────────────────────────────────────────
    async captureSnapshot() {
      const app = window.__app;
      const bookId = app?.selectedBookId;
      if (!bookId || this.capturing) return;
      this.capturing = true;
      try {
        const r = await fetch(`/snapshots/${bookId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: this.newLabel.trim() || null,
            description: this.newDescription.trim() || null,
          }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error_code || `HTTP ${r.status}`);
        }
        this.newLabel = '';
        this.newDescription = '';
        await this.loadSnapshots(bookId, { fresh: true });
        app.setStatus?.(app.t('snapshots.captured'), false, 4000);
      } catch (e) {
        console.error('[snapshots:capture]', e);
        const msg = e.message === 'BOOK_EMPTY' ? app.t('snapshots.errorEmpty') : (app.t('snapshots.captureFailed') + ' ' + (e.message || ''));
        app.setStatus?.(msg, true, 6000);
      } finally {
        this.capturing = false;
      }
    },

    async deleteSnapshot(snap) {
      const app = window.__app;
      const bookId = app?.selectedBookId;
      if (!snap?.id || !bookId || this.deletingId) return;
      if (!confirm(app.t('snapshots.deleteConfirm', { n: snap.seq }))) return;
      this.deletingId = snap.id;
      try {
        const r = await fetch(`/snapshots/${bookId}/${snap.id}`, { method: 'DELETE' });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error_code || `HTTP ${r.status}`);
        }
        await this.loadSnapshots(bookId, { fresh: true });
        app.setStatus?.(app.t('snapshots.deleted'), false, 3000);
      } catch (e) {
        console.error('[snapshots:delete]', e);
        app.setStatus?.(app.t('snapshots.deleteFailed') + ' ' + (e.message || ''), true, 6000);
      } finally {
        this.deletingId = null;
      }
    },

    // ── Anzeige-Helfer ────────────────────────────────────────────────────────────
    fassungLabel(snap) {
      const app = window.__app;
      const base = app.t('snapshots.fassung', { n: snap.seq });
      return snap.label ? `${base} · ${snap.label}` : base;
    },

    snapOptionLabel(snap) {
      const app = window.__app;
      const when = app?.formatDate ? app.formatDate(snap.created_at) : snap.created_at;
      return `${this.fassungLabel(snap)} — ${when}`;
    },

    snapshotOptions() {
      return this.snapshots.map(s => ({ value: String(s.id), label: this.snapOptionLabel(s) }));
    },

    formatNum(n) {
      const app = window.__app;
      const locale = app?.uiLocale === 'en' ? 'en-US' : 'de-CH';
      return Number(n || 0).toLocaleString(locale);
    },

    formatDelta(d) {
      if (d == null) return '';
      const app = window.__app;
      const locale = app?.uiLocale === 'en' ? 'en-US' : 'de-CH';
      return Number(d).toLocaleString(locale, { signDisplay: 'exceptZero' });
    },

    // Delta gegen die naechstaeltere Fassung (Liste DESC → idx+1).
    charsDelta(idx) {
      const cur = this.snapshots[idx];
      const prev = this.snapshots[idx + 1];
      if (!cur || !prev) return null;
      return Number(cur.chars || 0) - Number(prev.chars || 0);
    },

    isOwn(snap) {
      const me = window.__app?.currentUser?.email;
      return !!me && !!snap?.user_email && String(me).toLowerCase() === String(snap.user_email).toLowerCase();
    },

    // ── Vergleich ───────────────────────────────────────────────────────────────
    canCompare() {
      return this.compareFrom && this.compareTo && this.compareFrom !== this.compareTo;
    },

    async runCompare() {
      const app = window.__app;
      const bookId = app?.selectedBookId;
      if (!bookId || !this.canCompare()) { this.diff = null; return; }
      this.diffLoading = true;
      this.diffError = '';
      this.diff = null;
      this.expanded = {};
      this.expandLoading = {};
      try {
        const [a, b] = await Promise.all([
          fetchJson(`/snapshots/${bookId}/${this.compareFrom}`),
          fetchJson(`/snapshots/${bookId}/${this.compareTo}`),
        ]);
        const fromContent = a?.snapshot?.content;
        const toContent = b?.snapshot?.content;
        if (!fromContent || !toContent) throw new Error('SNAPSHOT_NOT_FOUND');
        this.diff = diffSnapshots(fromContent, toContent);
      } catch (e) {
        console.error('[snapshots:compare]', e);
        this.diffError = e.message || 'compare failed';
      } finally {
        this.diffLoading = false;
      }
    },

    // Sichtbare Diff-Eintraege (unveraenderte standardmaessig ausgeblendet).
    visibleEntries() {
      if (!this.diff) return [];
      if (this.showUnchanged) return this.diff.entries;
      return this.diff.entries.filter(e => e.status !== 'unchanged' || e.renamed || e.moved);
    },

    entryKey(entry, idx) {
      return entry.srcId != null ? `s${entry.srcId}` : `i${idx}`;
    },

    statusLabel(entry) {
      const app = window.__app;
      return app.t(`snapshots.status.${entry.status}`);
    },

    chapterPathLabel(path) {
      if (!Array.isArray(path) || !path.length) return window.__app.t('snapshots.topLevel');
      return path.filter(Boolean).join(' › ');
    },

    // Lazy Word-Level-Diff fuer eine Seite (Inhalt-Aenderung).
    async toggleEntry(entry, idx) {
      const key = this.entryKey(entry, idx);
      if (this.expanded[key]) { delete this.expanded[key]; return; }
      // Reine Umbenennung/Verschiebung ohne Inhaltsaenderung: nichts zu rendern.
      if (entry.status === 'unchanged') { this.expanded[key] = ''; return; }
      this.expandLoading[key] = true;
      try {
        const app = window.__app;
        const diffLib = await loadDiff();
        const skipLabel = (n) => app?.t?.('editor.revisions.viewer.diffSkip', { n }) || `… ${n} …`;
        const out = renderSideBySide(entry.fromHtml || '', entry.toHtml || '', diffLib, { skipLabel });
        this.expanded[key] = out.unchanged ? '' : out.html;
      } catch (e) {
        console.error('[snapshots:entryDiff]', e);
        this.expanded[key] = '';
      } finally {
        this.expandLoading[key] = false;
      }
    },
  }));
}
