'use strict';
// Normalisierte Content-Endpunkte (Buecher, Kapitel, Seiten) im App-Domain-Shape.
//
// Diese Datei ist nur noch eine duenne HTTP-Schicht: Validierung, Token-Check,
// Logging-Context — die eigentliche Storage-Logik (inkl. Mapper + cleanPageHtml)
// lebt in [lib/content-store.js](../lib/content-store.js). Phase 1 des Exit-
// Plans tauscht den content-store-Inhalt auf Local-DB; die Routen aendern sich
// dabei nicht.

const express = require('express');
const logger = require('../logger');
const contentStore = require('../lib/content-store');
const pageRevisions = require('../db/page-revisions');
const bookOrder = require('../db/book-order');
const { toIntId } = require('../lib/validate');
const { getTokenForRequest, getAnyUserToken } = require('../db/schema');
const { setContext, bookParamHandler } = require('../lib/log-context');
const { aclParamGuard, requireBookAccess, sendACLError, ACLError } = require('../lib/acl');
const bookAccess = require('../db/book-access');
const bookTags = require('../db/book-tags');
const { db } = require('../db/connection');

const router = express.Router();
router.param('book_id', bookParamHandler);

function _userEmail(req) { return req.session?.user?.email || null; }

function _pageBookId(pageId) {
  const r = db.prepare('SELECT book_id FROM pages WHERE page_id = ?').get(parseInt(pageId, 10));
  return r?.book_id || null;
}

function _chapterBookId(chapterId) {
  const r = db.prepare('SELECT book_id FROM chapters WHERE chapter_id = ?').get(parseInt(chapterId, 10));
  return r?.book_id || null;
}

function _guardPage(req, res, pageId, minRole) {
  const bookId = _pageBookId(pageId);
  if (!bookId) { res.status(404).json({ error_code: 'PAGE_NOT_FOUND' }); return null; }
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, minRole); return bookId; }
  catch (e) { sendACLError(res, e); return null; }
}

function _guardChapter(req, res, chapterId, minRole) {
  const bookId = _chapterBookId(chapterId);
  if (!bookId) { res.status(404).json({ error_code: 'CHAPTER_NOT_FOUND' }); return null; }
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, minRole); return bookId; }
  catch (e) { sendACLError(res, e); return null; }
}

const jsonBody = express.json({ limit: '10mb' });
const NAME_MAX = 255;

function _requireToken(req, res) {
  const t = getTokenForRequest(req) || getAnyUserToken();
  if (t) return t;
  res.status(503).json({ error_code: 'NO_BOOKSTACK_TOKEN' });
  return null;
}

function _fail(res, e, opName) {
  const status = e?.status || 500;
  const bodySnippet = e?.bodyText ? ' | body: ' + String(e.bodyText).slice(0, 200) : '';
  logger.warn(`${opName} fehlgeschlagen: ${e.message}${bodySnippet}`);
  res.status(status === 401 ? 502 : status).json({
    error_code: 'CONTENT_FAILED',
    status,
    detail: e.message,
  });
}

// GET /content/books — Liste der fuer den User per book_access sichtbaren
// Buecher. Strikt gefiltert: Admin ohne Share-Row sieht leeres Array.
// Jedes Buch traegt `role` (eigene Buch-Rolle) und `owner_email` als Hint.
router.get('/books', async (req, res) => {
  const email = _userEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const accessRows = bookAccess.listBookIdsForUser(email);
  if (accessRows.length === 0) return res.json([]);
  const allowedIds = new Set(accessRows.map(r => r.book_id));
  const roleByBook = new Map(accessRows.map(r => [r.book_id, r.role]));
  const token = _requireToken(req, res);
  if (!token) return;
  try {
    const all = await contentStore.listBooks(token);
    const meta = new Map(
      db.prepare('SELECT book_id, owner_email, category_id FROM books').all()
        .map(r => [r.book_id, { owner_email: r.owner_email, category_id: r.category_id }])
    );
    const visibleIds = all.filter(b => allowedIds.has(b.id)).map(b => b.id);
    const tagsByBook = bookTags.listAssignmentsForBooks(visibleIds);
    const visible = all
      .filter(b => allowedIds.has(b.id))
      .map(b => ({
        ...b,
        role: roleByBook.get(b.id) || null,
        owner_email: meta.get(b.id)?.owner_email || null,
        category_id: meta.get(b.id)?.category_id ?? null,
        tags: tagsByBook.get(b.id) || [],
      }));
    res.json(visible);
  } catch (e) { _fail(res, e, 'GET /content/books'); }
});

// GET /content/books/:book_id — Buch-Detail.
router.get('/books/:book_id', aclParamGuard('viewer'), async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  try {
    const book = await contentStore.loadBook(req.bookId, token);
    res.json({ ...book, role: req.bookRole });
  } catch (e) { _fail(res, e, 'GET /content/books/:id'); }
});

// GET /content/books/:book_id/tree — Hierarchie als `{ chapters, topPages }`.
router.get('/books/:book_id/tree', aclParamGuard('viewer'), async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  try { res.json(await contentStore.bookTree(req.bookId, token)); }
  catch (e) { _fail(res, e, 'GET /content/books/:id/tree'); }
});

// Phase 3 (BookStack-Exit): Eigene Sortierung.
//
// GET /content/books/:book_id/order — Tree-Snapshot + Audit-Meta. Auto-init:
// keine Row -> aus aktuellen pages.position/chapters.position bauen; vorhandene
// Row gegen DB-Stand reconcilen (neue/geloeschte Items).
router.get('/books/:book_id/order', aclParamGuard('viewer'), (req, res) => {
  try {
    const data = bookOrder.ensureTree(req.bookId, _userEmail(req));
    res.json(data);
  } catch (e) { _fail(res, e, 'GET /content/books/:id/order'); }
});

// PUT /content/books/:book_id/order — Vollstaendigen Tree speichern. Body:
// `{ order_json: [...] }`. Server validiert (Schema + Vollstaendigkeit +
// Doppel-IDs) und materialisiert chapters.position/pages.position/
// pages.chapter_id in einer Transaction.
router.put('/books/:book_id/order', aclParamGuard('editor'), jsonBody, (req, res) => {
  const tree = req.body?.order_json;
  if (!Array.isArray(tree)) {
    return res.status(400).json({ error_code: 'INVALID_BODY', detail: 'order_json must be array' });
  }
  try {
    const saved = bookOrder.putOrder(req.bookId, tree, _userEmail(req));
    res.json(saved);
  } catch (e) {
    if (e instanceof bookOrder.TreeValidationError) {
      return res.status(400).json({ error_code: 'INVALID_TREE', reason: e.code, detail: e.detail });
    }
    _fail(res, e, 'PUT /content/books/:id/order');
  }
});

// GET /content/chapters/:chapter_id — Kapitel-Detail.
router.get('/chapters/:chapter_id', async (req, res) => {
  const chapterId = toIntId(req.params.chapter_id);
  if (!chapterId) return res.status(400).json({ error_code: 'INVALID_CHAPTER_ID' });
  if (_guardChapter(req, res, chapterId, 'viewer') == null) return;
  const token = _requireToken(req, res);
  if (!token) return;
  try { res.json(await contentStore.loadChapter(chapterId, token)); }
  catch (e) { _fail(res, e, 'GET /content/chapters/:id'); }
});

// GET /content/pages/:page_id — Volltext + Metadaten.
router.get('/pages/:page_id', async (req, res) => {
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  if (_guardPage(req, res, pageId, 'viewer') == null) return;
  const token = _requireToken(req, res);
  if (!token) return;
  try { res.json(await contentStore.loadPage(pageId, token)); }
  catch (e) { _fail(res, e, 'GET /content/pages/:id'); }
});

// PUT /content/pages/:page_id — Free-Edit-Pfad. minRole editor.
// Lektor nutzt /apply/pages/:id/* (Substring-Replace mit DB-Validierung).
// Blockiert durch fremden Page-Lock (lektorat-Session).
router.put('/pages/:page_id', jsonBody, async (req, res) => {
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  const bookId = _guardPage(req, res, pageId, 'editor');
  if (bookId == null) return;
  const email = _userEmail(req);
  const blocking = bookAccess.getBlockingLockFor(pageId, email);
  if (blocking) return res.status(423).json({
    error_code: 'PAGE_LOCKED',
    locked_by_email: blocking.locked_by_email,
    expires_at: blocking.expires_at,
  });
  const token = _requireToken(req, res);
  if (!token) return;
  try { res.json(await contentStore.savePage(pageId, req.body || {}, req)); }
  catch (e) {
    if (e.code === 'EMPTY_BODY') return res.status(400).json({ error_code: 'EMPTY_BODY' });
    _fail(res, e, 'PUT /content/pages/:id');
  }
});

// ── Phase 2: Page-Revisions ────────────────────────────────────────────────
// Schreib-Hook lebt in der content-store-Facade (jeder erfolgreiche
// savePage → page_revisions-Row). Routen hier sind nur Lese-Pfad + Restore.

// GET /content/pages/:page_id/revisions — Liste (ohne body_html).
router.get('/pages/:page_id/revisions', async (req, res) => {
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  if (_guardPage(req, res, pageId, 'viewer') == null) return;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  res.json({ revisions: pageRevisions.listForPage(pageId, limit) });
});

// GET /content/pages/:page_id/revisions/:rev_id — Voller Body fuer Vorschau.
router.get('/pages/:page_id/revisions/:rev_id', async (req, res) => {
  const pageId = toIntId(req.params.page_id);
  const revId = toIntId(req.params.rev_id);
  if (!pageId || !revId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (_guardPage(req, res, pageId, 'viewer') == null) return;
  const rev = pageRevisions.get(revId);
  if (!rev || rev.page_id !== pageId) return res.status(404).json({ error_code: 'REVISION_NOT_FOUND' });
  res.json({ revision: rev });
});

// POST /content/pages/:page_id/revisions/:rev_id/restore — Body der Revision
// wird via Facade als neue Revision (source='main') zurueckgeschrieben.
// Page-Lock + editor-Rolle wie der normale Save-Pfad.
router.post('/pages/:page_id/revisions/:rev_id/restore', jsonBody, async (req, res) => {
  const pageId = toIntId(req.params.page_id);
  const revId = toIntId(req.params.rev_id);
  if (!pageId || !revId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = _guardPage(req, res, pageId, 'editor');
  if (bookId == null) return;
  const email = _userEmail(req);
  const blocking = bookAccess.getBlockingLockFor(pageId, email);
  if (blocking) return res.status(423).json({
    error_code: 'PAGE_LOCKED',
    locked_by_email: blocking.locked_by_email,
    expires_at: blocking.expires_at,
  });
  const rev = pageRevisions.get(revId);
  if (!rev || rev.page_id !== pageId) return res.status(404).json({ error_code: 'REVISION_NOT_FOUND' });
  const token = _requireToken(req, res);
  if (!token) return;
  try {
    const saved = await contentStore.savePage(
      pageId,
      { html: rev.body_html, markdown: rev.body_markdown, source: 'main', summary: `restored from #${revId}` },
      req,
    );
    res.json({ ok: true, page: saved, restored_from: revId });
  } catch (e) {
    if (e.code === 'EMPTY_BODY') return res.status(400).json({ error_code: 'EMPTY_BODY' });
    _fail(res, e, 'POST /content/pages/:id/revisions/:rev/restore');
  }
});

// POST /content/pages — Neue Seite. Body: { book_id?, chapter_id?, name, html? }.
// Mindestens einer von book_id/chapter_id ist Pflicht. minRole editor.
router.post('/pages', jsonBody, async (req, res) => {
  const bookIdRaw = req.body?.book_id !== undefined ? toIntId(req.body.book_id) : null;
  const chapterIdRaw = req.body?.chapter_id !== undefined ? toIntId(req.body.chapter_id) : null;
  const name = (req.body?.name || '').toString().trim();
  if (!name) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
  if (!bookIdRaw && !chapterIdRaw) return res.status(400).json({ error_code: 'BOOK_OR_CHAPTER_REQUIRED' });
  const effBookId = bookIdRaw || _chapterBookId(chapterIdRaw);
  if (!effBookId) return res.status(404).json({ error_code: 'BOOK_NOT_FOUND' });
  setContext({ book: effBookId });
  try { requireBookAccess(req, effBookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const token = _requireToken(req, res);
  if (!token) return;
  try {
    const created = await contentStore.createPage({
      book_id: bookIdRaw || undefined,
      chapter_id: chapterIdRaw || undefined,
      name,
      html: req.body?.html,
    }, token);
    res.json(created);
  } catch (e) { _fail(res, e, 'POST /content/pages'); }
});

// DELETE /content/pages/:page_id — Seite in den Papierkorb. minRole editor.
router.delete('/pages/:page_id', async (req, res) => {
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  if (_guardPage(req, res, pageId, 'editor') == null) return;
  const token = _requireToken(req, res);
  if (!token) return;
  try {
    await contentStore.deletePage(pageId, token);
    res.json({ ok: true });
  } catch (e) { _fail(res, e, 'DELETE /content/pages/:id'); }
});

// POST /content/chapters — Neues Kapitel. Body: { book_id, name, position?, description? }.
router.post('/chapters', jsonBody, async (req, res) => {
  const bookId = toIntId(req.body?.book_id);
  const name = (req.body?.name || '').toString().trim();
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  if (!name) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const token = _requireToken(req, res);
  if (!token) return;
  try {
    const created = await contentStore.createChapter({
      book_id: bookId,
      name,
      position: req.body?.position,
      description: req.body?.description,
    }, token);
    res.json(created);
  } catch (e) { _fail(res, e, 'POST /content/chapters'); }
});

// PUT /content/chapters/:chapter_id — Kapitel-Update (rename / reorder / description).
router.put('/chapters/:chapter_id', jsonBody, async (req, res) => {
  const chapterId = toIntId(req.params.chapter_id);
  if (!chapterId) return res.status(400).json({ error_code: 'INVALID_CHAPTER_ID' });
  const hasName = typeof req.body?.name === 'string';
  const hasPos = Number.isFinite(req.body?.position);
  const hasDesc = typeof req.body?.description === 'string';
  if (!hasName && !hasPos && !hasDesc) {
    return res.status(400).json({ error_code: 'EMPTY_BODY' });
  }
  if (_guardChapter(req, res, chapterId, 'editor') == null) return;
  const token = _requireToken(req, res);
  if (!token) return;
  try { res.json(await contentStore.updateChapter(chapterId, req.body || {}, token)); }
  catch (e) { _fail(res, e, 'PUT /content/chapters/:id'); }
});

// DELETE /content/chapters/:chapter_id — Kapitel + seine Seiten in den Papierkorb.
router.delete('/chapters/:chapter_id', async (req, res) => {
  const chapterId = toIntId(req.params.chapter_id);
  if (!chapterId) return res.status(400).json({ error_code: 'INVALID_CHAPTER_ID' });
  if (_guardChapter(req, res, chapterId, 'editor') == null) return;
  const token = _requireToken(req, res);
  if (!token) return;
  try {
    await contentStore.deleteChapter(chapterId, token);
    res.json({ ok: true });
  } catch (e) { _fail(res, e, 'DELETE /content/chapters/:id'); }
});

// DELETE /content/books/:book_id — Buch loeschen. minRole owner.
router.delete('/books/:book_id', aclParamGuard('owner'), async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  try {
    await contentStore.deleteBook(req.bookId, token);
    res.json({ ok: true });
  } catch (e) { _fail(res, e, 'DELETE /content/books/:id'); }
});

// GET /content/search?query=…&book_id=… — Volltextsuche, nur Page-Hits.
// Mit book_id: viewer-Guard auf Buch. Ohne book_id: filtert auf
// book_access-Buecher des Users (Cross-Book-Suche).
router.get('/search', async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const query = (req.query?.query || '').toString().trim();
  const bookId = req.query?.book_id ? toIntId(req.query.book_id) : null;
  const count = req.query?.count;
  if (query.length < 2) return res.json({ hits: [] });
  if (bookId) {
    setContext({ book: bookId });
    try { requireBookAccess(req, bookId, 'viewer'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }
  const email = _userEmail(req);
  const allowedIds = new Set(bookAccess.listBookIdsForUser(email).map(r => r.book_id));
  try {
    const hits = await contentStore.searchPages(query, { bookId, count }, token);
    const filtered = bookId ? hits : hits.filter(h => !h.book_id || allowedIds.has(h.book_id));
    res.json({ hits: filtered });
  } catch (e) { _fail(res, e, 'GET /content/search'); }
});

// POST /content/books — Neues Buch anlegen. Anleger wird automatisch Owner
// via book_access-Row.
router.post('/books', jsonBody, async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const email = _userEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const name = (req.body?.name || '').toString().trim();
  const description = (req.body?.description || '').toString().trim();
  if (!name) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
  if (name.length > NAME_MAX) return res.status(400).json({ error_code: 'NAME_TOO_LONG', params: { max: NAME_MAX } });
  try {
    const created = await contentStore.createBook({ name, description }, token);
    setContext({ book: created.id });
    // Owner-Grant + books.owner_email setzen (idempotent).
    try {
      db.prepare(`UPDATE books SET owner_email = COALESCE(owner_email, ?) WHERE book_id = ?`)
        .run(email, created.id);
      bookAccess.grantAccess(created.id, email, 'owner', email);
    } catch (gErr) {
      logger.warn(`Auto-Owner-Grant fuer book=${created.id} fehlgeschlagen: ${gErr.message}`);
    }
    logger.info(`Buch erstellt id=${created.id} name="${created.name}" owner=${email}`);
    res.json({ ...created, role: 'owner' });
  } catch (e) {
    const status = e?.status || 500;
    let detail = '';
    try {
      const parsed = JSON.parse(e?.bodyText || '{}');
      const validation = parsed?.error?.validation;
      detail = validation && typeof validation === 'object'
        ? Object.values(validation).flat().filter(Boolean).join('; ')
        : (parsed?.error?.message || parsed?.message || '');
    } catch { /* bodyText kein JSON */ }
    logger.warn(`Buch erstellen fehlgeschlagen: ${status} ${detail || e.message}`);
    res.status(status === 401 ? 502 : status).json({
      error_code: 'CREATE_FAILED',
      status,
      detail: detail || e.message,
    });
  }
});

module.exports = router;
