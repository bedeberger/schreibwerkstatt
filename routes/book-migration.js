'use strict';

// Buch-Migration: Sync-Export eines ganzen Buchs als `.swbook` (ZIP-Bundle),
// damit ein Buch verlustfrei auf eine andere App-Instanz gezuegelt werden kann.
// Import laeuft als Job (routes/jobs/book-import.js). Format-Details: lib/book-bundle.js.

const express = require('express');
const JSZip = require('jszip');
const logger = require('../logger');
const contentStore = require('../lib/content-store');
const { getBookSettings } = require('../db/schema');
const { buildManifest, treeToNodes, buildBookJson } = require('../lib/book-bundle');
const { slugify } = require('../lib/slug');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { requireBookAccess, sendACLError } = require('../lib/acl');

const router = express.Router();

router.get('/:bookId', async (req, res) => {
  const bookId = toIntId(req.params.bookId);
  if (!bookId) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  setContext({ book: bookId });

  try { requireBookAccess(req, bookId, 'viewer'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  let book, tree;
  try {
    [book, tree] = await Promise.all([
      contentStore.loadBook(bookId, req),
      contentStore.bookTree(bookId, req),
    ]);
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error_code: 'NOT_FOUND' });
    logger.error(`swbook-Export Load fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(502).json({ error_code: 'EXPORT_FAILED' });
  }

  // Alle Seiten-Metas einsammeln (Top-Pages + rekursiv aus Kapiteln) und in
  // einem Batch mit HTML laden.
  const metas = [];
  (function collect(t) {
    for (const p of (t.topPages || [])) metas.push(p);
    (function walk(chapters) {
      for (const c of chapters) {
        for (const p of (c.pages || [])) metas.push(p);
        walk(c.subchapters || []);
      }
    })(t.chapters || []);
  })(tree);

  if (!metas.length) return res.status(400).json({ error_code: 'BOOK_EMPTY' });

  let details;
  try {
    details = await contentStore.loadPagesBatch(metas, req, { batchSize: 15, onError: () => null });
  } catch (e) {
    logger.error(`swbook-Export Pages fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(502).json({ error_code: 'EXPORT_FAILED' });
  }
  const htmlById = new Map();
  for (const d of details) if (d && d.id) htmlById.set(d.id, d.html || '');

  const nodes = treeToNodes(tree, htmlById);
  const settings = (() => { try { return getBookSettings(bookId); } catch { return null; } })();

  const manifest = buildManifest({ sourceBookId: bookId, exportedAt: new Date().toISOString() });
  const bookJson = buildBookJson({ book, settings, nodes });

  let buf;
  try {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    zip.file('book.json', JSON.stringify(bookJson, null, 2));
    buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  } catch (e) {
    logger.error(`swbook-Export ZIP fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(502).json({ error_code: 'EXPORT_FAILED' });
  }

  const slug = book.slug || slugify(book.name || `book-${bookId}`) || `book-${bookId}`;
  const filename = `${slug}.swbook`;
  const sizeKb = Math.round(buf.length / 1024);
  logger.info(`swbook-Export «${filename}» (${sizeKb} KB, book=${bookId}, pages=${metas.length})`);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

module.exports = router;
