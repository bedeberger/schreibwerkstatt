'use strict';
// Normalisierte Content-Endpunkte (Buecher, Kapitel, Seiten) im App-Domain-Shape.
//
// Anti-Drift gegen BookStack-API: Caller (Frontend-Repo-Layer, kuenftige
// Server-Konsumenten) bekommen `{id, name, position, …}` statt BookStack-
// spezifischer Felder (`priority`, verschachtelte Owner-Struktur etc.).
// Intern bleibt heute alles bsGet/bsPut/bsPost — Phase 1 des Exit-Plans
// (docs/bookstack-exit.md) tauscht nur das Innenleben gegen lokale DB,
// die Route-Vertraege aendern sich nicht.
//
// HTML-Sanitization fuer Page-Writes laeuft hier explizit ueber `cleanPageHtml`,
// weil der globale `bookstackPageCleaner` nur am /api-Proxy haengt.

const express = require('express');
const logger = require('../logger');
const { bsGet, bsGetAll, bsPost, bsPut } = require('../lib/bookstack');
const { mapBook, mapChapter, mapPage, mapPageMeta } = require('../lib/content-mapper');
const { cleanPageHtml } = require('../lib/html-clean');
const { toIntId } = require('../lib/validate');
const { getTokenForRequest, getAnyUserToken, upsertBook } = require('../db/schema');
const { setContext, bookParamHandler } = require('../lib/log-context');

const router = express.Router();
router.param('book_id', bookParamHandler);

const jsonBody = express.json({ limit: '10mb' });
const NAME_MAX = 255;

function _token(req) {
  return getTokenForRequest(req) || getAnyUserToken();
}

function _requireToken(req, res) {
  const t = _token(req);
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
  try {
    const books = await bsGetAll('books', token);
    res.json(books.map(mapBook));
  } catch (e) { _fail(res, e, 'GET /content/books'); }
});

// GET /content/books/:book_id — Buch-Detail (Domain-Shape).
router.get('/books/:book_id', async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  try {
    const book = await bsGet(`books/${bookId}`, token);
    res.json(mapBook(book));
  } catch (e) { _fail(res, e, 'GET /content/books/:id'); }
});

// GET /content/books/:book_id/tree — Hierarchie als `{ chapters, topPages }`.
// `chapters[i].pages` enthaelt die Seiten dieses Kapitels (positions-sortiert);
// `topPages` sind Seiten direkt unter dem Buch.
router.get('/books/:book_id/tree', async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  try {
    const [rawChapters, rawPages] = await Promise.all([
      bsGetAll(`chapters?filter[book_id]=${bookId}`, token),
      bsGetAll(`pages?filter[book_id]=${bookId}`, token),
    ]);
    const chapters = rawChapters.map(mapChapter)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const pages = rawPages.map(mapPageMeta)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const byChapter = new Map(chapters.map(c => [c.id, { ...c, pages: [] }]));
    const topPages = [];
    for (const p of pages) {
      const bucket = p.chapter_id ? byChapter.get(p.chapter_id) : null;
      if (bucket) bucket.pages.push(p);
      else topPages.push(p);
    }
    res.json({ chapters: Array.from(byChapter.values()), topPages });
  } catch (e) { _fail(res, e, 'GET /content/books/:id/tree'); }
});

// GET /content/chapters/:chapter_id — Kapitel-Detail.
router.get('/chapters/:chapter_id', async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const chapterId = toIntId(req.params.chapter_id);
  if (!chapterId) return res.status(400).json({ error_code: 'INVALID_CHAPTER_ID' });
  try {
    const ch = await bsGet(`chapters/${chapterId}`, token);
    if (ch?.book_id) setContext({ book: ch.book_id });
    res.json(mapChapter(ch));
  } catch (e) { _fail(res, e, 'GET /content/chapters/:id'); }
});

// GET /content/pages/:page_id — Volltext + Metadaten.
router.get('/pages/:page_id', async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  try {
    const page = await bsGet(`pages/${pageId}`, token);
    if (page?.book_id) setContext({ book: page.book_id });
    res.json(mapPage(page));
  } catch (e) { _fail(res, e, 'GET /content/pages/:id'); }
});

// PUT /content/pages/:page_id — Speichert Body+Name. HTML wird serverseitig
// durch cleanPageHtml geschleust (gleiche Invariante wie bookstackPageCleaner).
router.put('/pages/:page_id', jsonBody, async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });

  const body = {};
  if (typeof req.body?.html === 'string') {
    try { body.html = cleanPageHtml(req.body.html); }
    catch (e) {
      logger.warn(`PUT /content/pages/${pageId} cleanPageHtml fehlgeschlagen: ${e.message}`);
      body.html = req.body.html;
    }
  }
  if (typeof req.body?.name === 'string') body.name = req.body.name;
  if (!Object.keys(body).length) return res.status(400).json({ error_code: 'EMPTY_BODY' });

  try {
    const updated = await bsPut(`pages/${pageId}`, body, token);
    if (updated?.book_id) setContext({ book: updated.book_id });
    res.json(mapPage(updated));
  } catch (e) { _fail(res, e, 'PUT /content/pages/:id'); }
});

// POST /content/books — Neues Buch anlegen. Upserted lokale `books`-Row,
// damit FK-abhaengige Folgefeatures (BookSettings, Ideen, ...) sofort sicher
// schreiben koennen. Loest die einzige verbleibende bsPost-Call-Site ausserhalb
// dieses Layers (routes/books.js) ab — siehe Plan Schritt 3.
router.post('/books', jsonBody, async (req, res) => {
  const token = _requireToken(req, res);
  if (!token) return;
  const name = (req.body?.name || '').toString().trim();
  const description = (req.body?.description || '').toString().trim();
  if (!name) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
  if (name.length > NAME_MAX) return res.status(400).json({ error_code: 'NAME_TOO_LONG', params: { max: NAME_MAX } });

  try {
    const payload = description ? { name, description } : { name };
    const created = await bsPost('books', payload, token);
    upsertBook({ id: created.id, name: created.name, slug: created.slug });
    setContext({ book: created.id });
    logger.info(`Buch erstellt id=${created.id} name="${created.name}"`);
    res.json(mapBook(created));
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
