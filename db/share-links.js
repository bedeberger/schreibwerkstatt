'use strict';
// DB-Helper für Share-Links (Page/Chapter teilen via opaken Token).
const crypto = require('crypto');
const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

function newToken() {
  return crypto.randomBytes(16).toString('base64url');
}

function createShareLink({ kind, pageId = null, chapterId = null, bookId, ownerEmail, intro = null, expiresAt = null, showToc = false }) {
  if (kind !== 'page' && kind !== 'chapter' && kind !== 'book') throw new Error('invalid kind');
  if (kind === 'page' && !pageId) throw new Error('page_id required');
  if (kind === 'chapter' && !chapterId) throw new Error('chapter_id required');
  if (!bookId) throw new Error('book_id required');
  // TOC nur bei Buch-/Kapitel-Shares sinnvoll (eine Seite hat keins).
  const toc = kind !== 'page' && showToc ? 1 : 0;
  const stmt = db.prepare(`
    INSERT INTO share_links (token, kind, page_id, chapter_id, book_id, owner_email, intro, expires_at, show_toc, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
  `);
  for (let i = 0; i < 3; i++) {
    const token = newToken();
    try {
      stmt.run(token, kind, kind === 'page' ? pageId : null, kind === 'chapter' ? chapterId : null,
               bookId, ownerEmail, intro, expiresAt, toc);
      return getShareLinkByToken(token);
    } catch (e) {
      if (!/UNIQUE/i.test(e.message)) throw e;
    }
  }
  throw new Error('share token collision retries exhausted');
}

function getShareLinkByToken(token) {
  return db.prepare(`
    SELECT sl.*, b.name AS book_name,
           p.page_name AS page_name,
           c.chapter_name AS chapter_name,
           u.display_name AS owner_display_name
    FROM share_links sl
    JOIN books b ON b.book_id = sl.book_id
    LEFT JOIN pages p ON p.page_id = sl.page_id
    LEFT JOIN chapters c ON c.chapter_id = sl.chapter_id
    LEFT JOIN app_users u ON u.email = sl.owner_email
    WHERE sl.token = ?
  `).get(token);
}

function listSharesByOwner(ownerEmail) {
  return db.prepare(`
    SELECT sl.*,
           b.name AS book_name,
           p.page_name AS page_name,
           c.chapter_name AS chapter_name,
           (SELECT COUNT(*) FROM share_comments sc WHERE sc.share_token = sl.token) AS comment_count,
           (SELECT COUNT(*) FROM share_comments sc
              WHERE sc.share_token = sl.token
                AND sc.author_email IS NULL
                AND (sl.owner_last_seen_at IS NULL OR sc.created_at > sl.owner_last_seen_at)) AS unread_count
    FROM share_links sl
    JOIN books b ON b.book_id = sl.book_id
    LEFT JOIN pages p ON p.page_id = sl.page_id
    LEFT JOIN chapters c ON c.chapter_id = sl.chapter_id
    WHERE sl.owner_email = ?
    ORDER BY sl.created_at DESC
  `).all(ownerEmail);
}

function listSharesByOwnerAndBook(ownerEmail, bookId) {
  return db.prepare(`
    SELECT sl.*,
           p.page_name AS page_name,
           c.chapter_name AS chapter_name,
           (SELECT COUNT(*) FROM share_comments sc WHERE sc.share_token = sl.token) AS comment_count,
           (SELECT COUNT(*) FROM share_comments sc
              WHERE sc.share_token = sl.token
                AND sc.author_email IS NULL
                AND (sl.owner_last_seen_at IS NULL OR sc.created_at > sl.owner_last_seen_at)) AS unread_count
    FROM share_links sl
    LEFT JOIN pages p ON p.page_id = sl.page_id
    LEFT JOIN chapters c ON c.chapter_id = sl.chapter_id
    WHERE sl.owner_email = ? AND sl.book_id = ?
    ORDER BY sl.created_at DESC
  `).all(ownerEmail, bookId);
}

function revokeShareLink(token, ownerEmail) {
  const r = db.prepare(`
    UPDATE share_links SET revoked_at = ${NOW_ISO_SQL}
    WHERE token = ? AND owner_email = ? AND revoked_at IS NULL
  `).run(token, ownerEmail);
  return r.changes > 0;
}

function updateShareLink(token, ownerEmail, { intro, expiresAt, showToc }) {
  const sets = [];
  const params = [];
  if (intro !== undefined) { sets.push('intro = ?'); params.push(intro); }
  if (expiresAt !== undefined) { sets.push('expires_at = ?'); params.push(expiresAt); }
  if (showToc !== undefined) { sets.push('show_toc = ?'); params.push(showToc ? 1 : 0); }
  if (!sets.length) return false;
  params.push(token, ownerEmail);
  const r = db.prepare(`UPDATE share_links SET ${sets.join(', ')} WHERE token = ? AND owner_email = ?`).run(...params);
  return r.changes > 0;
}

function incrementViewCount(token) {
  db.prepare('UPDATE share_links SET view_count = view_count + 1 WHERE token = ?').run(token);
}

function markOwnerSeen(token, ownerEmail) {
  db.prepare(`UPDATE share_links SET owner_last_seen_at = ${NOW_ISO_SQL} WHERE token = ? AND owner_email = ?`).run(token, ownerEmail);
}

// Leser-Kommentar: anonym (author_email bleibt NULL). Optional verankert
// (anchor_*) und/oder Antwort auf einen Root-Kommentar (parentId).
function insertComment({
  token, readerName = null, readerToken = null, body, ipHash = null,
  parentId = null, anchorBid = null, anchorQuote = null, anchorStart = null, anchorEnd = null,
}) {
  const r = db.prepare(`
    INSERT INTO share_comments
      (share_token, reader_name, reader_token, body, ip_hash, parent_id,
       anchor_bid, anchor_quote, anchor_start, anchor_end, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
  `).run(token, readerName, readerToken, body, ipHash, parentId,
         anchorBid, anchorQuote, anchorStart, anchorEnd);
  return getCommentById(r.lastInsertRowid);
}

// Owner-Antwort auf einen Root-Kommentar: author_email gesetzt, kein Anker
// (erbt den Anker des Roots), kein reader_*-Pfad.
function insertOwnerReply({ token, parentId, authorEmail, body }) {
  const r = db.prepare(`
    INSERT INTO share_comments
      (share_token, body, parent_id, author_email, created_at)
    VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})
  `).run(token, body, parentId, authorEmail);
  return getCommentById(r.lastInsertRowid);
}

function getCommentById(id) {
  return db.prepare(`
    SELECT sc.*, u.display_name AS author_display_name
    FROM share_comments sc
    LEFT JOIN app_users u ON u.email = sc.author_email
    WHERE sc.id = ?
  `).get(id);
}

// Root-Thread (parent_id IS NULL) als erledigt markieren / wieder oeffnen.
// Nur fuer Kommentare unter einem Link des angegebenen Owners.
function setCommentResolved(id, ownerEmail, resolved) {
  const r = db.prepare(`
    UPDATE share_comments
    SET resolved_at = ${resolved ? NOW_ISO_SQL : 'NULL'}
    WHERE id = ? AND parent_id IS NULL
      AND share_token IN (SELECT token FROM share_links WHERE owner_email = ?)
  `).run(id, ownerEmail);
  return r.changes > 0;
}

function listCommentsByToken(token, { order = 'desc' } = {}) {
  const sql = `SELECT sc.id, sc.share_token, sc.parent_id, sc.reader_name, sc.reader_token,
                      sc.author_email, u.display_name AS author_display_name,
                      sc.body, sc.created_at, sc.resolved_at,
                      sc.anchor_bid, sc.anchor_quote, sc.anchor_start, sc.anchor_end
               FROM share_comments sc
               LEFT JOIN app_users u ON u.email = sc.author_email
               WHERE sc.share_token = ?
               ORDER BY sc.created_at ${order === 'asc' ? 'ASC' : 'DESC'}`;
  return db.prepare(sql).all(token);
}

function deleteComment(commentId, ownerEmail) {
  const r = db.prepare(`
    DELETE FROM share_comments
    WHERE id = ?
      AND share_token IN (SELECT token FROM share_links WHERE owner_email = ?)
  `).run(commentId, ownerEmail);
  return r.changes > 0;
}

// Vollständige Kommentare (Root + Antworten, inkl. resolved/author) über ALLE
// Links eines Owners zu einem Buch. Gleiche Spaltenliste wie listCommentsByToken;
// jede Zeile trägt share_token, damit Reply/Resolve/Delete den richtigen
// Link/Thread treffen. Für die Kommentar-Leiste der Leseansicht: der Client
// filtert per Anker auf die aktuell gerenderte Seite.
function listCommentsByOwnerBook(ownerEmail, bookId) {
  return db.prepare(`
    SELECT sc.id, sc.share_token, sc.parent_id, sc.reader_name, sc.reader_token,
           sc.author_email, u.display_name AS author_display_name,
           sc.body, sc.created_at, sc.resolved_at,
           sc.anchor_bid, sc.anchor_quote, sc.anchor_start, sc.anchor_end
    FROM share_comments sc
    JOIN share_links sl ON sl.token = sc.share_token
    LEFT JOIN app_users u ON u.email = sc.author_email
    WHERE sl.owner_email = ? AND sl.book_id = ?
    ORDER BY sc.created_at ASC
  `).all(ownerEmail, bookId);
}

// Owner-last-seen für ALLE Links eines Buchs setzen (Unread-Badges der
// „Geteilte Links"-Karte konsistent halten, wenn die Leiste die Kommentare zeigt).
function markOwnerSeenForBook(ownerEmail, bookId) {
  db.prepare(`UPDATE share_links SET owner_last_seen_at = ${NOW_ISO_SQL}
              WHERE owner_email = ? AND book_id = ?`).run(ownerEmail, bookId);
}

// Alle offenen Reviewer-Kommentare (Root, nicht erledigt, von Lesern) über alle
// Links eines Buchs. Page-Shares tragen page_id direkt; Chapter/Book-Shares
// verankern via anchor_bid (Page-Auflösung über den Content-Store im Route-Layer,
// die DB kennt die Block→Seite-Zuordnung nicht). Basis für den Pro-Seite-Zähler
// am „Teilen"-Menü.
function openReaderCommentsForBook(ownerEmail, bookId) {
  return db.prepare(`
    SELECT sc.id, sc.anchor_bid, sl.kind, sl.page_id
    FROM share_comments sc
    JOIN share_links sl ON sl.token = sc.share_token
    WHERE sl.book_id = ? AND sl.owner_email = ?
      AND sc.parent_id IS NULL
      AND sc.author_email IS NULL
      AND sc.resolved_at IS NULL
  `).all(bookId, ownerEmail);
}

function countRecentCommentsByTokenIp(token, ipHash, windowMs) {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM share_comments
    WHERE share_token = ? AND ip_hash = ? AND created_at > ?
  `).get(token, ipHash, cutoff);
  return row?.n || 0;
}

module.exports = {
  newToken,
  createShareLink,
  getShareLinkByToken,
  listSharesByOwner,
  listSharesByOwnerAndBook,
  revokeShareLink,
  updateShareLink,
  incrementViewCount,
  markOwnerSeen,
  insertComment,
  insertOwnerReply,
  getCommentById,
  setCommentResolved,
  listCommentsByToken,
  deleteComment,
  openReaderCommentsForBook,
  listCommentsByOwnerBook,
  markOwnerSeenForBook,
  countRecentCommentsByTokenIp,
};
