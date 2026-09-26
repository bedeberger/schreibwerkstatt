'use strict';
const logger = require('../../../logger');
const { runWithContext } = require('../../../lib/log-context');
const { startJobRun } = require('../../../db/schema');
const appSettings = require('../../../lib/app-settings');
const { jobs, runningJobs, jobQueue, jobDedupKey } = require('./state');
const { emitJobChange, emitQueueShift } = require('./events');

// Maximale Anzahl gleichzeitig laufender Jobs (über alle User).
function _maxConcurrent() {
  return parseInt(appSettings.get('jobs.max_concurrent'), 10) || 2;
}
let activeCount = 0;

// Auto-Cleanup: 2 h nachdem der Job terminal (done|error|cancelled) wurde,
// wird der Memory-Eintrag entfernt. Vorher nicht – solange der Job läuft, soll
// der Client ihn abfragen können.
const CLEANUP_DELAY_MS = 2 * 60 * 60 * 1000;

function drainQueue() {
  const maxConcurrent = _maxConcurrent();
  while (activeCount < maxConcurrent && jobQueue.length > 0) {
    const { jobId, fn } = jobQueue.shift();
    const job = jobs.get(jobId);
    if (!job) continue; // Job wurde zwischenzeitlich entfernt
    activeCount++;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    emitJobChange(job);
    emitQueueShift();
    const ctx = { job: job.type, user: job.userEmail || null, book: job.bookId, jobId };
    runWithContext(ctx, () => {
      try { startJobRun(jobId); } catch (e) { logger.error(`startJobRun: ${e.message}`); }
      // Job-Module loggen Start mit eigenem Detail (Pages-Count, Buchname etc.).
      // jobId steht via ALS-Ctx im Tag — kein zentrales Generik-Start nötig.
      // Promise.resolve().then(fn): auch ein synchroner Throw landet im catch,
      // sonst bliebe activeCount fuer immer erhoeht. Ein Fehler, der am try des
      // Job-Moduls vorbeigeht (z.B. `await getPrompts()` davor), wird hier
      // terminal verbucht — ohne failJob bliebe der Job ewig auf 'running' und
      // der Dedup-Slot belegt.
      Promise.resolve().then(fn)
        .catch(e => {
          logger.error(`Unkontrollierter Job-Fehler: ${e?.message || e}`);
          const j = jobs.get(jobId);
          if (j && (j.status === 'queued' || j.status === 'running')) {
            try { require('./jobs').failJob(jobId, e instanceof Error ? e : new Error(String(e))); }
            catch (fe) { logger.error(`failJob nach unkontrolliertem Job-Fehler: ${fe.message}`); }
          }
        })
        .finally(() => { activeCount--; drainQueue(); });
    });
  }
}

function enqueueJob(jobId, fn) {
  jobQueue.push({ jobId, fn });
  emitJobChange(jobs.get(jobId));
  drainQueue();
}

function _scheduleJobCleanup(id) {
  const job = jobs.get(id);
  if (!job) return;
  const key = jobDedupKey(job);
  const timer = setTimeout(() => {
    jobs.delete(id);
    if (runningJobs.get(key) === id) runningJobs.delete(key);
  }, CLEANUP_DELAY_MS);
  timer.unref?.();
}

module.exports = {
  CLEANUP_DELAY_MS,
  drainQueue, enqueueJob, _scheduleJobCleanup,
};
