'use strict';
// Integration test for routes/jobs/blog-sync.js — exercises the three jobs
// (import, pull, push) against an in-process Mock-WP. Mock is wired by
// monkey-patching globalThis.fetch with a tiny route table that mimics the
// WP REST API surface lib/wp-client.js touches. Verifies the LWW merge,
// initial-import gating, and conflict-state detection at the Job-Queue level.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
// Mock-WP laeuft ueber gestubbtes globalThis.fetch mit Reserved-TLD-Host
// (wp.test) — DNS-Aufloesung im SSRF-Guard ueberspringen (Literal-Block bleibt).
process.env.SSRF_SKIP_DNS_CHECK = '1';

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
let blogSync;
let blogs;
let contentStore;

test.before(() => {
  ctx = bootstrap();
  blogSync = require('../../routes/jobs/blog-sync');
  blogs = require('../../db/blogs');
  contentStore = require('../../lib/content-store');
});
test.after(() => { ctx.cleanup(); });

// ── Mock-WP ───────────────────────────────────────────────────────────────

function makeWpStub({ posts = [], me = { id: 1, name: 'Editor', capabilities: { edit_posts: true } } } = {}) {
  const state = {
    posts: posts.map(p => ({ ...p })),
    me,
    nextId: posts.reduce((m, p) => Math.max(m, p.id), 100) + 1,
    calls: [],
  };

  function respond(status, body, headers = {}) {
    const hdr = new Map(Object.entries(headers));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: k => hdr.get(k) ?? hdr.get(k.toLowerCase()) ?? null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  state.fetch = async (rawUrl, init) => {
    const u = new URL(rawUrl);
    const method = (init?.method || 'GET').toUpperCase();
    state.calls.push({ url: rawUrl, method, body: init?.body });

    if (u.pathname === '/wp-json/wp/v2/users/me') return respond(200, state.me);

    if (u.pathname === '/wp-json/wp/v2/posts' && method === 'GET') {
      const perPage = parseInt(u.searchParams.get('per_page') || '10', 10);
      const page = parseInt(u.searchParams.get('page') || '1', 10);
      const modifiedAfter = u.searchParams.get('modified_after');
      let pool = state.posts.slice();
      if (modifiedAfter) pool = pool.filter(p => (p.modified_gmt || '') > modifiedAfter);
      pool.sort((a, b) => (a.modified_gmt || '').localeCompare(b.modified_gmt || ''));
      const total = pool.length;
      const totalPages = Math.max(1, Math.ceil(total / perPage));
      const slice = pool.slice((page - 1) * perPage, page * perPage);
      return respond(200, slice, {
        'X-WP-Total': String(total),
        'X-WP-TotalPages': String(totalPages),
      });
    }

    const updMatch = u.pathname.match(/^\/wp-json\/wp\/v2\/posts\/(\d+)$/);
    if (updMatch && method === 'POST') {
      const id = Number(updMatch[1]);
      const post = state.posts.find(p => p.id === id);
      if (!post) return respond(404, { code: 'rest_post_invalid_id' });
      const payload = JSON.parse(init.body || '{}');
      if (payload.title) post.title = { rendered: payload.title, raw: payload.title };
      if (payload.content) post.content = { rendered: payload.content, raw: payload.content };
      if (payload.status) post.status = payload.status;
      post.modified_gmt = new Date().toISOString().replace('Z', '');
      return respond(200, post);
    }

    if (u.pathname === '/wp-json/wp/v2/posts' && method === 'POST') {
      const payload = JSON.parse(init.body || '{}');
      const newPost = {
        id: state.nextId++,
        title: { rendered: payload.title || '', raw: payload.title || '' },
        content: { rendered: payload.content || '', raw: payload.content || '' },
        status: payload.status || 'draft',
        slug: payload.slug || `post-${Date.now()}`,
        modified_gmt: new Date().toISOString().replace('Z', ''),
        date_gmt: new Date().toISOString().replace('Z', ''),
      };
      state.posts.push(newPost);
      return respond(201, newPost);
    }

    return respond(404, { code: 'rest_no_route' });
  };

  return state;
}

function installFetch(stub) {
  const prev = globalThis.fetch;
  globalThis.fetch = stub.fetch;
  return () => { globalThis.fetch = prev; };
}

// ── Test-Buch + Blog-Settings ─────────────────────────────────────────────

function seedBlogBook(bookId) {
  const { db } = require('../../db/connection');
  db.prepare(`
    INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(book_id) DO UPDATE SET name=excluded.name
  `).run(bookId, `Blog-Test-${bookId}`);
  ctx.dbSchema.saveBookSettings(bookId, 'de', 'CH', 'blog', null, null, null, 0, 0);
}

function seedConnection(bookId) {
  blogs.upsertConnection({
    bookId,
    baseUrl: 'https://wp.test',
    username: 'editor',
    password: 'pw',
    defaultStatus: 'draft',
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

test.beforeEach(() => {
  ctx.dbSeed.reset();
  const { db } = require('../../db/connection');
  db.prepare('DELETE FROM blog_page_links').run();
  db.prepare('DELETE FROM blog_connections').run();
});

test('Initial-Import: holt alle Posts und legt Pages an', async () => {
  const bookId = 9001;
  seedBlogBook(bookId);
  seedConnection(bookId);

  const wp = makeWpStub({
    posts: [
      {
        id: 11, title: { rendered: 'Post Eins', raw: 'Post Eins' },
        content: {
          rendered: '<!-- wp:paragraph --><p>Hallo Welt.</p><!-- /wp:paragraph -->',
          raw: '<!-- wp:paragraph --><p>Hallo Welt.</p><!-- /wp:paragraph -->',
        },
        status: 'publish', slug: 'post-eins',
        modified_gmt: '2026-04-01T10:00:00', date_gmt: '2026-04-01T10:00:00',
      },
      {
        id: 12, title: { rendered: 'Post Zwei', raw: 'Post Zwei' },
        content: { rendered: '<p>Zweiter Eintrag.</p>', raw: '<p>Zweiter Eintrag.</p>' },
        status: 'draft', slug: 'post-zwei',
        modified_gmt: '2026-04-02T10:00:00', date_gmt: '2026-04-02T10:00:00',
      },
    ],
  });
  const restore = installFetch(wp);
  try {
    const jobId = `test-import-${Date.now()}`;
    const { jobs, runningJobs } = ctx.shared;
    jobs.set(jobId, {
      id: jobId, type: 'blog-import', bookId, userEmail: 'tester@test.dev',
      status: 'running', progress: 0, createdAt: Date.now(), result: null, error: null,
    });
    runningJobs.set(jobId, { type: 'blog-import', bookId, userEmail: 'tester@test.dev' });

    await blogSync.runBlogImportJob(jobId, bookId, 'tester@test.dev');

    const job = jobs.get(jobId);
    assert.equal(job.status, 'done', job.error || '');
    assert.equal(job.result.imported, 2);

    const conn = blogs.getConnectionPublic(bookId);
    assert.ok(conn.initialImportDoneAt, 'initialImportDoneAt set');

    const links = blogs.listLinksForBlog(blogs.getConnection(bookId).id);
    assert.equal(links.length, 2);

    const pages = await contentStore.listPages(bookId, null);
    assert.equal(pages.length, 2);
    const firstLink = links.find(l => l.wp_post_id === 11);
    const firstPage = await contentStore.loadPage(firstLink.page_id);
    const firstHtml = firstPage.html || firstPage.body_html;
    assert.match(firstHtml, /Hallo Welt/);
    assert.doesNotMatch(firstHtml, /wp:paragraph/);
  } finally {
    restore();
  }
});

test('Initial-Import: zweiter Lauf failed mit BLOG_ALREADY_IMPORTED', async () => {
  const bookId = 9002;
  seedBlogBook(bookId);
  seedConnection(bookId);
  blogs.markInitialImportDone(blogs.getConnection(bookId).id);

  const wp = makeWpStub({ posts: [] });
  const restore = installFetch(wp);
  try {
    const jobId = `test-import-2-${Date.now()}`;
    const { jobs, runningJobs } = ctx.shared;
    jobs.set(jobId, { id: jobId, type: 'blog-import', bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
    runningJobs.set(jobId, { type: 'blog-import', bookId });

    await blogSync.runBlogImportJob(jobId, bookId, null);
    const job = jobs.get(jobId);
    assert.equal(job.status, 'error');
    assert.match(JSON.stringify(job.error || ''), /BLOG_ALREADY_IMPORTED/);
  } finally {
    restore();
  }
});

test('Push: lokal editierte Seite wird zu WP gepusht (Update)', async () => {
  const bookId = 9003;
  seedBlogBook(bookId);
  seedConnection(bookId);
  const connId = blogs.getConnection(bookId).id;
  blogs.markInitialImportDone(connId);

  // Seed-Page + Link. Page-Name in App weicht absichtlich vom WP-Titel ab,
  // damit der Test absichert, dass Push den WP-Titel nicht überschreibt.
  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null, name: 'App-Name',
    html: '<h2>Update</h2><p>Geänderter Text.</p>',
  }, null);
  blogs.upsertLink({
    pageId: page.id, blogId: connId,
    wpPostId: 11, wpModifiedAt: '2026-04-01T10:00:00',
    wpStatus: 'publish', wpSlug: 'pushable',
    lastPulledAt: '2026-04-01T10:00:00',
    lastPushedAt: '2026-04-01T10:00:00',
  });

  const wp = makeWpStub({
    posts: [{
      id: 11, title: { rendered: 'WP-Original', raw: 'WP-Original' },
      content: { rendered: '<p>alt</p>', raw: '<p>alt</p>' },
      status: 'publish', slug: 'pushable',
      modified_gmt: '2026-04-01T10:00:00', date_gmt: '2026-04-01T10:00:00',
    }],
  });
  const restore = installFetch(wp);
  try {
    const jobId = `test-push-${Date.now()}`;
    const { jobs, runningJobs } = ctx.shared;
    jobs.set(jobId, { id: jobId, type: 'blog-push', bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
    runningJobs.set(jobId, { type: 'blog-push', bookId });

    await blogSync.runBlogPushJob(jobId, bookId, null, [page.id]);
    const job = jobs.get(jobId);
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.pushed, 1);

    const updatedRemote = wp.posts.find(p => p.id === 11);
    assert.match(updatedRemote.content.raw, /wp:heading/);
    assert.match(updatedRemote.content.raw, /Geänderter Text/);
    assert.equal(updatedRemote.title.raw, 'WP-Original', 'Update-Push darf WP-Titel nicht überschreiben');
  } finally {
    restore();
  }
});

test('Push (Create): praegt Page-Name mit YYYY-MM-DD-Prefix von heute', async () => {
  const bookId = 9005;
  seedBlogBook(bookId);
  seedConnection(bookId);
  const connId = blogs.getConnection(bookId).id;
  blogs.markInitialImportDone(connId);

  // Page ohne Link → noch nicht in WP
  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null, name: 'Neuer App-Titel',
    html: '<p>Frischer Eintrag.</p>',
  }, null);

  const { localIsoDate } = require('../../lib/local-date');
  const expected = `${localIsoDate()}: Neuer App-Titel`;

  const wp = makeWpStub({ posts: [] });
  const restore = installFetch(wp);
  try {
    const jobId = `test-push-new-${Date.now()}`;
    const { jobs, runningJobs } = ctx.shared;
    jobs.set(jobId, { id: jobId, type: 'blog-push', bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
    runningJobs.set(jobId, { type: 'blog-push', bookId });

    await blogSync.runBlogPushJob(jobId, bookId, null, [page.id]);
    const job = jobs.get(jobId);
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.createdRemote, 1);

    const created = wp.posts[0];
    assert.ok(created, 'WP-Post wurde nicht angelegt');
    assert.equal(created.title.raw, expected);
    const reloaded = await contentStore.loadPage(page.id);
    assert.equal(reloaded.name, expected);
  } finally {
    restore();
  }
});

test('Push (Create): leerer Titel wird zu YYYY-MM-DD von heute', async () => {
  const bookId = 9008;
  seedBlogBook(bookId);
  seedConnection(bookId);
  const connId = blogs.getConnection(bookId).id;
  blogs.markInitialImportDone(connId);

  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null, name: '   ',
    html: '<p>Ohne Titel.</p>',
  }, null);

  const { localIsoDate } = require('../../lib/local-date');
  const expected = localIsoDate();

  const wp = makeWpStub({ posts: [] });
  const restore = installFetch(wp);
  try {
    const jobId = `test-push-empty-${Date.now()}`;
    const { jobs, runningJobs } = ctx.shared;
    jobs.set(jobId, { id: jobId, type: 'blog-push', bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
    runningJobs.set(jobId, { type: 'blog-push', bookId });

    await blogSync.runBlogPushJob(jobId, bookId, null, [page.id]);
    const job = jobs.get(jobId);
    assert.equal(job.status, 'done', JSON.stringify(job.error));

    assert.equal(wp.posts[0].title.raw, expected);
    const reloaded = await contentStore.loadPage(page.id);
    assert.equal(reloaded.name, expected);
  } finally {
    restore();
  }
});

test('Push (Create): bumpt YYYY-MM-DD im Titel auf heute, lokal + WP synchron', async () => {
  const bookId = 9006;
  seedBlogBook(bookId);
  seedConnection(bookId);
  const connId = blogs.getConnection(bookId).id;
  blogs.markInitialImportDone(connId);

  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null,
    name: '2020-01-01: Mein Eintrag',
    html: '<p>Inhalt.</p>',
  }, null);

  const { localIsoDate } = require('../../lib/local-date');
  const today = localIsoDate();
  const expected = `${today}: Mein Eintrag`;

  const wp = makeWpStub({ posts: [] });
  const restore = installFetch(wp);
  try {
    const jobId = `test-push-bump-${Date.now()}`;
    const { jobs, runningJobs } = ctx.shared;
    jobs.set(jobId, { id: jobId, type: 'blog-push', bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
    runningJobs.set(jobId, { type: 'blog-push', bookId });

    await blogSync.runBlogPushJob(jobId, bookId, null, [page.id]);
    const job = jobs.get(jobId);
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.createdRemote, 1);

    assert.equal(wp.posts[0].title.raw, expected, 'WP-Titel sollte heute-bumpt sein');

    const reloaded = await contentStore.loadPage(page.id);
    assert.equal(reloaded.name, expected, 'Lokaler page_name sollte heute-bumpt sein');
  } finally {
    restore();
  }
});

test('Push (Create): Titel ohne YYYY-MM-DD bekommt heute als Prefix', async () => {
  const bookId = 9007;
  seedBlogBook(bookId);
  seedConnection(bookId);
  const connId = blogs.getConnection(bookId).id;
  blogs.markInitialImportDone(connId);

  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null,
    name: 'Kein Datum hier',
    html: '<p>Inhalt.</p>',
  }, null);

  const { localIsoDate } = require('../../lib/local-date');
  const expected = `${localIsoDate()}: Kein Datum hier`;

  const wp = makeWpStub({ posts: [] });
  const restore = installFetch(wp);
  try {
    const jobId = `test-push-nobump-${Date.now()}`;
    const { jobs, runningJobs } = ctx.shared;
    jobs.set(jobId, { id: jobId, type: 'blog-push', bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
    runningJobs.set(jobId, { type: 'blog-push', bookId });

    await blogSync.runBlogPushJob(jobId, bookId, null, [page.id]);
    assert.equal(wp.posts[0].title.raw, expected);

    const reloaded = await contentStore.loadPage(page.id);
    assert.equal(reloaded.name, expected);
  } finally {
    restore();
  }
});

test('Pull: erkennt Konflikt wenn beide Seiten nach last_pulled_at neu', async () => {
  const bookId = 9004;
  seedBlogBook(bookId);
  seedConnection(bookId);
  const connId = blogs.getConnection(bookId).id;
  blogs.markInitialImportDone(connId);

  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null, name: 'Konflikt',
    html: '<p>App-Edit nach Pull.</p>',
  }, null);
  // Link sagt: zuletzt gepullt am 2026-04-01; WP-modified war 2026-04-01.
  blogs.upsertLink({
    pageId: page.id, blogId: connId,
    wpPostId: 21, wpModifiedAt: '2026-04-01T00:00:00',
    wpStatus: 'publish', wpSlug: 'konflikt',
    lastPulledAt: '2026-04-01T00:00:00',
  });

  // WP-Stub liefert neueren modified_gmt → konkurrierende Änderung.
  const wp = makeWpStub({
    posts: [{
      id: 21, title: { rendered: 'Konflikt', raw: 'Konflikt' },
      content: { rendered: '<p>WP-Edit nach Pull.</p>', raw: '<p>WP-Edit nach Pull.</p>' },
      status: 'publish', slug: 'konflikt',
      modified_gmt: '2026-05-01T00:00:00', date_gmt: '2026-04-01T00:00:00',
    }],
  });
  const restore = installFetch(wp);
  try {
    const jobId = `test-pull-${Date.now()}`;
    const { jobs, runningJobs } = ctx.shared;
    jobs.set(jobId, { id: jobId, type: 'blog-pull', bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
    runningJobs.set(jobId, { type: 'blog-pull', bookId });

    await blogSync.runBlogPullJob(jobId, bookId, null);
    const job = jobs.get(jobId);
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.conflicts, 1);

    const link = blogs.getLinkByPage(page.id);
    assert.equal(link.conflict_state, 'detected');
  } finally {
    restore();
  }
});
