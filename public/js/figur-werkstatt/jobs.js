// KI-Jobs: Brainstorm (pro Knoten) + Konsistenz-Check (gegen Buchwelt).
// Beide Jobs erzwingen Save vor Start; bei Save-Fail wird abgebrochen, sonst
// arbeitet KI auf altem Server-Snapshot und überschreibt user-edits beim Apply.

import { fetchJson } from '../utils.js';
import { startPoll, runningJobStatus } from '../cards/job-helpers.js';
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
          // Result nur aufs aktuelle Draft anwenden; sonst landet Vorschlags-
          // Liste auf der falschen Figur. History via loadRuns kriegt der
          // Quell-Draft beim nächsten Öffnen via _reattachActiveJobs / loadRuns.
          const targetId = this._brainstormJobDraftId;
          this.brainstormLoading = false;
          this.brainstormStatus = '';
          this._brainstormJobId = null;
          this._brainstormJobDraftId = null;
          if (this.selectedDraftId === targetId) {
            this.brainstormResult = {
              knotenId: job.result.knotenId,
              knotenPfad: job.result.knotenPfad,
              vorschlaege: job.result.vorschlaege || [],
            };
            this.selectedRunId = job.result.runId || null;
            this.loadRuns?.();
          }
        },
        onError: (job) => {
          this.brainstormLoading = false;
          this.brainstormStatus = '';
          this._brainstormJobId = null;
          if (this.selectedDraftId === this._brainstormJobDraftId) {
            this.errorMessage = app.t(job.error || 'common.error', job.errorParams || {});
          }
          this._brainstormJobDraftId = null;
        },
        onNotFound: () => {
          this.brainstormLoading = false;
          this.brainstormStatus = '';
          this._brainstormJobId = null;
          this._brainstormJobDraftId = null;
        },
      });
    } catch (e) {
      this.brainstormLoading = false;
      this._brainstormJobDraftId = null;
      this.errorMessage = app.t('werkstatt.error.brainstorm') || app.t('common.error');
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

  dismissBrainstorm() {
    this.brainstormResult = null;
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
    this._consistencyJobDraftId = sel.id;
    try {
      const resp = await fetchJson('/jobs/werkstatt-consistency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: sel.id }),
      });
      this._consistencyJobId = resp.jobId;
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
          const targetId = this._consistencyJobDraftId;
          this.consistencyLoading = false;
          this.consistencyStatus = '';
          this._consistencyJobId = null;
          this._consistencyJobDraftId = null;
          if (this.selectedDraftId === targetId) {
            this.consistencyResult = {
              konflikte: job.result.konflikte || [],
              fazit: job.result.fazit || '',
            };
            this.selectedRunId = job.result.runId || null;
            this.loadRuns?.();
          }
        },
        onError: (job) => {
          this.consistencyLoading = false;
          this.consistencyStatus = '';
          this._consistencyJobId = null;
          if (this.selectedDraftId === this._consistencyJobDraftId) {
            this.errorMessage = app.t(job.error || 'common.error', job.errorParams || {});
          }
          this._consistencyJobDraftId = null;
        },
        onNotFound: () => {
          this.consistencyLoading = false;
          this.consistencyStatus = '';
          this._consistencyJobId = null;
          this._consistencyJobDraftId = null;
        },
      });
    } catch (e) {
      this.consistencyLoading = false;
      this._consistencyJobDraftId = null;
      this.errorMessage = app.t('werkstatt.error.consistency') || app.t('common.error');
    }
  },

  dismissConsistency() {
    this.consistencyResult = null;
  },

  // Cancel: schickt DELETE /jobs/:id; Server setzt Status auf 'cancelled',
  // laufender callAI wird via AbortController unterbrochen.
  async cancelBrainstorm() {
    const id = this._brainstormJobId;
    if (!id) return;
    await window.__app.cancelJob(id);
    if (this._brainstormPollTimer) { clearInterval(this._brainstormPollTimer); this._brainstormPollTimer = null; }
    this.brainstormLoading = false;
    this.brainstormStatus = '';
    this.brainstormProgress = 0;
    this._brainstormJobId = null;
    this._brainstormJobDraftId = null;
  },

  async cancelConsistency() {
    const id = this._consistencyJobId;
    if (!id) return;
    await window.__app.cancelJob(id);
    if (this._consistencyPollTimer) { clearInterval(this._consistencyPollTimer); this._consistencyPollTimer = null; }
    this.consistencyLoading = false;
    this.consistencyStatus = '';
    this.consistencyProgress = 0;
    this._consistencyJobId = null;
    this._consistencyJobDraftId = null;
  },

  _clearJobs() {
    if (this._brainstormPollTimer) { clearInterval(this._brainstormPollTimer); this._brainstormPollTimer = null; }
    if (this._consistencyPollTimer) { clearInterval(this._consistencyPollTimer); this._consistencyPollTimer = null; }
    this.brainstormLoading = false;
    this.consistencyLoading = false;
    this.brainstormStatus = '';
    this.consistencyStatus = '';
    this._brainstormJobId = null;
    this._brainstormJobDraftId = null;
    this._consistencyJobId = null;
    this._consistencyJobDraftId = null;
  },
};
