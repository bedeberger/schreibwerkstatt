// Geteilte Basis der drei Export-Karten (PDF/EPUB/DOCX).
//
// Die drei Karten unterscheiden sich im Profil-/Publikations-Modell, in den
// Konfig-Tabs und im Done-Handling — teilen aber den format-agnostischen Kern:
// Scope-Auswahl (Buch/Kapitel/Seite), Job-Submit + Polling + Download und die
// Kapitel-ohne-Nummer-Chips. Diese Slices werden per Spread in die jeweilige
// `Alpine.data(...)` gemischt; die Methodennamen bleiben exakt erhalten, sodass
// die Partials (exportScopeOptions, cancelExport, unnumberedChapterChips, …)
// unverändert funktionieren.
//
// Bewusst NICHT geteilt: init/destroy (book:changed/view:reset divergieren stark
// — PDF unmountet das Form, EPUB lädt Publikation neu, DOCX resettet Scope),
// Profil-/Publikations-CRUD (PDF+DOCX user-scoped Profile, EPUB book_publication)
// und die Fehler-Namespaces (PDF mappt `pdfExport.error.<code>`, DOCX/EPUB nutzen
// `tError` → `error.<code>`) — letzteres bleibt der `errorFor`-Hook.

import { startPoll } from './job-helpers.js';

// ── Scope-Auswahl (Buch/Kapitel/Seite) ───────────────────────────────────────
// Vollständig format-unabhängig, keine Config. Liefert State + Methoden +
// Watch-/Preset-Verdrahtung; die Karte ruft _initScopeWatches()/_bindPreset()
// in ihrem init() auf.
export function exportScopeSlice() {
  return {
    exportScope: 'book',
    exportChapterId: null,
    exportPageId: null,
    exportIncludeSubchapters: false,

    _onExportPreset: null,
    _presetEvent: null,

    _initScopeWatches() {
      this.$watch(() => this.exportScope, () => this._ensureExportPicked());
      this.$watch(() => this.exportChapterId, () => { this.exportIncludeSubchapters = false; });
      this.$watch(() => window.__app?.currentPage?.id, () => this._ensureExportPicked());
    },

    // Preset (Deep-Link/Quick-Action „dieses Kapitel exportieren") binden.
    // event/globalKey sind pro Karte verschieden, das Muster ist identisch.
    _bindPreset(event, globalKey) {
      this._presetEvent = event;
      this._onExportPreset = (e) => this._applyExportPreset(e.detail);
      window.addEventListener(event, this._onExportPreset);
      const pending = window.__app?.[globalKey];
      if (pending) {
        this._applyExportPreset(pending);
        window.__app[globalKey] = null;
      }
    },
    _unbindPreset() {
      if (this._onExportPreset) window.removeEventListener(this._presetEvent, this._onExportPreset);
    },

    exportScopeOptions() {
      const app = window.__app;
      const opts = [{ value: 'book', label: app?.t?.('export.scope.book') || 'Buch' }];
      if (this.exportChapterOptions().length) opts.push({ value: 'chapter', label: app.t('export.scope.chapter') });
      if (this.exportPageOptions().length)    opts.push({ value: 'page',    label: app.t('export.scope.page') });
      return opts;
    },
    exportChapterOptions() {
      const app = window.__app;
      if (!app || !Array.isArray(Alpine.store('nav').tree)) return [];
      return Alpine.store('nav').tree
        .filter(c => c.type === 'chapter' && !c.solo)
        .map(c => ({ value: c.id, label: c.name }));
    },
    selectedChapterHasSubs() {
      const app = window.__app;
      if (!app || !Array.isArray(Alpine.store('nav').tree) || !this.exportChapterId) return false;
      const ch = Alpine.store('nav').tree.find(c => c.type === 'chapter' && c.id === this.exportChapterId);
      return !!ch?.hasChildren;
    },
    exportPageOptions() {
      const app = window.__app;
      if (!app || !Array.isArray(Alpine.store('nav').pages)) return [];
      return Alpine.store('nav').pages.map(p => ({ value: p.id, label: p.name }));
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
      const bid = Alpine.store('nav').selectedBookId;
      return bid ? { scope: 'book', id: parseInt(bid) } : null;
    },
  };
}

// ── Fassungs-Quelle (book_snapshots) ──────────────────────────────────────────
// Optional auf Buch-Scope: statt des Live-Buchs eine gespeicherte Fassung als
// Export-Quelle wählen. Fassungen sind ganze-Buch-Snapshots — daher nur bei
// exportScope === 'book' relevant; bei Kapitel/Seite ignoriert. exportSnapshotId
// === '' bedeutet „aktueller Stand" (Live-Buch). Die Karten laden die Liste in
// ihrem Visibility-Watch + book:changed-Handler via _loadExportSnapshots().
export function exportSnapshotSlice() {
  return {
    exportSnapshots: [],
    exportSnapshotId: '',   // '' = aktueller Stand (Live-Buch)

    async _loadExportSnapshots() {
      const bid = Alpine.store('nav').selectedBookId;
      if (!bid) { this.exportSnapshots = []; this.exportSnapshotId = ''; return; }
      try {
        const r = await fetch(`/snapshots/${parseInt(bid)}`);
        if (!r.ok) { this.exportSnapshots = []; this.exportSnapshotId = ''; return; }
        const d = await r.json();
        this.exportSnapshots = Array.isArray(d.snapshots) ? d.snapshots : [];
        // Auswahl invalidieren, wenn die gemerkte Fassung nicht mehr existiert.
        if (this.exportSnapshotId && !this.exportSnapshots.some(s => String(s.id) === String(this.exportSnapshotId))) {
          this.exportSnapshotId = '';
        }
      } catch {
        this.exportSnapshots = [];
        this.exportSnapshotId = '';
      }
    },

    // Server persistiert Auto-Sicherungs-Labels als __i18n:key__-Marker — in der
    // Locale des Betrachters auflösen (analog snapshots-card).
    _exportSnapLabel(snap) {
      const app = window.__app;
      const base = app.t('snapshots.fassung', { n: snap.seq });
      const m = /^__i18n:([a-zA-Z0-9_.-]+)__$/.exec(snap.label || '');
      const label = m ? app.t(m[1]) : snap.label;
      const when = app.formatDate ? app.formatDate(snap.created_at) : snap.created_at;
      const head = label ? `${base} · ${label}` : base;
      return `${head} — ${when}`;
    },

    exportSnapshotOptions() {
      const app = window.__app;
      const opts = [{ value: '', label: app?.t?.('export.snapshot.current') || 'Current version' }];
      for (const s of this.exportSnapshots) opts.push({ value: String(s.id), label: this._exportSnapLabel(s) });
      return opts;
    },

    // Submit-Helper: liefert die zu sendende snapshot_id (Number) oder null.
    // Nur auf Buch-Scope; bei Kapitel/Seite immer null.
    _exportSnapshotIdForSubmit() {
      if (this.exportScope !== 'book') return null;
      const id = parseInt(this.exportSnapshotId);
      return Number.isFinite(id) && id > 0 ? id : null;
    },
  };
}

// ── Job-Submit + Polling + Download ───────────────────────────────────────────
// cfg:
//   jobPath          — POST-Endpunkt + Datei-Basis (`${jobPath}/${id}/file`)
//   defaultFilename  — Fallback-Dateiname
//   i18nPrefix       — Karten-Prefix für starting/done/error.network/error.generic
//   errorFor(self,d) — baut die Fehlermeldung bei !ok-POST (Namespace pro Karte)
//   resolveDone(self,result) → { statusKey, ttl? } — Done-Status (Warnungen etc.),
//                              Default: { statusKey: `${prefix}.done`, ttl: 3500 }
export function exportJobSlice(cfg) {
  return {
    exporting: false,
    exportProgress: 0,
    exportStatus: '',
    exportError: '',
    currentJobId: null,
    _pollTimer: null,
    _exportStatusTimer: null,

    // Laufenden Export-Run räumen (book:changed / view:reset). Profil-/Publikations-
    // State bleibt unberührt — das ist Sache der jeweiligen Karte.
    _resetExportRun() {
      this._stopPoll();
      if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
      this.exporting = false;
      this.exportProgress = 0;
      this.exportStatus = '';
      this.exportError = '';
      this.currentJobId = null;
    },

    // Body bauen die Karten selbst (Cover-Target, include_subchapters, profile_id);
    // hier nur der gemeinsame POST → jobId → Poll-Pfad inkl. Fehlerbehandlung.
    async _runExportJob(body) {
      if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
      this.exporting = true;
      this.exportProgress = 0;
      this.exportStatus = window.__app.t(`${cfg.i18nPrefix}.starting`);
      this.exportError = '';
      try {
        const r = await fetch(cfg.jobPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = cfg.errorFor(this, d);
          this.exporting = false;
          return;
        }
        const { jobId } = await r.json();
        this.currentJobId = jobId;
        this._startPoll(jobId);
      } catch {
        this.exportError = window.__app.t(`${cfg.i18nPrefix}.error.network`);
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
            : window.__app.t(`${cfg.i18nPrefix}.error.generic`);
        },
        onDone: (job) => {
          this.exporting = false;
          this.exportProgress = 100;
          const result = job.result || {};
          const { statusKey, ttl = 3500 } = cfg.resolveDone
            ? cfg.resolveDone(this, result)
            : { statusKey: `${cfg.i18nPrefix}.done`, ttl: 3500 };
          this.exportStatus = window.__app.t(statusKey);
          this._triggerDownload(jobId, result.filename);
          if (this._exportStatusTimer) clearTimeout(this._exportStatusTimer);
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
      a.href = `${cfg.jobPath}/${jobId}/file`;
      a.download = filename || cfg.defaultFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    },

    async cancelExport() {
      if (!this.currentJobId) return;
      try { await fetch(`/jobs/${this.currentJobId}`, { method: 'DELETE' }); } catch {}
      // Poll deckt das `cancelled`-Status-Update bereits ab; UI-Reset im Polling.
    },
  };
}

// ── Kapitel-ohne-Nummer-Chips ─────────────────────────────────────────────────
// Pick-Optionen sind identisch (Tree-basiert); nur die Id-Quelle unterscheidet
// sich (PDF/DOCX: activeProfile.config.chapter.unnumberedChapterIds, EPUB:
// pub.epub_unnumbered_chapter_ids). Daher Accessor-Paar via cfg.
//   getIds(self) → number[]      (Lese-Quelle, robust gegen null)
//   setIds(self, arr)            (Schreib-Ziel)
export function unnumberedChipsSlice({ getIds, setIds }) {
  return {
    unnumberedChapterPickOptions() {
      const app = window.__app;
      if (!app || !Array.isArray(Alpine.store('nav').tree)) return [];
      return Alpine.store('nav').tree
        .filter(c => c.type === 'chapter' && !c.solo)
        .map(c => ({
          value: c.id,
          label: ((c.depth || 1) > 1 ? '— '.repeat((c.depth || 1) - 1) : '') + c.name,
        }));
    },
    unnumberedChapterChips() {
      const ids = getIds(this) || [];
      const opts = this.unnumberedChapterPickOptions();
      return ids.map(id => {
        const o = opts.find(x => x.value === id);
        return o ? { id, label: o.label } : { id, label: '#' + id };
      });
    },
    removeUnnumberedChapter(id) {
      const arr = getIds(this) || [];
      setIds(this, arr.filter(v => v !== id));
    },
  };
}
