// KI-Jobs: Brainstorm (pro Knoten) + Konsistenz-Check (gegen Buchwelt).
// Beide Jobs erzwingen Save vor Start; bei Save-Fail wird abgebrochen, sonst
// arbeitet KI auf altem Server-Snapshot und überschreibt user-edits beim Apply.

import { fetchJson } from '../utils.js';
import { startWerkstattJobPoll, stopWerkstattJob } from './job-poll.js';
import { _newNodeId } from './mindmap.js';

export const jobsMethods = {
  async runBrainstorm() {
    const app = window.__app;
    const sel = this.selectedDraft();
    if (!sel || !this.selectedKnotenId) return;
    if (this.isDirty()) {
      const ok = await this.saveDraft();
      if (!ok) return; // Save-Fail: errorMessage steht; KI-Run abbrechen.
    }
    this.brainstormLoading = true;
    this.brainstormStatus = '';
    this.brainstormResult = null;
    this._brainstormJobDraftId = sel.id;
    try {
      const resp = await fetchJson('/jobs/werkstatt-brainstorm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: sel.id, knotenId: this.selectedKnotenId }),
      });
      this._brainstormJobId = resp.jobId;
      startWerkstattJobPoll(this, 'brainstorm', resp.jobId);
    } catch (e) {
      this.brainstormLoading = false;
      this._brainstormJobDraftId = null;
      this.errorMessage = app.t('werkstatt.error.brainstorm') || app.t('common.unknownError');
    }
  },

  applyBrainstormVorschlag(idx) {
    if (!this.brainstormResult) return;
    const v = this.brainstormResult.vorschlaege[idx];
    if (!v || !this._jm) return;
    const parentId = this.brainstormResult.knotenId;
    // History-Run kann auf Knoten zeigen, der zwischenzeitlich aus der
    // Mindmap entfernt wurde — verständlich melden statt _mutateMindmap-Fail.
    if (this._jm.get_node && !this._jm.get_node(parentId)) {
      this.errorMessage = window.__app.t('werkstatt.error.knotenGone');
      return;
    }
    const ok = this._mutateMindmap(jm => jm.add_node(parentId, _newNodeId(), v.label));
    if (ok) {
      this.brainstormResult.vorschlaege = this.brainstormResult.vorschlaege.filter((_, i) => i !== idx);
    } else {
      this.errorMessage = window.__app.t('werkstatt.error.applyFailed');
    }
  },

  async runConsistency() {
    const app = window.__app;
    const sel = this.selectedDraft();
    if (!sel) return;
    if (this.isDirty()) {
      const ok = await this.saveDraft();
      if (!ok) return;
    }
    this.consistencyLoading = true;
    this.consistencyStatus = '';
    this.consistencyResult = null;
    this.selectedKonfliktIdx = null;
    this._consistencyJobDraftId = sel.id;
    try {
      const resp = await fetchJson('/jobs/werkstatt-consistency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: sel.id }),
      });
      this._consistencyJobId = resp.jobId;
      startWerkstattJobPoll(this, 'consistency', resp.jobId);
    } catch (e) {
      this.consistencyLoading = false;
      this._consistencyJobDraftId = null;
      this.errorMessage = app.t('werkstatt.error.consistency') || app.t('common.unknownError');
    }
  },

  // Cancel: schickt DELETE /jobs/:id; Server setzt Status auf 'cancelled',
  // laufender callAI wird via AbortController unterbrochen.
  async cancelBrainstorm() {
    const id = this._brainstormJobId;
    if (!id) return;
    await window.__app.cancelJob(id);
    stopWerkstattJob(this, 'brainstorm');
  },

  async cancelConsistency() {
    const id = this._consistencyJobId;
    if (!id) return;
    await window.__app.cancelJob(id);
    stopWerkstattJob(this, 'consistency');
  },

  _clearJobs() {
    stopWerkstattJob(this, 'brainstorm');
    stopWerkstattJob(this, 'consistency');
  },
};
