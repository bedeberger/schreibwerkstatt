'use strict';
// Admin-Verwaltung fuer Buecher: Owner-Zuweisung fuer Buecher ohne Owner
// (entstanden z.B. nach Backend-Switch, wenn das BookStack-Token-User nicht
// im app_users-Verzeichnis lebt). Fuer Buecher mit existierendem Owner geht
// die Reassignment ueber den normalen Transfer-Flow (Owner → Admin macht sich
// selbst zum Editor → neuer Owner → transferOwnership).

const express = require('express');
const { requireAdmin } = require('../lib/admin-mw');
const { setContext } = require('../lib/log-context');
const appUsers = require('../db/app-users');
const bookAccess = require('../db/book-access');
const { db } = require('../db/connection');
const { toIntId } = require('../lib/validate');
const logger = require('../logger');

const router = express.Router();
router.use(requireAdmin);

function _normEmail(e) { return (e || '').toString().trim().toLowerCase(); }

// GET /admin/books — Liste aller Buecher mit Owner-Info + ACL-Count.
// Zeigt explizit auch ownerless Buecher, damit Admin sie zuweisen kann.
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT b.book_id, b.name, b.owner_email,
           (SELECT COUNT(*) FROM book_access ba WHERE ba.book_id = b.book_id) AS acl_count
      FROM books b
     ORDER BY b.name COLLATE NOCASE
  `).all();
  res.json({ books: rows });
});

// POST /admin/books/:book_id/assign-owner { email }
// Nur fuer Buecher ohne Owner. Setzt books.owner_email und legt book_access-
// Row als 'owner' an (idempotent — bestehende Rolle wird auf owner gehoben).
router.post('/:book_id/assign-owner', express.json({ limit: '4kb' }), (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  setContext({ book: bookId });

  const target = _normEmail(req.body?.email);
  if (!target) return res.status(400).json({ error_code: 'EMAIL_REQUIRED' });

  const book = db.prepare('SELECT book_id, owner_email FROM books WHERE book_id = ?').get(bookId);
  if (!book) return res.status(404).json({ error_code: 'BOOK_NOT_FOUND' });
  if (book.owner_email) {
    return res.status(409).json({
      error_code: 'BOOK_HAS_OWNER',
      detail: 'Use /books/:id/transfer-ownership for reassignment',
      current_owner: book.owner_email,
    });
  }

  const user = appUsers.getUser(target);
  if (!user) return res.status(404).json({ error_code: 'USER_NOT_FOUND' });
  if (user.status !== 'active') {
    return res.status(400).json({ error_code: 'USER_NOT_ACTIVE', detail: { status: user.status } });
  }

  const performedBy = req.session?.user?.email || 'admin';
  try {
    db.transaction(() => {
      db.prepare('UPDATE books SET owner_email = ? WHERE book_id = ?').run(target, bookId);
      bookAccess.grantAccess(bookId, target, 'owner', performedBy);
    })();
    logger.info(`Admin assign-owner: book=${bookId} owner=${target} by ${performedBy}`);
    res.json({ ok: true, book_id: bookId, owner_email: target });
  } catch (e) {
    logger.error(`POST /admin/books/:id/assign-owner: ${e.message}`);
    res.status(500).json({ error_code: 'ASSIGN_FAILED', detail: e.message });
  }
});

module.exports = router;
