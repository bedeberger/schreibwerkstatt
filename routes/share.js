'use strict';
// Share-Link-Routes: Public-Reader (GET /share/:token, POST .../comment) +
// Auth-Owner-API (GET/POST/PATCH/DELETE /share/api/...).
//
// Mount in server.js VOR Auth-Guard, damit Reader-Route ohne Session
// erreichbar bleibt. Owner-API-Routen prüfen Session selbst.

const express = require('express');
const fs = require('fs');
const path = require('path');
const contentStore = require('../lib/content-store');
const shareLinks = require('../db/share-links');
const rateLimit = require('../lib/share-ratelimit');
const { requireBookAccess, sendACLError, ACLError } = require('../lib/acl');
const { setContext } = require('../lib/log-context');
const { tServer } = require('../lib/i18n-server');
const appSettings = require('../lib/app-settings');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

const TEMPLATE_OK   = fs.readFileSync(path.join(__dirname, '..', 'public', 'share.html'), 'utf8');
const TEMPLATE_GONE = fs.readFileSync(path.join(__dirname, '..', 'public', 'share.gone.html'), 'utf8');

const READER_NAME_MAX = 80;
const BODY_MAX = 4000;
const INTRO_MAX = 2000;

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function detectLang(req) {
  const accept = String(req.headers['accept-language'] || '').toLowerCase();
  if (accept.startsWith('en')) return 'en';
  return 'de';
}

function isExpired(link) {
  if (link.revoked_at) return 'revoked';
  if (link.expires_at && new Date(link.expires_at) <= new Date()) return 'expired';
  return null;
}

function fillTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : ''));
}

function paragraphifyIntro(text) {
  if (!text) return '';
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  return blocks.map(b => `<p>${escHtml(b).replace(/\n/g, '<br>')}</p>`).join('');
}

async function loadContentForLink(link) {
  if (link.kind === 'page') {
    try {
      const pd = await contentStore.loadPage(link.page_id);
      return {
        title: pd.name || '',
        html: pd.html || '',
      };
    } catch {
      return null;
    }
  }
  // chapter — alle Seiten des Kapitels (ohne Sub-Kapitel, MVP).
  try {
    const chapter = await contentStore.loadChapter(link.chapter_id);
    const pages = await contentStore.listPages(link.book_id);
    const chapterPages = pages
      .filter(p => p.chapter_id === link.chapter_id)
      .sort((a, b) => (a.position || 0) - (b.position || 0));
    const blocks = [];
    for (const meta of chapterPages) {
      const pd = await contentStore.loadPage(meta.id);
      blocks.push(`<section class="share-page-block">
        <h2 class="share-page-block__title">${escHtml(pd.name || '')}</h2>
        <div class="share-page-block__body">${pd.html || ''}</div>
      </section>`);
    }
    return {
      title: chapter.name || chapter.chapter_name || '',
      html: blocks.join('\n'),
    };
  } catch {
    return null;
  }
}

function renderGone(req, res, kind) {
  const lang = detectLang(req);
  const html = fillTemplate(TEMPLATE_GONE, {
    lang,
    title: tServer('share.reader.gone.title', lang),
    heading: tServer(kind === 'revoked' ? 'share.reader.revoked_heading' : 'share.reader.expired_heading', lang),
    body: tServer(kind === 'revoked' ? 'share.reader.revoked_body' : 'share.reader.expired_body', lang),
  });
  res.status(410).type('html').send(html);
}

// ── Public: Reader-View ─────────────────────────────────────────────────────
router.get('/:token', async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(token)) return res.status(404).type('html').send('Not found');
  const link = shareLinks.getShareLinkByToken(token);
  if (!link) return res.status(404).type('html').send('Not found');
  setContext({ book: link.book_id });
  const gone = isExpired(link);
  if (gone) {
    logger.warn(`[share/reader] 410 ${gone} token=${token.slice(0, 8)} book=${link.book_id}`);
    return renderGone(req, res, gone);
  }
  const lang = detectLang(req);
  const content = await loadContentForLink(link);
  if (!content) return res.status(404).type('html').send('Not found');

  const introBlock = link.intro
    ? `<blockquote class="share-intro">${paragraphifyIntro(link.intro)}</blockquote>`
    : '';

  const comments = shareLinks.listCommentsByToken(token, { order: 'desc' });
  const commentsHtml = comments.length
    ? comments.map(c => `<li class="share-comments__item">
        <div class="share-comments__meta">${escHtml(c.reader_name || tServer('share.reader.anon', lang))} · ${escHtml(c.created_at)}</div>
        <div class="share-comments__body">${escHtml(c.body)}</div>
      </li>`).join('\n')
    : `<li class="share-comments__empty">${escHtml(tServer('share.reader.comments_empty', lang))}</li>`;

  const formBlock = `<form id="share-comment-form" class="share-comments__form" autocomplete="off"
      data-empty-msg="${escHtml(tServer('share.reader.form_empty', lang))}"
      data-rate-msg="${escHtml(tServer('share.reader.comment_rate_limited', lang))}"
      data-error-msg="${escHtml(tServer('share.reader.form_error', lang))}"
      data-success-msg="${escHtml(tServer('share.reader.comment_submitted', lang))}"
      data-anon="${escHtml(tServer('share.reader.anon', lang))}">
      <label class="share-comments__label">
        <span>${escHtml(tServer('share.reader.comment_form_name', lang))}</span>
        <input type="text" name="reader_name" maxlength="${READER_NAME_MAX}" placeholder="${escHtml(tServer('share.reader.comment_form_name_placeholder', lang))}">
      </label>
      <label class="share-comments__label">
        <span>${escHtml(tServer('share.reader.comment_form_body', lang))}</span>
        <textarea name="body" rows="4" required maxlength="${BODY_MAX}"></textarea>
      </label>
      <input type="text" name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true" class="share-comments__hp">
      <div class="share-comments__actions">
        <button type="submit">${escHtml(tServer('share.reader.comment_form_submit', lang))}</button>
        <span id="share-comment-status" class="share-comments__status" role="status"></span>
      </div>
    </form>`;

  const html = fillTemplate(TEMPLATE_OK, {
    lang,
    title: escHtml(`${content.title} · ${link.book_name}`),
    book_name: escHtml(link.book_name || ''),
    target_name: escHtml(content.title),
    author_name: escHtml(link.owner_display_name || tServer('share.reader.anon_author', lang)),
    t_by: escHtml(tServer('share.reader.by', lang)),
    t_skip: escHtml(tServer('share.reader.skip_to_content', lang)),
    t_comments: escHtml(tServer('share.reader.comments_heading', lang)),
    intro_block: introBlock,
    content_html: content.html,
    comments_html: commentsHtml,
    form_block: formBlock,
    app_name: 'Schreibwerkstatt',
    app_url: escHtml((appSettings.get('app.public_url') || '').replace(/\/$/, '') || '/'),
  });

  // View-Count non-blocking
  setImmediate(() => {
    try { shareLinks.incrementViewCount(token); } catch {}
  });

  res.set('Cache-Control', 'no-store');
  res.status(200).type('html').send(html);
});

// ── Public: Kommentar abgeben ────────────────────────────────────────────────
router.post('/:token/comment', jsonBody, (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(token)) return res.status(404).json({ error_code: 'NOT_FOUND' });
  const link = shareLinks.getShareLinkByToken(token);
  if (!link) return res.status(404).json({ error_code: 'NOT_FOUND' });
  setContext({ book: link.book_id });
  if (isExpired(link)) return res.status(410).json({ error_code: 'GONE' });

  const body = String((req.body?.body || '')).trim();
  const readerName = String((req.body?.reader_name || '')).trim();
  const hp = String((req.body?._hp || '')).trim();
  if (hp) {
    // Honeypot — Bot.
    logger.warn(`[share/comment] honeypot triggered token=${token.slice(0, 8)}`);
    return res.status(400).json({ error_code: 'INVALID' });
  }
  if (!body) return res.status(400).json({ error_code: 'BODY_REQUIRED' });
  if (body.length > BODY_MAX) return res.status(400).json({ error_code: 'BODY_TOO_LONG' });
  if (readerName.length > READER_NAME_MAX) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });

  const ip = req.ip || req.connection?.remoteAddress || '';
  const ipHash = rateLimit.hashIp(ip);
  const rl = rateLimit.check(token, ipHash);
  if (!rl.allowed) {
    logger.warn(`[share/comment] rate-limit token=${token.slice(0, 8)} ipHash=${ipHash}`);
    res.setHeader('Retry-After', String(rl.retryAfterSec));
    return res.status(429).json({ error_code: 'RATE_LIMITED', retry_after: rl.retryAfterSec });
  }

  try {
    const comment = shareLinks.insertComment({
      token,
      readerName: readerName || null,
      body,
      ipHash,
    });
    logger.info(`[share/comment] new token=${token.slice(0, 8)} book=${link.book_id} bytes=${body.length}`);
    res.json({ ok: true, id: comment.id, reader_name: comment.reader_name, body: comment.body, created_at: comment.created_at });
  } catch (e) {
    logger.error('[share/comment] DB-Fehler: ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

// ── Auth-Mw ──────────────────────────────────────────────────────────────────
function requireSession(req, res, next) {
  if (!req.session?.user?.email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  next();
}

// ── Owner-API ────────────────────────────────────────────────────────────────
router.get('/api/links', requireSession, (req, res) => {
  const ownerEmail = req.session.user.email;
  const bookId = parseInt(req.query.book_id, 10);
  try {
    const rows = bookId
      ? shareLinks.listSharesByOwnerAndBook(ownerEmail, bookId)
      : shareLinks.listSharesByOwner(ownerEmail);
    if (bookId) setContext({ book: bookId });
    res.json(rows);
  } catch (e) {
    logger.error('[share/api/links GET] ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

router.post('/api/links', requireSession, jsonBody, async (req, res) => {
  const ownerEmail = req.session.user.email;
  const { kind, page_id, chapter_id, intro, expires_at } = req.body || {};
  if (kind !== 'page' && kind !== 'chapter') return res.status(400).json({ error_code: 'INVALID_KIND' });
  if (kind === 'page' && !Number.isInteger(parseInt(page_id, 10))) return res.status(400).json({ error_code: 'PAGE_ID_REQUIRED' });
  if (kind === 'chapter' && !Number.isInteger(parseInt(chapter_id, 10))) return res.status(400).json({ error_code: 'CHAPTER_ID_REQUIRED' });
  if (intro && String(intro).length > INTRO_MAX) return res.status(400).json({ error_code: 'INTRO_TOO_LONG' });
  if (expires_at) {
    const d = new Date(expires_at);
    if (isNaN(d.getTime())) return res.status(400).json({ error_code: 'INVALID_EXPIRES_AT' });
    if (d <= new Date()) return res.status(400).json({ error_code: 'EXPIRES_AT_IN_PAST' });
  }

  // bookId aus Page bzw. Chapter holen + ACL prüfen.
  let bookId = null;
  let pageId = null;
  let chapterId = null;
  try {
    if (kind === 'page') {
      pageId = parseInt(page_id, 10);
      const pd = await contentStore.loadPage(pageId);
      bookId = pd.book_id;
    } else {
      chapterId = parseInt(chapter_id, 10);
      const ch = await contentStore.loadChapter(chapterId);
      bookId = ch.book_id;
    }
  } catch {
    return res.status(404).json({ error_code: 'TARGET_NOT_FOUND' });
  }

  try {
    requireBookAccess(req, bookId, 'editor');
  } catch (e) {
    const ack = sendACLError(res, e); if (ack) return; throw e;
  }
  setContext({ book: bookId });

  try {
    const created = shareLinks.createShareLink({
      kind, pageId, chapterId, bookId,
      ownerEmail,
      intro: intro ? String(intro).slice(0, INTRO_MAX) : null,
      expiresAt: expires_at || null,
    });
    logger.info(`[share/api/links POST] kind=${kind} book=${bookId} token=${created.token.slice(0, 8)}`);
    res.json(created);
  } catch (e) {
    logger.error('[share/api/links POST] ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

router.patch('/api/links/:token', requireSession, jsonBody, (req, res) => {
  const ownerEmail = req.session.user.email;
  const token = String(req.params.token || '');
  const link = shareLinks.getShareLinkByToken(token);
  if (!link || link.owner_email !== ownerEmail) return res.status(404).json({ error_code: 'NOT_FOUND' });
  setContext({ book: link.book_id });
  const patch = {};
  if ('intro' in (req.body || {})) {
    const intro = req.body.intro;
    if (intro != null && String(intro).length > INTRO_MAX) return res.status(400).json({ error_code: 'INTRO_TOO_LONG' });
    patch.intro = intro ? String(intro).slice(0, INTRO_MAX) : null;
  }
  if ('expires_at' in (req.body || {})) {
    const exp = req.body.expires_at;
    if (exp) {
      const d = new Date(exp);
      if (isNaN(d.getTime())) return res.status(400).json({ error_code: 'INVALID_EXPIRES_AT' });
    }
    patch.expiresAt = exp || null;
  }
  try {
    shareLinks.updateShareLink(token, ownerEmail, patch);
    res.json(shareLinks.getShareLinkByToken(token));
  } catch (e) {
    logger.error('[share/api/links PATCH] ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

router.delete('/api/links/:token', requireSession, (req, res) => {
  const ownerEmail = req.session.user.email;
  const token = String(req.params.token || '');
  const link = shareLinks.getShareLinkByToken(token);
  if (!link || link.owner_email !== ownerEmail) return res.status(404).json({ error_code: 'NOT_FOUND' });
  setContext({ book: link.book_id });
  try {
    const ok = shareLinks.revokeShareLink(token, ownerEmail);
    if (!ok) return res.status(409).json({ error_code: 'ALREADY_REVOKED' });
    logger.info(`[share/api/links DELETE] token=${token.slice(0, 8)} book=${link.book_id}`);
    res.json({ ok: true });
  } catch (e) {
    logger.error('[share/api/links DELETE] ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

router.get('/api/links/:token/comments', requireSession, (req, res) => {
  const ownerEmail = req.session.user.email;
  const token = String(req.params.token || '');
  const link = shareLinks.getShareLinkByToken(token);
  if (!link || link.owner_email !== ownerEmail) return res.status(404).json({ error_code: 'NOT_FOUND' });
  setContext({ book: link.book_id });
  try {
    const rows = shareLinks.listCommentsByToken(token, { order: 'desc' });
    if (req.query.mark_seen === '1') shareLinks.markOwnerSeen(token, ownerEmail);
    res.json(rows);
  } catch (e) {
    logger.error('[share/api/links/comments GET] ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

router.delete('/api/comments/:id', requireSession, (req, res) => {
  const ownerEmail = req.session.user.email;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  try {
    const ok = shareLinks.deleteComment(id, ownerEmail);
    if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
    res.json({ ok: true });
  } catch (e) {
    logger.error('[share/api/comments DELETE] ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

module.exports = router;
