// Plot-Werkstatt: KI-Jobs (Brainstorm pro Akt/Zelle + Consistency gegen die
// Buchrealität), persistierte Lauf-Historie, Fullscreen-Toggle und das
// Aufräumen der Poll-Timer. Die KI plant/prüft nur Struktur — kein Fliesstext.

import { fetchJson, tzOpts } from '../../utils.js';
import { startPoll, runningJobStatus } from '../../cards/job-helpers.js';
import { toggleWrapFullscreen } from '../../fullscreen.js';

export const aiMethods = {
  // ── KI: Brainstorm ──────────────────────────────────────────────────────
  // Im flachen Board akt-weit (thread = null), im Grid zell-granular (Strang
  // mitgegeben → die KI grundiert den Vorschlag mit Strang + gebundener Figur).
  async runBrainstorm(act, thread = null) {
    const app = window.__app;
    this.brainstormActId = act.id;
    this.brainstormThreadId = thread ? thread.id : null;
    this.brainstormLoading = true;
    this.brainstormStatus = '';
    this.brainstormResult = null;
    try {
      const resp = await fetchJson('/jobs/plot-brainstorm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: app.selectedBookId, act_id: act.id, thread_id: thread ? thread.id : null }),
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
          this._brainstormJobId = null;
          this.brainstormResult = { actId: job.result.actId, threadId: job.result.threadId ?? null, vorschlaege: job.result.vorschlaege || [] };
        },
        onError: (job) => {
          this.brainstormLoading = false;
          this.brainstormStatus = '';
          this._brainstormJobId = null;
          this.errorMessage = app.t(job.error || 'common.error', job.errorParams || {});
        },
        onNotFound: () => {
          this.brainstormLoading = false;
          this.brainstormStatus = '';
          this._brainstormJobId = null;
        },
      });
    } catch (e) {
      this.brainstormLoading = false;
      this.errorMessage = app.t('plot.error.brainstorm');
    }
  },

  async applyBrainstorm(idx) {
    const app = window.__app;
    if (!this.brainstormResult) return;
    const v = this.brainstormResult.vorschlaege[idx];
    const actId = this.brainstormResult.actId;
    if (!v || !actId) return;
    this.busy = true;
    try {
      const beat = await fetchJson('/plot/beats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: app.selectedBookId, act_id: actId, thread_id: this.brainstormResult.threadId ?? null, titel: v.label, beschreibung: v.begruendung || '' }),
      });
      this.beats = [...this.beats, beat];
      this._memos = {};
      this.brainstormResult.vorschlaege = this.brainstormResult.vorschlaege.filter((_, i) => i !== idx);
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  async cancelBrainstorm() {
    const id = this._brainstormJobId;
    if (id) await window.__app.cancelJob(id);
    if (this._brainstormPollTimer) { clearInterval(this._brainstormPollTimer); this._brainstormPollTimer = null; }
    this.brainstormLoading = false;
    this.brainstormStatus = '';
    this.brainstormProgress = 0;
    this._brainstormJobId = null;
  },

  dismissBrainstorm() { this.brainstormResult = null; this.brainstormActId = null; this.brainstormThreadId = null; },

  // ── KI: Consistency ─────────────────────────────────────────────────────
  async runConsistency() {
    const app = window.__app;
    if (!this.beats.length) { this.errorMessage = app.t('plot.error.boardEmpty'); return; }
    this.consistencyLoading = true;
    this.consistencyStatus = '';
    this.consistencyResult = null;
    this.selectedKonfliktIdx = null;
    try {
      const resp = await fetchJson('/jobs/plot-consistency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: app.selectedBookId }),
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
          this.consistencyLoading = false;
          this.consistencyStatus = '';
          this._consistencyJobId = null;
          this.consistencyResult = { konflikte: job.result.konflikte || [], fazit: job.result.fazit || '' };
          this.selectedKonfliktIdx = null;
          // Frisch persistierten Lauf als ausgewählt markieren + Historie neu laden.
          this.selectedRunId = job.result.runId || null;
          this.loadConsistencyRuns();
        },
        onError: (job) => {
          this.consistencyLoading = false;
          this.consistencyStatus = '';
          this._consistencyJobId = null;
          this.errorMessage = app.t(job.error || 'common.error', job.errorParams || {});
        },
        onNotFound: () => {
          this.consistencyLoading = false;
          this.consistencyStatus = '';
          this._consistencyJobId = null;
        },
      });
    } catch (e) {
      this.consistencyLoading = false;
      this.errorMessage = app.t('plot.error.consistency');
    }
  },

  async cancelConsistency() {
    const id = this._consistencyJobId;
    if (id) await window.__app.cancelJob(id);
    if (this._consistencyPollTimer) { clearInterval(this._consistencyPollTimer); this._consistencyPollTimer = null; }
    this.consistencyLoading = false;
    this.consistencyStatus = '';
    this.consistencyProgress = 0;
    this._consistencyJobId = null;
  },

  dismissConsistency() { this.consistencyResult = null; this.selectedKonfliktIdx = null; this.selectedRunId = null; },

  // ── KI: Konsistenz-Prüfungs-Historie ─────────────────────────────────────
  // Persistierte Läufe pro Buch. Liste kommt ohne result_json (Spaltensparsam);
  // Detail wird beim Öffnen lazy geholt und ins bestehende Consistency-Panel
  // (consistencyResult) gelegt — genau wie ein frischer Lauf.
  async loadConsistencyRuns() {
    const app = window.__app;
    const bookId = app.selectedBookId;
    if (!bookId) { this.consistencyRuns = []; return; }
    try {
      const rows = await fetchJson(`/plot/consistency-runs?book_id=${bookId}`);
      this.consistencyRuns = Array.isArray(rows) ? rows : [];
    } catch (e) {
      this.consistencyRuns = [];
    }
  },

  // Toggle: Klick auf den aktiv markierten Eintrag schliesst das Panel; sonst
  // Detail laden und consistencyResult füllen. Während eines Live-Laufs gesperrt.
  async openConsistencyRun(runId) {
    const app = window.__app;
    if (!runId || this.consistencyLoading) return;
    if (this.selectedRunId === runId) {
      this.selectedRunId = null;
      this.consistencyResult = null;
      this.selectedKonfliktIdx = null;
      return;
    }
    try {
      const run = await fetchJson(`/plot/consistency-runs/${runId}`);
      if (!run?.result) throw new Error('no result');
      this.consistencyResult = { konflikte: run.result.konflikte || [], fazit: run.result.fazit || '' };
      this.selectedKonfliktIdx = null;
      this.selectedRunId = run.id;
    } catch (e) {
      this.errorMessage = app.t('plot.error.runLoad');
    }
  },

  async deleteConsistencyRun(runId) {
    const app = window.__app;
    if (!runId) return;
    if (!await app.appConfirm({ message: app.t('plot.consistency.confirmDeleteRun'), danger: true })) return;
    try {
      await fetchJson(`/plot/consistency-runs/${runId}`, { method: 'DELETE' });
      this.consistencyRuns = this.consistencyRuns.filter(r => r.id !== runId);
      if (this.selectedRunId === runId) {
        this.selectedRunId = null;
        this.consistencyResult = null;
        this.selectedKonfliktIdx = null;
      }
    } catch (e) {
      this.errorMessage = app.t('plot.error.runDelete');
    }
  },

  formatRunDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const locale = window.__app?.uiLocale === 'en' ? 'en-GB' : 'de-CH';
      return d.toLocaleString(locale, tzOpts());
    } catch { return iso; }
  },

  // Ganze Plot-Karte ins Native-Vollbild — mehr horizontaler Platz fürs Akt-Board.
  // Status-Sync via fullscreenchange-Listener in plot-card.js (plotFullscreen).
  async togglePlotFullscreen() {
    try {
      await toggleWrapFullscreen(this.$root);
    } catch {
      this.errorMessage = window.__app.t('plot.error.fullscreen');
    }
  },

  _clearJobs() {
    if (this._brainstormPollTimer) { clearInterval(this._brainstormPollTimer); this._brainstormPollTimer = null; }
    if (this._consistencyPollTimer) { clearInterval(this._consistencyPollTimer); this._consistencyPollTimer = null; }
    this.brainstormLoading = false;
    this.consistencyLoading = false;
    this.brainstormStatus = '';
    this.consistencyStatus = '';
    this._brainstormJobId = null;
    this._consistencyJobId = null;
  },
};
