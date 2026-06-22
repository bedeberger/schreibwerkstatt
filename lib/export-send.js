'use strict';

// Geteilte Helper fuer Sync-Export-Routen (routes/export.js + die Fassungs-
// Export-Route in routes/snapshots.js): Build-Optionen (Sprache/Autor + EPUB-
// Publikations-Metadaten) und das Schreiben der Buffer-Antwort (inkl. BOM).
//
// Domain-Shape von loadContents/snapshotToBundle fuehrt Sprache/Autor (noch)
// nicht — EPUB/DOCX brauchen dc:language/dc:creator, darum hier aufgeloest.

const logger = require('../logger');
const { getBookSettings } = require('../db/schema');
const { getOwnerEmail } = require('../db/book-access');
const { getUser } = require('../db/app-users');

// Sprache (book_settings) + Autor (Owner-Anzeigename) fuer die Builder.
// fmt='epub' augmentiert zusaetzlich um die buch-weiten Publikations-Metadaten
// (Cover/Titelei/Bio aus book_publication). Lazy geladen — nur die BLOBs bei
// Bedarf.
function buildExportMeta(bookId, fmt) {
  const opts = { lang: 'de', author: '' };
  if (!bookId) return opts;

  opts.lang = getBookSettings(bookId)?.language || 'de';
  try {
    const ownerEmail = getOwnerEmail(bookId);
    if (ownerEmail) opts.author = getUser(ownerEmail)?.display_name || '';
  } catch { /* Owner/User nicht aufloesbar -> Autor leer */ }

  if (fmt === 'epub') {
    try {
      const bp = require('../db/book-publication');
      const meta = bp.getMeta(bookId);
      opts.meta = meta;
      // Publikationsname (book_publication.author_name) uebersteuert den Account-Namen.
      if ((meta.author_name || '').trim()) opts.author = meta.author_name.trim();
      opts.tocTitle = meta.epub_toc_title || undefined;
      if (meta.has_cover) opts.cover = bp.getCover(bookId);
      if (meta.has_author_image) opts.authorImage = bp.getAuthorImage(bookId);
    } catch (e) {
      logger.warn(`Publikations-Metadaten fuer EPUB nicht ladbar (book=${bookId}): ${e.message}`);
    }
  }
  return opts;
}

// Schreibt den fertigen Export-Buffer als Download. `spec` ist der FORMATS-
// Eintrag (mime + optionales bom-Flag).
function sendExportBuffer(res, { spec, buf, filename }) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
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
}

module.exports = { buildExportMeta, sendExportBuffer };
