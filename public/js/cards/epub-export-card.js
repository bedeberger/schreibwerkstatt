// Alpine.data('epubExportCard') — EPUB-Export-Konfiguration + Trigger.
//
// State: Scope-Auswahl (Buch/Kapitel/Seite), EPUB-Reflow-Settings aus
// book_publication (css-Style/Blocksatz/Inhalts-Titel) + Job-Status.
// `showEpubExportCard` bleibt im Root (Hash-Router + Exklusivität).
//
// Cover/Titelei/Autor-Bio bleiben buch-weit im BookSettings → Publikation-Tab
// (SSoT book_publication); diese Karte spiegelt nur die EPUB-spezifischen
// Reflow-Toggles, schreibt aber denselben /publication-Endpunkt — daher wird
// die volle Meta geladen und vollständig zurückgeschrieben (sonst würde der
// strikte Upsert isbn/subtitle/… auf Defaults zurücksetzen).
//
// Render-Job läuft über die Standard-Job-Queue (/jobs/epub-export). Sobald done,
// wird die EPUB-Datei via /jobs/epub-export/:id/file als Download geholt.

import { startPoll } from './job-helpers.js';

const _EMPTY_META = () => ({
  isbn: '', subtitle: '', year: '', dedication: '', imprint: '', copyright: '',
  frontmatter: '', author_bio: '', epub_css_style: 'serif', epub_justify: true,
  epub_toc_title: '', has_cover: false, has_author_image: false,
});

export function registerEpubExportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('epubExportCard', () => ({
    exportScope: 'book',
    exportChapterId: null,
    exportPageId: null,
    exportIncludeSubchapters: false,

    pub: _EMPTY_META(),
    pubLoaded: false,

    saving: false,
    savedAt: null,
    _savedAtTimer: null,

    exporting: false,
    exportProgress: 0,
    exportStatus: '',
    exportError: '',
    currentJobId: null,

    _pollTimer: null,
    _exportStatusTimer: null,
    _onBookChanged: null,
    _onViewReset: null,
    _onExportPreset: null,

    init() {
      this.$watch(() => window.__app.showEpubExportCard, async (visible) => {
        if (!visible) return;
        if (!this.pubLoaded) await this.loadPublication();
        this._ensureExportPicked();
      });
      this.$watch(() => this.exportScope, () => this._ensureExportPicked());
      this.$watch(() => this.exportChapterId, () => { this.exportIncludeSubchapters = false; });
      this.$watch(() => window.__app?.currentPage?.id, () => this._ensureExportPicked());

      this._onExportPreset = (e) => this._applyExportPreset(e.detail);
      window.addEventListener('export:epub:preset', this._onExportPreset);
      const pending = window.__app?.__epubExportPreset;
      if (pending) {
        this._applyExportPreset(pending);
        window.__app.__epubExportPreset = null;
      }

      // book:changed: laufenden Export räumen + Publikations-Meta neu laden.
      this._onBookChanged = async () => {
        this._stopPoll();
        if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
        this.exporting = false;
        this.exportProgress = 0;
        this.exportStatus = '';
        this.exportError = '';
        this.currentJobId = null;
        this.pubLoaded = false;
        if (window.__app?.showEpubExportCard) await this.loadPublication();
      };
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => {
        this._stopPoll();
        if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
        if (this._savedAtTimer) { clearTimeout(this._savedAtTimer); this._savedAtTimer = null; }
        this.exporting = false;
        this.exportProgress = 0;
        this.exportStatus = '';
        this.exportError = '';
        this.currentJobId = null;
        this.pub = _EMPTY_META();
        this.pubLoaded = false;
        this.exportScope = 'book';
        this.exportChapterId = null;
        this.exportPageId = null;
      };
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      this._stopPoll();
      if (this._savedAtTimer)      { clearTimeout(this._savedAtTimer);      this._savedAtTimer = null; }
      if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
      if (this._onBookChanged)  window.removeEventListener('book:changed',       this._onBookChanged);
      if (this._onViewReset)    window.removeEventListener('view:reset',         this._onViewReset);
      if (this._onExportPreset) window.removeEventListener('export:epub:preset', this._onExportPreset);
    },

    // ── Publikations-Meta (book_publication, geteilt mit PDF + BookSettings) ──
    async loadPublication() {
      const bookId = window.__app?.selectedBookId;
      if (!bookId) return;
      try {
        const r = await fetch(`/publication/${bookId}`);
        if (!r.ok) return;
        this.pub = await r.json();
        this.pubLoaded = true;
      } catch {}
    },

    async savePublication() {
      const bookId = window.__app?.selectedBookId;
      if (!bookId) return;
      this.saving = true;
      this.savedAt = null;
      this.exportError = '';
      try {
        const p = this.pub || {};
        const r = await fetch(`/publication/${bookId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            isbn: p.isbn || '', subtitle: p.subtitle || '', year: p.year || '',
            dedication: p.dedication || '', imprint: p.imprint || '', copyright: p.copyright || '',
            frontmatter: p.frontmatter || '', author_bio: p.author_bio || '',
            epub_css_style: p.epub_css_style || 'serif', epub_justify: p.epub_justify ? 1 : 0,
            epub_toc_title: p.epub_toc_title || '',
          }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = window.__app.tError(d) || window.__app.t('epubExport.error.saveFailed');
          return;
        }
        this.pub = await r.json();
        this.savedAt = Date.now();
        if (this._savedAtTimer) clearTimeout(this._savedAtTimer);
        this._savedAtTimer = setTimeout(() => { this.savedAt = null; this._savedAtTimer = null; }, 2500);
      } finally {
        this.saving = false;
      }
    },

    // Reflow-Settings schreiben book_publication → braucht editor+. Viewer
    // dürfen trotzdem exportieren (Export = viewer), nur nicht die Settings ändern.
    canEditPublication() {
      const role = window.__app?.currentBookRole;
      return role === 'editor' || role === 'owner';
    },

    publicationCssOptions() {
      return [
        { value: 'serif', label: window.__app.t('publication.cssSerif') },
        { value: 'sans',  label: window.__app.t('publication.cssSans') },
      ];
    },

    openBookSettings() {
      window.__app?.toggleBookSettingsCard?.();
    },

    // ── Export-Trigger ────────────────────────────────────────────────────
    async exportEpub() {
      // Settings sind buch-weit und werden serverseitig aus der DB gelesen —
      // vor Export speichern, damit ungespeicherte Änderungen greifen. Nur
      // editor+ darf book_publication schreiben; Viewer exportiert mit DB-Stand.
      if (this.canEditPublication()) {
        await this.savePublication();
        if (this.exportError) return;
      }
      if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
      const ref = this._exportEntity();
      if (!ref) { this.exportError = window.__app.t('epubExport.error.startFailed'); return; }
      this.exporting = true;
      this.exportProgress = 0;
      this.exportStatus = window.__app.t('epubExport.starting');
      this.exportError = '';
      try {
        const r = await fetch('/jobs/epub-export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: ref.scope,
            entityId: ref.id,
            ...(ref.scope === 'chapter' ? { include_subchapters: !!this.exportIncludeSubchapters } : {}),
          }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = window.__app.tError(d) || window.__app.t('epubExport.error.startFailed');
          this.exporting = false;
          return;
        }
        const { jobId } = await r.json();
        this.currentJobId = jobId;
        this._startPoll(jobId);
      } catch {
        this.exportError = window.__app.t('epubExport.error.network');
        this.exporting = false;
      }
    },

    _startPoll(jobId) {
      this._stopPoll();
      startPoll(this, {
        timerProp: '_pollTimer',
        jobId,
        progressProp: 'exportProgress',
        intervalMs: 1000,
        onProgress: (job) => {
          this.exportStatus = job.statusText ? window.__app.t(job.statusText, job.statusParams) : '';
        },
        onError: (job) => {
          this.exporting = false;
          this.exportError = job.error
            ? window.__app.t(job.error, job.errorParams)
            : window.__app.t('epubExport.error.generic');
        },
        onDone: (job) => {
          this.exporting = false;
          this.exportProgress = 100;
          this.exportStatus = window.__app.t('epubExport.done');
          const result = job.result || {};
          this._triggerDownload(jobId, result.filename);
          if (this._exportStatusTimer) clearTimeout(this._exportStatusTimer);
          this._exportStatusTimer = setTimeout(() => {
            this.exportStatus = '';
            this.exportProgress = 0;
            this._exportStatusTimer = null;
          }, 3500);
        },
      });
    },

    _stopPoll() {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    },

    _triggerDownload(jobId, filename) {
      const a = document.createElement('a');
      a.href = `/jobs/epub-export/${jobId}/file`;
      a.download = filename || 'book.epub';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },

    async cancelExport() {
      if (!this.currentJobId) return;
      try { await fetch(`/jobs/${this.currentJobId}`, { method: 'DELETE' }); } catch {}
    },

    // ── Scope-Auswahl (Buch/Kapitel/Seite) ───────────────────────────────
    exportScopeOptions() {
      const app = window.__app;
      const opts = [{ value: 'book', label: app?.t?.('export.scope.book') || 'Buch' }];
      if (this.exportChapterOptions().length) opts.push({ value: 'chapter', label: app.t('export.scope.chapter') });
      if (this.exportPageOptions().length)    opts.push({ value: 'page',    label: app.t('export.scope.page') });
      return opts;
    },
    exportChapterOptions() {
      const app = window.__app;
      if (!app || !Array.isArray(app.tree)) return [];
      return app.tree
        .filter(c => c.type === 'chapter' && !c.solo)
        .map(c => ({ value: c.id, label: c.name }));
    },
    selectedChapterHasSubs() {
      const app = window.__app;
      if (!app || !Array.isArray(app.tree) || !this.exportChapterId) return false;
      const ch = app.tree.find(c => c.type === 'chapter' && c.id === this.exportChapterId);
      return !!ch?.hasChildren;
    },
    exportPageOptions() {
      const app = window.__app;
      if (!app || !Array.isArray(app.pages)) return [];
      return app.pages.map(p => ({ value: p.id, label: p.name }));
    },
    _applyExportPreset({ kind, id } = {}) {
      if (kind === 'page' && id != null) {
        this.exportPageId = id;
        this.exportScope = 'page';
      } else if (kind === 'chapter' && id != null) {
        this.exportChapterId = id;
        this.exportScope = 'chapter';
      }
    },
    _ensureExportPicked() {
      const app = window.__app;
      const cur = app?.currentPage;
      if (this.exportScope === 'chapter') {
        const opts = this.exportChapterOptions();
        const valid = opts.some(o => o.value === this.exportChapterId);
        if (!valid) this.exportChapterId = cur?.chapter_id || opts[0]?.value || null;
      }
      if (this.exportScope === 'page') {
        const opts = this.exportPageOptions();
        const valid = opts.some(o => o.value === this.exportPageId);
        if (!valid) this.exportPageId = cur?.id || opts[0]?.value || null;
      }
    },
    _exportEntity() {
      const app = window.__app;
      if (!app) return null;
      const scope = this.exportScope || 'book';
      if (scope === 'page' && this.exportPageId) return { scope: 'page', id: this.exportPageId };
      if (scope === 'chapter' && this.exportChapterId) return { scope: 'chapter', id: this.exportChapterId };
      const bid = app.selectedBookId;
      return bid ? { scope: 'book', id: parseInt(bid) } : null;
    },
  }));
}
