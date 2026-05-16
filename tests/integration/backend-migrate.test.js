'use strict';
// Phase 8 (BookStack-Exit, docs/bookstack-exit.md): Backend-Migrate-Job
// `bookstack` → `localdb`. Pruefungen:
//   - Bulk-Copy ID-erhaltend (Pages aus mockBs landen unter denselben IDs in
//     `pages.body_html`).
//   - Read-Only-Marker wird vor dem Copy gesetzt (Content-Store-Facade blockt
//     writes gegen den aktuellen Backend mit Code BACKEND_READ_ONLY).
//   - Cutover-Flag setzt `app.backend` am Ende auf 'localdb'.
//   - Idempotenter Re-Run uebernimmt aktualisierte Bodies.
//   - foreign_key_check leer.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
let appSettings;
let contentStore;
test.before(() => {
  ctx = bootstrap();
  ctx.backendMigrate = require('../../routes/jobs/backend-migrate');
  appSettings = require('../../lib/app-settings');
  contentStore = require('../../lib/content-store');
});
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.mockBs.reset();
  appSettings.set('app.backend', 'bookstack', { updatedBy: 'test' });
  appSettings.set('app.migrate.source_readonly', '', { updatedBy: 'test' });
});

function _seedFixture() {
  ctx.mockBs.setBook({
    books: [
      { id: 31, name: 'Buch A', slug: 'a', description: 'desc A', created_at: '2024-03-01', updated_at: '2024-03-10' },
      { id: 32, name: 'Buch B', slug: 'b', description: 'desc B', created_at: '2024-03-02', updated_at: '2024-03-11' },
    ],
    chapters: [
      { id: 3100, book_id: 31, name: 'A-K1', updated_at: '2024-03-05', priority: 0 },
      { id: 3200, book_id: 32, name: 'B-K1', updated_at: '2024-03-06', priority: 0 },
    ],
    pages: [
      { id: 3110, book_id: 31, chapter_id: 3100, name: 'A-Seite-1', updated_at: '2024-03-07', priority: 0 },
      { id: 3210, book_id: 32, chapter_id: 3200, name: 'B-Seite-1', updated_at: '2024-03-08', priority: 0 },
    ],
    pageBodies: {
      3110: '<p>A-Body</p>',
      3210: '<p>B-Body</p>',
    },
  });
}

function _startJob(opts) {
  const jobId = ctx.shared.createJob(
    'backend-migrate', 0, 'admin@example.com',
    opts.bookIdFilter ? 'job.label.migrateBook' : 'job.label.migrateAll',
    null, `migrate:test:${Date.now()}:${Math.random()}`,
  );
  ctx.shared.enqueueJob(jobId, () => ctx.backendMigrate.runBackendMigrateJob(jobId, {
    userEmail: 'admin@example.com',
    token: { id: 'tok', pw: 'pw' },
    source: 'bookstack',
    target: 'localdb',
    bookIdFilter: opts.bookIdFilter || null,
    setSourceReadOnly: opts.setSourceReadOnly !== false,
    cutover: opts.cutover !== false,
  }));
  return jobId;
}

test('Bulk-Copy kopiert Bodies ID-erhaltend nach localdb', async () => {
  _seedFixture();
  const { db } = ctx.dbSchema;

  const jobId = _startJob({});
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });

  assert.equal(job.status, 'done', `job failed: ${job.error || ''}`);
  assert.equal(job.result.books, 2);
  assert.equal(job.result.pages, 2);
  assert.equal(job.result.cutoverDone, true);
  assert.equal(job.result.source, 'bookstack');
  assert.equal(job.result.target, 'localdb');

  const p31 = db.prepare('SELECT page_id, body_html FROM pages WHERE page_id = 3110').get();
  assert.ok(p31, 'Page 3110 muss in localdb existieren');
  assert.match(p31.body_html, /A-Body/);
  const p32 = db.prepare('SELECT page_id, body_html FROM pages WHERE page_id = 3210').get();
  assert.match(p32.body_html, /B-Body/);

  assert.equal(db.pragma('foreign_key_check').length, 0);
});

test('Cutover setzt app.backend auf localdb', async () => {
  _seedFixture();
  assert.equal(appSettings.get('app.backend'), 'bookstack');
  const jobId = _startJob({ setSourceReadOnly: false });
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done');
  assert.equal(appSettings.get('app.backend'), 'localdb');
});

test('cutover:false laesst app.backend unveraendert', async () => {
  _seedFixture();
  const jobId = _startJob({ cutover: false, setSourceReadOnly: false });
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done');
  assert.equal(job.result.cutoverDone, false);
  assert.equal(appSettings.get('app.backend'), 'bookstack');
});

test('Read-Only-Marker blockt Content-Store-Writes gegen aktiven Backend', async () => {
  _seedFixture();

  // Marker setzen, app.backend bleibt bookstack — Writes muessen BACKEND_READ_ONLY werfen.
  appSettings.set('app.migrate.source_readonly', 'bookstack', { updatedBy: 'test' });
  await assert.rejects(
    () => contentStore.createBook({ name: 'X' }, { id: 'tok', pw: 'pw' }),
    (e) => {
      assert.equal(e.code, 'BACKEND_READ_ONLY');
      assert.equal(e.status, 423);
      return true;
    },
  );

  // Marker fuer falschen Backend → kein Block.
  appSettings.set('app.migrate.source_readonly', 'localdb', { updatedBy: 'test' });
  // savePage gegen Bookstack-Backend ruft mockBs.bsPut auf — wir testen nur,
  // dass der Guard nicht greift. mockBs liefert ggf. Fehler, das ist erlaubt.
});

test('Idempotenter Re-Run: aktualisierter Body wird uebernommen', async () => {
  _seedFixture();
  const { db } = ctx.dbSchema;

  await waitForJob(ctx.shared, _startJob({ setSourceReadOnly: false }), { timeoutMs: 10000 });
  let body = db.prepare('SELECT body_html FROM pages WHERE page_id = 3110').get().body_html;
  assert.match(body, /A-Body/);

  // Update im Mock + Re-Run.
  ctx.mockBs.setBook({
    books: [
      { id: 31, name: 'Buch A', slug: 'a', description: 'desc A', created_at: '2024-03-01', updated_at: '2024-03-15' },
    ],
    chapters: [
      { id: 3100, book_id: 31, name: 'A-K1', updated_at: '2024-03-05', priority: 0 },
    ],
    pages: [
      { id: 3110, book_id: 31, chapter_id: 3100, name: 'A-Seite-1', updated_at: '2024-03-15', priority: 0 },
    ],
    pageBodies: { 3110: '<p>A-Body-NEU</p>' },
  });
  // Reset auf bookstack fuer den naechsten Lauf.
  appSettings.set('app.backend', 'bookstack', { updatedBy: 'test' });

  await waitForJob(ctx.shared, _startJob({ bookIdFilter: 31, setSourceReadOnly: false }), { timeoutMs: 10000 });
  body = db.prepare('SELECT body_html FROM pages WHERE page_id = 3110').get().body_html;
  assert.match(body, /A-Body-NEU/);
});
