// Tests für _onJobFinished → Job-Done-Toast.
// Whitelist-Filter, Severity-Mapping, Auto-Dismiss-Verhalten via Stub-Timer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appJobsCoreMethods } from '../../public/js/app-jobs-core.js';

function makeCtx() {
  return {
    jobToast: null,
    _jobToastTimer: null,
    currentPage: null,
    pages: [],
    pageLastChecked: {},
    markPageChecked() {},
    loadPageHistory() {},
    t: (k) => k,
    ...appJobsCoreMethods,
  };
}

test('komplett-analyse done → ok-Toast mit Label + done-Suffix', () => {
  const ctx = makeCtx();
  ctx._onJobFinished({
    type: 'komplett-analyse',
    jobId: 1,
    bookId: 42,
    job: { status: 'done' },
  });
  assert.equal(ctx.jobToast.severity, 'ok');
  assert.equal(ctx.jobToast.jobType, 'komplett-analyse');
  assert.equal(ctx.jobToast.bookId, 42);
  assert.match(ctx.jobToast.message, /toast\.job\.komplettAnalyse/);
  assert.match(ctx.jobToast.message, /toast\.job\.done/);
});

test('pdf-export error → err-Toast mit failed-Suffix', () => {
  const ctx = makeCtx();
  ctx._onJobFinished({
    type: 'pdf-export',
    jobId: 2,
    bookId: 7,
    job: { status: 'error', error: 'job.error.bookEmpty' },
  });
  assert.equal(ctx.jobToast.severity, 'err');
  assert.match(ctx.jobToast.message, /toast\.job\.pdfExport/);
  assert.match(ctx.jobToast.message, /toast\.job\.failed/);
});

test('cancelled → kein Toast', () => {
  const ctx = makeCtx();
  ctx._onJobFinished({
    type: 'komplett-analyse',
    jobId: 3,
    bookId: 1,
    job: { status: 'cancelled' },
  });
  assert.equal(ctx.jobToast, null);
});

test('type=check → kein Toast (Sidebar-Signal reicht, sonst Spam)', () => {
  const ctx = makeCtx();
  ctx._onJobFinished({
    type: 'check',
    jobId: 4,
    dedupId: 999,
    job: { status: 'done', result: { fehler: [] } },
  });
  assert.equal(ctx.jobToast, null);
});

test('unbekannter Job-Typ → kein Toast', () => {
  const ctx = makeCtx();
  ctx._onJobFinished({
    type: 'totally-new-type',
    jobId: 5,
    bookId: 1,
    job: { status: 'done' },
  });
  assert.equal(ctx.jobToast, null);
});

test('_dismissJobToast räumt State + Timer', () => {
  const ctx = makeCtx();
  ctx._onJobFinished({
    type: 'review',
    jobId: 6,
    bookId: 1,
    job: { status: 'done' },
  });
  assert.ok(ctx.jobToast);
  assert.ok(ctx._jobToastTimer);
  ctx._dismissJobToast();
  assert.equal(ctx.jobToast, null);
  assert.equal(ctx._jobToastTimer, null);
});

test('aufeinanderfolgende Toasts ersetzen sich (Timer reset)', () => {
  const ctx = makeCtx();
  ctx._onJobFinished({ type: 'review', jobId: 7, bookId: 1, job: { status: 'done' } });
  const firstTimer = ctx._jobToastTimer;
  ctx._onJobFinished({ type: 'figuren', jobId: 8, bookId: 1, job: { status: 'done' } });
  assert.notEqual(ctx._jobToastTimer, firstTimer);
  assert.equal(ctx.jobToast.jobType, 'figuren');
});

test('alle Whitelist-Typen erzeugen Toast', () => {
  const types = [
    'komplett-analyse','kontinuitaet','review','kapitel-review','figuren',
    'book-chat','finetune-export','pdf-export','batch-check',
    'werkstatt-brainstorm','werkstatt-consistency',
  ];
  for (const t of types) {
    const ctx = makeCtx();
    ctx._onJobFinished({ type: t, jobId: 1, bookId: 1, job: { status: 'done' } });
    assert.ok(ctx.jobToast, `${t} sollte Toast erzeugen`);
    assert.equal(ctx.jobToast.severity, 'ok');
  }
});
