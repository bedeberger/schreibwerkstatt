'use strict';

// Sync-Export-Route fuer Buch/Kapitel/Seite in pdf/html/txt/md/epub/docx.
// Default-Styling, kein Profil — Schnellpfad fuer "eben mal Kapitel als DOCX
// an Lektor". Custom-Profile gehen ueber /jobs/pdf-export (async).
//
// Filename: <scope>-<slug>-YYYY-MM-DD-hh-mm-ss.<ext> via buildExportFilename.
// BOM bei txt/md, sonst rohes Buffer.

const express = require('express');
const logger = require('../logger');
const { getTokenForRequest } = require('../db/schema');
const { loadContents } = require('../lib/load-contents');
const { FORMATS } = require('../lib/export-builders');
const { buildExportFilename } = require('../lib/filenames');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');

const router = express.Router();

const VALID_SCOPES = new Set(['book', 'chapter', 'page']);

router.get('/:scope/:id/:fmt', async (req, res) => {
  const scope = String(req.params.scope || '').toLowerCase();
  const id = toIntId(req.params.id);
  const fmt = String(req.params.fmt || '').toLowerCase();

  if (!VALID_SCOPES.has(scope)) return res.status(400).json({ error_code: 'BAD_SCOPE' });
  if (!id) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  const spec = FORMATS[fmt];
  if (!spec) return res.status(400).json({ error_code: 'BAD_FORMAT' });

  const token = getTokenForRequest(req);
  if (!token) return res.status(401).json({ error_code: 'BOOKSTACK_UNAUTHED' });

  let bundle;
  try {
    bundle = await loadContents({ scope, id }, token);
  } catch (e) {
    if (e.code === 'BOOK_EMPTY')      return res.status(400).json({ error_code: 'BOOK_EMPTY' });
    if (e.code === 'CHAPTER_EMPTY')   return res.status(400).json({ error_code: 'CHAPTER_EMPTY' });
    if (e.code === 'PAGE_EMPTY')      return res.status(400).json({ error_code: 'PAGE_EMPTY' });
    if (e.code === 'CHAPTER_NOT_FOUND') return res.status(404).json({ error_code: 'CHAPTER_NOT_FOUND' });
    if (e.status === 401 || e.status === 403) return res.status(401).json({ error_code: 'BOOKSTACK_UNAUTHED' });
    if (e.status === 404) return res.status(404).json({ error_code: 'NOT_FOUND' });
    logger.error(`Export-Load fehlgeschlagen (scope=${scope}, id=${id}): ${e.message}`);
    return res.status(502).json({ error_code: 'BOOKSTACK_UNREACHABLE' });
  }
  if (bundle.book?.id) setContext({ book: bundle.book.id });
  if (bundle.book?.id) {
    const { requireBookAccess, sendACLError } = require('../lib/acl');
    try { requireBookAccess(req, bundle.book.id, 'viewer'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }

  let buf;
  try {
    buf = await spec.build(bundle, { token, lang: 'de' });
  } catch (e) {
    logger.error(`Export-Build fehlgeschlagen (scope=${scope}, id=${id}, fmt=${fmt}): ${e.message}`);
    return res.status(502).json({ error_code: 'EXPORT_FAILED' });
  }
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);

  const { resolveSlug } = require('../lib/export-builders/shared');
  const slug = resolveSlug(bundle);
  const filename = buildExportFilename({ prefix: scope, slug, ext: fmt, date: new Date() });

  res.setHeader('Content-Type', spec.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  if (spec.bom) {
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    res.setHeader('Content-Length', bom.length + buf.length);
    res.write(bom);
    res.end(buf);
    return;
  }
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

module.exports = router;
