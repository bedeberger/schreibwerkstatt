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
const { toIntId } = require('../lib/validate');
const { getTokenForRequest, getAnyUserToken } = require('../db/schema');
const { setContext, bookParamHandler } = require('../lib/log-context');

const router = express.Router();
router.param('book_id', bookParamHandler);

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

// GET /content/books — Liste aller fuer den User sichtbaren Buecher.
router.get('/books', async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  try { res.json(await contentStore.listBooks(token)); }
  catch (e) { _fail(res, e, 'GET /content/books'); }
});

// GET /content/books/:book_id — Buch-Detail.
router.get('/books/:book_id', async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  try { res.json(await contentStore.loadBook(bookId, token)); }
  catch (e) { _fail(res, e, 'GET /content/books/:id'); }
});

// GET /content/books/:book_id/tree — Hierarchie als `{ chapters, topPages }`.
router.get('/books/:book_id/tree', async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  try { res.json(await contentStore.bookTree(bookId, token)); }
  catch (e) { _fail(res, e, 'GET /content/books/:id/tree'); }
});

// GET /content/chapters/:chapter_id — Kapitel-Detail.
router.get('/chapters/:chapter_id', async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const chapterId = toIntId(req.params.chapter_id);
  if (!chapterId) return res.status(400).json({ error_code: 'INVALID_CHAPTER_ID' });
  try {
    const ch = await contentStore.loadChapter(chapterId, token);
    if (ch?.book_id) setContext({ book: ch.book_id });
    res.json(ch);
  } catch (e) { _fail(res, e, 'GET /content/chapters/:id'); }
});

// GET /content/pages/:page_id — Volltext + Metadaten.
router.get('/pages/:page_id', async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  try {
    const page = await contentStore.loadPage(pageId, token);
    if (page?.book_id) setContext({ book: page.book_id });
    res.json(page);
  } catch (e) { _fail(res, e, 'GET /content/pages/:id'); }
});

// PUT /content/pages/:page_id — Speichert Body+Name, optional auch
// Position+Kapitel (Drag/Drop im Book-Organizer).
router.put('/pages/:page_id', jsonBody, async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  try {
    const updated = await contentStore.savePage(pageId, req.body || {}, token);
    if (updated?.book_id) setContext({ book: updated.book_id });
    res.json(updated);
  } catch (e) {
    if (e.code === 'EMPTY_BODY') return res.status(400).json({ error_code: 'EMPTY_BODY' });
    _fail(res, e, 'PUT /content/pages/:id');
  }
});

// POST /content/pages — Neue Seite. Body: { book_id?, chapter_id?, name, html? }.
// Mindestens einer von book_id/chapter_id ist Pflicht.
router.post('/pages', jsonBody, async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const bookId = req.body?.book_id !== undefined ? toIntId(req.body.book_id) : null;
  const chapterId = req.body?.chapter_id !== undefined ? toIntId(req.body.chapter_id) : null;
  const name = (req.body?.name || '').toString().trim();
  if (!name) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
  if (!bookId && !chapterId) return res.status(400).json({ error_code: 'BOOK_OR_CHAPTER_REQUIRED' });
  try {
    if (bookId) setContext({ book: bookId });
    const created = await contentStore.createPage({
      book_id: bookId || undefined,
      chapter_id: chapterId || undefined,
      name,
      html: req.body?.html,
    }, token);
    if (created?.book_id) setContext({ book: created.book_id });
    res.json(created);
  } catch (e) { _fail(res, e, 'POST /content/pages'); }
});

// DELETE /content/pages/:page_id — Seite in den Papierkorb.
router.delete('/pages/:page_id', async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  try {
    await contentStore.deletePage(pageId, token);
    res.json({ ok: true });
  } catch (e) { _fail(res, e, 'DELETE /content/pages/:id'); }
});

// POST /content/chapters — Neues Kapitel. Body: { book_id, name, position?, description? }.
router.post('/chapters', jsonBody, async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const bookId = toIntId(req.body?.book_id);
  const name = (req.body?.name || '').toString().trim();
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  if (!name) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
  try {
    setContext({ book: bookId });
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
  const token = _requireToken(req, res);
  if (!token) return;
  const chapterId = toIntId(req.params.chapter_id);
  if (!chapterId) return res.status(400).json({ error_code: 'INVALID_CHAPTER_ID' });
  const hasName = typeof req.body?.name === 'string';
  const hasPos = Number.isFinite(req.body?.position);
  const hasDesc = typeof req.body?.description === 'string';
  if (!hasName && !hasPos && !hasDesc) {
    return res.status(400).json({ error_code: 'EMPTY_BODY' });
  }
  try {
    const updated = await contentStore.updateChapter(chapterId, req.body || {}, token);
    if (updated?.book_id) setContext({ book: updated.book_id });
    res.json(updated);
  } catch (e) { _fail(res, e, 'PUT /content/chapters/:id'); }
});

// DELETE /content/chapters/:chapter_id — Kapitel + seine Seiten in den Papierkorb.
router.delete('/chapters/:chapter_id', async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const chapterId = toIntId(req.params.chapter_id);
  if (!chapterId) return res.status(400).json({ error_code: 'INVALID_CHAPTER_ID' });
  try {
    await contentStore.deleteChapter(chapterId, token);
    res.json({ ok: true });
  } catch (e) { _fail(res, e, 'DELETE /content/chapters/:id'); }
});

// DELETE /content/books/:book_id — Buch (samt allem darunter) in den Papierkorb.
router.delete('/books/:book_id', async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  try {
    await contentStore.deleteBook(bookId, token);
    res.json({ ok: true });
  } catch (e) { _fail(res, e, 'DELETE /content/books/:id'); }
});

// GET /content/search?query=…&book_id=… — Volltextsuche, nur Page-Hits.
router.get('/search', async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const query = (req.query?.query || '').toString().trim();
  const bookId = req.query?.book_id ? toIntId(req.query.book_id) : null;
  const count = req.query?.count;
  if (query.length < 2) return res.json({ hits: [] });
  try {
    if (bookId) setContext({ book: bookId });
    const hits = await contentStore.searchPages(query, { bookId, count }, token);
    res.json({ hits });
  } catch (e) { _fail(res, e, 'GET /content/search'); }
});

// POST /content/books — Neues Buch anlegen. Upserted lokale `books`-Row.
router.post('/books', jsonBody, async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const name = (req.body?.name || '').toString().trim();
  const description = (req.body?.description || '').toString().trim();
  if (!name) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
  if (name.length > NAME_MAX) return res.status(400).json({ error_code: 'NAME_TOO_LONG', params: { max: NAME_MAX } });
  try {
    const created = await contentStore.createBook({ name, description }, token);
    setContext({ book: created.id });
    logger.info(`Buch erstellt id=${created.id} name="${created.name}"`);
    res.json(created);
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
