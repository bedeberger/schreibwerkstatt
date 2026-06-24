'use strict';
// Share-Link-Routes: Public-Reader (GET /share/:token, POST .../comment) +
// Auth-Owner-API (GET/POST/PATCH/DELETE /share/api/...).
//
// Mount in server.js VOR Auth-Guard, damit Reader-Route ohne Session
// erreichbar bleibt. Owner-API-Routen prüfen Session selbst.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const contentStore = require('../lib/content-store');
const { loadContents } = require('../lib/load-contents');
const shareLinks = require('../db/share-links');
const rateLimit = require('../lib/share-ratelimit');
const { requireBookAccess, sendACLError, ACLError } = require('../lib/acl');
const { setContext } = require('../lib/log-context');
const { tServer, tServerParams } = require('../lib/i18n-server');
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

// Geteilter Manuskript-Stream-Renderer (public/js/, ESM) lazy + gecacht laden,
// Muster wie lib/prompts-loader.js. SSoT für den Stream-Look von Bucheditor,
// Fassungen-Reader und Share.
let _streamPromise = null;
function getStream() {
  if (_streamPromise) return _streamPromise;
  _streamPromise = (async () => {
    const base = path.join(__dirname, '..', 'public', 'js');
    const [render, model] = await Promise.all([
      import(pathToFileURL(path.join(base, 'manuscript-render.js')).href),
      import(pathToFileURL(path.join(base, 'manuscript-stream.js')).href),
    ]);
    return { renderStreamHtml: render.renderStreamHtml, fromGroups: model.fromGroups };
  })();
  return _streamPromise;
}

async function loadContentForLink(link) {
  if (link.kind === 'page') {
    try {
      const pd = await contentStore.loadPage(link.page_id);
      return {
        title: pd.name || '',
        html: pd.html || '',
        toc: [],
      };
    } catch {
      return null;
    }
  }
  if (link.kind === 'book') {
    // Ganzes Buch in Reihenfolge: Kapitel-Ueberschrift (h2) + Seiten (h3),
    // inkl. Sub-Kapitel (loadContents liefert alle Seiten chapter-geordnet).
    try {
      const { book, groups } = await loadContents({ scope: 'book', id: link.book_id });
      const { renderStreamHtml, fromGroups } = await getStream();
      const { html, toc } = renderStreamHtml(fromGroups(groups));
      return { title: book.name || '', html, toc };
    } catch {
      return null;
    }
  }
  // chapter — alle Seiten des Kapitels (ohne Sub-Kapitel, MVP). Kapitelname
  // steht bereits im Seiten-Header (h1), darum kein Kapitel-Heading im Body
  // (omitChapterHeaders) und Seiten als h2.
  try {
    const chapter = await contentStore.loadChapter(link.chapter_id);
    const pages = await contentStore.listPages(link.book_id);
    const chapterPages = pages
      .filter(p => p.chapter_id === link.chapter_id)
      .sort((a, b) => (a.position || 0) - (b.position || 0));
    const groupPages = [];
    for (const meta of chapterPages) {
      const pd = await contentStore.loadPage(meta.id);
      groupPages.push({ pd });
    }
    const { renderStreamHtml, fromGroups } = await getStream();
    const entries = fromGroups([{ chapterId: link.chapter_id, chapter, pages: groupPages }]);
    const { html, toc } = renderStreamHtml(entries, { pageTag: 'h2', omitChapterHeaders: true });
    return {
      title: chapter.name || chapter.chapter_name || '',
      html,
      toc,
    };
  } catch {
    return null;
  }
}

// Inhaltsverzeichnis fuer Buch-/Kapitel-Shares (nur wenn show_toc aktiv und
// mehr als ein Eintrag vorhanden — ein Single-Eintrag-TOC bringt nichts).
// Gerendert als linke Leiste (Pendant zur Bucheditor-Outline): im Grid sticky
// links, gestapelt (mobil) als Box ueber dem Inhalt.
function buildTocBlock(content, lang) {
  if (!content?.toc || content.toc.length < 2) return '';
  const items = content.toc.map(e =>
    `<li class="share-toc__item share-toc__item--l${e.level}"><a class="share-toc__link" href="#${escHtml(e.anchor)}">${escHtml(e.label)}</a></li>`
  ).join('');
  const heading = escHtml(tServer('share.reader.toc_heading', lang));
  return `<aside class="share-toc">
    <nav class="share-toc__inner" aria-label="${heading}">
      <h2 class="share-toc__heading">${heading}</h2>
      <ol class="share-toc__list">${items}</ol>
    </nav>
  </aside>`;
}

// Block-ID → Seite auflösen, mit Per-Buch-Memo. Verankerte Kommentare speichern
// nur die data-bid (keine page_id — Blöcke können zwischen Seiten wandern); die
// Zuordnung ergibt sich erst aus dem aktuellen Seiteninhalt. Da page-comment-counts
// bei jedem Tree-Refresh läuft, wird das Ergebnis pro Buch gecacht und über eine
// günstige Signatur (Seitenzahl + max updated_at, beides aus den Metadaten ohne
// HTML-Load) invalidiert. Nicht gefundene Bids werden als null gecacht (Block
// gelöscht / nie auf einer Seite); eine spätere Bearbeitung bumpt updated_at und
// verwirft den Cache. data-bid ist buchweit eindeutig → Scope = alle Buch-Seiten.
const _bidPageCache = new Map(); // bookId → { sig, map: { bid → pageId|null } }

async function resolveBidsToPages(bookId, bids) {
  const wanted = [...bids];
  if (!wanted.length) return {};
  const metas = await contentStore.listPages(bookId);
  let maxUpdated = '';
  for (const m of metas) { if (m.updated_at && m.updated_at > maxUpdated) maxUpdated = m.updated_at; }
  const sig = `${metas.length}:${maxUpdated}`;
  let entry = _bidPageCache.get(bookId);
  if (!entry || entry.sig !== sig) { entry = { sig, map: {} }; _bidPageCache.set(bookId, entry); }

  const remaining = new Set(wanted.filter(b => entry.map[b] === undefined));
  if (remaining.size) {
    for (const meta of metas) {
      if (!remaining.size) break; // alle gesuchten Bids gefunden → Scan abbrechen
      const pd = await contentStore.loadPage(meta.id);
      const html = pd.html || '';
      for (const b of [...remaining]) {
        if (html.includes(`data-bid="${b}"`)) { entry.map[b] = meta.id; remaining.delete(b); }
      }
    }
    for (const b of remaining) entry.map[b] = null; // nicht auffindbar
  }
  const out = {};
  for (const b of wanted) out[b] = entry.map[b] ?? null;
  return out;
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

  const introAuthor = link.owner_display_name || tServer('share.reader.anon_author', lang);
  const introLabel = tServerParams('share.reader.intro_label', { name: introAuthor }, lang);
  const introBlock = link.intro
    ? `<aside class="share-intro" aria-label="${escHtml(introLabel)}">
      <div class="share-intro__label">${escHtml(introLabel)}</div>
      <div class="share-intro__body">${paragraphifyIntro(link.intro)}</div>
    </aside>`
    : '';

  const tocBlock = link.show_toc ? buildTocBlock(content, lang) : '';
  const layoutClass = tocBlock ? 'share-layout--has-toc' : '';

  // SSR-Fallback zeigt nur allgemeine Anmerkungen (kein Anker, kein Reply) in der
  // unteren Sektion. Verankerte Threads werden client-seitig via /threads in die
  // schwebende Leiste hydriert (share-reader.js) — ohne JS nicht positionierbar,
  // daher SSR-Rail leer.
  const comments = shareLinks.listCommentsByToken(token, { order: 'desc' })
    .filter(c => !c.parent_id && !c.anchor_bid);
  const generalCommentsHtml = comments.length
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
    'jump_to_text', 'anchor_stale', 'anchor_changed', 'threads_heading', 'threads_empty',
    'your_name', 'comment_as', 'change_name', 'set_name', 'name_modal_title', 'name_modal_intro',
    'name_modal_save', 'name_modal_skip', 'anon', 'comment_form_body', 'comment_form_submit',
    'comment_submitted', 'comment_rate_limited', 'form_empty', 'form_error', 'comments_empty',
    'options_label', 'theme_label', 'theme_auto', 'theme_light', 'theme_dark',
    'delete', 'delete_confirm', 'mark_done', 'reopen', 'delete_has_replies'];
  const readerI18n = {};
  for (const k of readerKeys) readerI18n[k] = tServer(`share.reader.${k}`, lang);
  const configJson = JSON.stringify({ token, lang, i18n: readerI18n }).replace(/</g, '\\u003c');

  // Bei Buch-Shares ist content.title bereits der Buchname — keine Doppelung
  // (Buch-Zeile leer, H1 = Buchname). Sonst "Seite/Kapitel · Buch".
  const isBook = link.kind === 'book';
  const html = fillTemplate(TEMPLATE_OK, {
    lang,
    config_json: configJson,
    layout_class: layoutClass,
    title: escHtml(isBook ? content.title : `${content.title} · ${link.book_name}`),
    book_name: escHtml(isBook ? '' : (link.book_name || '')),
    target_name: escHtml(content.title),
    author_name: escHtml(link.owner_display_name || tServer('share.reader.anon_author', lang)),
    t_by: escHtml(tServer('share.reader.by', lang)),
    t_skip: escHtml(tServer('share.reader.skip_to_content', lang)),
    t_comments: escHtml(tServer('share.reader.comments_heading', lang)),
    t_general_heading: escHtml(tServer('share.reader.general_heading', lang)),
    intro_block: introBlock,
    toc_block: tocBlock,
    content_html: content.html,
    anchored_comments_html: '',
    general_comments_html: generalCommentsHtml,
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

// ── Public: Reader-Namen nachträglich ändern ────────────────────────────────
// Setzt der Leser oben rechts einen neuen (oder leeren) Namen, ziehen ALLE
// seiner bisherigen Kommentare unter diesem Link auf den neuen Namen nach —
// Zuordnung über sein Browser-reader_token (kein Auth, Self-Identität). Leerer
// Name → anonymisiert (reader_name = NULL).
router.post('/:token/reader-name', commentBody, (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(token)) return res.status(404).json({ error_code: 'NOT_FOUND' });
  const link = shareLinks.getShareLinkByToken(token);
  if (!link) return res.status(404).json({ error_code: 'NOT_FOUND' });
  setContext({ book: link.book_id });
  if (isExpired(link)) return res.status(410).json({ error_code: 'GONE' });

  const rtRaw = String(req.body?.reader_token || '').trim();
  if (!READER_TOKEN_RE.test(rtRaw)) return res.status(400).json({ error_code: 'INVALID_TOKEN' });
  const newName = String(req.body?.reader_name || '').trim();
  if (newName.length > READER_NAME_MAX) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });

  try {
    const changed = shareLinks.renameReaderComments(token, rtRaw, newName || null);
    res.json({ ok: true, updated: changed });
  } catch (e) {
    logger.error('[share/reader-name POST] ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

// ── Public: eigenen Kommentar als erledigt markieren / wieder öffnen ─────────
// Leser-Self-Service über sein Browser-reader_token (kein Auth). Nur eigene
// Root-Threads; teilt die resolved_at-Spalte mit dem Owner-Resolve.
router.patch('/:token/comment/:id/resolve', commentBody, (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(token)) return res.status(404).json({ error_code: 'NOT_FOUND' });
  const link = shareLinks.getShareLinkByToken(token);
  if (!link) return res.status(404).json({ error_code: 'NOT_FOUND' });
  setContext({ book: link.book_id });
  if (isExpired(link)) return res.status(410).json({ error_code: 'GONE' });

  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error_code: 'INVALID_ID' });
  const rtRaw = String(req.body?.reader_token || '').trim();
  if (!READER_TOKEN_RE.test(rtRaw)) return res.status(400).json({ error_code: 'INVALID_TOKEN' });
  const resolved = req.body?.resolved !== false;

  try {
    const ok = shareLinks.setReaderCommentResolved(id, token, rtRaw, resolved);
    if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
    res.json({ ok: true, resolved });
  } catch (e) {
    logger.error('[share/comment resolve PATCH] ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

// ── Public: eigenen Kommentar löschen ───────────────────────────────────────
// Self-Service via reader_token. Hart löschen nur, wenn der Beitrag KEINE
// Antworten hat — sonst würde der Owner-Reply per CASCADE still verschwinden
// (→ 409 HAS_REPLIES, Frontend bietet dann nur „Erledigt" an).
router.delete('/:token/comment/:id', commentBody, (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(token)) return res.status(404).json({ error_code: 'NOT_FOUND' });
  const link = shareLinks.getShareLinkByToken(token);
  if (!link) return res.status(404).json({ error_code: 'NOT_FOUND' });
  setContext({ book: link.book_id });
  if (isExpired(link)) return res.status(410).json({ error_code: 'GONE' });

  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error_code: 'INVALID_ID' });
  const rtRaw = String(req.body?.reader_token || '').trim();
  if (!READER_TOKEN_RE.test(rtRaw)) return res.status(400).json({ error_code: 'INVALID_TOKEN' });

  try {
    const own = shareLinks.getReaderComment(id, token, rtRaw);
    if (!own) return res.status(404).json({ error_code: 'NOT_FOUND' });
    if (shareLinks.commentHasReplies(id)) return res.status(409).json({ error_code: 'HAS_REPLIES' });
    const ok = shareLinks.deleteReaderComment(id, token, rtRaw);
    if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
    logger.info(`[share/comment DELETE] token=${token.slice(0, 8)} book=${link.book_id} id=${id}`);
    res.json({ ok: true });
  } catch (e) {
    logger.error('[share/comment DELETE] ' + e.message);
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

    // Block→Seite-Map nur bauen, wenn nötig (gecachter Scan über die Buch-Seiten).
    if (pendingBids.size) {
      const bidToPage = await resolveBidsToPages(bookId, pendingBids);
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

// Pro-Seite-Zähler aktiver Share-Links, die diese Seite enthalten. Speist den
// `.btn-count`-Badge am „Teilen"-Eintrag des Page-Action-Menüs. Eine Seite ist
// enthalten in: einem Page-Share auf sie selbst, einem Chapter-Share auf ihr
// Kapitel (Direkt-Children, analog Reader-Render) und jedem Buch-Share des Buchs.
router.get('/api/page-link-counts', requireSession, async (req, res) => {
  const ownerEmail = req.session.user.email;
  const bookId = parseInt(req.query.book_id, 10);
  if (!Number.isInteger(bookId) || bookId <= 0) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: bookId });
  try {
    const links = shareLinks.activeLinksForOwnerBook(ownerEmail, bookId);
    let bookCount = 0;
    const chapterCount = {};
    const pageCount = {};
    for (const l of links) {
      if (l.kind === 'book') bookCount++;
      else if (l.kind === 'chapter' && l.chapter_id != null) chapterCount[l.chapter_id] = (chapterCount[l.chapter_id] || 0) + 1;
      else if (l.kind === 'page' && l.page_id != null) pageCount[l.page_id] = (pageCount[l.page_id] || 0) + 1;
    }
    const counts = {};
    const pages = await contentStore.listPages(bookId);
    for (const p of pages) {
      const n = bookCount
        + (p.chapter_id != null ? (chapterCount[p.chapter_id] || 0) : 0)
        + (pageCount[p.id] || 0);
      if (n > 0) counts[p.id] = n;
    }
    res.json(counts);
  } catch (e) {
    logger.error('[share/api/page-link-counts GET] ' + e.message);
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
  const { kind, page_id, chapter_id, book_id, intro, expires_at, show_toc } = req.body || {};
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
      showToc: !!show_toc,
    });

    // Verankerte Leser-Kommentare + die schwebende Kommentar-Leiste haengen an
    // data-bid auf den Bloecken (share-anchor.js). data-bid entsteht sonst nur am
    // Editor-Write-Chokepoint — Legacy-/Import-Seiten haben keine. Beim Anlegen des
    // Links die betroffenen Seiten (je Scope) einmalig nachziehen: additiv, ohne
    // updated_at-Bump/Revision. Best-effort — ein Fehler darf das Teilen nie
    // abbrechen.
    try {
      let pageIds;
      if (kind === 'page') {
        pageIds = [pageId];
      } else {
        const pages = await contentStore.listPages(bookId);
        pageIds = (kind === 'chapter' ? pages.filter(p => p.chapter_id === chapterId) : pages).map(p => p.id);
      }
      let n = 0;
      for (const pid of pageIds) {
        try { if ((await contentStore.backfillBlockIds(pid)).changed) n++; } catch { /* per-page best-effort */ }
      }
      if (n) logger.info(`[share/api/links POST] data-bid backfill auf ${n}/${pageIds.length} Seiten (kind=${kind} book=${bookId})`);
    } catch (e) {
      logger.warn('[share/api/links POST] data-bid backfill fehlgeschlagen: ' + e.message);
    }

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
  if ('show_toc' in (req.body || {})) {
    patch.showToc = !!req.body.show_toc;
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
    // data-bid ist buchweit eindeutig → gecachter Scan über alle Buch-Seiten
    // (teilt den Cache mit page-comment-counts).
    const map = await resolveBidsToPages(link.book_id, new Set([bid]));
    res.json({ page_id: map[bid] || null });
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
