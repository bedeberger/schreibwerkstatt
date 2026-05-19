'use strict';
// Blog-Sync-Jobs: einmaliger Initial-Import, manueller Delta-Pull, selektiver Push.
// Mapping 1 Blog == 1 Buch, 1 WP-Post == 1 Page. Block-Editor-HTML round-trips via
// lib/wp-html.js (Gutenberg-Block-Markup). Konflikt-Strategie: Timestamp-LWW (siehe
// docs/blog-sync.md). Job-Dedup pro (type, bookId, user) via findActiveJobId.

const express = require('express');
const {
  createJob, updateJob, completeJob, failJob,
  enqueueJob, findActiveJobId, jobAbortControllers,
  makeJobLogger, jsonBody,
} = require('./shared');
const blogs = require('../../db/blogs');
const contentStore = require('../../lib/content-store');
const { createWpClient } = require('../../lib/wp-client');
const { wpToAppHtml, appToWpHtml } = require('../../lib/wp-html');
const { getBookSettings } = require('../../db/schema');
const { requireBookAccess, sendACLError } = require('../../lib/acl');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');

const blogSyncRouter = express.Router();

function _abortSignal(jobId) {
  return jobAbortControllers.get(jobId)?.signal || null;
}

function _newer(a, b) {
  if (!a) return false;
  if (!b) return true;
  return String(a) > String(b);
}

function _resolveBlogConn(bookId) {
  const conn = blogs.getConnection(bookId);
  if (!conn) {
    const err = new Error('BLOG_NOT_CONNECTED');
    err.code = 'BLOG_NOT_CONNECTED';
    throw err;
  }
  return conn;
}

function _requireBlogBook(bookId, userEmail) {
  const settings = getBookSettings(bookId, userEmail);
  if (!settings || settings.buchtyp !== 'blog') {
    const err = new Error('BLOG_REQUIRES_BLOG_TYPE');
    err.code = 'BLOG_REQUIRES_BLOG_TYPE';
    throw err;
  }
  return settings;
}

async function runBlogImportJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    _requireBlogBook(bookId, userEmail);
    const conn = _resolveBlogConn(bookId);
    if (conn.initialImportDoneAt) {
      throw Object.assign(new Error('BLOG_ALREADY_IMPORTED'), { code: 'BLOG_ALREADY_IMPORTED' });
    }
    const wp = createWpClient({
      baseUrl: conn.baseUrl,
      username: conn.username,
      password: conn.password,
      signal: _abortSignal(jobId),
    });

    updateJob(jobId, { statusText: 'job.blog.import.fetchPage', statusParams: { page: 1 }, progress: 1 });
    let page = 1;
    let totalPages = 1;
    let totalCount = 0;
    let imported = 0;

    do {
      if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { posts, totalPages: tp, total } = await wp.listPosts({ page, perPage: 100 });
      totalPages = tp || 1;
      if (page === 1) totalCount = total;

      for (const post of posts) {
        if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
        const title = (post.title && (post.title.rendered || post.title.raw)) || post.slug || `Post ${post.id}`;
        const rawHtml = (post.content && (post.content.raw || post.content.rendered)) || '';
        const appHtml = wpToAppHtml(rawHtml) || '<p></p>';
        const created = await contentStore.createPage({
          book_id: bookId,
          chapter_id: null,
          name: title,
          html: appHtml,
        }, null);
        blogs.upsertLink({
          pageId: created.id,
          blogId: conn.id,
          wpPostId: post.id,
          wpModifiedAt: post.modified_gmt || post.date_gmt || '',
          wpStatus: post.status || null,
          wpSlug: post.slug || null,
          lastPulledAt: new Date().toISOString(),
        });
        imported++;
        updateJob(jobId, {
          statusText: 'job.blog.import.progress',
          statusParams: { done: imported, total: totalCount || imported },
          progress: Math.min(98, Math.round((imported / Math.max(1, totalCount)) * 95) + 1),
        });
      }
      page++;
    } while (page <= totalPages);

    blogs.markInitialImportDone(conn.id);
    blogs.touchPull(conn.id);
    logger.info(`Initial-Import: ${imported} Posts importiert.`);
    completeJob(jobId, { imported, totalCount }, null, `${imported} Posts importiert`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`Blog-Import-Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

async function runBlogPullJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    _requireBlogBook(bookId, userEmail);
    const conn = _resolveBlogConn(bookId);
    if (!conn.initialImportDoneAt) {
      throw Object.assign(new Error('BLOG_IMPORT_FIRST'), { code: 'BLOG_IMPORT_FIRST' });
    }
    const wp = createWpClient({
      baseUrl: conn.baseUrl,
      username: conn.username,
      password: conn.password,
      signal: _abortSignal(jobId),
    });

    updateJob(jobId, { statusText: 'job.blog.pull.fetch', progress: 1 });

    let page = 1;
    let totalPages = 1;
    let updated = 0;
    let created = 0;
    let conflicts = 0;
    let skipped = 0;

    do {
      if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { posts, totalPages: tp } = await wp.listPosts({
        page, perPage: 100,
        modifiedAfter: conn.lastPullAt || undefined,
      });
      totalPages = tp || 1;

      for (const post of posts) {
        if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
        const link = blogs.getLinkByPost(conn.id, post.id);
        const wpModified = post.modified_gmt || post.date_gmt || '';
        const title = (post.title && (post.title.rendered || post.title.raw)) || post.slug || `Post ${post.id}`;
        const rawHtml = (post.content && (post.content.raw || post.content.rendered)) || '';
        const appHtml = wpToAppHtml(rawHtml) || '<p></p>';

        if (!link) {
          const createdPage = await contentStore.createPage({
            book_id: bookId, chapter_id: null, name: title, html: appHtml,
          }, null);
          blogs.upsertLink({
            pageId: createdPage.id,
            blogId: conn.id,
            wpPostId: post.id,
            wpModifiedAt: wpModified,
            wpStatus: post.status || null,
            wpSlug: post.slug || null,
            lastPulledAt: new Date().toISOString(),
          });
          created++;
          continue;
        }

        const pageRow = await contentStore.loadPage(link.page_id).catch(() => null);
        if (!pageRow) {
          skipped++;
          continue;
        }
        const wpHasNew = _newer(wpModified, link.wp_modified_at);
        const appHasLocalEdit = _newer(pageRow.updated_at, link.last_pulled_at);

        if (wpHasNew && appHasLocalEdit) {
          blogs.setConflictState(link.page_id, 'detected');
          conflicts++;
          continue;
        }
        if (wpHasNew && !appHasLocalEdit) {
          await contentStore.savePage(link.page_id, { name: title, html: appHtml }, null);
          blogs.markLinkPulled(link.page_id, {
            wpModifiedAt: wpModified,
            wpStatus: post.status || null,
            wpSlug: post.slug || null,
          });
          updated++;
          continue;
        }
        skipped++;
      }
      page++;
    } while (page <= totalPages);

    blogs.touchPull(conn.id);
    logger.info(`Pull: ${updated} aktualisiert, ${created} neu, ${conflicts} Konflikt, ${skipped} unverändert.`);
    completeJob(jobId, { updated, created, conflicts, skipped }, null,
      `${updated} aktualisiert / ${created} neu / ${conflicts} Konflikt`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`Blog-Pull-Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

async function runBlogPushJob(jobId, bookId, userEmail, pageIds) {
  const logger = makeJobLogger(jobId);
  try {
    _requireBlogBook(bookId, userEmail);
    const conn = _resolveBlogConn(bookId);
    const wp = createWpClient({
      baseUrl: conn.baseUrl,
      username: conn.username,
      password: conn.password,
      signal: _abortSignal(jobId),
    });

    const ids = (pageIds || []).map(x => parseInt(x, 10)).filter(n => Number.isInteger(n) && n > 0);
    if (!ids.length) throw Object.assign(new Error('BLOG_NO_PAGES'), { code: 'BLOG_NO_PAGES' });

    let pushed = 0;
    let createdRemote = 0;
    let conflictSkipped = 0;
    const errors = [];

    for (let i = 0; i < ids.length; i++) {
      if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
      const pageId = ids[i];
      updateJob(jobId, {
        statusText: 'job.blog.push.upload',
        statusParams: { current: i + 1, total: ids.length },
        progress: Math.round((i / ids.length) * 95) + 2,
      });
      const pageRow = await contentStore.loadPage(pageId).catch(() => null);
      if (!pageRow) { errors.push({ pageId, code: 'PAGE_NOT_FOUND' }); continue; }
      if (pageRow.book_id !== bookId) { errors.push({ pageId, code: 'PAGE_WRONG_BOOK' }); continue; }

      const link = blogs.getLinkByPage(pageId);
      if (link && link.conflict_state === 'detected') {
        conflictSkipped++;
        errors.push({ pageId, code: 'BLOG_CONFLICT' });
        continue;
      }

      const wpHtml = appToWpHtml(pageRow.html || pageRow.body_html || '<p></p>');
      const payload = {
        title: pageRow.page_name || '',
        content: wpHtml,
        status: link ? undefined : conn.defaultStatus,
      };

      try {
        const remote = link
          ? await wp.updatePost(link.wp_post_id, payload)
          : await wp.createPost({ ...payload, status: conn.defaultStatus });
        blogs.upsertLink({
          pageId,
          blogId: conn.id,
          wpPostId: remote.id,
          wpModifiedAt: remote.modified_gmt || remote.date_gmt || '',
          wpStatus: remote.status || null,
          wpSlug: remote.slug || null,
          lastPushedAt: new Date().toISOString(),
        });
        if (!link) createdRemote++;
        else pushed++;
      } catch (e) {
        errors.push({ pageId, code: e.code || 'BLOG_PUSH_FAILED' });
      }
    }

    blogs.touchPush(conn.id);
    logger.info(`Push: ${pushed} aktualisiert, ${createdRemote} neu in WP, ${conflictSkipped} Konflikt skipped, ${errors.length} Fehler.`);
    completeJob(jobId, { pushed, createdRemote, conflictSkipped, errors }, null,
      `${pushed + createdRemote} gepusht / ${errors.length} Fehler`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`Blog-Push-Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

function _aclEditor(req, res, bookId) {
  try { requireBookAccess(req, bookId, 'editor'); return true; }
  catch (e) { if (sendACLError(res, e)) return false; throw e; }
}

blogSyncRouter.post('/blog-import', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  if (!_aclEditor(req, res, book_id)) return;
  const userEmail = req.session?.user?.email || null;
  try { _requireBlogBook(book_id, userEmail); }
  catch (e) { return res.status(400).json({ error_code: e.code }); }
  const existing = findActiveJobId('blog-import', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('blog-import', book_id, userEmail, 'job.label.blogImport');
  enqueueJob(jobId, () => runBlogImportJob(jobId, book_id, userEmail));
  res.json({ jobId });
});

blogSyncRouter.post('/blog-pull', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  if (!_aclEditor(req, res, book_id)) return;
  const userEmail = req.session?.user?.email || null;
  try { _requireBlogBook(book_id, userEmail); }
  catch (e) { return res.status(400).json({ error_code: e.code }); }
  const existing = findActiveJobId('blog-pull', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('blog-pull', book_id, userEmail, 'job.label.blogPull');
  enqueueJob(jobId, () => runBlogPullJob(jobId, book_id, userEmail));
  res.json({ jobId });
});

blogSyncRouter.post('/blog-push', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  if (!_aclEditor(req, res, book_id)) return;
  const userEmail = req.session?.user?.email || null;
  try { _requireBlogBook(book_id, userEmail); }
  catch (e) { return res.status(400).json({ error_code: e.code }); }
  const pageIds = Array.isArray(req.body?.page_ids) ? req.body.page_ids : [];
  if (!pageIds.length) return res.status(400).json({ error_code: 'BLOG_PAGE_IDS_REQUIRED' });
  const existing = findActiveJobId('blog-push', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('blog-push', book_id, userEmail, 'job.label.blogPush', { count: pageIds.length });
  enqueueJob(jobId, () => runBlogPushJob(jobId, book_id, userEmail, pageIds));
  res.json({ jobId });
});

module.exports = { blogSyncRouter, runBlogImportJob, runBlogPullJob, runBlogPushJob };
