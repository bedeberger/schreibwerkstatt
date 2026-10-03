'use strict';
// Content-Routes: Papierkorb geloeschter Seiten eines Buchs (Liste + Wiederherstellen).
// Gesichert wird beim Loeschen im Content-Store (lib/content-store/backends/localdb-delete.js).

const contentStore = require('../../lib/content-store');
const { toIntId } = require('../../lib/validate');
const { aclParamGuard } = require('../../lib/acl');
const logger = require('../../logger');
const { _fail } = require('./shared');

function register(router) {
  // GET /content/books/:book_id/trash — wiederherstellbare geloeschte Seiten,
  // juengste zuerst. minRole editor (nur wer loeschen darf, stellt wieder her).
  router.get('/books/:book_id/trash', aclParamGuard('editor'), (req, res) => {
    try {
      const rows = contentStore.listPageTrash(req.bookId);
      res.json({
        items: rows.map(r => ({
          id: r.id,
          page_id: r.page_id,
          name: r.page_name || '',
          deleted_at: r.deleted_at,
          deleted_by: r.deleted_by_name || r.deleted_by_email || null,
          chapter_id: r.chapter_id ?? null,
          chapter_name: r.chapter_name || null,
          html_len: r.html_len || 0,
          has_images: !!r.has_images,
        })),
      });
    } catch (e) { _fail(res, e, 'GET /content/books/:id/trash'); }
  });

  // POST /content/books/:book_id/trash/:deletion_id/restore — Seite neu anlegen
  // (neue page_id). 404 TRASH_NOT_FOUND, 409 ALREADY_RESTORED.
  router.post('/books/:book_id/trash/:deletion_id/restore', aclParamGuard('editor'), async (req, res) => {
    const deletionId = toIntId(req.params.deletion_id);
    if (!deletionId) return res.status(400).json({ error_code: 'INVALID_DELETION_ID' });
    try {
      const page = await contentStore.restoreDeletedPage(deletionId, req.bookId, req);
      logger.info(`Seite «${page.name}» aus dem Papierkorb wiederhergestellt (neue page_id ${page.id}).`);
      res.json({ ok: true, page });
    } catch (e) {
      if (e.code === 'TRASH_NOT_FOUND') return res.status(404).json({ error_code: 'TRASH_NOT_FOUND' });
      if (e.code === 'ALREADY_RESTORED') return res.status(409).json({ error_code: 'ALREADY_RESTORED' });
      _fail(res, e, 'POST /content/books/:id/trash/:id/restore');
    }
  });
}

module.exports = { register };
