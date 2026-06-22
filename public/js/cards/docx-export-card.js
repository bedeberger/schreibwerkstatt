// Alpine.data('docxExportCard') — Custom-Word-Export: Profile + Konfiguration + Trigger.
//
// Profile (docx_export_profile, user-scoped) halten Layout/Typografie/Struktur.
// Die Titelei-Texte (Titel/Untertitel/Autor/Widmung/Impressum/Copyright/
// Frontmatter/Bio) kommen buch-weit aus book_publication (im BookSettings →
// Publikation-Tab gepflegt) — diese Karte verlinkt nur dorthin und schaltet
// pro Profil, welche Bausteine eingebunden werden.
//
// Render-Job läuft über die Standard-Job-Queue (/jobs/docx-export). Sobald done,
// wird die .docx via /jobs/docx-export/:id/file als Download geholt.
// `showDocxExportCard` bleibt im Root (Hash-Router + Exklusivität).

import { startPoll } from './job-helpers.js';

export function registerDocxExportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('docxExportCard', () => ({
    profiles: [],
    activeProfileId: null,
    activeProfile: null,   // { id, name, config }
    _formMounted: false,

    showCreate: false,
    newProfileName: '',
    cloneFromId: null,
    creating: false,

    activeTab: 'layout',

    exportScope: 'book',
    exportChapterId: null,
    exportPageId: null,
    exportIncludeSubchapters: false,

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
      this.$watch(() => window.__app.showDocxExportCard, async (visible) => {
        if (!visible) return;
        if (!this.profiles.length) await this.loadProfiles();
        this._ensureExportPicked();
      });
      this.$watch(() => this.exportScope, () => this._ensureExportPicked());
      this.$watch(() => this.exportChapterId, () => { this.exportIncludeSubchapters = false; });
      this.$watch(() => window.__app?.currentPage?.id, () => this._ensureExportPicked());

      this._onExportPreset = (e) => this._applyExportPreset(e.detail);
      window.addEventListener('export:docx:preset', this._onExportPreset);
      const pending = window.__app?.__docxExportPreset;
      if (pending) { this._applyExportPreset(pending); window.__app.__docxExportPreset = null; }

      this._onBookChanged = () => { this._resetExportState(); this._ensureExportPicked(); };
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => {
        this._resetExportState();
        if (this._savedAtTimer) { clearTimeout(this._savedAtTimer); this._savedAtTimer = null; }
        this.exportScope = 'book';
        this.exportChapterId = null;
        this.exportPageId = null;
        this.activeTab = 'layout';
      };
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      this._stopPoll();
      if (this._savedAtTimer)      { clearTimeout(this._savedAtTimer);      this._savedAtTimer = null; }
      if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
      if (this._onBookChanged)  window.removeEventListener('book:changed',       this._onBookChanged);
      if (this._onViewReset)    window.removeEventListener('view:reset',         this._onViewReset);
      if (this._onExportPreset) window.removeEventListener('export:docx:preset', this._onExportPreset);
    },

    _resetExportState() {
      this._stopPoll();
      if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
      this.exporting = false;
      this.exportProgress = 0;
      this.exportStatus = '';
      this.exportError = '';
      this.currentJobId = null;
    },

    canEdit() {
      const role = window.__app?.currentBookRole;
      return role === 'editor' || role === 'owner' || role == null;
    },

    // ── Profile ───────────────────────────────────────────────────────────
    async loadProfiles() {
      try {
        const r = await fetch('/docx-export/profiles');
        const d = await r.json();
        this.profiles = d.profiles || [];
        if (!this.profiles.length) {
          // Erstes Öffnen: ein Standard-Profil anlegen (Server nutzt defaultConfig).
          await this._createProfileNamed(window.__app.t('docxExport.defaultProfileName'));
          return;
        }
        const def = this.profiles.find(p => p.is_default) || this.profiles[0];
        const target = this.profiles.some(p => p.id === this.activeProfileId) ? this.activeProfileId : def.id;
        await this.selectProfile(target);
      } catch (e) {
        console.error('loadProfiles', e);
      }
    },

    async _unmountFormThen(mutate) {
      this._formMounted = false;
      await this.$nextTick();
      mutate();
    },

    async selectProfile(id) {
      await this._unmountFormThen(() => { this.activeProfileId = id; });
      try {
        const r = await fetch(`/docx-export/profiles/${id}`);
        if (!r.ok) { this.activeProfile = null; return; }
        this.activeProfile = await r.json();
        this._formMounted = true;
      } catch {}
    },

    async _createProfileNamed(name, cloneFromId) {
      const body = { name: String(name || '').trim() };
      if (!body.name) return;
      if (cloneFromId) body.clone_from = cloneFromId;
      this.creating = true;
      try {
        const r = await fetch('/docx-export/profiles', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = window.__app.tError(d) || window.__app.t('docxExport.error.createFailed');
          return;
        }
        const profile = await r.json();
        this.profiles.push(profile);
        this.newProfileName = '';
        this.cloneFromId = null;
        this.showCreate = false;
        await this.selectProfile(profile.id);
      } finally {
        this.creating = false;
      }
    },

    async createProfile() {
      await this._createProfileNamed(this.newProfileName, this.cloneFromId);
    },

    async deleteProfile(id) {
      if (this.profiles.length <= 1) return; // letztes Profil nicht löschen
      if (!confirm(window.__app.t('docxExport.confirmDelete'))) return;
      const r = await fetch(`/docx-export/profiles/${id}`, { method: 'DELETE' });
      if (!r.ok) return;
      this.profiles = this.profiles.filter(p => p.id !== id);
      if (this.activeProfileId === id) {
        await this._unmountFormThen(() => { this.activeProfileId = null; this.activeProfile = null; });
        await this.selectProfile(this.profiles[0].id);
      }
    },

    async setDefaultProfile(id) {
      const r = await fetch(`/docx-export/profiles/${id}/default`, { method: 'POST' });
      if (!r.ok) return;
      this.profiles.forEach(p => { p.is_default = p.id === id; });
      // Auch das separat geladene aktive Profil mitziehen, sonst bleibt der
      // „Als Standard"-Button sichtbar, obwohl das Profil schon Standard ist.
      if (this.activeProfile && this.activeProfile.id === id) this.activeProfile.is_default = true;
    },

    async saveProfile() {
      if (!this.activeProfile) return;
      this.saving = true;
      this.savedAt = null;
      this.exportError = '';
      try {
        const r = await fetch(`/docx-export/profiles/${this.activeProfile.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.activeProfile.name, config: this.activeProfile.config }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = window.__app.tError(d) || window.__app.t('docxExport.error.saveFailed');
          return;
        }
        this.activeProfile = await r.json();
        const idx = this.profiles.findIndex(p => p.id === this.activeProfile.id);
        if (idx >= 0) this.profiles[idx].name = this.activeProfile.name;
        this.savedAt = Date.now();
        if (this._savedAtTimer) clearTimeout(this._savedAtTimer);
        this._savedAtTimer = setTimeout(() => { this.savedAt = null; this._savedAtTimer = null; }, 2500);
      } finally {
        this.saving = false;
      }
    },

    openBookSettings() { window.__app?.toggleBookSettingsCard?.(); },

    // ── Config-Optionen (Enum → Combobox) ─────────────────────────────────
    _enum(values, prefix) {
      return values.map(v => ({ value: v, label: window.__app.t(`${prefix}.${v}`) }));
    },
    fontFamilyOptions() {
      return ['Times New Roman', 'Calibri', 'Courier New', 'Georgia', 'Arial', 'Garamond', 'Cambria', 'Book Antiqua', 'Palatino Linotype']
        .map(v => ({ value: v, label: v }));
    },
    pageSizeOptions()       { return ['A4', 'A5', 'Letter'].map(v => ({ value: v, label: v })); },
    lineSpacingOptions()    { return this._enum(['single', 'oneAndHalf', 'double'], 'docxExport.lineSpacing'); },
    paragraphStyleOptions() { return this._enum(['indent', 'spaced'], 'docxExport.paragraphStyle'); },
    headerModeOptions()     { return this._enum(['none', 'title', 'manuscript'], 'docxExport.headerMode'); },
    pageNumberOptions()     { return this._enum(['none', 'footer', 'headerRight'], 'docxExport.pageNumber'); },
    titleModeOptions()      { return this._enum(['generated', 'none'], 'docxExport.titleMode'); },
    imprintPositionOptions() { return this._enum(['front', 'back'], 'docxExport.imprintPosition'); },
    tocModeOptions()        { return this._enum(['none', 'field', 'static'], 'docxExport.tocMode'); },
    sceneSeparatorOptions() { return this._enum(['line', 'asterism', 'stars', 'blank'], 'docxExport.sceneSep'); },
    pageStructureOptions()  { return this._enum(['flatten', 'nested'], 'docxExport.pageStructure'); },
    numberingModeOptions()  { return this._enum(['nested', 'flat'], 'docxExport.numberingMode'); },
    chapterNumberingOptions() {
      return [
        { value: 'none',   label: window.__app.t('docxExport.numbering.none') },
        { value: 'arabic', label: '1, 2, 3' },
        { value: 'roman',  label: 'I, II, III' },
        { value: 'word',   label: window.__app.t('docxExport.numbering.word') },
      ];
    },
    tocDepthOptions() {
      return [1, 2, 3].map(n => ({ value: n, label: window.__app.t(`docxExport.tocDepth.${n}`) }));
    },

    // Kapitel ohne Nummer (Pendant zur PDF/EPUB-Option).
    unnumberedChapterPickOptions() {
      const app = window.__app;
      if (!app || !Array.isArray(app.tree)) return [];
      return app.tree.filter(c => c.type === 'chapter' && !c.solo)
        .map(c => ({ value: c.id, label: ((c.depth || 1) > 1 ? '— '.repeat((c.depth || 1) - 1) : '') + c.name }));
    },
    unnumberedChapterChips() {
      const ids = this.activeProfile?.config?.chapter?.unnumberedChapterIds || [];
      const opts = this.unnumberedChapterPickOptions();
      return ids.map(id => { const o = opts.find(x => x.value === id); return o ? { id, label: o.label } : { id, label: '#' + id }; });
    },
    removeUnnumberedChapter(id) {
      const arr = this.activeProfile?.config?.chapter?.unnumberedChapterIds || [];
      this.activeProfile.config.chapter.unnumberedChapterIds = arr.filter(v => v !== id);
    },

    // ── Export-Trigger ─────────────────────────────────────────────────────
    async exportDocx() {
      if (this.canEdit() && this.activeProfile) {
        await this.saveProfile();
        if (this.exportError) return;
      }
      if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
      const ref = this._exportEntity();
      if (!ref || !this.activeProfile) { this.exportError = window.__app.t('docxExport.error.startFailed'); return; }
      this.exporting = true;
      this.exportProgress = 0;
      this.exportStatus = window.__app.t('docxExport.starting');
      this.exportError = '';
      try {
        const r = await fetch('/jobs/docx-export', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: ref.scope, entityId: ref.id, profile_id: this.activeProfile.id,
            ...(ref.scope === 'chapter' ? { include_subchapters: !!this.exportIncludeSubchapters } : {}),
          }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = window.__app.tError(d) || window.__app.t('docxExport.error.startFailed');
          this.exporting = false;
          return;
        }
        const { jobId } = await r.json();
        this.currentJobId = jobId;
        this._startPoll(jobId);
      } catch {
        this.exportError = window.__app.t('docxExport.error.network');
        this.exporting = false;
      }
    },

    _startPoll(jobId) {
      this._stopPoll();
      startPoll(this, {
        timerProp: '_pollTimer', jobId, progressProp: 'exportProgress', intervalMs: 1000,
        onProgress: (job) => { this.exportStatus = job.statusText ? window.__app.t(job.statusText, job.statusParams) : ''; },
        onError: (job) => {
          this.exporting = false;
          this.exportError = job.error ? window.__app.t(job.error, job.errorParams) : window.__app.t('docxExport.error.generic');
        },
        onDone: (job) => {
          this.exporting = false;
          this.exportProgress = 100;
          const result = job.result || {};
          this.exportStatus = window.__app.t('docxExport.done');
          this._triggerDownload(jobId, result.filename);
          if (this._exportStatusTimer) clearTimeout(this._exportStatusTimer);
          this._exportStatusTimer = setTimeout(() => { this.exportStatus = ''; this.exportProgress = 0; this._exportStatusTimer = null; }, 3500);
        },
      });
    },

    _stopPoll() { if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; } },

    _triggerDownload(jobId, filename) {
      const a = document.createElement('a');
      a.href = `/jobs/docx-export/${jobId}/file`;
      a.download = filename || 'book.docx';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },

    async cancelExport() {
      if (!this.currentJobId) return;
      try { await fetch(`/jobs/${this.currentJobId}`, { method: 'DELETE' }); } catch {}
    },

    // ── Scope-Auswahl (Buch/Kapitel/Seite) — analog EPUB-Karte ─────────────
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
      return app.tree.filter(c => c.type === 'chapter' && !c.solo).map(c => ({ value: c.id, label: c.name }));
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
      if (kind === 'page' && id != null)    { this.exportPageId = id; this.exportScope = 'page'; }
      else if (kind === 'chapter' && id != null) { this.exportChapterId = id; this.exportScope = 'chapter'; }
    },
    _ensureExportPicked() {
      const app = window.__app;
      const cur = app?.currentPage;
      if (this.exportScope === 'chapter') {
        const opts = this.exportChapterOptions();
        if (!opts.some(o => o.value === this.exportChapterId)) this.exportChapterId = cur?.chapter_id || opts[0]?.value || null;
      }
      if (this.exportScope === 'page') {
        const opts = this.exportPageOptions();
        if (!opts.some(o => o.value === this.exportPageId)) this.exportPageId = cur?.id || opts[0]?.value || null;
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
