// Alpine.data('pdfExportCard') — Custom-PDF-Export-Konfiguration + Trigger.
//
// State: profiles[], aktives Profil, aktiver Tab, Font-Liste, Job-Status.
// `showPdfExportCard` bleibt im Root (Hash-Router + Exklusivität).
//
// Lifecycle:
//   - $watch($app.showPdfExportCard): on-visible → loadProfiles + loadFonts.
//   - book:changed: aktive Auswahl resetten + Profile neu laden.
//   - view:reset: alles leeren.
//
// Render-Job läuft über die Standard-Job-Queue (/jobs/pdf-export). Sobald done,
// wird das PDF-File via /jobs/pdf-export/:id/file als Download geholt.

import { startPoll } from './job-helpers.js';

const TABS = ['layout', 'font', 'chapter', 'cover', 'toc', 'extras', 'pdfa'];

export function registerPdfExportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('pdfExportCard', () => ({
    profiles: [],
    activeProfileId: null,
    activeProfile: null,        // { id, name, config, has_cover, ... }
    exportScope: 'book',
    exportChapterId: null,
    exportPageId: null,
    exportIncludeSubchapters: false,
    // Form-Mount-Gate: getrennt von activeProfile, damit Alpine die x-if-DOM
    // sicher unmounten kann, BEVOR activeProfile auf null/neuen Wert wechselt.
    // Sonst feuern x-model/x-effect-Closures (combobox-x-data) noch ein Mal mit
    // null-activeProfile und werfen "Cannot read properties of null (reading 'config')".
    _formMounted: false,
    activeTab: 'layout',

    fontList: [],
    fontPreviewLoaded: new Set(),

    // Collapsible-Toggles für lange Sektionen.
    secOpen: {
      margins: false,
      bodyInset: false,
      headerFooter: false,
      pageStructure: false,
      coverOptions: false,
    },

    // Pro-Rolle-Akkordeon im Schrift-Tab. `body` default offen, Rest zu.
    fontRoleOpen: {
      body: true,
      heading: false,
      title: false,
      subtitle: false,
      byline: false,
      dedication: false,
      year: false,
      imprint: false,
      tocTitle: false,
      toc: false,
    },

    creating: false,
    newProfileName: '',
    cloneFromId: null,

    saving: false,
    savedAt: null,
    _savedAtTimer: null,
    _exportStatusTimer: null,

    exporting: false,
    exportProgress: 0,
    exportStatus: '',
    exportError: '',
    currentJobId: null,

    coverUploading: false,
    coverError: '',
    coverPreviewVersion: 0,

    _pollTimer: null,
    _onBookChanged: null,
    _onViewReset: null,
    _onExportPreset: null,

    init() {
      this.$watch(() => window.__app.showPdfExportCard, async (visible) => {
        if (!visible) return;
        await this.loadFonts();
        // Profile sind user-scoped → einmal geladen reicht; selectedBookId-
        // Wechsel triggert KEINE Neuladung.
        if (!this.profiles.length) await this.loadProfiles();
      });
      this.$watch(() => this.exportScope, () => this._ensureExportPicked());
      this.$watch(() => this.exportChapterId, () => { this.exportIncludeSubchapters = false; });
      this.$watch(() => window.__app?.currentPage?.id, () => this._ensureExportPicked());

      this._onExportPreset = (e) => this._applyExportPreset(e.detail);
      window.addEventListener('export:preset', this._onExportPreset);
      const pending = window.__app?.__exportPreset;
      if (pending) {
        this._applyExportPreset(pending);
        window.__app.__exportPreset = null;
      }

      // book:changed räumt nur den laufenden Export-State (Buchwechsel = neuer
      // Render-Kontext). Profile-Liste bleibt erhalten.
      this._onBookChanged = () => {
        this._stopPoll();
        if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
        this.exporting = false;
        this.exportProgress = 0;
        this.exportStatus = '';
        this.exportError = '';
        this.currentJobId = null;
      };
      window.addEventListener('book:changed', this._onBookChanged);

      // view:reset (Logout / User-Settings-Danger-Reset) räumt ALLES inkl.
      // Profile-Liste — könnte anderer User sein nach Re-Login.
      this._onViewReset = async () => {
        this._onBookChanged();
        await this._unmountFormThen(() => {
          this.profiles = [];
          this.activeProfile = null;
          this.activeProfileId = null;
          this.savedAt = null;
        });
      };
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      this._stopPoll();
      if (this._savedAtTimer)     { clearTimeout(this._savedAtTimer);     this._savedAtTimer = null; }
      if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
      if (this._onBookChanged)  window.removeEventListener('book:changed',  this._onBookChanged);
      if (this._onViewReset)    window.removeEventListener('view:reset',    this._onViewReset);
      if (this._onExportPreset) window.removeEventListener('export:preset', this._onExportPreset);
    },

    // ── Profile-Liste / Auswahl ──────────────────────────────────────────
    async loadFonts() {
      if (this.fontList.length) return;
      try {
        const r = await fetch('/pdf-export/fonts');
        if (!r.ok) return;
        const d = await r.json();
        this.fontList = d.fonts || [];
      } catch {}
    },

    fontsByCategory(cat) {
      return this.fontList.filter(f => f.category === cat);
    },

    async loadProfiles() {
      try {
        const r = await fetch('/pdf-export/profiles');
        const d = await r.json();
        this.profiles = d.profiles || [];
        const def = this.profiles.find(p => p.is_default) || this.profiles[0] || null;
        if (def && (!this.activeProfileId || !this.profiles.some(p => p.id === this.activeProfileId))) {
          await this.selectProfile(def.id);
        } else if (this.activeProfileId) {
          await this.selectProfile(this.activeProfileId);
        } else {
          await this._unmountFormThen(() => { this.activeProfile = null; });
        }
      } catch (e) {
        console.error('loadProfiles', e);
      }
    },

    // Unmount form, await DOM teardown, then run mutator. Ensures x-if-children
    // (combobox x-data, x-model) won't see a null activeProfile.
    async _unmountFormThen(mutate) {
      this._formMounted = false;
      await this.$nextTick();
      mutate();
    },

    async selectProfile(id) {
      // Form unmounten, dann State wechseln, dann neu mounten.
      await this._unmountFormThen(() => { this.activeProfileId = id; });
      try {
        const r = await fetch(`/pdf-export/profiles/${id}`);
        if (!r.ok) { this.activeProfile = null; return; }
        this.activeProfile = await r.json();
        this.coverPreviewVersion++;
        this._formMounted = true;
      } catch {}
    },

    async createProfile() {
      const name = (this.newProfileName || '').trim();
      if (!name) return;
      // Profile sind user-scoped — kein book_id im Payload.
      const body = { name };
      if (this.cloneFromId) body.clone_from = this.cloneFromId;
      this.creating = true;
      try {
        const r = await fetch('/pdf-export/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = window.__app.t(d.error_code ? 'pdfExport.error.' + d.error_code : 'pdfExport.error.createFailed');
          return;
        }
        const profile = await r.json();
        this.newProfileName = '';
        this.cloneFromId = null;
        await this.loadProfiles();
        await this.selectProfile(profile.id);
      } finally {
        this.creating = false;
      }
    },

    async deleteProfile(id) {
      if (!confirm(window.__app.t('pdfExport.confirmDelete'))) return;
      const r = await fetch(`/pdf-export/profiles/${id}`, { method: 'DELETE' });
      if (!r.ok) return;
      if (this.activeProfileId === id) {
        await this._unmountFormThen(() => { this.activeProfileId = null; });
      }
      await this.loadProfiles();
    },

    async setDefault(id) {
      const r = await fetch(`/pdf-export/profiles/${id}/default`, { method: 'POST' });
      if (!r.ok) return;
      await this.loadProfiles();
    },

    async saveActiveProfile() {
      if (!this.activeProfile) return;
      this.saving = true;
      this.savedAt = null;
      try {
        const r = await fetch(`/pdf-export/profiles/${this.activeProfile.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.activeProfile.name, config: this.activeProfile.config }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = window.__app.t(d.error_code ? 'pdfExport.error.' + d.error_code : 'pdfExport.error.saveFailed', d.params);
          return;
        }
        this.activeProfile = await r.json();
        this.savedAt = Date.now();
        if (this._savedAtTimer) clearTimeout(this._savedAtTimer);
        this._savedAtTimer = setTimeout(() => { this.savedAt = null; this._savedAtTimer = null; }, 2500);
      } finally {
        this.saving = false;
      }
    },

    // ── Cover-Upload ──────────────────────────────────────────────────────
    async uploadCover(ev) {
      const file = ev?.target?.files?.[0];
      if (!file || !this.activeProfile) return;
      this.coverUploading = true;
      this.coverError = '';
      try {
        const r = await fetch(`/pdf-export/profiles/${this.activeProfile.id}/cover`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.coverError = window.__app.t('pdfExport.error.coverInvalid', d.params);
          return;
        }
        await this.selectProfile(this.activeProfile.id);
      } finally {
        this.coverUploading = false;
        ev.target.value = '';
      }
    },

    async removeCover() {
      if (!this.activeProfile) return;
      const r = await fetch(`/pdf-export/profiles/${this.activeProfile.id}/cover`, { method: 'DELETE' });
      if (!r.ok) return;
      await this.selectProfile(this.activeProfile.id);
    },

    coverUrl() {
      if (!this.activeProfile?.has_cover) return '';
      return `/pdf-export/profiles/${this.activeProfile.id}/cover?v=${this.coverPreviewVersion}`;
    },

    // ── Font-Preview ──────────────────────────────────────────────────────
    loadFontPreview(family, weight) {
      const key = `${family}:${weight}`;
      if (this.fontPreviewLoaded.has(key)) return;
      const url = `/pdf-export/fonts/${encodeURIComponent(family)}/${weight}/preview.css`;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      document.head.appendChild(link);
      this.fontPreviewLoaded.add(key);
    },

    fontPreviewStyle(role) {
      if (!this.activeProfile) return '';
      const f = this.activeProfile.config.font[role];
      if (!f) return '';
      this.loadFontPreview(f.family, f.weight || 400);
      const color = f.color && /^#[0-9a-fA-F]{6}$/.test(f.color) ? f.color : '';
      const italic = f.italic ? ' font-style: italic;' : '';
      return `font-family: '${f.family}', serif; font-weight: ${f.weight || 400};${color ? ` color: ${color};` : ''}${italic}`;
    },

    onFontPick(role, family) {
      if (!this.activeProfile) return;
      this.activeProfile.config.font[role].family = family;
      // Vorhandenes Weight-Setting beibehalten, aber gegen Allowed-Liste prüfen.
      const meta = this.fontList.find(f => f.family === family);
      if (meta && !meta.weights.includes(this.activeProfile.config.font[role].weight)) {
        this.activeProfile.config.font[role].weight = meta.weights.includes(400) ? 400 : meta.weights[0];
      }
    },

    // ── Export-Trigger ────────────────────────────────────────────────────
    async exportPdf() {
      if (!this.activeProfile) return;
      // Vor Export speichern (Config könnte ungespeichert sein).
      await this.saveActiveProfile();
      if (this.exportError) return;
      if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
      this.exporting = true;
      this.exportProgress = 0;
      this.exportStatus = window.__app.t('pdfExport.starting');
      this.exportError = '';
      try {
        const ref = this._exportEntity();
        if (!ref) { this.exportError = window.__app.t('pdfExport.error.startFailed'); this.exporting = false; return; }
        const r = await fetch('/jobs/pdf-export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: ref.scope,
            entityId: ref.id,
            profile_id: this.activeProfile.id,
            ...(ref.scope === 'chapter' ? { include_subchapters: !!this.exportIncludeSubchapters } : {}),
          }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = window.__app.t(d.error_code ? 'pdfExport.error.' + d.error_code : 'pdfExport.error.startFailed');
          this.exporting = false;
          return;
        }
        const { jobId } = await r.json();
        this.currentJobId = jobId;
        this._startPoll(jobId);
      } catch (e) {
        this.exportError = window.__app.t('pdfExport.error.network');
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
          this.exportStatus = job.statusText
            ? window.__app.t(job.statusText, job.statusParams)
            : '';
        },
        onError: (job) => {
          this.exporting = false;
          this.exportError = job.error
            ? window.__app.t(job.error, job.errorParams)
            : window.__app.t('pdfExport.error.generic');
        },
        onDone: (job) => {
          this.exporting = false;
          this.exportProgress = 100;
          const result = job.result || {};
          const isWarning = result.pdfa?.requested && result.pdfa.validatorAvailable && !result.pdfa.passed;
          this.exportStatus = window.__app.t(isWarning ? 'pdfExport.pdfaWarning' : 'pdfExport.done');
          this._triggerDownload(jobId, result.filename);
          if (this._exportStatusTimer) clearTimeout(this._exportStatusTimer);
          const ttl = isWarning ? 8000 : 3500;
          this._exportStatusTimer = setTimeout(() => {
            this.exportStatus = '';
            this.exportProgress = 0;
            this._exportStatusTimer = null;
          }, ttl);
        },
      });
    },

    _stopPoll() {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    },

    _triggerDownload(jobId, filename) {
      const a = document.createElement('a');
      a.href = `/jobs/pdf-export/${jobId}/file`;
      a.download = filename || 'book.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },

    async cancelExport() {
      if (!this.currentJobId) return;
      try { await fetch(`/jobs/${this.currentJobId}`, { method: 'DELETE' }); } catch {}
      // Poll deckt das `cancelled`-Status-Update bereits ab; UI-Reset im Polling.
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

    // Optionen fuer Kapitel-ohne-Nummer-Auswahl (Multi-Combobox).
    // Tiefen werden via Einrueckung im Label sichtbar — Cascade-Hinweis: ist
    // ein Top-Kapitel hier gewaehlt, sind auch alle Subs automatisch unnumbered.
    unnumberedChapterPickOptions() {
      const app = window.__app;
      if (!app || !Array.isArray(app.tree)) return [];
      return app.tree
        .filter(c => c.type === 'chapter' && !c.solo)
        .map(c => ({
          value: c.id,
          label: ((c.depth || 1) > 1 ? '— '.repeat((c.depth || 1) - 1) : '') + c.name,
        }));
    },
    unnumberedChapterChips() {
      const ids = this.activeProfile?.config?.chapter?.unnumberedChapterIds || [];
      const opts = this.unnumberedChapterPickOptions();
      return ids
        .map(id => {
          const o = opts.find(x => x.value === id);
          return o ? { id, label: o.label } : { id, label: '#' + id };
        });
    },
    removeUnnumberedChapter(id) {
      if (!this.activeProfile) return;
      const arr = this.activeProfile.config.chapter.unnumberedChapterIds || [];
      this.activeProfile.config.chapter.unnumberedChapterIds = arr.filter(v => v !== id);
    },

    // Picker fuer Seitenzaehler-Skip: gleicher Tree-Lookup wie bei
    // unnumberedChapterPickOptions; Kapitel-Auswahl ohne Numbering-Mode-Gate
    // (gilt auch wenn Kapitel-Titel-Nummern aus sind).
    skipPageCounterChapterPickOptions() {
      return this.unnumberedChapterPickOptions();
    },
    skipPageCounterChapterChips() {
      const ids = this.activeProfile?.config?.chapter?.skipPageCounterChapterIds || [];
      const opts = this.skipPageCounterChapterPickOptions();
      return ids.map(id => {
        const o = opts.find(x => x.value === id);
        return o ? { id, label: o.label } : { id, label: '#' + id };
      });
    },
    removeSkipPageCounterChapter(id) {
      if (!this.activeProfile) return;
      const arr = this.activeProfile.config.chapter.skipPageCounterChapterIds || [];
      this.activeProfile.config.chapter.skipPageCounterChapterIds = arr.filter(v => v !== id);
    },
    // Seiten-Picker: Pages mit Kapitel-Prefix gruppiert (Label "Kapitel — Seite").
    skipPageCounterPagePickOptions() {
      const app = window.__app;
      if (!app || !Array.isArray(app.pages)) return [];
      const chapterById = new Map();
      if (Array.isArray(app.tree)) {
        for (const c of app.tree) {
          if (c.type === 'chapter') chapterById.set(c.id, c.name);
        }
      }
      return app.pages.map(p => {
        const chName = p.chapter_id ? chapterById.get(p.chapter_id) : null;
        return {
          value: p.id,
          label: chName ? `${chName} — ${p.name}` : p.name,
        };
      });
    },
    skipPageCounterPageChips() {
      const ids = this.activeProfile?.config?.chapter?.skipPageCounterPageIds || [];
      const opts = this.skipPageCounterPagePickOptions();
      return ids.map(id => {
        const o = opts.find(x => x.value === id);
        return o ? { id, label: o.label } : { id, label: '#' + id };
      });
    },
    removeSkipPageCounterPage(id) {
      if (!this.activeProfile) return;
      const arr = this.activeProfile.config.chapter.skipPageCounterPageIds || [];
      this.activeProfile.config.chapter.skipPageCounterPageIds = arr.filter(v => v !== id);
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

    // ── Helpers fürs Template ────────────────────────────────────────────
    setTab(tab) { if (TABS.includes(tab)) this.activeTab = tab; },
    isTab(tab) { return this.activeTab === tab; },

    // Combobox-Options sind als Inline-Expressions im Template (siehe DESIGN.md
    // "Reaktivitaet bei Datenquelle aus Karten-Scope"). Nested x-data der Combobox
    // trackt this.xxx aus Card-Methods nicht zuverlaessig — deshalb Arrays inline
    // im x-effect aufbauen.
  }));
}
