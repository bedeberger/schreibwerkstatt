'use strict';
// CRUD fuer book_publication (1:1 zu books). Buch-weite Publikations-Metadaten
// (Cover/Autorfoto als BLOB + Titelei-Texte + EPUB-Reflow-Toggles). Von PDF-
// und EPUB-Export sowie der Publikation-Karte konsumiert. Sprache bleibt SSoT
// in book_settings.language (hier NICHT gefuehrt).

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { defaultMeta, validateMeta } = require('../lib/publication-meta');

const _META_COLS = [
  'isbn', 'subtitle', 'year', 'dedication', 'imprint', 'copyright',
  'frontmatter', 'author_bio', 'epub_css_style', 'epub_justify', 'epub_toc_title',
];

const _stmtGet = db.prepare(`
  SELECT book_id, ${_META_COLS.join(', ')},
         (cover_image IS NOT NULL) AS has_cover, cover_mime,
         (author_image IS NOT NULL) AS has_author_image, author_image_mime,
         created_at, updated_at
    FROM book_publication WHERE book_id = ?
`);

const _stmtGetCover = db.prepare('SELECT cover_image AS image, cover_mime AS mime FROM book_publication WHERE book_id = ?');
const _stmtGetAuthorImage = db.prepare('SELECT author_image AS image, author_image_mime AS mime FROM book_publication WHERE book_id = ?');

// Upsert nur der Metadaten-Spalten (BLOBs separat). updated_at immer mit.
const _stmtUpsertMeta = db.prepare(`
  INSERT INTO book_publication
    (book_id, isbn, subtitle, year, dedication, imprint, copyright, frontmatter,
     author_bio, epub_css_style, epub_justify, epub_toc_title, created_at, updated_at)
  VALUES
    (@book_id, @isbn, @subtitle, @year, @dedication, @imprint, @copyright, @frontmatter,
     @author_bio, @epub_css_style, @epub_justify, @epub_toc_title, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
  ON CONFLICT(book_id) DO UPDATE SET
    isbn = @isbn, subtitle = @subtitle, year = @year, dedication = @dedication,
    imprint = @imprint, copyright = @copyright, frontmatter = @frontmatter,
    author_bio = @author_bio, epub_css_style = @epub_css_style,
    epub_justify = @epub_justify, epub_toc_title = @epub_toc_title,
    updated_at = ${NOW_ISO_SQL}
`);

// BLOB-Setter legen die Zeile bei Bedarf an (Buch koennte noch keine Meta haben).
const _stmtEnsureRow = db.prepare(`
  INSERT INTO book_publication (book_id, created_at, updated_at)
  VALUES (?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
  ON CONFLICT(book_id) DO NOTHING
`);
const _stmtSetCover = db.prepare(`UPDATE book_publication SET cover_image = ?, cover_mime = ?, updated_at = ${NOW_ISO_SQL} WHERE book_id = ?`);
const _stmtClearCover = db.prepare(`UPDATE book_publication SET cover_image = NULL, cover_mime = NULL, updated_at = ${NOW_ISO_SQL} WHERE book_id = ?`);
const _stmtSetAuthorImage = db.prepare(`UPDATE book_publication SET author_image = ?, author_image_mime = ?, updated_at = ${NOW_ISO_SQL} WHERE book_id = ?`);
const _stmtClearAuthorImage = db.prepare(`UPDATE book_publication SET author_image = NULL, author_image_mime = NULL, updated_at = ${NOW_ISO_SQL} WHERE book_id = ?`);

// Liefert die validierten Metadaten (Defaults wenn keine Zeile). epub_justify
// als bool, has_cover/has_author_image als Flags fuer die UI.
function getMeta(bookId) {
  const id = parseInt(bookId);
  const row = _stmtGet.get(id);
  if (!row) {
    return { book_id: id, ...defaultMeta(), has_cover: false, has_author_image: false, cover_mime: null, author_image_mime: null };
  }
  return {
    book_id: id,
    ...validateMeta(row),
    has_cover: !!row.has_cover,
    cover_mime: row.cover_mime || null,
    has_author_image: !!row.has_author_image,
    author_image_mime: row.author_image_mime || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function upsertMeta(bookId, meta) {
  const v = validateMeta(meta);
  _stmtUpsertMeta.run({
    book_id: parseInt(bookId),
    ...v,
    epub_justify: v.epub_justify ? 1 : 0,
  });
  return getMeta(bookId);
}

function setCover(bookId, buffer, mime) {
  _stmtEnsureRow.run(parseInt(bookId));
  _stmtSetCover.run(buffer, mime, parseInt(bookId));
}
function clearCover(bookId) { _stmtClearCover.run(parseInt(bookId)); }
function getCover(bookId) {
  const r = _stmtGetCover.get(parseInt(bookId));
  return r && r.image ? { image: r.image, mime: r.mime } : null;
}

function setAuthorImage(bookId, buffer, mime) {
  _stmtEnsureRow.run(parseInt(bookId));
  _stmtSetAuthorImage.run(buffer, mime, parseInt(bookId));
}
function clearAuthorImage(bookId) { _stmtClearAuthorImage.run(parseInt(bookId)); }
function getAuthorImage(bookId) {
  const r = _stmtGetAuthorImage.get(parseInt(bookId));
  return r && r.image ? { image: r.image, mime: r.mime } : null;
}

module.exports = {
  getMeta, upsertMeta,
  setCover, clearCover, getCover,
  setAuthorImage, clearAuthorImage, getAuthorImage,
};
