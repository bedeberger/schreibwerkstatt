// Plot-Werkstatt: KI-Jobs (Brainstorm pro Akt/Zelle + Consistency gegen die
// Buchrealität), persistierte Lauf-Historie, Fullscreen-Toggle und das
// Aufräumen der Poll-Timer. Die KI plant/prüft nur Struktur — kein Fliesstext.

import { fetchJson, tzOpts } from '../../utils.js';
import { startPoll, runningJobStatus } from '../../cards/job-helpers.js';
import { toggleWrapFullscreen } from '../../fullscreen.js';
import { normTitle } from './constants.js';

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
          // Frisch persistierten Lauf als ausgewählt markieren + Historie neu laden.
          this.selectedBrainstormRunId = job.result.runId || null;
          this.loadBrainstormRuns();
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

  // Inline-Vorschlags-Panel + Lauf-Auswahl leeren (geteilt von dismiss/toggle-close/delete).
  _clearBrainstormPanel() {
    this.brainstormResult = null;
    this.brainstormActId = null;
    this.brainstormThreadId = null;
    this.selectedBrainstormRunId = null;
  },

  dismissBrainstorm() { this._clearBrainstormPanel(); },

  // ── KI: Brainstorm-Lauf-Historie ──────────────────────────────────────────
  // Persistierte Läufe pro Buch (zusätzlich pro Akt/Strang). Liste kommt ohne
  // result_json; Detail wird beim Öffnen lazy geholt und in das bestehende
  // Inline-Vorschlags-Panel des zugehörigen Akts/der Zelle gelegt (brainstormResult)
  // — genau wie ein frischer Lauf, sodass „Übernehmen" unverändert greift.
  async loadBrainstormRuns() {
    const app = window.__app;
    const bookId = app.selectedBookId;
    if (!bookId) { this.brainstormRuns = []; return; }
    try {
      const rows = await fetchJson(`/plot/brainstorm-runs?book_id=${bookId}`);
      this.brainstormRuns = Array.isArray(rows) ? rows : [];
    } catch (e) {
      this.brainstormRuns = [];
    }
  },

  // Toggle: Klick auf den aktiven Eintrag schliesst das Panel; sonst Detail laden
  // und brainstormResult füllen. Ein Lauf mit gelöschtem Akt (act_id == null) hat
  // keine Ziel-Spalte/-Zelle mehr — das Inline-Panel kann nicht erscheinen, darum
  // im Template nicht klickbar (hier defensiv nochmal geguardet).
  async openBrainstormRun(run) {
    const app = window.__app;
    if (!run || this.brainstormLoading) return;
    if (run.act_id == null) { this.errorMessage = app.t('plot.error.runLoad'); return; }
    if (this.selectedBrainstormRunId === run.id) { this._clearBrainstormPanel(); return; }
    try {
      const detail = await fetchJson(`/plot/brainstorm-runs/${run.id}`);
      if (!detail?.result) throw new Error('no result');
      this.brainstormActId = detail.act_id;
      this.brainstormThreadId = detail.thread_id ?? null;
      this.brainstormResult = { actId: detail.act_id, threadId: detail.thread_id ?? null, vorschlaege: detail.result.vorschlaege || [] };
      this.selectedBrainstormRunId = detail.id;
      this._scrollToBrainstormPanel();
    } catch (e) {
      this.errorMessage = app.t('plot.error.runLoad');
    }
  },

  async deleteBrainstormRun(runId) {
    const app = window.__app;
    if (!runId) return;
    if (!await app.appConfirm({ message: app.t('plot.brainstorm.confirmDeleteRun'), danger: true })) return;
    try {
      await fetchJson(`/plot/brainstorm-runs/${runId}`, { method: 'DELETE' });
      this.brainstormRuns = this.brainstormRuns.filter(r => r.id !== runId);
      if (this.selectedBrainstormRunId === runId) this._clearBrainstormPanel();
    } catch (e) {
      this.errorMessage = app.t('plot.error.runDelete');
    }
  },

  // Das eine sichtbare Vorschlags-Panel (flach ODER Grid-Zelle) ins Bild holen —
  // beim Reopen eines Laufs steht der Ziel-Akt evtl. ausserhalb des Sichtfelds.
  _scrollToBrainstormPanel() {
    this.$nextTick(() => {
      const panels = [...(this.$root?.querySelectorAll('.plot-brainstorm-panel') || [])];
      const vis = panels.find(p => p.offsetParent !== null);
      vis?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  },

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

  // Consistency-Panel + Lauf-Auswahl leeren (geteilt von dismiss/toggle-close/delete).
  _clearConsistencyPanel() {
    this.consistencyResult = null;
    this.selectedKonfliktIdx = null;
    this.selectedRunId = null;
  },

  dismissConsistency() { this._clearConsistencyPanel(); },

  // ── Konsistenz-Triage: Befund ↔ Beat ──────────────────────────────────────
  // Scrollt einen Beat ins Sichtfeld und hebt ihn kurz hervor. $root-skopiert
  // (funktioniert auch im Vollbild). Kein Auto-Edit — der User entscheidet.
  scrollToBeat(beatId) {
    const el = this.$root?.querySelector(`[data-beat-id="${beatId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('plot-beat--flash');
    void el.offsetWidth; // Reflow erzwingen → Animation startet auch beim zweiten Klick neu
    el.classList.add('plot-beat--flash');
    setTimeout(() => el.classList.remove('plot-beat--flash'), 1600);
  },

  // Aus einem Konsistenz-Befund zum benannten Beat springen (Titel-Match, gleiche
  // Vertragsbasis wie der Befund). Übergreifende Befunde ("—") haben kein Ziel.
  gotoKonfliktBeat(k) {
    if (!k || !k.beat || k.beat === '—') return;
    const key = normTitle(k.beat);
    const beat = (this.beats || []).find(b => normTitle(b.titel) === key);
    if (beat) this.scrollToBeat(beat.id);
  },

  // Vom Warn-Badge eines Beats zum Befund: ersten zugehörigen Konflikt aufklappen
  // und das Consistency-Panel ins Sichtfeld holen.
  focusKonfliktForBeat(beat) {
    const list = this.beatKonflikte(beat);
    if (!list.length) return;
    this.selectedKonfliktIdx = list[0].idx;
    this.$nextTick(() => {
      this.$root?.querySelector('.plot-consistency-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  },

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
    if (this.selectedRunId === runId) { this._clearConsistencyPanel(); return; }
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
      if (this.selectedRunId === runId) this._clearConsistencyPanel();
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
