'use strict';
// HubSpot-Sync-Jobs: einmaliger Initial-Import (alle PUBLISHED-Posts des
// konfigurierten Authors+Blogs in Jahres-Kapitel), selektiver Push (Page →
// HubSpot-Draft). Push erstellt ausschliesslich neue Posts; bereits gepushte
// Pages werden mit HUBSPOT_ALREADY_PUSHED abgelehnt. Mapping 1 Buch == 1 Blog,
// 1 Post == 1 Page. Job-Dedup pro (type, bookId, user) via findActiveJobId.

const express = require('express');
const {
  createJob, updateJob, completeJob, failJob,
  enqueueJob, findActiveJobId, jobAbortControllers,
  makeJobLogger, jsonBody,
} = require('./shared');
const hubspot = require('../../db/hubspot');
const contentStore = require('../../lib/content-store');
const { createHubspotClient } = require('../../lib/hubspot-client');
const { hubspotToAppHtml, appToHubspotHtml } = require('../../lib/hubspot-html');
const { getBookSettings } = require('../../db/schema');
const { requireBookAccess, sendACLError } = require('../../lib/acl');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { db } = require('../../db/connection');
const { localIsoDate, localIsoDaysAgo } = require('../../lib/local-date');

const hubspotSyncRouter = express.Router();

function _abortSignal(jobId) {
  return jobAbortControllers.get(jobId)?.signal || null;
}

async function _resolveYearChapter(bookId, year, cache) {
  if (cache.has(year)) return cache.get(year);
  const existing = await contentStore.listChapters(bookId, null);
  for (const ch of existing) {
    if (String(ch.name) === year) {
      cache.set(year, ch.id);
      return ch.id;
    }
  }
  const created = await contentStore.createChapter({ book_id: bookId, name: year }, null);
  cache.set(year, created.id);
  return created.id;
}

function _postYear(post) {
  const src = post.publishDate || post.created || post.updated || '';
  const y = String(src).slice(0, 4);
  return /^\d{4}$/.test(y) ? y : 'Undatiert';
}

function _postPageName(post) {
  const src = post.publishDate || post.created || post.updated || '';
  const day = String(src).slice(0, 10);
  const title = (post.htmlTitle || post.name || post.slug || `Post ${post.id}`).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}: ${title}` : title;
}

function _resolveHubConn(bookId) {
  const conn = hubspot.getConnection(bookId);
  if (!conn) {
    const err = new Error('HUBSPOT_NOT_CONNECTED');
    err.code = 'HUBSPOT_NOT_CONNECTED';
    throw err;
  }
  return conn;
}

function _requireBlogBook(bookId, userEmail) {
  const settings = getBookSettings(bookId, userEmail);
  if (!settings || settings.buchtyp !== 'blog') {
    const err = new Error('HUBSPOT_REQUIRES_BLOG_TYPE');
    err.code = 'HUBSPOT_REQUIRES_BLOG_TYPE';
    throw err;
  }
  return settings;
}

async function runHubspotImportJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    _requireBlogBook(bookId, userEmail);
    const conn = _resolveHubConn(bookId);
    if (conn.initialImportDoneAt) {
      throw Object.assign(new Error('HUBSPOT_ALREADY_IMPORTED'), { code: 'HUBSPOT_ALREADY_IMPORTED' });
    }
    const client = createHubspotClient({
      token: conn.token,
      signal: _abortSignal(jobId),
    });

    updateJob(jobId, { statusText: 'job.hubspot.import.fetch', progress: 1 });
    let imported = 0;
    let dropped = 0;
    const chapterCache = new Map();

    for await (const post of client.iteratePosts({
      authorId: conn.authorId,
      blogId: conn.blogId,
      state: 'PUBLISHED',
    })) {
      if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');

      // Idempotenz: bereits importierter Post (existing link) wird übersprungen.
      const existingLink = hubspot.getLinkByPost(conn.id, post.id);
      if (existingLink) { dropped++; continue; }

      const title = (post.htmlTitle || post.name || '').trim();
      if (!title) { dropped++; continue; }

      const rawHtml = post.postBody || '';
      const appHtml = hubspotToAppHtml(rawHtml) || '<p></p>';
      const pageName = _postPageName(post);
      const year = _postYear(post);
      const chapterId = await _resolveYearChapter(bookId, year, chapterCache);

      const created = await contentStore.createPage({
        book_id: bookId,
        chapter_id: chapterId,
        name: pageName,
        html: appHtml,
      }, null);
      hubspot.upsertLink({
        pageId: created.id,
        hubId: conn.id,
        hubspotPostId: post.id,
        hubspotState: post.state || 'PUBLISHED',
        hubspotCreatedAt: post.created || post.publishDate || null,
        lastPushedAt: null,
      });
      imported++;
      updateJob(jobId, {
        statusText: 'job.hubspot.import.progress',
        statusParams: { done: imported },
        progress: Math.min(98, 2 + imported),
      });
    }

    hubspot.markInitialImportDone(conn.id);

    if (imported > 0) {
      try {
        const { syncBook } = require('../sync');
        await syncBook(bookId, { session: { user: { email: userEmail } } });
        const yesterday = localIsoDaysAgo(1);
        const today = localIsoDate();
        db.prepare(`
          INSERT INTO book_stats_history (book_id, recorded_at, page_count, words, chars, tok, unique_words, chapter_count, avg_sentence_len, avg_lix, avg_flesch_de)
          SELECT book_id, ?, page_count, words, chars, tok, unique_words, chapter_count, avg_sentence_len, avg_lix, avg_flesch_de
            FROM book_stats_history WHERE book_id = ? AND recorded_at = ?
          ON CONFLICT(book_id, recorded_at) DO UPDATE SET
            page_count=excluded.page_count, words=excluded.words, chars=excluded.chars, tok=excluded.tok,
            unique_words=excluded.unique_words, chapter_count=excluded.chapter_count,
            avg_sentence_len=excluded.avg_sentence_len, avg_lix=excluded.avg_lix, avg_flesch_de=excluded.avg_flesch_de
        `).run(yesterday, bookId, today);
        logger.info(`Vortags-Baseline gesetzt (${yesterday}) aus HubSpot-Import.`);
      } catch (e) {
        logger.warn(`Baseline-Snapshot nach HubSpot-Import fehlgeschlagen: ${e.message}`);
      }
    }

    logger.info(`HubSpot-Initial-Import: ${imported} importiert, ${dropped} uebersprungen.`);
    completeJob(jobId, { imported, dropped }, null, `${imported} Posts importiert`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`HubSpot-Import-Fehler: ${e.code || e.message}`);
    failJob(jobId, e);
  }
}

async function runHubspotPushJob(jobId, bookId, userEmail, pageIds) {
  const logger = makeJobLogger(jobId);
  try {
    _requireBlogBook(bookId, userEmail);
    const conn = _resolveHubConn(bookId);
    const client = createHubspotClient({
      token: conn.token,
      signal: _abortSignal(jobId),
    });

    const ids = (pageIds || []).map(x => parseInt(x, 10)).filter(n => Number.isInteger(n) && n > 0);
    if (!ids.length) throw Object.assign(new Error('HUBSPOT_NO_PAGES'), { code: 'HUBSPOT_NO_PAGES' });

    let pushed = 0;
    const errors = [];

    for (let i = 0; i < ids.length; i++) {
      if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
      const pageId = ids[i];
      updateJob(jobId, {
        statusText: 'job.hubspot.push.upload',
        statusParams: { current: i + 1, total: ids.length },
        progress: Math.round((i / ids.length) * 95) + 2,
      });

      const pageRow = await contentStore.loadPage(pageId).catch(() => null);
      if (!pageRow) { errors.push({ pageId, code: 'PAGE_NOT_FOUND' }); continue; }
      if (pageRow.book_id !== bookId) { errors.push({ pageId, code: 'PAGE_WRONG_BOOK' }); continue; }

      const existing = hubspot.getLinkByPage(pageId);
      if (existing) { errors.push({ pageId, code: 'HUBSPOT_ALREADY_PUSHED' }); continue; }

      const postBody = appToHubspotHtml(pageRow.html || pageRow.body_html || '<p></p>');
      const name = (pageRow.name || `Page ${pageId}`).trim();

      try {
        const remote = await client.createPost({
          name,
          postBody,
          contentGroupId: conn.blogId,
          blogAuthorId: conn.authorId,
          state: 'DRAFT',
        });
        hubspot.upsertLink({
          pageId,
          hubId: conn.id,
          hubspotPostId: remote.id,
          hubspotState: remote.state || 'DRAFT',
          hubspotCreatedAt: remote.created || remote.publishDate || null,
          lastPushedAt: new Date().toISOString(),
        });
        pushed++;
      } catch (e) {
        errors.push({ pageId, code: e.code || 'HUBSPOT_PUSH_FAILED' });
      }
    }

    hubspot.touchPush(conn.id);
    logger.info(`HubSpot-Push: ${pushed} neu, ${errors.length} Fehler.`);
    completeJob(jobId, { pushed, errors }, null, `${pushed} gepusht / ${errors.length} Fehler`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`HubSpot-Push-Fehler: ${e.code || e.message}`);
    failJob(jobId, e);
  }
}

function _aclEditor(req, res, bookId) {
  try { requireBookAccess(req, bookId, 'editor'); return true; }
  catch (e) { if (sendACLError(res, e)) return false; throw e; }
}

hubspotSyncRouter.post('/hubspot-import', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  if (!_aclEditor(req, res, book_id)) return;
  const userEmail = req.session?.user?.email || null;
  try { _requireBlogBook(book_id, userEmail); }
  catch (e) { return res.status(400).json({ error_code: e.code }); }
  const existing = findActiveJobId('hubspot-import', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('hubspot-import', book_id, userEmail, 'job.label.hubspotImport');
  enqueueJob(jobId, () => runHubspotImportJob(jobId, book_id, userEmail));
  res.json({ jobId });
});

hubspotSyncRouter.post('/hubspot-push', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  if (!_aclEditor(req, res, book_id)) return;
  const userEmail = req.session?.user?.email || null;
  try { _requireBlogBook(book_id, userEmail); }
  catch (e) { return res.status(400).json({ error_code: e.code }); }
  const pageIds = Array.isArray(req.body?.page_ids) ? req.body.page_ids : [];
  if (!pageIds.length) return res.status(400).json({ error_code: 'HUBSPOT_PAGE_IDS_REQUIRED' });
  const existing = findActiveJobId('hubspot-push', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('hubspot-push', book_id, userEmail, 'job.label.hubspotPushCount', { count: pageIds.length });
  enqueueJob(jobId, () => runHubspotPushJob(jobId, book_id, userEmail, pageIds));
  res.json({ jobId });
});

module.exports = { hubspotSyncRouter, runHubspotImportJob, runHubspotPushJob };
