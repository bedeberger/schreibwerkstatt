'use strict';
// Integration test: Cache für Lektorat (Single + Batch) und Synonyme.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
test.before(() => { ctx = bootstrap(); });
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.mockAi.reset();
  ctx.dbSeed.reset();
});

function lektoratResponse(errorCount = 1) {
  const fehler = [];
  for (let i = 0; i < errorCount; i++) {
    fehler.push({
      typ: 'rechtschreibung',
      original: 'fehler',
      korrektur: 'Fehler',
      erklaerung: 'Substantive werden grossgeschrieben.',
    });
  }
  return { fehler, szenen: [], stilanalyse: 'ok', fazit: 'ok' };
}

// ── Lektorat Single-Check ────────────────────────────────────────────────────

test('Lektorat-Cache: identischer Re-Run trifft lektorat_cache → 0 AI-Calls', async () => {
  const BOOK_ID = 200;
  const PAGE_ID = 2001;
  ctx.dbSeed.setBook({
    chapters: [{ id: 2010, book_id: BOOK_ID, name: 'Kap A' }],
    pages: [{ id: PAGE_ID, book_id: BOOK_ID, chapter_id: 2010, name: 'S 1', updated_at: '2026-05-01T10:00:00Z' }],
    pageBodies: { [PAGE_ID]: '<p>Anna ging in den wald.</p>' },
  });

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('fehler') && e.schemaKeys.includes('szenen'),
    lektoratResponse(2),
  );

  const jobId1 = ctx.shared.createJob('check', BOOK_ID, 'tester@test.dev', 'job.label.checkPage', null, PAGE_ID);
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.lektorat.runCheckJob(jobId1, PAGE_ID, BOOK_ID, 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job1 = await waitForJob(ctx.shared, jobId1);
  assert.equal(job1.status, 'done', `expected done, got ${job1.status}: ${job1.error || ''}`);
  assert.equal(ctx.mockAi.log.length, 1, '1. Run = 1 AI-Call');

  const cacheRow = ctx.dbSchema.db.prepare(
    'SELECT ctx_sig FROM lektorat_cache WHERE book_id = ? AND page_id = ? AND user_email = ?'
  ).get(BOOK_ID, PAGE_ID, 'tester@test.dev');
  assert.ok(cacheRow, 'lektorat_cache fehlt nach 1. Run');

  // 2. Run, gleiche Seite, gleicher updated_at → HIT.
  const jobId2 = ctx.shared.createJob('check', BOOK_ID, 'tester@test.dev', 'job.label.checkPage', null, PAGE_ID);
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.lektorat.runCheckJob(jobId2, PAGE_ID, BOOK_ID, 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job2 = await waitForJob(ctx.shared, jobId2);
  assert.equal(job2.status, 'done');
  assert.equal(ctx.mockAi.log.length, 1, '2. Run = Cache-HIT');
  assert.deepEqual(job2.result.fehler, job1.result.fehler, 'identische Fehler-Liste');
});

test('Lektorat-Cache: updated_at-Wechsel invalidiert Cache', async () => {
  const BOOK_ID = 201;
  const PAGE_ID = 2011;
  ctx.dbSeed.setBook({
    chapters: [{ id: 2020, book_id: BOOK_ID, name: 'Kap B' }],
    pages: [{ id: PAGE_ID, book_id: BOOK_ID, chapter_id: 2020, name: 'S 1', updated_at: '2026-05-01T10:00:00Z' }],
    pageBodies: { [PAGE_ID]: '<p>Test.</p>' },
  });

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('fehler') && e.schemaKeys.includes('szenen'),
    lektoratResponse(1),
  );

  const jobId1 = ctx.shared.createJob('check', BOOK_ID, 'tester@test.dev', 'job.label.checkPage', null, PAGE_ID);
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.lektorat.runCheckJob(jobId1, PAGE_ID, BOOK_ID, 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  await waitForJob(ctx.shared, jobId1);
  assert.equal(ctx.mockAi.log.length, 1);

  // Seite ändert sich.
  ctx.dbSeed.setBook({
    chapters: [{ id: 2020, book_id: BOOK_ID, name: 'Kap B' }],
    pages: [{ id: PAGE_ID, book_id: BOOK_ID, chapter_id: 2020, name: 'S 1', updated_at: '2026-05-02T11:00:00Z' }],
    pageBodies: { [PAGE_ID]: '<p>Test geändert.</p>' },
  });

  const jobId2 = ctx.shared.createJob('check', BOOK_ID, 'tester@test.dev', 'job.label.checkPage', null, PAGE_ID);
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.lektorat.runCheckJob(jobId2, PAGE_ID, BOOK_ID, 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  await waitForJob(ctx.shared, jobId2);
  assert.equal(ctx.mockAi.log.length, 2, 'updated_at-Wechsel → MISS, 2 Calls insgesamt');
});

// ── Lektorat Batch ───────────────────────────────────────────────────────────

test('Batch-Lektorat-Cache: zweiter Lauf nur für geänderte Seite', async () => {
  const BOOK_ID = 202;
  ctx.dbSeed.setBook({
    chapters: [{ id: 2030, book_id: BOOK_ID, name: 'Kap C' }],
    pages: [
      { id: 2031, book_id: BOOK_ID, chapter_id: 2030, name: 'S 1', updated_at: '2026-05-01T10:00:00Z' },
      { id: 2032, book_id: BOOK_ID, chapter_id: 2030, name: 'S 2', updated_at: '2026-05-01T10:00:00Z' },
      { id: 2033, book_id: BOOK_ID, chapter_id: 2030, name: 'S 3', updated_at: '2026-05-01T10:00:00Z' },
    ],
    pageBodies: {
      2031: '<p>Seite eins inhaltsreich.</p>',
      2032: '<p>Seite zwei inhaltsreich.</p>',
      2033: '<p>Seite drei inhaltsreich.</p>',
    },
  });

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('fehler') && e.schemaKeys.includes('szenen'),
    lektoratResponse(1),
  );

  const jobId1 = ctx.shared.createJob('batch-check', BOOK_ID, 'tester@test.dev', 'job.label.batchCheck');
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.lektorat.runBatchCheckJob(jobId1, BOOK_ID, 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job1 = await waitForJob(ctx.shared, jobId1, { timeoutMs: 8000 });
  assert.equal(job1.status, 'done');
  assert.equal(ctx.mockAi.log.length, 3, '1. Batch = 3 Seiten-Calls');

  // Eine Seite ändert sich.
  ctx.dbSeed.setBook({
    chapters: [{ id: 2030, book_id: BOOK_ID, name: 'Kap C' }],
    pages: [
      { id: 2031, book_id: BOOK_ID, chapter_id: 2030, name: 'S 1', updated_at: '2026-05-01T10:00:00Z' },
      { id: 2032, book_id: BOOK_ID, chapter_id: 2030, name: 'S 2', updated_at: '2026-05-03T12:00:00Z' },
      { id: 2033, book_id: BOOK_ID, chapter_id: 2030, name: 'S 3', updated_at: '2026-05-01T10:00:00Z' },
    ],
    pageBodies: {
      2031: '<p>Seite eins inhaltsreich.</p>',
      2032: '<p>Seite zwei NEU.</p>',
      2033: '<p>Seite drei inhaltsreich.</p>',
    },
  });

  ctx.mockAi.reset();
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('fehler') && e.schemaKeys.includes('szenen'),
    lektoratResponse(1),
  );

  const jobId2 = ctx.shared.createJob('batch-check', BOOK_ID, 'tester@test.dev', 'job.label.batchCheck');
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.lektorat.runBatchCheckJob(jobId2, BOOK_ID, 'tester@test.dev', { id: 'tok', pw: 'pw' }),
  );
  const job2 = await waitForJob(ctx.shared, jobId2, { timeoutMs: 8000 });
  assert.equal(job2.status, 'done');
  // Seite 2032 ändert sich → MISS. Seite 2033 hat 2032 als Vorseite →
  // previousExcerpt-Wechsel → ebenfalls MISS. Seite 2031 bleibt HIT.
  assert.equal(ctx.mockAi.log.length, 2, '2. Batch = 2 Calls (geänderte Seite + Nachfolger via previousExcerpt)');
});

// ── Synonym-Cache ────────────────────────────────────────────────────────────

test('Synonym-Cache: identischer Lookup → 0 AI-Calls', async () => {
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('synonyme'),
    { synonyme: [{ wort: 'Wald', hinweis: 'Forst' }, { wort: 'Hain', hinweis: '' }] },
  );

  const jobId1 = ctx.shared.createJob('synonym', 0, 'tester@test.dev', 'job.label.synonymWord', { word: 'Forst' }, 'wald|satz');
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.synonyme.runSynonymJob(jobId1, 'Wald', 'Anna ging in den Wald.', null, 'tester@test.dev'),
  );
  const job1 = await waitForJob(ctx.shared, jobId1);
  assert.equal(job1.status, 'done');
  assert.equal(ctx.mockAi.log.length, 1);
  assert.equal(job1.result.synonyme.length, 1, '"Wald" selbst rausgefiltert');

  // Cache geschrieben.
  const cacheRow = ctx.dbSchema.db.prepare(
    'SELECT key_hash FROM synonym_cache WHERE user_email = ?'
  ).get('tester@test.dev');
  assert.ok(cacheRow, 'synonym_cache fehlt');

  // 2. Lookup identische Eingaben → HIT.
  const jobId2 = ctx.shared.createJob('synonym', 0, 'tester@test.dev', 'job.label.synonymWord', { word: 'Forst' }, 'wald|satz|2');
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.synonyme.runSynonymJob(jobId2, 'Wald', 'Anna ging in den Wald.', null, 'tester@test.dev'),
  );
  const job2 = await waitForJob(ctx.shared, jobId2);
  assert.equal(job2.status, 'done');
  assert.equal(job2.result.cached, true);
  assert.equal(ctx.mockAi.log.length, 1, '2. Lookup = Cache-HIT');
});

test('Synonym-Cache: anderer Satz → MISS', async () => {
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('synonyme'),
    { synonyme: [{ wort: 'Hain', hinweis: '' }] },
  );

  const jobId1 = ctx.shared.createJob('synonym', 0, 'tester@test.dev', 'job.label.synonymWord', { word: 'A' }, 'wald|s1');
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.synonyme.runSynonymJob(jobId1, 'Wald', 'Erster Satz.', null, 'tester@test.dev'),
  );
  await waitForJob(ctx.shared, jobId1);
  assert.equal(ctx.mockAi.log.length, 1);

  const jobId2 = ctx.shared.createJob('synonym', 0, 'tester@test.dev', 'job.label.synonymWord', { word: 'B' }, 'wald|s2');
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.synonyme.runSynonymJob(jobId2, 'Wald', 'Zweiter, anderer Satz.', null, 'tester@test.dev'),
  );
  await waitForJob(ctx.shared, jobId2);
  assert.equal(ctx.mockAi.log.length, 2, 'anderer Satz → MISS');
});
