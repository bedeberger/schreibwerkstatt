'use strict';

// In-Memory-State der Job-Queue. Wird von queue/jobs/router/ai geteilt –
// in CJS sind die exportierten Map/Array-Referenzen identisch in allen Importern.
// key: jobId → { id, type, bookId, status, progress, statusText, result, error, … }
const jobs = new Map();
// key: `${type}:${bookId}:${userEmail}` → jobId  (verhindert Doppel-Starts)
const runningJobs = new Map();
// key: jobId → AbortController
const jobAbortControllers = new Map();
// FIFO-Warteschlange: { jobId, fn }
const jobQueue = [];

function jobKey(type, bookId, userEmail) {
  return `${type}:${bookId}:${userEmail || ''}`;
}

function jobDedupKey(job) {
  return jobKey(job.type, job.dedupId ?? job.bookId, job.userEmail);
}

module.exports = {
  jobs, runningJobs, jobAbortControllers, jobQueue,
  jobKey, jobDedupKey,
};
