'use strict';
// Buch-Erstellung aus der App: BookStack legt das Buch an, lokale `books`-Row
// wird im selben Request upserted. So existiert die FK-Target-Row schon, bevor
// der User direkt danach Book-Settings setzt (FK auf books.bookstack_book_id).
const express = require('express');
const logger = require('../logger');
const { bsPost } = require('../lib/bookstack');
const { upsertBook } = require('../db/books');

const router = express.Router();
const jsonBody = express.json();

const NAME_MAX = 255;

router.post('/', jsonBody, async (req, res) => {
  const name = (req.body?.name || '').trim();
  const description = (req.body?.description || '').trim();
  if (!name) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
  if (name.length > NAME_MAX) return res.status(400).json({ error_code: 'NAME_TOO_LONG', params: { max: NAME_MAX } });

  try {
    const payload = description ? { name, description } : { name };
    const created = await bsPost('books', payload, req.session.bookstackToken);
    upsertBook({ id: created.id, name: created.name, slug: created.slug });
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
