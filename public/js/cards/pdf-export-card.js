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
// Scope-Auswahl, Job-Polling/Download und Kapitel-Chips kommen aus
// export-card-base.js (geteilt mit EPUB + DOCX).

import { EVT } from '../events.js';
import { exportScopeSlice, exportJobSlice, unnumberedChipsSlice, exportSnapshotSlice } from './export-card-base.js';

// Druckerei-Trim-Presets (mm). Setzen pageSize='custom' + Masse. Decken die
// gängigen Buchformate ab, die A4/A5/A6/Letter nicht abbilden.
const TRIM_PRESETS = [
  { value: '125x200', w: 125, h: 200 },
  { value: '135x215', w: 135, h: 215 },
  { value: '155x230', w: 155, h: 230 },
  { value: '170x240', w: 170, h: 240 },
  // Amazon-KDP-Trims (in Zoll definiert, mm gerundet). `label` überschreibt das
  // berechnete cm-Label, weil KDP-Formate nach ihrer Zoll-Bezeichnung bekannt sind.
  { value: 'kdp-5.06x7.81', w: 128.5,  h: 198.4, label: 'KDP 5.06 × 7.81″ (12.85 × 19.84 cm)' },
  { value: 'kdp-5x8',       w: 127,    h: 203.2, label: 'KDP 5 × 8″ (12.7 × 20.32 cm)' },
  { value: 'kdp-5.25x8',    w: 133.35, h: 203.2, label: 'KDP 5.25 × 8″ (13.34 × 20.32 cm)' },
  { value: 'kdp-5.5x8.5',   w: 139.7,  h: 215.9, label: 'KDP 5.5 × 8.5″ (13.97 × 21.59 cm)' },
  { value: 'kdp-6x9',       w: 152.4,  h: 228.6, label: 'KDP 6 × 9″ (15.24 × 22.86 cm)' },
];

// Papiertyp-Vorlagen für die Rückenbreite. `bulk` = mm Rückenstärke je 1000
// Innenseiten (= coverSpec.paperBulkMmPer1000). Die KDP-Werte stammen aus deren
// offiziellen Papier-Kennwerten (Seiten pro Zoll umgerechnet); die restlichen
// sind Richtwerte für gängiges Buchpapier — im Zweifel das Papierdatenblatt der
// Druckerei nutzen. `labelKey` → i18n.
const PAPER_PRESETS = [
  { value: 'kdp-white',      bulk: 57.2, labelKey: 'pdfExport.cover.paper.kdpWhite' },
  { value: 'kdp-cream',      bulk: 63.5, labelKey: 'pdfExport.cover.paper.kdpCream' },
  { value: 'kdp-color-std',  bulk: 59.6, labelKey: 'pdfExport.cover.paper.kdpColorStd' },
  { value: 'kdp-color-prem', bulk: 66.0, labelKey: 'pdfExport.cover.paper.kdpColorPrem' },
  { value: 'offset-80',      bulk: 60.0, labelKey: 'pdfExport.cover.paper.offset80' },
  { value: 'bulk-90',        bulk: 81.0, labelKey: 'pdfExport.cover.paper.bulk90' },
];

// KDP-Mindest-Bundsteg (innen) in mm, abhängig von der Seitenzahl (KDP-Tabelle,
// Zoll → mm gerundet). Aussenränder-Minimum ist konstant 6.35 mm (0.25″).
const KDP_OUTER_MIN_MM = 6.35;
function kdpMinGutterMm(pageCount) {
  if (pageCount <= 150) return 9.53;
  if (pageCount <= 300) return 12.7;
  if (pageCount <= 500) return 15.88;
  if (pageCount <= 600) return 19.05;
  return 22.23;
}

export function registerPdfExportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('pdfExportCard', () => ({
    ...exportScopeSlice(),
    ...exportSnapshotSlice(),
    ...exportJobSlice({
      jobPath: '/jobs/pdf-export',
      defaultFilename: 'book.pdf',
      i18nPrefix: 'pdfExport',
      // PDF mappt Fehler-Codes in den karteneigenen Namespace `pdfExport.error.*`
      // (nicht den globalen `tError`-Namespace `error.*` wie EPUB/DOCX).
      errorFor: (self, d) => window.__app.t(d.error_code ? 'pdfExport.error.' + d.error_code : 'pdfExport.error.startFailed'),
      resolveDone: (self, result) => {
        self.exportLowRes = result.lowResImages || 0;
        const pdfaWarn = result.pdfa?.requested && result.pdfa.validatorAvailable && !result.pdfa.passed;
        const pdfxWarn = result.pdfx?.requested && !result.pdfx.applied;
        const coverWarn = !!result.coverInInterior;
        const isWarning = pdfaWarn || pdfxWarn || coverWarn;
        // Ganzes-Buch-Innenteil gerendert → die echte physische Seitenzahl
        // (inkl. manueller Umbrüche/Leerseiten) in die Cover-Innenteil-Seitenzahl
        // spiegeln, die Rückenbreite + KDP-Bundsteg treibt. Nur bei Abweichung
        // schreiben+persistieren, damit ein unveränderter Re-Export nicht speichert.
        const cs = self.activeProfile?.config?.coverSpec;
        const pagesCounted = result.target !== 'cover' && result.scope === 'book'
          && Number.isInteger(result.interiorPages) && result.interiorPages > 0
          && cs && cs.pageCount !== result.interiorPages;
        if (pagesCounted) {
          cs.pageCount = result.interiorPages;
          self.saveActiveProfile();
        }
        const statusKey = pdfxWarn ? 'pdfExport.pdfxWarning'
          : pdfaWarn ? 'pdfExport.pdfaWarning'
          : coverWarn ? 'pdfExport.coverInInteriorWarning'
          : pagesCounted ? 'pdfExport.donePagesCounted'
          : 'pdfExport.done';
        return {
          statusKey,
          statusParams: pagesCounted ? { n: result.interiorPages } : undefined,
          ttl: (isWarning || pagesCounted) ? 8000 : 3500,
        };
      },
    }),
    ...unnumberedChipsSlice({
      getIds: (s) => s.activeProfile?.config?.chapter?.unnumberedChapterIds || [],
      setIds: (s, arr) => { s.activeProfile.config.chapter.unnumberedChapterIds = arr; },
    }),

    profiles: [],
    activeProfileId: null,
    activeProfile: null,        // { id, name, config, has_cover, ... }
    // Form-Mount-Gate: getrennt von activeProfile, damit Alpine die x-if-DOM
    // sicher unmounten kann, BEVOR activeProfile auf null/neuen Wert wechselt.
    // Sonst feuern x-model/x-effect-Closures (combobox-x-data) noch ein Mal mit
    // null-activeProfile und werfen "Cannot read properties of null (reading 'config')".
    _formMounted: false,
    activeTab: 'layout',

    fontList: [],
    fontPreviewLoaded: new Set(),

    creating: false,
    newProfileName: '',
    cloneFromId: null,
    _showCreate: false,

    saving: false,
    savedAt: null,
    _savedAtTimer: null,

    exportLowRes: 0,
    trimPresetSel: '',
    paperPresetSel: '',

    // coverPreviewVersion bustet den Cache der Rückseiten-Bild-Vorschau
    // (Umschlag). Front-Cover + Autorfoto leben buch-weit in book_publication
    // und werden im BookSettings → Publikation-Tab gepflegt.
    coverPreviewVersion: 0,

    backCoverUploading: false,
    backCoverError: '',

    _onBookChanged: null,
    _onViewReset: null,

    init() {
      this.$watch(() => window.__app.showPdfExportCard, async (visible) => {
        if (!visible) return;
        await this.loadFonts();
        // Profile sind user-scoped → einmal geladen reicht; selectedBookId-
        // Wechsel triggert KEINE Neuladung.
        if (!this.profiles.length) await this.loadProfiles();
        // Fassungen sind buch-scoped → bei jedem Öffnen frisch ziehen.
        await this._loadExportSnapshots();
      });
      this._initScopeWatches();
      this._bindPreset(EVT.EXPORT_PRESET, '__exportPreset');

      // book:changed räumt nur den laufenden Export-State (Buchwechsel = neuer
      // Render-Kontext). Profile-Liste bleibt erhalten.
      this._onBookChanged = () => {
        this._resetExportRun();
        this.exportSnapshotId = '';
        if (window.__app?.showPdfExportCard) this._loadExportSnapshots();
        else { this.exportSnapshots = []; }
      };
      window.addEventListener(EVT.BOOK_CHANGED, this._onBookChanged);

      // view:reset (Logout / User-Settings-Danger-Reset) räumt ALLES inkl.
      // Profile-Liste — könnte anderer User sein nach Re-Login.
      this._onViewReset = async () => {
        this._resetExportRun();
        this.exportSnapshots = [];
        this.exportSnapshotId = '';
        await this._unmountFormThen(() => {
          this.profiles = [];
          this.activeProfile = null;
          this.activeProfileId = null;
          this.savedAt = null;
        });
      };
      window.addEventListener(EVT.VIEW_RESET, this._onViewReset);
    },

    destroy() {
      this._stopPoll();
      if (this._savedAtTimer)     { clearTimeout(this._savedAtTimer);     this._savedAtTimer = null; }
      if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
      if (this._onBookChanged)  window.removeEventListener(EVT.BOOK_CHANGED, this._onBookChanged);
      if (this._onViewReset)    window.removeEventListener(EVT.VIEW_RESET,   this._onViewReset);
      this._unbindPreset();
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
        if (!this.profiles.length) {
          // Erstes Öffnen: ein Standard-Profil anlegen (Server nutzt defaultConfig).
          // Gleiches Verhalten wie die Word-Karte — kein leerer Zwischenzustand.
          await this._createProfileNamed(window.__app.t('pdfExport.defaultProfileName'));
          return;
        }
        const def = this.profiles.find(p => p.is_default) || this.profiles[0];
        const target = this.profiles.some(p => p.id === this.activeProfileId) ? this.activeProfileId : def.id;
        await this.selectProfile(target);
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

    // Slot-Auszeichnung (bold/italic/upper) einer Kopf-/Fusszeilen-Zelle
    // umschalten bzw. abfragen. Die Struktur wird beim ersten Toggle lazy
    // angelegt (ältere Profile ohne layout.hfStyle crashen so nicht; Server-
    // Validierung ergänzt den Rest beim Speichern), Alpine wrappt sie reaktiv.
    hfStyleActive(zone, side, pos, attr) {
      return !!this.activeProfile?.config?.layout?.hfStyle?.[zone]?.[side]?.[pos]?.[attr];
    },
    toggleHfStyle(zone, side, pos, attr) {
      const lay = this.activeProfile?.config?.layout;
      if (!lay) return;
      const hf = lay.hfStyle || (lay.hfStyle = {});
      const zo = hf[zone] || (hf[zone] = {}), si = zo[side] || (zo[side] = {});
      const cell = si[pos] || (si[pos] = { bold: false, italic: false, upper: false });
      cell[attr] = !cell[attr];
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

    // Profil anlegen (optional als Klon). Profile sind user-scoped — kein
    // book_id im Payload. Nach dem Anlegen wird genau einmal selectProfile
    // gerufen (ein Form-Mount-Zyklus, keine Race mit laufenden Klicks).
    async _createProfileNamed(name, cloneFromId) {
      const body = { name: String(name || '').trim() };
      if (!body.name) return;
      if (cloneFromId) body.clone_from = cloneFromId;
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
        this.profiles.push(profile);
        this.newProfileName = '';
        this.cloneFromId = null;
        this._showCreate = false;
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
      if (!confirm(window.__app.t('pdfExport.confirmDelete'))) return;
      const r = await fetch(`/pdf-export/profiles/${id}`, { method: 'DELETE' });
      if (!r.ok) return;
      this.profiles = this.profiles.filter(p => p.id !== id);
      if (this.activeProfileId === id) {
        await this._unmountFormThen(() => { this.activeProfileId = null; this.activeProfile = null; });
        await this.selectProfile(this.profiles[0].id);
      }
    },

    async setDefault(id) {
      const r = await fetch(`/pdf-export/profiles/${id}/default`, { method: 'POST' });
      if (!r.ok) return;
      this.profiles.forEach(p => { p.is_default = p.id === id; });
      // Aktives (separat geladenes) Profil mitziehen, sonst bleibt der
      // „Als Standard"-Icon-Button sichtbar, obwohl es schon Standard ist.
      if (this.activeProfile && this.activeProfile.id === id) this.activeProfile.is_default = true;
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

    // ── Umschlag-Rückseitenbild (separates Cover-PDF) ─────────────────────
    async uploadBackCover(file) {
      if (!file || !this.activeProfile) return;
      this.backCoverUploading = true;
      this.backCoverError = '';
      try {
        const r = await fetch(`/pdf-export/profiles/${this.activeProfile.id}/back-cover`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.backCoverError = window.__app.t('pdfExport.error.backCoverInvalid', d.params);
          return;
        }
        await this.selectProfile(this.activeProfile.id);
      } finally {
        this.backCoverUploading = false;
      }
    },

    async removeBackCover() {
      if (!this.activeProfile) return;
      const r = await fetch(`/pdf-export/profiles/${this.activeProfile.id}/back-cover`, { method: 'DELETE' });
      if (!r.ok) return;
      await this.selectProfile(this.activeProfile.id);
    },

    backCoverUrl() {
      if (!this.activeProfile?.has_back_cover) return '';
      return `/pdf-export/profiles/${this.activeProfile.id}/back-cover?v=${this.coverPreviewVersion}`;
    },

    // Live-Rückenbreite (mm) = Papiervolumen je 1000 Seiten × Seitenzahl / 1000.
    coverSpineMm() {
      const cs = this.activeProfile?.config?.coverSpec;
      if (!cs) return 0;
      return (Math.max(0, cs.pageCount || 0) * Math.max(0, cs.paperBulkMmPer1000 || 0)) / 1000;
    },
    coverSpecReady() {
      const cs = this.activeProfile?.config?.coverSpec;
      return !!(cs && cs.pageCount > 0 && cs.paperBulkMmPer1000 > 0);
    },

    // ── Druck-Tab: Trim-Preset anwenden ──────────────────────────────────
    // cm-Label mit '.'-Dezimal (Swiss-konform, locale-unabhängig).
    trimPresetOptions() {
      return TRIM_PRESETS.map(p => ({
        value: p.value,
        label: p.label || `${p.w / 10} × ${p.h / 10} cm`,
      }));
    },
    applyTrimPreset(value) {
      const p = TRIM_PRESETS.find(x => x.value === value);
      if (!p || !this.activeProfile) return;
      this.activeProfile.config.layout.pageSize = 'custom';
      this.activeProfile.config.layout.customWidthMm = p.w;
      this.activeProfile.config.layout.customHeightMm = p.h;
    },

    // ── Cover-Tab: Papiertyp → Rückenbreite ──────────────────────────────────
    paperPresetOptions() {
      return PAPER_PRESETS.map(p => ({ value: p.value, label: window.__app.t(p.labelKey) }));
    },
    applyPaperPreset(value) {
      const p = PAPER_PRESETS.find(x => x.value === value);
      if (!p || !this.activeProfile) return;
      this.activeProfile.config.coverSpec.paperBulkMmPer1000 = p.bulk;
    },

    // ── Druck-Tab: KDP-Vorgaben + Bundsteg-Prüfung ───────────────────────────
    // Setzt die bindungs-/druckrelevanten Flags für Amazon KDP und hebt Bund-/
    // Aussenränder auf die KDP-Mindestwerte an (Seitenzahl aus dem Cover-Tab).
    applyKdpPreset() {
      const cfg = this.activeProfile?.config;
      if (!cfg) return;
      cfg.print.cropMarks = false;       // KDP-Innenteil ohne Schnittmarken
      cfg.print.padToEvenPages = true;   // gerade Seitenzahl zwingend
      cfg.extras.barcode = false;        // KDP setzt eigenen Barcode
      cfg.layout.mirrorMargins = true;   // Bundsteg (innen = marginsMm.left)
      const pc = Math.max(0, cfg.coverSpec?.pageCount || 0);
      if (pc) {
        const minG = kdpMinGutterMm(pc);
        if (cfg.layout.marginsMm.left < minG) cfg.layout.marginsMm.left = minG;
      }
      for (const edge of ['right', 'top', 'bottom']) {
        if (cfg.layout.marginsMm[edge] < KDP_OUTER_MIN_MM) cfg.layout.marginsMm[edge] = KDP_OUTER_MIN_MM;
      }
    },
    // Advisory: prüft die aktuellen Ränder gegen die KDP-Minima. ok===null =
    // Hinweis (Seitenzahl fehlt), ok===false = Verstoss, ok===true = konform.
    kdpMarginWarnings() {
      const cfg = this.activeProfile?.config;
      if (!cfg) return [];
      const t = window.__app.t;
      const pc = Math.max(0, cfg.coverSpec?.pageCount || 0);
      if (!pc) return [{ ok: null, text: t('pdfExport.print.kdpWarnPageCount') }];
      const m = cfg.layout.marginsMm;
      const mirror = !!cfg.layout.mirrorMargins;
      const inner = mirror ? m.left : Math.min(m.left, m.right);
      const minG = kdpMinGutterMm(pc);
      const out = [];
      if (inner + 1e-6 < minG) {
        out.push({ ok: false, text: t('pdfExport.print.kdpWarnGutter', { have: inner, min: minG, pages: pc }) });
      }
      const outers = mirror ? [m.right, m.top, m.bottom] : [m.left, m.right, m.top, m.bottom];
      const minOuter = Math.min(...outers);
      if (minOuter + 1e-6 < KDP_OUTER_MIN_MM) {
        out.push({ ok: false, text: t('pdfExport.print.kdpWarnOuter', { have: minOuter, min: KDP_OUTER_MIN_MM }) });
      }
      // KDP-Innenteil darf keine Druckermarken tragen — Schnittmarken sind ein
      // Upload-Verhinderer, auch wenn die Ränder passen.
      if (cfg.print?.cropMarks) {
        out.push({ ok: false, text: t('pdfExport.print.kdpWarnCropMarks') });
      }
      if (!out.length) out.push({ ok: true, text: t('pdfExport.print.kdpOk', { pages: pc }) });
      return out;
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

    // Schriftfamilie einer Rolle auf alle übrigen Font-Rollen übertragen. Nur die
    // Familie wird gesetzt — Grösse/Zeilenhöhe/Farbe/Kursiv bleiben rollenspezifisch
    // (typografische Einheitlichkeit ohne die Feinheiten zu plätten). Das Weight
    // jeder Rolle wird gegen die Allowed-Liste der neuen Familie geclamped.
    applyFamilyToAll(fromRole) {
      if (!this.activeProfile) return;
      const fonts = this.activeProfile.config.font;
      const family = fonts[fromRole]?.family;
      if (!family) return;
      const meta = this.fontList.find(f => f.family === family);
      for (const role of Object.keys(fonts)) {
        const f = fonts[role];
        if (!f || typeof f !== 'object' || !('family' in f)) continue;
        f.family = family;
        if (meta && !meta.weights.includes(f.weight)) {
          f.weight = meta.weights.includes(400) ? 400 : meta.weights[0];
        }
      }
    },

    // ── Export-Trigger ────────────────────────────────────────────────────
    // target: 'interior' (Standard) oder 'cover' (separates Umschlag-PDF).
    async exportPdf(target = 'interior') {
      if (!this.activeProfile) return;
      // Vor Export speichern (Config könnte ungespeichert sein).
      await this.saveActiveProfile();
      if (this.exportError) return;
      // Umschlag-PDF immer Buch-scoped; sonst der gewählte Scope.
      const ref = target === 'cover'
        ? (Alpine.store('nav').selectedBookId ? { scope: 'book', id: parseInt(Alpine.store('nav').selectedBookId) } : null)
        : this._exportEntity();
      if (!ref) { this.exportError = window.__app.t('pdfExport.error.startFailed'); return; }
      // Fassungs-Quelle nur für den Innenteil des ganzen Buchs (Umschlag + Live-Cover
      // kommen weiterhin aus book_publication).
      const snapId = target === 'interior' ? this._exportSnapshotIdForSubmit() : null;
      this.exportLowRes = 0;
      await this._runExportJob({
        scope: ref.scope,
        entityId: ref.id,
        profile_id: this.activeProfile.id,
        target,
        ...(snapId ? { snapshot_id: snapId } : {}),
        ...(target === 'interior' && ref.scope === 'chapter' ? { include_subchapters: !!this.exportIncludeSubchapters } : {}),
      });
    },

    // ── PDF-eigene Picker (Seitenzähler-Skip) ─────────────────────────────
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
      if (!app || !Array.isArray(Alpine.store('nav').pages)) return [];
      const chapterById = new Map();
      if (Array.isArray(Alpine.store('nav').tree)) {
        for (const c of Alpine.store('nav').tree) {
          if (c.type === 'chapter') chapterById.set(c.id, c.name);
        }
      }
      return Alpine.store('nav').pages.map(p => {
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

    // ── Helpers fürs Template ────────────────────────────────────────────
    // Tab-State (activeTab) lebt über die `tabs`-Komponente im Markup
    // (x-modelable an activeTab gekoppelt) — kein setTab/isTab mehr hier.

    // Combobox-Options sind als Inline-Expressions im Template (siehe DESIGN.md
    // "Reaktivitaet bei Datenquelle aus Karten-Scope"). Nested x-data der Combobox
    // trackt this.xxx aus Card-Methods nicht zuverlaessig — deshalb Arrays inline
    // im x-effect aufbauen.
  }));
}
