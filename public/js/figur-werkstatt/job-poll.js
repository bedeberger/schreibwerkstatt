// Geteilter Poll-Kern für die beiden Werkstatt-KI-Jobs (Brainstorm + Consistency).
// Sowohl der Live-Start (jobs.js) als auch der Reattach beim Öffnen (runs.js)
// polten mit identischen onProgress/onDone/onError/onNotFound-Handlern — sie
// unterscheiden sich nur in den State-Prop-Namen und der Result-Form. Beides
// steckt im JOB_KINDS-Deskriptor, damit es genau eine Poll-Definition gibt.

import { startPoll, runningJobStatus } from '../cards/job-helpers.js';

export const JOB_KINDS = {
  brainstorm: {
    loadingProp: 'brainstormLoading',
    statusProp: 'brainstormStatus',
    progressProp: 'brainstormProgress',
    timerProp: '_brainstormPollTimer',
    jobIdProp: '_brainstormJobId',
    draftIdProp: '_brainstormJobDraftId',
    resultProp: 'brainstormResult',
    mapResult: (job) => ({
      knotenId: job.result.knotenId,
      knotenPfad: job.result.knotenPfad,
      vorschlaege: job.result.vorschlaege || [],
    }),
    onDoneExtra: null,
  },
  consistency: {
    loadingProp: 'consistencyLoading',
    statusProp: 'consistencyStatus',
    progressProp: 'consistencyProgress',
    timerProp: '_consistencyPollTimer',
    jobIdProp: '_consistencyJobId',
    draftIdProp: '_consistencyJobDraftId',
    resultProp: 'consistencyResult',
    mapResult: (job) => ({
      konflikte: job.result.konflikte || [],
      fazit: job.result.fazit || '',
    }),
    onDoneExtra: (self) => { self.selectedKonfliktIdx = null; },
  },
};

// Startet das Polling für einen laufenden Job. Erwartet, dass die Loading-/
// JobId-/DraftId-State-Props bereits gesetzt sind (Live-Start in jobs.js bzw.
// Reattach-Seeding in reattachWerkstattJob).
export function startWerkstattJobPoll(self, kind, jobId) {
  const app = window.__app;
  const k = JOB_KINDS[kind];
  startPoll(self, {
    timerProp: k.timerProp,
    jobId,
    progressProp: k.progressProp,
    onProgress: (job) => {
      self[k.statusProp] = runningJobStatus(app.t.bind(app),
        job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
        job.progress, job.tokensPerSec, job.statusParams);
    },
    onDone: (job) => {
      // Result nur aufs aktuelle Draft anwenden; sonst landet es auf der
      // falschen Figur. History via loadRuns kriegt der Quell-Draft beim
      // nächsten Öffnen (loadRuns / _reattachActiveJobs).
      const targetId = self[k.draftIdProp];
      self[k.loadingProp] = false;
      self[k.statusProp] = '';
      self[k.jobIdProp] = null;
      self[k.draftIdProp] = null;
      if (self.selectedDraftId === targetId) {
        self[k.resultProp] = k.mapResult(job);
        if (k.onDoneExtra) k.onDoneExtra(self);
        self.selectedRunId = job.result.runId || null;
        self.loadRuns?.();
      }
    },
    onError: (job) => {
      self[k.loadingProp] = false;
      self[k.statusProp] = '';
      self[k.jobIdProp] = null;
      if (self.selectedDraftId === self[k.draftIdProp]) {
        self.errorMessage = app.t(job.error || 'common.unknownError', job.errorParams || {});
      }
      self[k.draftIdProp] = null;
    },
    onNotFound: () => {
      self[k.loadingProp] = false;
      self[k.statusProp] = '';
      self[k.jobIdProp] = null;
      self[k.draftIdProp] = null;
    },
  });
}

// Stoppt Poll-Timer und nullt allen Lauf-State eines Kind (Cancel, Reset,
// Kappung beim Wechsel auf eine andere Figur). Progress geht auf 0 zurück.
export function stopWerkstattJob(self, kind) {
  const k = JOB_KINDS[kind];
  if (self[k.timerProp]) { clearInterval(self[k.timerProp]); self[k.timerProp] = null; }
  self[k.loadingProp] = false;
  self[k.statusProp] = '';
  self[k.progressProp] = 0;
  self[k.jobIdProp] = null;
  self[k.draftIdProp] = null;
}

// Reattach beim Öffnen einer Figur: seedet Loading-/Progress-/Status-State aus
// dem Queue-Item und hängt sich dann via startWerkstattJobPoll dran.
export function reattachWerkstattJob(self, kind, qItem, draftId) {
  const app = window.__app;
  const k = JOB_KINDS[kind];
  self[k.loadingProp] = true;
  self[k.progressProp] = qItem.progress || 0;
  self[k.statusProp] = runningJobStatus(app.t.bind(app),
    qItem.statusText, qItem.tokensIn, qItem.tokensOut, qItem.maxTokensOut,
    qItem.progress, qItem.tokensPerSec, qItem.statusParams);
  self[k.resultProp] = null;
  self[k.jobIdProp] = qItem.id;
  self[k.draftIdProp] = draftId;
  startWerkstattJobPoll(self, kind, qItem.id);
}
