'use strict';
// Integration: HubSpot-Initial-Import + Push-Job gegen Mock-HubSpot.
// Buchtyp 'blog' Pflicht; sonst HUBSPOT_REQUIRES_BLOG_TYPE.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-1234567890abcdef';

const { bootstrap, waitForJob } = require('./_helpers/setup');
const { makeMock } = require('./_helpers/mock-hubspot');

let ctx;
let mock;
let hubspot;
let hubspotSync;

test.before(() => {
  ctx = bootstrap();
  hubspot = require('../../db/hubspot');
  hubspotSync = require('../../routes/jobs/hubspot-sync');
});
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.dbSeed.reset();
  mock = makeMock();
});
test.afterEach(() => { mock.restore(); });

function seedBlogBook(bookId) {
  ctx.dbSeed.setBook({
    books: [{ id: bookId, name: `Test-Book-${bookId}` }],
    chapters: [], pages: [], pageBodies: {},
  });
  ctx.dbSchema.saveBookSettings(bookId, 'de', 'CH', 'blog', '', null, null, 0, 0, 1500);
}

test('hubspot-import: zwei PUBLISHED-Posts → Pages + Jahres-Kapitel + Link-Eintraege', async () => {
  const BOOK_ID = 70;
  seedBlogBook(BOOK_ID);
  hubspot.upsertConnection({ bookId: BOOK_ID, token: 'pat-x', blogId: '555', authorId: '111' });
  mock.state.posts = [
    {
      id: '1001', htmlTitle: 'Erster Beitrag', name: 'Erster Beitrag',
      publishDate: '2024-03-15T10:00:00.000Z', state: 'PUBLISHED',
      postBody: '<p>Hallo Welt</p><img src="https://x/foo.png">',
    },
    {
      id: '1002', htmlTitle: 'Zweiter Beitrag', name: 'Zweiter Beitrag',
      publishDate: '2025-01-02T10:00:00.000Z', state: 'PUBLISHED',
      postBody: '<p>Mehr Text</p>',
    },
  ];

  const jobId = ctx.shared.createJob('hubspot-import', BOOK_ID, 'tester@test.dev', 'job.label.hubspotImport');
  ctx.shared.enqueueJob(jobId, () => hubspotSync.runHubspotImportJob(jobId, BOOK_ID, 'tester@test.dev'));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 6000 });
  assert.equal(job.status, 'done', `got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.imported, 2);

  const conn = hubspot.getConnection(BOOK_ID);
  assert.match(conn.initialImportDoneAt, /^\d{4}-/);

  const pages = ctx.dbSchema.db.prepare('SELECT page_id, page_name, chapter_id FROM pages WHERE book_id = ?').all(BOOK_ID);
  assert.equal(pages.length, 2);
  const names = pages.map(p => p.page_name).sort();
  assert.match(names[0], /^2024-03-15:/);
  assert.match(names[1], /^2025-01-02:/);

  const chapters = ctx.dbSchema.db.prepare('SELECT chapter_name FROM chapters WHERE book_id = ?').all(BOOK_ID);
  const chNames = chapters.map(c => c.chapter_name).sort();
  assert.deepEqual(chNames, ['2024', '2025']);

  // Bild im Body wurde gestrippt.
  const body = ctx.dbSchema.db.prepare('SELECT body_html FROM pages WHERE page_id = ?').get(pages[0].page_id);
  assert.doesNotMatch(body.body_html, /<img/);

  // Link-Eintraege existieren.
  const links = hubspot.listLinksForConnection(conn.id);
  assert.equal(links.length, 2);

  // Import setzt last_pushed_at als Sync-Baseline auf den Anlage-Zeitpunkt der
  // Page → Status direkt nach Import ist 'pushed', nicht 'pushed-dirty'.
  for (const link of links) {
    assert.ok(link.last_pushed_at, 'last_pushed_at muss nach Import gesetzt sein');
    const page = ctx.dbSchema.db.prepare('SELECT updated_at FROM pages WHERE page_id = ?').get(link.page_id);
    assert.ok(page.updated_at <= link.last_pushed_at, 'page.updated_at darf nicht ueber der Baseline liegen');
  }
});

test('hubspot-import: bereits importiert → HUBSPOT_ALREADY_IMPORTED', async () => {
  const BOOK_ID = 71;
  seedBlogBook(BOOK_ID);
  hubspot.upsertConnection({ bookId: BOOK_ID, token: 'pat-x', blogId: '555', authorId: '111' });
  hubspot.markInitialImportDone(hubspot.getConnection(BOOK_ID).id);

  const jobId = ctx.shared.createJob('hubspot-import', BOOK_ID, 'tester@test.dev', 'job.label.hubspotImport');
  ctx.shared.enqueueJob(jobId, () => hubspotSync.runHubspotImportJob(jobId, BOOK_ID, 'tester@test.dev'));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 4000 });
  assert.equal(job.status, 'error');
  assert.match(String(job.error || ''), /HUBSPOT_ALREADY_IMPORTED/);
});

test('hubspot-push: Erst-Push erstellt Draft + Link; Re-Push aktualisiert den Buffer (PATCH /draft)', async () => {
  const BOOK_ID = 72;
  seedBlogBook(BOOK_ID);
  hubspot.upsertConnection({ bookId: BOOK_ID, token: 'pat-x', blogId: '555', authorId: '111' });

  const contentStore = require('../../lib/content-store');
  const page = await contentStore.createPage(
    { book_id: BOOK_ID, name: 'Mein Eintrag', html: '<p>Inhalt</p>' },
    null,
  );

  const jobId = ctx.shared.createJob('hubspot-push', BOOK_ID, 'tester@test.dev', 'job.label.hubspotPushCount', { count: 1 });
  ctx.shared.enqueueJob(jobId, () => hubspotSync.runHubspotPushJob(jobId, BOOK_ID, 'tester@test.dev', [page.id]));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 4000 });
  assert.equal(job.status, 'done', `got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.pushed, 1);
  assert.equal(mock.state.created.length, 1);
  assert.equal(mock.state.created[0].state, 'DRAFT');
  assert.equal(mock.state.created[0].contentGroupId, '555');
  assert.equal(mock.state.created[0].blogAuthorId, '111');
  assert.equal(mock.state.created[0].authorName, 'Autor Eins');

  const link = hubspot.getLinkByPage(page.id);
  assert.ok(link);
  assert.equal(link.hubspot_state, 'DRAFT');
  const firstPostId = link.hubspot_post_id;
  const firstPushedAt = link.last_pushed_at;
  assert.ok(firstPushedAt);

  // Page lokal ändern → Re-Push aktualisiert den Buffer via PATCH …/draft.
  await new Promise(r => setTimeout(r, 30)); // sicherstellen, dass updated_at > last_pushed_at
  await contentStore.savePage(page.id, { html: '<p>Geänderter Inhalt</p>' }, null);

  const jobId2 = ctx.shared.createJob('hubspot-push', BOOK_ID, 'tester@test.dev', 'job.label.hubspotPushCount', { count: 1 });
  ctx.shared.enqueueJob(jobId2, () => hubspotSync.runHubspotPushJob(jobId2, BOOK_ID, 'tester@test.dev', [page.id]));
  const job2 = await waitForJob(ctx.shared, jobId2, { timeoutMs: 4000 });
  assert.equal(job2.status, 'done', `got ${job2.status}: ${job2.error || ''}`);
  assert.equal(job2.result.pushed, 1);
  assert.equal(job2.result.errors.length, 0);
  // Kein zweiter create — PATCH statt POST.
  assert.equal(mock.state.created.length, 1);
  assert.equal(mock.state.updated.length, 1);
  assert.equal(mock.state.updated[0].id, firstPostId);
  assert.match(mock.state.updated[0].postBody, /Geänderter/);

  // Link bleibt auf derselben Post-ID, last_pushed_at wurde aktualisiert.
  const link2 = hubspot.getLinkByPage(page.id);
  assert.equal(link2.hubspot_post_id, firstPostId);
  assert.notEqual(link2.last_pushed_at, firstPushedAt);
});

test('hubspot-push: Buchtyp != blog → HUBSPOT_REQUIRES_BLOG_TYPE', async () => {
  const BOOK_ID = 73;
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: `Test-Book-${BOOK_ID}` }],
    chapters: [], pages: [], pageBodies: {},
  });
  ctx.dbSchema.saveBookSettings(BOOK_ID, 'de', 'CH', 'roman', '', null, null, 0, 0, 1500);

  const jobId = ctx.shared.createJob('hubspot-push', BOOK_ID, 'tester@test.dev', 'job.label.hubspotPushCount', { count: 1 });
  ctx.shared.enqueueJob(jobId, () => hubspotSync.runHubspotPushJob(jobId, BOOK_ID, 'tester@test.dev', [1]));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 4000 });
  assert.equal(job.status, 'error');
  assert.match(String(job.error || ''), /HUBSPOT_REQUIRES_BLOG_TYPE/);
});
