'use strict';
// Phase 0b: Backfill-Job gegen Mock-BookStack. Verifiziert:
//   - vorhandene Mager-Rows (id+name) werden mit Body-HTML/Markdown,
//     Description, Order, owner_email angereichert
//   - Idempotenz: Re-Run aktualisiert vorhandene Rows, keine Duplikate
//   - owner_email wird beim Erst-Backfill gesetzt, beim Re-Run nicht ueberschrieben
//   - FK-Reihenfolge haelt: foreign_key_check leer
//   - Einzel-Buch-Filter laeuft nur ueber das selektierte Buch
//   - leerer BookStack → result.books = 0
//
// mock-bookstack._seedDb fuellt books/chapters/pages bei setBook mit minimalen
// Rows (id + name + chapter_id), damit das createJob-FK auf books(book_id) haelt.
// Body, description, position, owner_email fehlen vor dem Backfill — genau das,
// was der Backfill nachzieht.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
test.before(() => {
  ctx = bootstrap();
  // backfill-Router fuer den shared-State (jobs Map, enqueueJob) frueh binden.
  ctx.backfill = require('../../routes/jobs/backfill');
});
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.mockBs.reset();
});

function _seedTwoBookFixture() {
  ctx.mockBs.setBook({
    books: [
      { id: 11, name: 'Buch Alpha', slug: 'alpha', description: 'erste Buch', created_at: '2024-01-01', updated_at: '2024-01-10' },
      { id: 22, name: 'Buch Beta',  slug: 'beta',  description: 'zweite Buch', created_at: '2024-02-01', updated_at: '2024-02-10' },
    ],
    chapters: [
      { id: 1100, book_id: 11, name: 'Alpha-K1', updated_at: '2024-01-05', priority: 0 },
      { id: 1101, book_id: 11, name: 'Alpha-K2', updated_at: '2024-01-06', priority: 1 },
      { id: 2200, book_id: 22, name: 'Beta-K1',  updated_at: '2024-02-05', priority: 0 },
    ],
    pages: [
      { id: 1200, book_id: 11, chapter_id: 1100, name: 'Alpha-Seite-1', updated_at: '2024-01-07', priority: 0 },
      { id: 1201, book_id: 11, chapter_id: 1101, name: 'Alpha-Seite-2', updated_at: '2024-01-08', priority: 1 },
      { id: 2300, book_id: 22, chapter_id: 2200, name: 'Beta-Seite-1',  updated_at: '2024-02-07', priority: 0 },
    ],
    pageBodies: {
      1200: '<p>Alpha-Seite-1 Body</p>',
      1201: '<p>Alpha-Seite-2 Body</p>',
      2300: '<p>Beta-Seite-1 Body</p>',
    },
  });
}

test('Backfill: Body-HTML, Description, Order, owner_email landen in DB', async () => {
  _seedTwoBookFixture();
  const { db } = ctx.dbSchema;

  const jobId = ctx.shared.createJob('backfill', 0, 'alice@example.com', 'job.label.backfillAll', null, 'user:alice:1');
  ctx.shared.enqueueJob(jobId, () => ctx.backfill.runBackfillJob(jobId, 'alice@example.com', { id: 'tok', pw: 'pw' }));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });

  assert.equal(job.status, 'done', `job failed: ${job.error || ''}`);
  assert.equal(job.result.books, 2);
  assert.equal(job.result.chapters, 3);
  assert.equal(job.result.pages, 3);

  const books = db.prepare('SELECT book_id, name, description, owner_email FROM books WHERE book_id IN (11,22) ORDER BY book_id').all();
  assert.deepEqual(books.map(b => b.book_id), [11, 22]);
  assert.equal(books[0].owner_email, 'alice@example.com');
  assert.equal(books[0].description, 'erste Buch');

  const chapters = db.prepare('SELECT chapter_id, position, priority, slug FROM chapters WHERE chapter_id IN (1100,1101,2200) ORDER BY chapter_id').all();
  assert.equal(chapters.length, 3);
  assert.equal(chapters[0].position, 0);
  assert.equal(chapters[1].position, 1);
  assert.equal(chapters[1].priority, 1);

  const pages = db.prepare('SELECT page_id, body_html, remote_updated_at, local_updated_at, dirty FROM pages WHERE page_id IN (1200,1201,2300) ORDER BY page_id').all();
  assert.equal(pages.length, 3);
  assert.match(pages[0].body_html, /Alpha-Seite-1 Body/);
  assert.equal(pages[0].remote_updated_at, '2024-01-07');
  assert.equal(pages[0].local_updated_at, '2024-01-07');
  assert.equal(pages[0].dirty, 0);

  assert.equal(db.pragma('foreign_key_check').length, 0, 'foreign_key_check muss leer sein');
});

test('Re-Run ist idempotent: keine Duplikate, body bleibt befuellt', async () => {
  _seedTwoBookFixture();
  const { db } = ctx.dbSchema;

  const job1 = ctx.shared.createJob('backfill', 0, 'alice@example.com', 'job.label.backfillAll', null, 'user:alice:rr1');
  ctx.shared.enqueueJob(job1, () => ctx.backfill.runBackfillJob(job1, 'alice@example.com', { id: 'tok', pw: 'pw' }));
  await waitForJob(ctx.shared, job1, { timeoutMs: 10000 });

  const job2 = ctx.shared.createJob('backfill', 0, 'alice@example.com', 'job.label.backfillAll', null, 'user:alice:rr2');
  ctx.shared.enqueueJob(job2, () => ctx.backfill.runBackfillJob(job2, 'alice@example.com', { id: 'tok', pw: 'pw' }));
  const job = await waitForJob(ctx.shared, job2, { timeoutMs: 10000 });
  assert.equal(job.status, 'done');

  // Row-Counts unveraendert
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM books    WHERE book_id IN (11,22)').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM chapters WHERE chapter_id IN (1100,1101,2200)').get().c, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM pages    WHERE page_id IN (1200,1201,2300)').get().c, 3);

  const p = db.prepare('SELECT body_html FROM pages WHERE page_id = 1200').get();
  assert.match(p.body_html, /Alpha-Seite-1 Body/);
});

test('owner_email beim Re-Run von anderem User wird nicht ueberschrieben', async () => {
  _seedTwoBookFixture();
  const { db } = ctx.dbSchema;

  // Lauf 1: alice wird Owner.
  const job1 = ctx.shared.createJob('backfill', 0, 'alice@example.com', 'job.label.backfillAll', null, 'user:alice:owner1');
  ctx.shared.enqueueJob(job1, () => ctx.backfill.runBackfillJob(job1, 'alice@example.com', { id: 'tok', pw: 'pw' }));
  await waitForJob(ctx.shared, job1, { timeoutMs: 10000 });

  // Lauf 2: bob backfilled dieselben Buecher.
  const job2 = ctx.shared.createJob('backfill', 0, 'bob@example.com', 'job.label.backfillAll', null, 'user:bob:owner2');
  ctx.shared.enqueueJob(job2, () => ctx.backfill.runBackfillJob(job2, 'bob@example.com', { id: 'tok', pw: 'pw' }));
  await waitForJob(ctx.shared, job2, { timeoutMs: 10000 });

  const books = db.prepare('SELECT book_id, owner_email FROM books WHERE book_id IN (11,22) ORDER BY book_id').all();
  assert.equal(books[0].owner_email, 'alice@example.com', 'owner_email darf bei Re-Run nicht ueberschrieben werden');
  assert.equal(books[1].owner_email, 'alice@example.com');
});

test('Einzel-Buch-Filter: nur das selektierte Buch wird gebackfilled', async () => {
  _seedTwoBookFixture();
  const { db } = ctx.dbSchema;

  // Vor-Snapshot: Buch 22 hat noch keine description / kein owner_email.
  const before22 = db.prepare('SELECT description, owner_email FROM books WHERE book_id = 22').get();
  assert.equal(before22.description, null);
  assert.equal(before22.owner_email, null);

  const jobId = ctx.shared.createJob('backfill', 11, 'alice@example.com', 'job.label.backfillBook', { bookId: 11 }, 'user:alice:filter11');
  ctx.shared.enqueueJob(jobId, () => ctx.backfill.runBackfillJob(jobId, 'alice@example.com', { id: 'tok', pw: 'pw' }, { bookIdFilter: 11 }));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });

  assert.equal(job.status, 'done', `job failed: ${job.error || ''}`);
  assert.equal(job.result.books, 1);
  assert.equal(job.result.pages, 2);

  // Buch 11 ist angereichert
  const after11 = db.prepare('SELECT description, owner_email FROM books WHERE book_id = 11').get();
  assert.equal(after11.owner_email, 'alice@example.com');
  assert.equal(after11.description, 'erste Buch');

  // Buch 22 unveraendert (kein Owner, keine description)
  const after22 = db.prepare('SELECT description, owner_email FROM books WHERE book_id = 22').get();
  assert.equal(after22.description, null);
  assert.equal(after22.owner_email, null);

  // Seiten aus Buch 22 haben keinen body_html bekommen
  const page22 = db.prepare('SELECT body_html FROM pages WHERE page_id = 2300').get();
  assert.equal(page22.body_html, null);
});

test('Leerer BookStack: result.books = 0, kein Throw', async () => {
  ctx.mockBs.setBook({ books: [], chapters: [], pages: [], pageBodies: {} });

  const jobId = ctx.shared.createJob('backfill', 0, 'alice@example.com', 'job.label.backfillAll', null, 'user:alice:empty');
  ctx.shared.enqueueJob(jobId, () => ctx.backfill.runBackfillJob(jobId, 'alice@example.com', { id: 'tok', pw: 'pw' }));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });

  assert.equal(job.status, 'done');
  assert.equal(job.result.books, 0);
  assert.equal(job.result.chapters, 0);
  assert.equal(job.result.pages, 0);
});
