'use strict';
// notify: drei fire-and-forget-Mailer-Pfade fuer Job-Crash, Token-Cap und
// Budget-Overrun. Aufrufer (failJob/completeJob/chat-send) duerfen blockieren
// nicht — alle Funktionen swallowen interne Fehler in den Logger.
//
// Throttle:
//   Job-Crash/Token-Cap: in-memory Map<dedupKey, lastSentMs>, Fenster aus
//     mail.notify.job_fail_throttle_min (default 60 min). Restart resettet —
//     im Worst-Case 1 Extra-Mail pro Restart pro Fehler, akzeptabel.
//   Budget-Overrun: persistent via budget_alerts (PK email+period), ein
//     Eintrag pro Monat.

const logger = require('../logger');
const mailer = require('./mailer');
const appSettings = require('./app-settings');
const appUsers = require('../db/app-users');
const books = require('../db/books');
const budgetAlerts = require('../db/budget-alerts');
const { checkBudget } = require('./budget');

const _crashThrottle = new Map();
const DEFAULT_SKIP_ERRORS = [
  'job.cancelled',
  'BUDGET_EXCEEDED',
  'job.error.aiTruncated',
  'job.error.parseFailed',
  'job.error.aiInvalidJson',
];

function _skipErrorSet() {
  const raw = appSettings.get('mail.notify.skip_errors');
  if (!raw || typeof raw !== 'string') return new Set(DEFAULT_SKIP_ERRORS);
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  return new Set(list.length ? list : DEFAULT_SKIP_ERRORS);
}

function _isHttp4xx(status) {
  return Number.isInteger(status) && status >= 400 && status < 500;
}

function _shouldSkip(errorMsg, httpStatus) {
  if (!errorMsg) return true;
  if (_isHttp4xx(httpStatus)) return true;
  const skipSet = _skipErrorSet();
  if (skipSet.has(errorMsg)) return true;
  for (const key of skipSet) {
    if (key && errorMsg.includes(key)) return true;
  }
  return false;
}

function _throttleMs() {
  const min = Number(appSettings.get('mail.notify.job_fail_throttle_min'));
  return (Number.isFinite(min) && min > 0 ? min : 60) * 60_000;
}

function _underThrottle(key) {
  const now = Date.now();
  const last = _crashThrottle.get(key);
  if (last && now - last < _throttleMs()) return true;
  _crashThrottle.set(key, now);
  return false;
}

function _fmtDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return '—';
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function _ctxFromJob(job, errorMsg) {
  const bookName = job.bookId ? (books.getBookName(job.bookId) || '—') : '—';
  return {
    jobType:   job.type,
    jobId:     job.id,
    userEmail: job.userEmail || '—',
    bookId:    job.bookId || '—',
    bookName,
    errorMsg:  errorMsg || job.error || '—',
    provider:  job.provider || '—',
    model:     job.model || '—',
    tokensIn:  job.tokensIn || 0,
    tokensOut: job.tokensOut || 0,
    duration:  _fmtDuration(job.startedAt, job.endedAt),
  };
}

async function _sendToMany(recipients, template, ctx) {
  for (const email of recipients) {
    const u = appUsers.getUser(email);
    const locale = (u && u.language) || 'de';
    try {
      await mailer.send({ to: email, template, ctx, locale });
    } catch (e) {
      logger.warn(`notify ${template} to=${email}: ${e.message}`);
    }
  }
}

async function maybeNotifyJobFailed(job, errorMsg, httpStatus = null) {
  if (!appSettings.get('mail.notify.admin_on_job_fail')) return;
  if (_shouldSkip(errorMsg, httpStatus)) return;
  const dedupKey = `${job.type}:${(errorMsg || '').slice(0, 80)}`;
  if (_underThrottle(dedupKey)) return;
  const admins = appUsers.getActiveAdminEmails();
  if (!admins.length) return;
  await _sendToMany(admins, 'job-failed-admin', _ctxFromJob(job, errorMsg));
}

async function maybeNotifyTokenCapHit(job, errorMsg) {
  if (!appSettings.get('mail.notify.admin_on_token_cap')) return;
  const dedupKey = `token-cap:${job.type}`;
  if (_underThrottle(dedupKey)) return;
  const admins = appUsers.getActiveAdminEmails();
  if (!admins.length) return;
  const ctx = _ctxFromJob(job, errorMsg);
  ctx.maxTokens = Number(appSettings.get('ai.claude.max_tokens_out')) || 64000;
  await _sendToMany(admins, 'token-cap-hit-admin', ctx);
}

function _fmtUsd(n) {
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

async function maybeNotifyBudgetOverrun(userEmail) {
  if (!userEmail) return;
  let status;
  try { status = checkBudget(userEmail); }
  catch (e) { logger.warn(`notify budget checkBudget(${userEmail}): ${e.message}`); return; }
  if (!status.overrun) return;
  const period = budgetAlerts.currentPeriodUtc();
  if (budgetAlerts.wasSent(userEmail, period)) return;
  if (!budgetAlerts.markSent(userEmail, period)) return;

  const ctx = {
    userEmail,
    period,
    usd:    _fmtUsd(status.usd),
    budget: _fmtUsd(status.budget),
    mode:   status.mode,
  };

  if (appSettings.get('mail.notify.user_on_budget_overrun')) {
    await _sendToMany([userEmail], 'budget-overrun-user', ctx);
  }
  if (appSettings.get('mail.notify.admin_on_budget_overrun')) {
    const admins = appUsers.getActiveAdminEmails().filter(e => e !== userEmail);
    if (admins.length) await _sendToMany(admins, 'budget-overrun-admin', ctx);
  }
}

function _resetThrottleForTests() {
  _crashThrottle.clear();
}

module.exports = {
  maybeNotifyJobFailed,
  maybeNotifyTokenCapHit,
  maybeNotifyBudgetOverrun,
  _resetThrottleForTests,
  DEFAULT_SKIP_ERRORS,
};
