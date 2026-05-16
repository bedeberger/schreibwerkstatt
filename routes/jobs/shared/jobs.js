'use strict';
const { randomUUID } = require('crypto');
const logger = require('../../../logger');
const { insertJobRun, endJobRun } = require('../../../db/schema');
const { MAX_TOKENS_OUT } = require('../../../lib/ai');
const { jobs, runningJobs, jobAbortControllers, jobQueue, jobKey, jobDedupKey } = require('./state');
const { _scheduleJobCleanup } = require('./queue');
const { _modelName } = require('./model');

// Job-Ctx (type/user/book) wird via ALS in `drainQueue` gesetzt – jeder
// `logger.*`-Call innerhalb der Job-Funktion erbt ihn automatisch.
// Der frühere Child-Logger ist damit überflüssig; die Funktion bleibt als
// reiner Pass-Through erhalten, damit die zahlreichen Aufruf-Sites
// (`const logger = makeJobLogger(jobId)`) unverändert weiterlaufen.
function makeJobLogger(_jobId) {
  return logger;
}

function fmtTok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtDuration(seconds) {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function _jobDurationFmt(startedAt) {
  if (!startedAt) return '?';
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function _jobLogCtx(job) {
  return { job: job.type, user: job.userEmail, book: job.bookId, jobId: job.id };
}

function tps(tok) {
  return tok.ms > 0 ? tok.out / (tok.ms / 1000) : null;
}

/**
 * Baut einen Error, dessen `message` ein i18n-Key ist und der optionale Params trägt.
 * `failJob` liest diese Params und stellt sie dem Frontend als `errorParams` zur Verfügung,
 * damit `t(key, params)` die Meldung in der User-Locale rendern kann.
 */
function i18nError(key, params = null) {
  const err = new Error(key);
  if (params) err.i18nParams = params;
  return err;
}

/**
 * Helper: BookStack-/content-store-Errors mit `e.status` in i18nError-Form
 * uebersetzen. Job-Handler wrappen ihre content-store-Calls damit, sodass
 * Frontend dieselbe Fehlermeldung sehen wie zuvor mit dem shared/bookstack.js-
 * Wrapper. Andere Fehler (Abort, AssertionError, ...) werden unveraendert
 * weitergeworfen.
 */
function bsHttpError(e) {
  if (e?.status) return i18nError('job.error.bookstack', { status: e.status, text: e.bodyText });
  return e;
}

/**
 * Liefert die jobId eines AKTIVEN (queued/running) Dedup-Matches oder null.
 * `runningJobs` hält Einträge auch nach Abschluss noch CLEANUP_DELAY_MS lang;
 * die nackte Map-Lookup würde abgeschlossene Jobs (status='done'/'error'/
 * 'cancelled') wie laufende behandeln und das Frontend pollt einen toten Job.
 */
function findActiveJobId(type, entityId, userEmail) {
  const id = runningJobs.get(jobKey(type, entityId, userEmail));
  if (!id) return null;
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === 'queued' || job.status === 'running') return id;
  return null;
}

function createJob(type, bookId, userEmail, label, labelParams = null, dedupId = null) {
  const id = randomUUID();
  const dedupValue = dedupId != null ? String(dedupId) : null;
  const key = jobKey(type, dedupValue ?? bookId, userEmail);
  const provider = (process.env.API_PROVIDER || 'claude').toLowerCase();
  const model = _modelName(provider);
  jobs.set(id, {
    id, type, bookId: String(bookId), dedupId: dedupValue, userEmail: userEmail || null,
    label: label || null,
    labelParams: labelParams || null,
    provider, model,
    status: 'queued', progress: 0, statusText: 'job.queued', statusParams: null,
    tokensIn: 0, tokensOut: 0, cacheReadIn: 0, cacheCreationIn: 0, tokensPerSec: null,
    maxTokensOut: MAX_TOKENS_OUT,
    result: null, error: null, errorParams: null,
    startedAt: null, endedAt: null,
    cancelled: false,
  });
  jobAbortControllers.set(id, new AbortController());
  try { insertJobRun({ id, type, bookId: String(bookId), userEmail, label, provider, model }); } catch (e) {
    logger.error(`insertJobRun: ${e.message}`, { job: type, user: userEmail, book: bookId });
  }
  runningJobs.set(key, id);
  return id;
}

function updateJob(id, updates) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return;
  // statusText-Setzer dürfen statusParams gezielt zurücksetzen: wenn nur
  // statusText gesetzt wird, wird ein evtl. alter statusParams geleert,
  // damit Platzhalter aus älteren Meldungen nicht nachwirken.
  if ('statusText' in updates && !('statusParams' in updates)) {
    updates = { ...updates, statusParams: null };
  }
  if (updates.progress != null && updates.progress < (job.progress || 0)) {
    // Parallel-Branch mit niedrigerem Fortschritt darf progress nicht zurücksetzen,
    // statusText darf aber aktualisiert werden – der User sieht so, was gerade läuft.
    const { progress: _, ...rest } = updates;
    Object.assign(job, rest);
  } else {
    Object.assign(job, updates);
  }
}

function completeJob(id, result, tokensPerSec = null, detail = null) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, { status: 'done', progress: 100, result, tokensPerSec, endedAt: new Date().toISOString() });
  try {
    endJobRun(id, 'done', job.endedAt, job.tokensIn, job.tokensOut, job.cacheReadIn, job.cacheCreationIn, tokensPerSec, null);
  } catch (e) {
    logger.error(`endJobRun: ${e.message}`, _jobLogCtx(job));
  }
  // Zentrales Done-Log — ALS-Ctx liefert [type|user|book|jobId8].
  // Job-Module geben semantisches Detail (Note, Pages, Beanstandungen…) als 4. Arg mit.
  const cacheSeg = (job.cacheReadIn || job.cacheCreationIn)
    ? ` cache=${fmtTok(job.cacheReadIn)}r/${fmtTok(job.cacheCreationIn)}w`
    : '';
  const detailSeg = detail ? `${detail}, ` : '';
  logger.info(
    `Fertig (${_jobDurationFmt(job.startedAt)}, ${detailSeg}${fmtTok(job.tokensIn)}↑ ${fmtTok(job.tokensOut)}↓${cacheSeg}, ${job.provider}/${job.model})`,
    _jobLogCtx(job),
  );
  runningJobs.delete(jobDedupKey(job));
  jobAbortControllers.delete(id);
  _scheduleJobCleanup(id);
}

function failJob(id, err) {
  const job = jobs.get(id);
  if (!job) return;
  const isCancelled = job.cancelled || err?.name === 'AbortError';
  const status = isCancelled ? 'cancelled' : 'error';
  const errorMsg = isCancelled ? 'job.cancelled' : (err.message || String(err));
  const errorParams = isCancelled ? null : (err?.i18nParams || null);
  Object.assign(job, { status, error: errorMsg, errorParams, progress: isCancelled ? job.progress : 0, endedAt: new Date().toISOString() });
  try {
    endJobRun(id, status, job.endedAt, job.tokensIn, job.tokensOut, job.cacheReadIn, job.cacheCreationIn, null, errorMsg, errorParams);
  } catch (e) {
    logger.error(`endJobRun: ${e.message}`, _jobLogCtx(job));
  }
  // Zentrales Terminal-Log: Cancellation als info, echte Fehler als warn
  // (Job-Modul hat ggf. bereits ein Error mit Stack geschrieben).
  if (isCancelled) {
    logger.info(`Abgebrochen (${_jobDurationFmt(job.startedAt)})`, _jobLogCtx(job));
  } else {
    logger.warn(`Fehlgeschlagen (${_jobDurationFmt(job.startedAt)}): ${errorMsg}`, _jobLogCtx(job));
  }
  runningJobs.delete(jobDedupKey(job));
  jobAbortControllers.delete(id);
  _scheduleJobCleanup(id);
}

function cancelJob(id, userEmail) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.userEmail !== (userEmail || null)) return false;
  if (job.status === 'queued') {
    const idx = jobQueue.findIndex(e => e.jobId === id);
    if (idx !== -1) jobQueue.splice(idx, 1);
    const endedAt = new Date().toISOString();
    Object.assign(job, { status: 'cancelled', error: 'job.cancelled', errorParams: null, endedAt });
    try { endJobRun(id, 'cancelled', endedAt, 0, 0, 0, 0, null, 'Abgebrochen'); } catch (e) {
      logger.error(`endJobRun: ${e.message}`, { job: job.type, user: job.userEmail, book: job.bookId });
    }
    runningJobs.delete(jobDedupKey(job));
    jobAbortControllers.delete(id);
    _scheduleJobCleanup(id);
    logger.info('Aus Warteschlange entfernt und abgebrochen.', _jobLogCtx(job));
    return true;
  }
  if (job.status === 'running') {
    job.cancelled = true;
    const ctrl = jobAbortControllers.get(id);
    if (ctrl) ctrl.abort();
    logger.info('Abbruch signalisiert.', _jobLogCtx(job));
    return true;
  }
  return false;
}

// ── Statistik-Konfiguration ───────────────────────────────────────────────────
// Werte sind i18n-Keys; Frontend übersetzt über t().
const JOB_TYPE_LABELS = {
  'check':            'job.label.check',
  'batch-check':      'job.label.batchCheck',
  'komplett-analyse': 'job.label.komplett',
  'review':           'job.label.review',
  'chapter-review':   'job.label.chapterReview',
  'book-chat':        'job.label.bookChat',
  'chat':             'job.label.chat',
  'synonym':          'job.label.synonym',
  'finetune-export':  'job.label.finetuneExport',
};

// Job-Typen, die vom Superjob (komplett-analyse) abgedeckt werden und nicht in der Statistik erscheinen sollen
const STATS_EXCLUDED_TYPES = ['figures', 'soziogramm', 'szenen', 'locations', 'figure-events', 'consolidate-zeitstrahl', 'kontinuitaet'];

module.exports = {
  makeJobLogger,
  fmtTok, fmtDuration, _jobDurationFmt, _jobLogCtx, tps,
  i18nError, bsHttpError,
  findActiveJobId,
  createJob, updateJob, completeJob, failJob, cancelJob,
  JOB_TYPE_LABELS, STATS_EXCLUDED_TYPES,
};
