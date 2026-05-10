// Methoden für die Figuren-Werkstatt-Karte (Sub-Komponente).
// Phase 4: jsMind-Editor + KI-Brainstorm + Konsistenz-Check.
// CRUD + Mindmap-Lifecycle + Job-Trigger + Result-Apply.

import { fetchJson } from './utils.js';
import { loadJsMind } from './lazy-libs.js';
import { startPoll, runningJobStatus } from './cards/job-helpers.js';

// Server persistiert Default-Knoten-Labels als `__i18n:werkstatt.tree.foo__`.
// Frontend löst beim Render via t() in die User-Locale auf.
const I18N_MARKER = /^__i18n:([a-zA-Z0-9_.-]+)__$/;
function resolveTopic(topic) {
  const m = I18N_MARKER.exec(topic || '');
  return m ? window.__app.t(m[1]) : (topic || '');
}

// Mindmap-Topics werden vor dem Show in jsMind durch resolved Strings ersetzt;
// beim Speichern bleiben User-Edits direkt erhalten (Default-Marker werden
// überschrieben sobald User Knoten umbenennt).
function resolveMindmapForDisplay(mindmap) {
  if (!mindmap?.data) return mindmap;
  const cloneNode = (n) => ({
    ...n,
    topic: resolveTopic(n.topic),
    children: (n.children || []).map(cloneNode),
  });
  return { ...mindmap, data: cloneNode(mindmap.data) };
}

// Knoten-ID-Generator für jsMind (eindeutig pro Mindmap).
function _newNodeId() {
  return 'n' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

export const figurWerkstattMethods = {
  // ── CRUD ──────────────────────────────────────────────────────────────────
  async loadDrafts() {
    const app = window.__app;
    const bookId = app?.selectedBookId;
    if (!bookId) { this.drafts = []; return; }
    this.loading = true;
    try {
      const rows = await fetchJson(`/draft-figures/${bookId}`);
      this.drafts = Array.isArray(rows) ? rows : [];
      this.errorMessage = '';
      if (this.selectedDraftId && !this.drafts.find(d => d.id === this.selectedDraftId)) {
        this.selectedDraftId = null;
      }
      if (!this.selectedDraftId && this.drafts.length > 0) {
        this.selectDraft(this.drafts[0].id);
      } else if (this.selectedDraftId) {
        this.$nextTick(() => this._mountMindmap());
      }
    } catch (e) {
      this.errorMessage = app.t('werkstatt.error.load') || app.t('common.error');
      this.drafts = [];
    } finally {
      this.loading = false;
    }
  },

  resetDrafts() {
    this._destroyMindmap();
    this._clearJobs();
    this.drafts = [];
    this.selectedDraftId = null;
    this.selectedKnotenId = null;
    this.editName = '';
    this.editArchetype = '';
    this.editNotes = '';
    this.creating = false;
    this.newName = '';
    this.errorMessage = '';
    this.busy = false;
    this.brainstormResult = null;
    this.consistencyResult = null;
  },

  selectDraft(id) {
    const d = this.drafts.find(x => x.id === id);
    if (!d) { this.selectedDraftId = null; return; }
    this.selectedDraftId = id;
    this.editName = d.name;
    this.editArchetype = d.archetype || '';
    this.editNotes = d.notes || '';
    this.creating = false;
    this.brainstormResult = null;
    this.consistencyResult = null;
    this.selectedKnotenId = null;
    this.$nextTick(() => this._mountMindmap());
  },

  selectedDraft() {
    if (!this.selectedDraftId) return null;
    return this.drafts.find(d => d.id === this.selectedDraftId) || null;
  },

  startCreate() {
    this.creating = true;
    this.newName = '';
    this.errorMessage = '';
    this.$nextTick(() => {
      const input = this.$el?.querySelector('.werkstatt-new-name');
      input?.focus();
    });
  },

  cancelCreate() {
    this.creating = false;
    this.newName = '';
  },

  async createDraft() {
    const app = window.__app;
    const name = (this.newName || '').trim();
    if (!name) { this.errorMessage = app.t('werkstatt.error.nameRequired') || app.t('common.error'); return; }
    const bookId = app.selectedBookId;
    if (!bookId) return;
    this.busy = true;
    try {
      const row = await fetchJson(`/draft-figures/${bookId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      this.drafts = [row, ...this.drafts];
      this.creating = false;
      this.newName = '';
      this.selectDraft(row.id);
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('werkstatt.error.create') || app.t('common.error');
    } finally {
      this.busy = false;
    }
  },

  async saveDraft() {
    const app = window.__app;
    const sel = this.selectedDraft();
    if (!sel) return;
    const name = (this.editName || '').trim();
    if (!name) { this.errorMessage = app.t('werkstatt.error.nameRequired') || app.t('common.error'); return; }
    // Aktuelle Mindmap aus jsMind exportieren, falls Editor geladen ist.
    const mindmap = this._exportMindmap() || sel.mindmap;
    this.busy = true;
    try {
      const updated = await fetchJson(`/draft-figures/${sel.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          archetype: this.editArchetype || null,
          notes: this.editNotes || null,
          mindmap,
        }),
      });
      this.drafts = this.drafts.map(d => d.id === updated.id ? updated : d);
      this.errorMessage = '';
      this.savedAt = Date.now();
      if (this._savedAtTimer) clearTimeout(this._savedAtTimer);
      this._savedAtTimer = setTimeout(() => { this.savedAt = null; this._savedAtTimer = null; }, 2500);
    } catch (e) {
      this.errorMessage = app.t('werkstatt.error.save') || app.t('common.error');
    } finally {
      this.busy = false;
    }
  },

  async requestDelete() {
    const sel = this.selectedDraft();
    if (!sel) return;
    const app = window.__app;
    const ok = await app.appConfirm({
      message: app.t('werkstatt.confirmDelete'),
      danger: true,
    });
    if (!ok) return;
    await this._doDelete(sel.id);
  },

  async _doDelete(id) {
    const app = window.__app;
    this.busy = true;
    try {
      await fetchJson(`/draft-figures/${id}`, { method: 'DELETE' });
      this._destroyMindmap();
      this.drafts = this.drafts.filter(d => d.id !== id);
      if (this.selectedDraftId === id) {
        this.selectedDraftId = null;
        this.editName = '';
        this.editArchetype = '';
        this.editNotes = '';
        this.brainstormResult = null;
        this.consistencyResult = null;
        if (this.drafts.length > 0) this.selectDraft(this.drafts[0].id);
      }
    } catch (e) {
      this.errorMessage = app.t('werkstatt.error.delete') || app.t('common.error');
    } finally {
      this.busy = false;
    }
  },

  // ── Mindmap-Lifecycle (jsMind) ────────────────────────────────────────────
  async _mountMindmap() {
    const sel = this.selectedDraft();
    if (!sel) return;
    const container = this.$el?.querySelector('.werkstatt-mindmap');
    if (!container) return;
    let jsMind;
    try {
      jsMind = await loadJsMind();
    } catch (e) {
      this.errorMessage = window.__app.t('werkstatt.error.libLoad') || 'Library load failed';
      return;
    }
    if (!this._jm) {
      this._jm = new jsMind({
        container,
        editable: true,
        theme: 'primary',
        view: { hmargin: 80, vmargin: 40, line_width: 1.5, draggable: true, hide_scrollbars_when_draggable: true },
        layout: { hspace: 30, vspace: 18, pspace: 14 },
      });
      // Selection-Tracking für KI-Brainstorm.
      this._jm.add_event_listener((type, data) => {
        // type 4 = select (jsMind enum: show=1, resize=2, edit=3, select=4)
        if (type === 4) {
          this.selectedKnotenId = data?.node || null;
        }
      });
    }
    this._jm.show(resolveMindmapForDisplay(sel.mindmap));
    // Nach show() Wurzel als Default-Selektion.
    this.selectedKnotenId = sel.mindmap?.data?.id || 'root';
  },

  _destroyMindmap() {
    // jsMind hat keine offizielle destroy()-Methode; container leeren reicht.
    const container = this.$el?.querySelector?.('.werkstatt-mindmap');
    if (container) container.innerHTML = '';
    this._jm = null;
  },

  _exportMindmap() {
    if (!this._jm) return null;
    try {
      const exported = this._jm.get_data('node_tree');
      // jsMind liefert { meta, format, data }; format auf 'node_tree' fixieren.
      return exported && exported.data ? exported : null;
    } catch (e) {
      return null;
    }
  },

  // Knoten-Pfad als „Wurzel > … > Knoten" — für UI-Anzeige + Brainstorm-Heading.
  knotenPfad(id) {
    if (!id || !this._jm) return '';
    const tree = this._exportMindmap()?.data;
    const walk = (node, trail) => {
      const here = [...trail, resolveTopic(node.topic)];
      if (node.id === id) return here.join(' > ');
      for (const c of node.children || []) {
        const found = walk(c, here);
        if (found) return found;
      }
      return null;
    };
    return tree ? (walk(tree, []) || '') : '';
  },

  // ── KI-Brainstorm ─────────────────────────────────────────────────────────
  async runBrainstorm() {
    const app = window.__app;
    const sel = this.selectedDraft();
    if (!sel || !this.selectedKnotenId) return;
    // Aktuellen Mindmap-Stand zuerst speichern, sonst sieht KI alte Daten.
    await this.saveDraft();
    this.brainstormLoading = true;
    this.brainstormStatus = '';
    this.brainstormResult = null;
    try {
      const resp = await fetchJson('/jobs/werkstatt-brainstorm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: sel.id, knotenId: this.selectedKnotenId }),
      });
      this._brainstormJobId = resp.jobId;
      startPoll(this, {
        timerProp: '_brainstormPollTimer',
        jobId: resp.jobId,
        progressProp: 'brainstormProgress',
        onProgress: (job) => {
          this.brainstormStatus = runningJobStatus(app.t.bind(app),
            job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
            job.progress, job.tokensPerSec, job.statusParams);
        },
        onDone: (job) => {
          this.brainstormLoading = false;
          this.brainstormStatus = '';
          this.brainstormResult = {
            knotenId: job.result.knotenId,
            knotenPfad: job.result.knotenPfad,
            vorschlaege: job.result.vorschlaege || [],
          };
        },
        onError: (job) => {
          this.brainstormLoading = false;
          this.brainstormStatus = '';
          this.errorMessage = app.t(job.error || 'common.error', job.errorParams || {});
        },
        onNotFound: () => { this.brainstormLoading = false; this.brainstormStatus = ''; },
      });
    } catch (e) {
      this.brainstormLoading = false;
      this.errorMessage = app.t('werkstatt.error.brainstorm') || app.t('common.error');
    }
  },

  applyBrainstormVorschlag(idx) {
    if (!this.brainstormResult) return;
    const v = this.brainstormResult.vorschlaege[idx];
    if (!v || !this._jm) return;
    const parentId = this.brainstormResult.knotenId;
    try {
      this._jm.add_node(parentId, _newNodeId(), v.label);
    } catch (e) {
      console.error('[werkstatt] add_node failed:', e);
    }
    // Vorschlag aus Liste entfernen, damit User Apply-Status sieht.
    this.brainstormResult.vorschlaege = this.brainstormResult.vorschlaege.filter((_, i) => i !== idx);
  },

  dismissBrainstorm() {
    this.brainstormResult = null;
  },

  // ── KI-Konsistenz-Check ──────────────────────────────────────────────────
  async runConsistency() {
    const app = window.__app;
    const sel = this.selectedDraft();
    if (!sel) return;
    await this.saveDraft();
    this.consistencyLoading = true;
    this.consistencyStatus = '';
    this.consistencyResult = null;
    try {
      const resp = await fetchJson('/jobs/werkstatt-consistency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: sel.id }),
      });
      startPoll(this, {
        timerProp: '_consistencyPollTimer',
        jobId: resp.jobId,
        progressProp: 'consistencyProgress',
        onProgress: (job) => {
          this.consistencyStatus = runningJobStatus(app.t.bind(app),
            job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
            job.progress, job.tokensPerSec, job.statusParams);
        },
        onDone: (job) => {
          this.consistencyLoading = false;
          this.consistencyStatus = '';
          this.consistencyResult = {
            konflikte: job.result.konflikte || [],
            fazit: job.result.fazit || '',
          };
        },
        onError: (job) => {
          this.consistencyLoading = false;
          this.consistencyStatus = '';
          this.errorMessage = app.t(job.error || 'common.error', job.errorParams || {});
        },
        onNotFound: () => { this.consistencyLoading = false; this.consistencyStatus = ''; },
      });
    } catch (e) {
      this.consistencyLoading = false;
      this.errorMessage = app.t('werkstatt.error.consistency') || app.t('common.error');
    }
  },

  dismissConsistency() {
    this.consistencyResult = null;
  },

  _clearJobs() {
    if (this._brainstormPollTimer) { clearInterval(this._brainstormPollTimer); this._brainstormPollTimer = null; }
    if (this._consistencyPollTimer) { clearInterval(this._consistencyPollTimer); this._consistencyPollTimer = null; }
    this.brainstormLoading = false;
    this.consistencyLoading = false;
    this.brainstormStatus = '';
    this.consistencyStatus = '';
  },
};

export { resolveTopic, resolveMindmapForDisplay };
