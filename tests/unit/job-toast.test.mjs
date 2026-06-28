// Tests für _onJobFinished → Job-Done-Toast.
// Whitelist-Filter, Severity-Mapping, Auto-Dismiss-Verhalten via Stub-Timer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appJobsCoreMethods } from '../../public/js/app/app-jobs-core.js';

function makeCtx() {
  return {
    // jobToast/_jobToastTimer/_toastedJobIds leben in Alpine.store('jobs');
    // im Unit-Test ein Plain-Stub, da die Methoden via this.$store.jobs zugreifen.
    $store: { jobs: { jobToast: null, _jobToastTimer: null, _toastedJobIds: new Set() } },
    currentPage: null,
    pages: [],
    pageLastChecked: {},
    selectedBookId: null,
    refreshAgesCalls: 0,
    markPageChecked() {},
    loadPageHistory() {},
    refreshPageAges() { this.refreshAgesCalls++; },
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
  assert.equal(ctx.$store.jobs.jobToast.severity, 'ok');
  assert.equal(ctx.$store.jobs.jobToast.jobType, 'komplett-analyse');
  assert.equal(ctx.$store.jobs.jobToast.bookId, 42);
  assert.match(ctx.$store.jobs.jobToast.message, /toast\.job\.komplettAnalyse/);
  assert.match(ctx.$store.jobs.jobToast.message, /toast\.job\.done/);
});

test('pdf-export error → err-Toast mit failed-Suffix', () => {
  const ctx = makeCtx();
  ctx._onJobFinished({
    type: 'pdf-export',
    jobId: 2,
    bookId: 7,
    job: { status: 'error', error: 'job.error.bookEmpty' },
  });
  assert.equal(ctx.$store.jobs.jobToast.severity, 'err');
  assert.match(ctx.$store.jobs.jobToast.message, /toast\.job\.pdfExport/);
  assert.match(ctx.$store.jobs.jobToast.message, /toast\.job\.failed/);
});

test('cancelled → kein Toast', () => {
  const ctx = makeCtx();
  ctx._onJobFinished({
    type: 'komplett-analyse',
    jobId: 3,
    bookId: 1,
    job: { status: 'cancelled' },
  });
  assert.equal(ctx.$store.jobs.jobToast, null);
});

test('type=check done → ok-Toast', () => {
  const ctx = makeCtx();
  ctx._onJobFinished({
    type: 'check',
    jobId: 4,
    dedupId: 999,
    job: { status: 'done', result: { fehler: [] } },
  });
  assert.equal(ctx.$store.jobs.jobToast.severity, 'ok');
  assert.equal(ctx.$store.jobs.jobToast.jobType, 'check');
  assert.match(ctx.$store.jobs.jobToast.message, /toast\.job\.check/);
});

test('unbekannter Job-Typ → kein Toast', () => {
  const ctx = makeCtx();
  ctx._onJobFinished({
    type: 'totally-new-type',
    jobId: 5,
    bookId: 1,
    job: { status: 'done' },
  });
  assert.equal(ctx.$store.jobs.jobToast, null);
});

test('_dismissJobToast räumt State + Timer', () => {
  const ctx = makeCtx();
  ctx._onJobFinished({
    type: 'review',
    jobId: 6,
    bookId: 1,
    job: { status: 'done' },
  });
  assert.ok(ctx.$store.jobs.jobToast);
  assert.ok(ctx.$store.jobs._jobToastTimer);
  ctx._dismissJobToast();
  assert.equal(ctx.$store.jobs.jobToast, null);
  assert.equal(ctx.$store.jobs._jobToastTimer, null);
});

test('aufeinanderfolgende Toasts ersetzen sich (Timer reset)', () => {
  const ctx = makeCtx();
  ctx._onJobFinished({ type: 'review', jobId: 7, bookId: 1, job: { status: 'done' } });
  const firstTimer = ctx.$store.jobs._jobToastTimer;
  ctx._onJobFinished({ type: 'pdf-export', jobId: 8, bookId: 1, job: { status: 'done' } });
  assert.notEqual(ctx.$store.jobs._jobToastTimer, firstTimer);
  assert.equal(ctx.$store.jobs.jobToast.jobType, 'pdf-export');
});

test('check done im aktuellen Buch → refreshPageAges + markPageChecked', () => {
  const ctx = makeCtx();
  ctx.selectedBookId = '42';
  let marked = null;
  ctx.markPageChecked = (pageId, opts) => { marked = { pageId, opts }; };
  ctx._onJobFinished({
    type: 'check', jobId: 20, dedupId: 7, bookId: 42,
    job: { status: 'done', result: { fehler: [{ typ: 'rechtschreibung' }] } },
  });
  assert.equal(ctx.refreshAgesCalls, 1);
  assert.deepEqual(marked, { pageId: 7, opts: { pending: true } });
});

test('check done in anderem Buch → kein refreshPageAges (markPageChecked trotzdem)', () => {
  const ctx = makeCtx();
  ctx.selectedBookId = '42';
  let marked = false;
  ctx.markPageChecked = () => { marked = true; };
  ctx._onJobFinished({
    type: 'check', jobId: 21, dedupId: 7, bookId: 99,
    job: { status: 'done', result: { fehler: [] } },
  });
  assert.equal(ctx.refreshAgesCalls, 0);
  assert.equal(marked, true);
});

test('batch-check done im aktuellen Buch → refreshPageAges', () => {
  const ctx = makeCtx();
  ctx.selectedBookId = '42';
  ctx._onJobFinished({
    type: 'batch-check', jobId: 10, bookId: 42, job: { status: 'done' },
  });
  assert.equal(ctx.refreshAgesCalls, 1);
});

test('batch-check done in anderem Buch → kein refreshPageAges', () => {
  const ctx = makeCtx();
  ctx.selectedBookId = '42';
  ctx._onJobFinished({
    type: 'batch-check', jobId: 11, bookId: 99, job: { status: 'done' },
  });
  assert.equal(ctx.refreshAgesCalls, 0);
});

test('batch-check error → kein refreshPageAges', () => {
  const ctx = makeCtx();
  ctx.selectedBookId = '42';
  ctx._onJobFinished({
    type: 'batch-check', jobId: 12, bookId: 42, job: { status: 'error', error: 'foo' },
  });
  assert.equal(ctx.refreshAgesCalls, 0);
});

test('derselbe Job toastet genau einmal (Dedup per-Card-Poller + Queue-Diff)', () => {
  const ctx = makeCtx();
  // per-Card-Poller-Pfad: Job hat eine echte id
  ctx._maybeShowJobToast({ type: 'review', job: { id: 'job-xyz', status: 'done' }, bookId: 1 });
  assert.ok(ctx.$store.jobs.jobToast);
  ctx._dismissJobToast();
  // Queue-Diff-Pfad für denselben Job (jobId == job.id) → kein zweiter Toast
  ctx._onJobFinished({ type: 'review', jobId: 'job-xyz', bookId: 1, job: { id: 'job-xyz', status: 'done' } });
  assert.equal(ctx.$store.jobs.jobToast, null);
});

test('neue Whitelist-Typen (book-import, epub-export, geocode-resolve) toasten', () => {
  for (const t of ['book-import', 'epub-export', 'geocode-resolve']) {
    const ctx = makeCtx();
    ctx._onJobFinished({ type: t, jobId: 1, bookId: 1, job: { status: 'done' } });
    assert.ok(ctx.$store.jobs.jobToast, `${t} sollte Toast erzeugen`);
    assert.equal(ctx.$store.jobs.jobToast.severity, 'ok');
  }
});

test('alle Whitelist-Typen erzeugen Toast', () => {
  const types = [
    'komplett-analyse','kontinuitaet','review','chapter-review','check',
    'book-chat','finetune-export','pdf-export','batch-check',
    'werkstatt-brainstorm','werkstatt-consistency',
    'book-import','epub-export','geocode-resolve',
  ];
  for (const t of types) {
    const ctx = makeCtx();
    ctx._onJobFinished({ type: t, jobId: 1, bookId: 1, job: { status: 'done' } });
    assert.ok(ctx.$store.jobs.jobToast, `${t} sollte Toast erzeugen`);
    assert.equal(ctx.$store.jobs.jobToast.severity, 'ok');
  }
});
