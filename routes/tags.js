'use strict';
// Phase 6 (BookStack-Exit, docs/bookstack-exit.md): Tag-Pool-Routen.
// Mount: app.use('/local/tags', router).
//
// GET    /         — alle User: Pool lesen.
// POST   /         — alle Auth-User: Tag anlegen (Inline-Create aus BookSettings).
// PUT    /:id      — admin: umbenennen / Farbe.
// DELETE /:id      — admin: Tag loeschen (Assignments via FK CASCADE).

const express = require('express');
const tags = require('../db/book-tags');
const { requireAdmin } = require('../lib/admin-mw');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

router.get('/', (_req, res) => {
  res.json({ tags: tags.list() });
});

router.post('/', jsonBody, (req, res) => {
  const { name, color = null } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error_code: 'NAME_REQUIRED' });
  }
  try {
    const created = tags.create({
      name,
      color,
      createdBy: req.session?.user?.email || null,
    });
    res.json({ tag: created });
  } catch (e) {
    if (/too long/.test(e.message)) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });
    logger.error(`POST /local/tags: ${e.message}`);
    res.status(500).json({ error_code: 'CREATE_FAILED', detail: e.message });
  }
});

router.put('/:id', requireAdmin, jsonBody, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error_code: 'INVALID_ID' });
  try {
    const updated = tags.update(id, { name: req.body?.name, color: req.body?.color });
    if (!updated) return res.status(404).json({ error_code: 'TAG_NOT_FOUND' });
    res.json({ tag: updated });
  } catch (e) {
    if (/too long/.test(e.message)) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });
    logger.error(`PUT /local/tags/:id: ${e.message}`);
    res.status(500).json({ error_code: 'UPDATE_FAILED', detail: e.message });
  }
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error_code: 'INVALID_ID' });
  const ok = tags.remove(id);
  if (!ok) return res.status(404).json({ error_code: 'TAG_NOT_FOUND' });
  logger.info(`Tag geloescht id=${id} by=${req.session.user.email}`);
  res.json({ ok: true });
});

module.exports = router;
