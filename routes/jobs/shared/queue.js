'use strict';
const logger = require('../../../logger');
const { runWithContext } = require('../../../lib/log-context');
const { startJobRun } = require('../../../db/schema');
const appSettings = require('../../../lib/app-settings');
const { jobs, runningJobs, jobQueue, jobDedupKey } = require('./state');

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
    const ctx = { job: job.type, user: job.userEmail || null, book: job.bookId, jobId };
    runWithContext(ctx, () => {
      try { startJobRun(jobId, job.startedAt); } catch (e) { logger.error(`startJobRun: ${e.message}`); }
      // Job-Module loggen Start mit eigenem Detail (Pages-Count, Buchname etc.).
      // jobId steht via ALS-Ctx im Tag — kein zentrales Generik-Start nötig.
      fn()
        .catch(e => logger.error(`Unkontrollierter Job-Fehler: ${e.message}`))
        .finally(() => { activeCount--; drainQueue(); });
    });
  }
}

function enqueueJob(jobId, fn) {
  jobQueue.push({ jobId, fn });
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
