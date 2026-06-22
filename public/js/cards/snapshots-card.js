// Alpine.data('snapshotsCard') — Manuskript-Meilensteine („Fassung 1/2/3").
// Hauptkarte auf Buchebene. Liste aller Fassungen + „Neue Fassung erstellen"
// (Capture des ganzen Buchs) + Vergleich zweier Fassungen (Buch-Level-Diff via
// book-snapshot-diff.js, Seiten-Diff via page-revision-diff.js#renderSideBySide)
// + Reader (Fassung nur-lesend oeffnen) + Export (HTML/TXT/MD/EPUB/DOCX sync,
// PDF via Job) + destruktiver Restore.

import { fetchJson } from '../utils.js';
import { loadDiff } from '../lazy-libs.js';
import { fromSnapshotTree } from '../manuscript-stream.js';
import { renderSideBySide, renderInline } from '../page-revision-diff.js';
import { diffSnapshots } from '../book-snapshot-diff.js';
import { startPoll } from './job-helpers.js';

export function registerSnapshotsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('snapshotsCard', () => ({
    snapshots: [],
    loading: false,
    capturing: false,
    deletingId: null,
    restoringId: null,
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

    // Reader (Fassung nur-lesend oeffnen, Bucheditor-Look) + Export.
    readerOpen: false,
    readerSnap: null,      // Meta der geoeffneten Fassung
    readerSections: [],    // [{ kind:'chapter'|'page', name, depth, html, id, status, renderHtml, key }]
    readerLoading: false,
    readerAddedSince: 0,   // Seiten, die seit der Fassung neu dazugekommen sind
    pdfProfiles: [],
    pdfProfileId: '',
    pdfExporting: false,
    pdfStatus: '',
    pdfError: '',
    pdfJobId: null,
    _pdfPollTimer: null,   // transienter Timer-Guard (siehe startPoll)

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
      this._stopPdfPoll();
    },

    reset() {
      this.snapshots = [];
      this.loading = false;
      this.capturing = false;
      this.deletingId = null;
      this.restoringId = null;
      this.newLabel = '';
      this.newDescription = '';
      this._bookId = null;
      this._resetCompare();
      this.closeReader();
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

    // ── Restore (Buch auf eine Fassung zuruecksetzen) ──────────────────────────────
    async restoreSnapshot(snap) {
      const app = window.__app;
      const bookId = app?.selectedBookId;
      if (!snap?.id || !bookId || this.restoringId || this.deletingId) return;
      if (!confirm(app.t('snapshots.restoreConfirm', { n: snap.seq }))) return;
      this.restoringId = snap.id;
      try {
        const r = await fetch(`/snapshots/${bookId}/${snap.id}/restore`, { method: 'POST' });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error_code || `HTTP ${r.status}`);
        }
        // Inhalt wurde serverseitig komplett ersetzt → Buch/Tree neu laden und
        // die Fassungs-Liste auffrischen (Auto-Sicherung ist neu dazugekommen).
        await app.loadPages?.();
        await this.loadSnapshots(bookId, { fresh: true });
        app.setStatus?.(app.t('snapshots.restored', { n: snap.seq }), false, 5000);
      } catch (e) {
        console.error('[snapshots:restore]', e);
        app.setStatus?.(app.t('snapshots.restoreFailed') + ' ' + (e.message || ''), true, 6000);
      } finally {
        this.restoringId = null;
      }
    },

    // ── Reader (Fassung nur-lesend, Bucheditor-Look, Diff gegen aktuell) ────────────
    async openSnapshot(snap) {
      const app = window.__app;
      const bookId = app?.selectedBookId;
      if (!snap?.id || !bookId) return;
      this.readerSnap = snap;
      this.readerOpen = true;
      this.readerLoading = true;
      this.readerSections = [];
      this.readerAddedSince = 0;
      this._resetPdfExport();
      // PDF-Profile lazy laden (fuer das Export-Menue im Reader).
      this.loadPdfProfiles();
      try {
        // Fassungs-Inhalt + aktueller Buchstand parallel. Letzterer liefert die
        // Vergleichsbasis fuer den Inline-Diff (Match via srcId == page_id).
        const [snapData, curData] = await Promise.all([
          fetchJson(`/snapshots/${bookId}/${snap.id}`),
          fetchJson(`/book-editor/${bookId}/contents`).catch(() => ({ pages: [] })),
        ]);
        const sections = this._buildReaderSections(snapData?.snapshot?.content);
        const currentById = new Map();
        for (const p of (curData?.pages || [])) currentById.set(p.pageId, p.html || '');

        const diffLib = await loadDiff().catch(() => null);
        const snapIds = new Set();
        for (const s of sections) {
          if (s.kind !== 'page') continue;
          if (s.id != null) snapIds.add(s.id);
          const curHtml = s.id != null ? currentById.get(s.id) : undefined;
          if (curHtml === undefined) {
            // In der Fassung vorhanden, im aktuellen Buch geloescht.
            s.status = 'removed';
            s.renderHtml = s.html;
            continue;
          }
          if (!diffLib) { s.status = ''; s.renderHtml = s.html; continue; }
          try {
            const out = renderInline(s.html, curHtml, diffLib);
            s.status = out.unchanged ? 'unchanged' : 'changed';
            s.renderHtml = out.unchanged ? s.html : out.html;
          } catch (e) {
            console.error('[snapshots:inlineDiff]', e);
            s.status = ''; s.renderHtml = s.html;
          }
        }
        // Seiten, die seit der Fassung neu dazugekommen sind.
        let added = 0;
        for (const pid of currentById.keys()) if (!snapIds.has(pid)) added += 1;
        this.readerAddedSince = added;
        this.readerSections = sections;
      } catch (e) {
        console.error('[snapshots:open]', e);
        this.readerSections = [];
      } finally {
        this.readerLoading = false;
      }
    },

    closeReader() {
      this.readerOpen = false;
      this.readerSnap = null;
      this.readerSections = [];
      this.readerAddedSince = 0;
      this._resetPdfExport();
      this._stopPdfPoll();
    },

    // Snapshot-Tree (buildBookJson-Format) → kanonisches Stream-Modell
    // (fromSnapshotTree, geteilt mit Bucheditor/Share). Page-Entries werden um
    // die Reader-Diff-State-Felder (status/renderHtml) ergaenzt; `id` ist die
    // alte page_id (srcId), gegen die der Inline-Diff matcht.
    _buildReaderSections(content) {
      return fromSnapshotTree(content?.tree).map((e) =>
        e.kind === 'page' ? { ...e, status: '', renderHtml: e.html } : e);
    },

    // ── Export (aus dem Reader) ─────────────────────────────────────────────────────
    // Schnell-Formate: direkter Download-Link auf die Sync-Route.
    quickFormats() {
      return ['html', 'epub', 'docx', 'md', 'txt'];
    },

    formatLabel(fmt) {
      return window.__app.t('book.export.' + fmt);
    },

    exportUrl(fmt) {
      const app = window.__app;
      const bookId = app?.selectedBookId;
      if (!bookId || !this.readerSnap?.id) return '#';
      return `/snapshots/${bookId}/${this.readerSnap.id}/export/${fmt}`;
    },

    async loadPdfProfiles() {
      try {
        const d = await fetchJson('/pdf-export/profiles');
        this.pdfProfiles = Array.isArray(d?.profiles) ? d.profiles : [];
        const def = this.pdfProfiles.find(p => p.is_default) || this.pdfProfiles[0] || null;
        if (def && (!this.pdfProfileId || !this.pdfProfiles.some(p => String(p.id) === String(this.pdfProfileId)))) {
          this.pdfProfileId = String(def.id);
        }
      } catch (e) {
        console.error('[snapshots:pdfProfiles]', e);
        this.pdfProfiles = [];
      }
    },

    pdfProfileOptions() {
      return this.pdfProfiles.map(p => ({ value: String(p.id), label: p.name }));
    },

    async exportPdf() {
      const app = window.__app;
      const bookId = app?.selectedBookId;
      if (!bookId || !this.readerSnap?.id || !this.pdfProfileId || this.pdfExporting) return;
      this.pdfExporting = true;
      this.pdfError = '';
      this.pdfStatus = app.t('snapshots.export.creating');
      try {
        const r = await fetch('/jobs/pdf-export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: 'book',
            entityId: parseInt(bookId, 10),
            profile_id: parseInt(this.pdfProfileId, 10),
            snapshot_id: this.readerSnap.id,
          }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d?.error_code || `HTTP ${r.status}`);
        }
        const { jobId } = await r.json();
        this.pdfJobId = jobId;
        this._startPdfPoll(jobId);
      } catch (e) {
        console.error('[snapshots:exportPdf]', e);
        this.pdfExporting = false;
        this.pdfError = app.t('snapshots.export.pdfFailed') + ' ' + (e.message || '');
        this.pdfStatus = '';
      }
    },

    _startPdfPoll(jobId) {
      this._stopPdfPoll();
      startPoll(this, {
        timerProp: '_pdfPollTimer',
        jobId,
        intervalMs: 1000,
        onProgress: (job) => {
          const app = window.__app;
          this.pdfStatus = job.statusText ? app.t(job.statusText, job.statusParams) : app.t('snapshots.export.creating');
        },
        onError: (job) => {
          const app = window.__app;
          this.pdfExporting = false;
          this.pdfStatus = '';
          this.pdfError = app.t('snapshots.export.pdfFailed') + ' ' + (job.error ? app.t(job.error, job.errorParams) : '');
        },
        onDone: (job) => {
          const app = window.__app;
          this.pdfExporting = false;
          this.pdfStatus = app.t('snapshots.export.pdfDone');
          this._triggerPdfDownload(jobId, job.result?.filename);
          setTimeout(() => { this.pdfStatus = ''; }, 3500);
        },
      });
    },

    _stopPdfPoll() {
      if (this._pdfPollTimer) { clearInterval(this._pdfPollTimer); this._pdfPollTimer = null; }
    },

    _triggerPdfDownload(jobId, filename) {
      const a = document.createElement('a');
      a.href = `/jobs/pdf-export/${jobId}/file`;
      a.download = filename || 'fassung.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },

    _resetPdfExport() {
      this.pdfExporting = false;
      this.pdfStatus = '';
      this.pdfError = '';
      this.pdfJobId = null;
    },

    // ── Anzeige-Helfer ────────────────────────────────────────────────────────────
    // Server kann ein Label als __i18n:key__-Marker persistieren (z.B. die
    // Auto-Sicherung vor einem Restore) — in der Locale des Betrachters aufloesen.
    _resolveLabel(label) {
      const m = /^__i18n:([a-zA-Z0-9_.-]+)__$/.exec(label || '');
      return m ? window.__app.t(m[1]) : label;
    },

    fassungLabel(snap) {
      const app = window.__app;
      const base = app.t('snapshots.fassung', { n: snap.seq });
      const label = this._resolveLabel(snap.label);
      return label ? `${base} · ${label}` : base;
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
