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
const { loadContents } = require('../lib/load-contents');
const shareLinks = require('../db/share-links');
const rateLimit = require('../lib/share-ratelimit');
const { requireBookAccess, sendACLError, ACLError } = require('../lib/acl');
const { setContext } = require('../lib/log-context');
const { tServer } = require('../lib/i18n-server');
const appSettings = require('../lib/app-settings');
const notify = require('../lib/notify');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();
const formBody = express.urlencoded({ extended: false });
const commentBody = (req, res, next) => {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct.startsWith('application/x-www-form-urlencoded')) return formBody(req, res, next);
  return jsonBody(req, res, next);
};

const TEMPLATE_OK   = fs.readFileSync(path.join(__dirname, '..', 'public', 'share.html'), 'utf8');
const TEMPLATE_GONE = fs.readFileSync(path.join(__dirname, '..', 'public', 'share.gone.html'), 'utf8');

const READER_NAME_MAX = 80;
const BODY_MAX = 4000;
const INTRO_MAX = 2000;
const ANCHOR_QUOTE_MAX = 600;
const ANCHOR_BID_RE = /^[0-9a-f]{6,32}$/i;
const READER_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Leser-sichere Serialisierung eines share_comments-Rows. Gibt NIE author_email,
// reader_token oder ip_hash preis; `mine` wird gegen den Token des anfragenden
// Lesers berechnet (Self-Erkennung ohne andere Tokens zu leaken).
function serializeCommentForReader(row, readerToken) {
  const isAuthor = !!row.author_email;
  return {
    id: row.id,
    parent_id: row.parent_id || null,
    name: isAuthor ? (row.author_display_name || null) : (row.reader_name || null),
    is_author: isAuthor,
    mine: !isAuthor && !!readerToken && row.reader_token === readerToken,
    body: row.body,
    created_at: row.created_at,
    resolved: !!row.resolved_at,
    anchor: row.anchor_bid
      ? { bid: row.anchor_bid, quote: row.anchor_quote || '', start: row.anchor_start, end: row.anchor_end }
      : null,
  };
}

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
  if (link.kind === 'book') {
    // Ganzes Buch in Reihenfolge: Kapitel-Ueberschrift + Seiten (inkl. Sub-
    // Kapitel, da loadContents alle Seiten chapter-geordnet liefert).
    try {
      const { book, groups } = await loadContents({ scope: 'book', id: link.book_id });
      const sections = [];
      for (const g of groups) {
        if (g.chapter) {
          sections.push(`<h2 class="share-chapter-block__title">${escHtml(g.chapter.name || '')}</h2>`);
        }
        for (const { pd } of g.pages) {
          sections.push(`<section class="share-page-block">
            <h3 class="share-page-block__title">${escHtml(pd.name || '')}</h3>
            <div class="share-page-block__body">${pd.html || ''}</div>
          </section>`);
        }
      }
      return {
        title: book.name || '',
        html: sections.join('\n'),
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

  // SSR-Fallback zeigt nur allgemeine Anmerkungen (kein Anker, kein Reply) —
  // verankerte Threads werden client-seitig via /threads hydriert (share-reader.js).
  const comments = shareLinks.listCommentsByToken(token, { order: 'desc' })
    .filter(c => !c.parent_id && !c.anchor_bid);
  const commentsHtml = comments.length
    ? comments.map(c => `<li class="share-comments__item">
        <div class="share-comments__meta">${escHtml(c.reader_name || tServer('share.reader.anon', lang))} · ${escHtml(c.created_at)}</div>
        <div class="share-comments__body">${escHtml(c.body)}</div>
      </li>`).join('\n')
    : `<li class="share-comments__empty">${escHtml(tServer('share.reader.comments_empty', lang))}</li>`;

  const fallback = req.query?.cmt;
  const fallbackMsg = fallback === 'ok'   ? tServer('share.reader.comment_submitted', lang)
                    : fallback === 'rate' ? tServer('share.reader.comment_rate_limited', lang)
                    : fallback === 'empty'? tServer('share.reader.form_empty', lang)
                    : fallback === 'long' ? tServer('share.reader.form_error', lang)
                    : fallback === 'err'  ? tServer('share.reader.form_error', lang)
                    : '';
  const fallbackBlock = fallbackMsg
    ? `<div class="share-comments__status share-comments__status--${escHtml(String(fallback))}" role="status">${escHtml(fallbackMsg)}</div>`
    : '';
  const formBlock = `${fallbackBlock}<form id="share-comment-form" class="share-comments__form" autocomplete="off"
      method="POST" action="/share/${escHtml(token)}/comment"
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

  // Reader-Config (Token + i18n) fuer share-reader.js. JSON in <script type=
  // "application/json"> — `<` escapen, damit kein `</script>`-Breakout moeglich.
  const readerKeys = ['anchor_cta', 'composer_title', 'composer_general_title', 'reply',
    'reply_placeholder', 'send', 'cancel', 'you_badge', 'author_badge', 'resolved_badge',
    'jump_to_text', 'anchor_stale', 'threads_heading', 'threads_empty', 'quote_label',
    'your_name', 'anon', 'comment_form_body', 'comment_form_submit', 'comment_submitted',
    'comment_rate_limited', 'form_empty', 'form_error'];
  const readerI18n = {};
  for (const k of readerKeys) readerI18n[k] = tServer(`share.reader.${k}`, lang);
  const configJson = JSON.stringify({ token, lang, i18n: readerI18n }).replace(/</g, '\\u003c');

  // Bei Buch-Shares ist content.title bereits der Buchname — keine Doppelung
  // (Buch-Zeile leer, H1 = Buchname). Sonst "Seite/Kapitel · Buch".
  const isBook = link.kind === 'book';
  const html = fillTemplate(TEMPLATE_OK, {
    lang,
    config_json: configJson,
    title: escHtml(isBook ? content.title : `${content.title} · ${link.book_name}`),
    book_name: escHtml(isBook ? '' : (link.book_name || '')),
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
router.post('/:token/comment', commentBody, (req, res) => {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  const wantsJson = ct.startsWith('application/json');
  const respond = (status, errorCode, extra) => {
    if (wantsJson) return res.status(status).json({ error_code: errorCode, ...(extra || {}) });
    const flag = errorCode === 'BODY_REQUIRED' ? 'empty'
              : errorCode === 'BODY_TOO_LONG' ? 'long'
              : errorCode === 'NAME_TOO_LONG' ? 'long'
              : errorCode === 'RATE_LIMITED'  ? 'rate'
              : errorCode === 'GONE'          ? 'gone'
              : errorCode === 'NOT_FOUND'     ? 'gone'
              : 'err';
    res.redirect(303, `/share/${encodeURIComponent(token)}?cmt=${flag}`);
  };

  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(token)) return respond(404, 'NOT_FOUND');
  const link = shareLinks.getShareLinkByToken(token);
  if (!link) return respond(404, 'NOT_FOUND');
  setContext({ book: link.book_id });
  if (isExpired(link)) return respond(410, 'GONE');

  const body = String((req.body?.body || '')).trim();
  const readerName = String((req.body?.reader_name || '')).trim();
  const hp = String((req.body?._hp || '')).trim();
  if (hp) {
    logger.warn(`[share/comment] honeypot triggered token=${token.slice(0, 8)}`);
    return respond(400, 'INVALID');
  }
  if (!body) return respond(400, 'BODY_REQUIRED');
  if (body.length > BODY_MAX) return respond(400, 'BODY_TOO_LONG');
  if (readerName.length > READER_NAME_MAX) return respond(400, 'NAME_TOO_LONG');

  // Optionale Anker-/Thread-/Identitaets-Felder (nur JSON-Pfad; No-JS-Form
  // schickt sie nicht → allgemeine Anmerkung). Defensiv validiert.
  const readerTokenRaw = String((req.body?.reader_token || '')).trim();
  const readerToken = READER_TOKEN_RE.test(readerTokenRaw) ? readerTokenRaw : null;

  let parentId = null;
  let anchorBid = null;
  let anchorQuote = null;
  let anchorStart = null;
  let anchorEnd = null;

  if (req.body?.parent_id != null && req.body.parent_id !== '') {
    parentId = parseInt(req.body.parent_id, 10);
    if (!Number.isInteger(parentId)) return respond(400, 'INVALID_PARENT');
    const parent = shareLinks.getCommentById(parentId);
    // Antwort nur auf einen Root-Kommentar DIESES Links (Threads eine Ebene tief).
    if (!parent || parent.share_token !== token || parent.parent_id) {
      return respond(400, 'INVALID_PARENT');
    }
    // Anker wird vom Root geerbt — eingehende Anker-Felder bei Replies ignoriert.
  } else if (req.body?.anchor_bid != null && req.body.anchor_bid !== '') {
    anchorBid = String(req.body.anchor_bid).trim().toLowerCase();
    if (!ANCHOR_BID_RE.test(anchorBid)) return respond(400, 'INVALID_ANCHOR');
    anchorQuote = String(req.body?.anchor_quote || '').slice(0, ANCHOR_QUOTE_MAX);
    const s = parseInt(req.body?.anchor_start, 10);
    const e = parseInt(req.body?.anchor_end, 10);
    if (Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e > s) {
      anchorStart = s;
      anchorEnd = e;
    }
  }

  const ip = req.ip || req.connection?.remoteAddress || '';
  const ipHash = rateLimit.hashIp(ip);
  const rl = rateLimit.check(token, ipHash);
  if (!rl.allowed) {
    logger.warn(`[share/comment] rate-limit token=${token.slice(0, 8)} ipHash=${ipHash}`);
    res.setHeader('Retry-After', String(rl.retryAfterSec));
    return respond(429, 'RATE_LIMITED', { retry_after: rl.retryAfterSec });
  }

  try {
    const comment = shareLinks.insertComment({
      token,
      readerName: readerName || null,
      readerToken,
      body,
      ipHash,
      parentId,
      anchorBid,
      anchorQuote,
      anchorStart,
      anchorEnd,
    });
    logger.info(`[share/comment] new token=${token.slice(0, 8)} book=${link.book_id} bytes=${body.length} anchored=${!!anchorBid} reply=${!!parentId}`);
    // Owner per Mail benachrichtigen (fire-and-forget, gedrosselt, opt-out).
    notify.maybeNotifyShareComment(link, comment).catch(() => {});
    if (wantsJson) {
      return res.json({ ok: true, comment: serializeCommentForReader(comment, readerToken) });
    }
    return res.redirect(303, `/share/${encodeURIComponent(token)}?cmt=ok`);
  } catch (e) {
    logger.error('[share/comment] DB-Fehler: ' + e.message);
    respond(500, 'DB_ERROR');
  }
});

// ── Public: Threads (verankerte + allgemeine Kommentare) als JSON ───────────
// Reader-Frontend hydriert daraus Inline-Highlights + Thread-Popover. `rt` =
// Reader-Token des Browsers (optional, fuer Self-Erkennung). no-store.
router.get('/:token/threads', (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(token)) return res.status(404).json({ error_code: 'NOT_FOUND' });
  const link = shareLinks.getShareLinkByToken(token);
  if (!link) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (isExpired(link)) return res.status(410).json({ error_code: 'GONE' });
  const rtRaw = String(req.query?.rt || '').trim();
  const readerToken = READER_TOKEN_RE.test(rtRaw) ? rtRaw : null;
  try {
    const rows = shareLinks.listCommentsByToken(token, { order: 'asc' });
    res.set('Cache-Control', 'no-store');
    res.json({ comments: rows.map(r => serializeCommentForReader(r, readerToken)) });
  } catch (e) {
    logger.error('[share/threads GET] ' + e.message);
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

// Pro-Seite-Zähler offener Reviewer-Kommentare über alle Links des Buchs
// (Page-, Chapter- und Book-Shares). Befüllt den Badge am „Teilen"-Menü und
// im Tree. Page-Shares: direkt via link.page_id. Chapter/Book-Shares: verankerte
// Kommentare via anchor_bid → Seite (Block-Scan über den Content-Store, nur
// einmal pro Buch und nur wenn überhaupt verankerte Kommentare vorliegen);
// nicht-verankerte Kommentare lassen sich keiner Seite zuordnen und zählen nicht.
router.get('/api/page-comment-counts', requireSession, async (req, res) => {
  const ownerEmail = req.session.user.email;
  const bookId = parseInt(req.query.book_id, 10);
  if (!Number.isInteger(bookId) || bookId <= 0) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: bookId });
  try {
    const rows = shareLinks.openReaderCommentsForBook(ownerEmail, bookId);
    const counts = {};
    const bump = (pageId) => { if (pageId) counts[pageId] = (counts[pageId] || 0) + 1; };

    // Block-IDs der noch aufzulösenden, verankerten Kommentare sammeln.
    const pendingBids = new Set();
    for (const r of rows) {
      if (r.kind === 'page') bump(r.page_id);
      else if (r.anchor_bid) pendingBids.add(String(r.anchor_bid).toLowerCase());
    }

    // Block→Seite-Map nur bauen, wenn nötig (ein Scan über die Buch-Seiten).
    if (pendingBids.size) {
      const bidToPage = {};
      const pages = await contentStore.listPages(bookId);
      for (const meta of pages) {
        const pd = await contentStore.loadPage(meta.id);
        const html = pd.html || '';
        for (const bid of pendingBids) {
          if (bidToPage[bid] === undefined && html.includes(`data-bid="${bid}"`)) bidToPage[bid] = meta.id;
        }
      }
      for (const r of rows) {
        if (r.kind !== 'page' && r.anchor_bid) bump(bidToPage[String(r.anchor_bid).toLowerCase()]);
      }
    }
    res.json(counts);
  } catch (e) {
    logger.error('[share/api/page-comment-counts GET] ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

// Volle Kommentar-Threads über alle Links eines Owners zu einem Buch. Speist die
// Kommentar-Leiste der Leseansicht: der Client gruppiert zu Threads und filtert
// per Anker (data-bid/quote) auf die aktuell gerenderte Seite. Jede Zeile trägt
// share_token → Reply/Resolve/Delete nutzen die bestehenden Owner-Endpoints.
router.get('/api/book-comments/:book_id', requireSession, (req, res) => {
  const ownerEmail = req.session.user.email;
  const bookId = parseInt(req.params.book_id, 10);
  if (!Number.isInteger(bookId) || bookId <= 0) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: bookId });
  try {
    const rows = shareLinks.listCommentsByOwnerBook(ownerEmail, bookId);
    if (req.query.mark_seen === '1') shareLinks.markOwnerSeenForBook(ownerEmail, bookId);
    res.json(rows);
  } catch (e) {
    logger.error('[share/api/book-comments GET] ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

router.post('/api/links', requireSession, jsonBody, async (req, res) => {
  const ownerEmail = req.session.user.email;
  const { kind, page_id, chapter_id, book_id, intro, expires_at } = req.body || {};
  if (kind !== 'page' && kind !== 'chapter' && kind !== 'book') return res.status(400).json({ error_code: 'INVALID_KIND' });
  if (kind === 'page' && !Number.isInteger(parseInt(page_id, 10))) return res.status(400).json({ error_code: 'PAGE_ID_REQUIRED' });
  if (kind === 'chapter' && !Number.isInteger(parseInt(chapter_id, 10))) return res.status(400).json({ error_code: 'CHAPTER_ID_REQUIRED' });
  if (kind === 'book' && !Number.isInteger(parseInt(book_id, 10))) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
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
    } else if (kind === 'chapter') {
      chapterId = parseInt(chapter_id, 10);
      const ch = await contentStore.loadChapter(chapterId);
      bookId = ch.book_id;
    } else {
      bookId = parseInt(book_id, 10);
      const b = await contentStore.loadBook(bookId);
      if (!b) throw new Error('book not found');
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

// Owner-Sprung: ordnet einen verankerten Kommentar (Block via data-bid) der
// konkreten Seite zu, damit der Editor sie öffnen kann. Page-Share = trivial;
// Chapter-Share = Block in den Kapitel-Seiten suchen (Anker speichert keine
// page_id).
router.get('/api/links/:token/locate', requireSession, async (req, res) => {
  const ownerEmail = req.session.user.email;
  const token = String(req.params.token || '');
  const link = shareLinks.getShareLinkByToken(token);
  if (!link || link.owner_email !== ownerEmail) return res.status(404).json({ error_code: 'NOT_FOUND' });
  setContext({ book: link.book_id });
  const bid = String(req.query?.bid || '').toLowerCase();
  if (!ANCHOR_BID_RE.test(bid)) return res.status(400).json({ error_code: 'INVALID_ANCHOR' });
  if (link.kind === 'page') return res.json({ page_id: link.page_id });
  try {
    // Chapter-Share: nur Kapitel-Seiten; Book-Share: alle Buch-Seiten.
    const pages = await contentStore.listPages(link.book_id);
    const candidates = link.kind === 'book'
      ? pages
      : pages.filter(p => p.chapter_id === link.chapter_id);
    for (const meta of candidates) {
      const pd = await contentStore.loadPage(meta.id);
      if ((pd.html || '').includes(`data-bid="${bid}"`)) return res.json({ page_id: meta.id });
    }
    res.json({ page_id: null });
  } catch (e) {
    logger.error('[share/api/links/locate GET] ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

// Owner antwortet auf einen Root-Kommentar (Thread bidirektional).
router.post('/api/links/:token/comments', requireSession, jsonBody, (req, res) => {
  const ownerEmail = req.session.user.email;
  const token = String(req.params.token || '');
  const link = shareLinks.getShareLinkByToken(token);
  if (!link || link.owner_email !== ownerEmail) return res.status(404).json({ error_code: 'NOT_FOUND' });
  setContext({ book: link.book_id });
  const body = String((req.body?.body || '')).trim();
  if (!body) return res.status(400).json({ error_code: 'BODY_REQUIRED' });
  if (body.length > BODY_MAX) return res.status(400).json({ error_code: 'BODY_TOO_LONG' });
  const parentId = parseInt(req.body?.parent_id, 10);
  if (!Number.isInteger(parentId)) return res.status(400).json({ error_code: 'INVALID_PARENT' });
  const parent = shareLinks.getCommentById(parentId);
  if (!parent || parent.share_token !== token || parent.parent_id) return res.status(400).json({ error_code: 'INVALID_PARENT' });
  try {
    const reply = shareLinks.insertOwnerReply({ token, parentId, authorEmail: ownerEmail, body });
    logger.info(`[share/api/reply] token=${token.slice(0, 8)} book=${link.book_id} parent=${parentId}`);
    res.json(reply);
  } catch (e) {
    logger.error('[share/api/reply POST] ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

// Owner markiert einen Root-Thread als erledigt / oeffnet ihn wieder.
router.patch('/api/comments/:id/resolve', requireSession, jsonBody, (req, res) => {
  const ownerEmail = req.session.user.email;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const resolved = req.body?.resolved !== false;
  try {
    const ok = shareLinks.setCommentResolved(id, ownerEmail, resolved);
    if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
    res.json({ ok: true, resolved });
  } catch (e) {
    logger.error('[share/api/comments resolve PATCH] ' + e.message);
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
