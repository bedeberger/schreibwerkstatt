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
           (SELECT COUNT(DISTINCT sv.ip_hash) FROM share_views sv
              WHERE sv.share_token = sl.token AND sv.ip_hash IS NOT NULL) AS unique_views,
           (SELECT CAST(AVG(sv.duration_ms) AS INTEGER) FROM share_views sv
              WHERE sv.share_token = sl.token AND sv.duration_ms IS NOT NULL) AS avg_duration_ms,
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
           (SELECT COUNT(DISTINCT sv.ip_hash) FROM share_views sv
              WHERE sv.share_token = sl.token AND sv.ip_hash IS NOT NULL) AS unique_views,
           (SELECT CAST(AVG(sv.duration_ms) AS INTEGER) FROM share_views sv
              WHERE sv.share_token = sl.token AND sv.duration_ms IS NOT NULL) AS avg_duration_ms,
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

// Einen Aufruf der Leseansicht protokollieren: erhoeht den schnellen
// Gesamtzaehler (view_count) UND legt eine share_views-Zeile fuer die feinere
// Statistik an (eindeutige Besucher via ip_hash, Lesedauer folgt per Beacon).
// Liefert die view_id, damit der Reader die Verweildauer nachtragen kann.
function recordShareView(token, ipHash = null) {
  incrementViewCount(token);
  const r = db.prepare(`
    INSERT INTO share_views (share_token, ip_hash, viewed_at)
    VALUES (?, ?, ${NOW_ISO_SQL})
  `).run(token, ipHash);
  return r.lastInsertRowid;
}

// Verweildauer eines Aufrufs nachtragen. Der Reader sendet die bisher sichtbar
// verbrachte Zeit bei jedem Wechsel in den Hintergrund (visibilitychange/
// pagehide) — kehrt der Leser zurueck und liest weiter, kommt ein groesserer
// Wert. Deshalb MAX statt Ueberschreiben: der laengste beobachtete Wert gewinnt,
// auch wenn die Seite spaeter ohne finales Event gekillt wird. Match zusaetzlich
// ueber den Token, damit eine fremde view_id nichts trifft. Clamping: Route.
function setViewDuration(viewId, token, durationMs) {
  const r = db.prepare(`
    UPDATE share_views SET duration_ms = MAX(COALESCE(duration_ms, 0), ?)
    WHERE id = ? AND share_token = ?
  `).run(durationMs, viewId, token);
  return r.changes > 0;
}

function markOwnerSeen(token, ownerEmail) {
  db.prepare(`UPDATE share_links SET owner_last_seen_at = ${NOW_ISO_SQL} WHERE token = ? AND owner_email = ?`).run(token, ownerEmail);
}

// Leser-Kommentar: anonym (author_email bleibt NULL). Optional verankert
// (anchor_*) und/oder Antwort auf einen Root-Kommentar (parentId). Optionale
// reader_email erlaubt die Reply-Benachrichtigung (Reader hat keinen Account).
function insertComment({
  token, readerName = null, readerEmail = null, readerToken = null, body, ipHash = null,
  parentId = null, anchorBid = null, anchorQuote = null, anchorStart = null, anchorEnd = null,
}) {
  const r = db.prepare(`
    INSERT INTO share_comments
      (share_token, reader_name, reader_email, reader_token, body, ip_hash, parent_id,
       anchor_bid, anchor_quote, anchor_start, anchor_end, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
  `).run(token, readerName, readerEmail, readerToken, body, ipHash, parentId,
         anchorBid, anchorQuote, anchorStart, anchorEnd);
  return getCommentById(r.lastInsertRowid);
}

// Root-Thread-ID zu einem (Reply- oder Root-)Kommentar dieses Links auflösen.
// Threads bleiben flach (eine Ebene): eine Antwort auf eine Antwort wird unter
// denselben Root gehängt. Liefert die Root-ID oder null (Kommentar gehört nicht
// zu diesem Link / existiert nicht).
function resolveThreadRootId(commentId, token) {
  const row = db.prepare(`
    SELECT id, parent_id FROM share_comments WHERE id = ? AND share_token = ?
  `).get(commentId, token);
  if (!row) return null;
  return row.parent_id || row.id;
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
  const sql = `SELECT sc.id, sc.share_token, sc.parent_id, sc.reader_name, sc.reader_email, sc.reader_token,
                      sc.author_email, u.display_name AS author_display_name,
                      sc.body, sc.created_at, sc.edited_at, sc.resolved_at,
                      sc.anchor_bid, sc.anchor_quote, sc.anchor_start, sc.anchor_end
               FROM share_comments sc
               LEFT JOIN app_users u ON u.email = sc.author_email
               WHERE sc.share_token = ?
               ORDER BY sc.created_at ${order === 'asc' ? 'ASC' : 'DESC'}`;
  return db.prepare(sql).all(token);
}

// Identität (Anzeigename + optionale Mail) aller eigenen Reader-Kommentare dieses
// Tokens nachziehen (Self-Identität via reader_token). Greift nur auf eigene
// Reader-Beiträge (author_email IS NULL); Owner-Antworten bleiben unberührt.
// name/email = null → entsprechendes Feld leeren (anonymisieren / Mail entfernen).
function updateReaderIdentity(token, readerToken, newName, newEmail) {
  const r = db.prepare(`
    UPDATE share_comments
    SET reader_name = ?, reader_email = ?
    WHERE share_token = ? AND reader_token = ? AND author_email IS NULL
  `).run(newName, newEmail, token, readerToken);
  return r.changes;
}

// Leser bearbeitet einen eigenen Kommentar (Body). Self-Identität via
// reader_token + author_email IS NULL (nie ein Owner-/Fremd-Beitrag). Setzt
// edited_at als „bearbeitet"-Marker.
function editReaderComment(commentId, token, readerToken, body) {
  const r = db.prepare(`
    UPDATE share_comments
    SET body = ?, edited_at = ${NOW_ISO_SQL}
    WHERE id = ? AND share_token = ? AND reader_token = ? AND author_email IS NULL
  `).run(body, commentId, token, readerToken);
  return r.changes > 0;
}

function deleteComment(commentId, ownerEmail) {
  const r = db.prepare(`
    DELETE FROM share_comments
    WHERE id = ?
      AND share_token IN (SELECT token FROM share_links WHERE owner_email = ?)
  `).run(commentId, ownerEmail);
  return r.changes > 0;
}

// Eigener Reader-Kommentar (Self-Identität via reader_token, author_email IS NULL)
// unter genau diesem Link. Liefert {id, parent_id} oder undefined — Basis für die
// Route, um „nicht gefunden / nicht meiner" von „hat Antworten" zu trennen.
function getReaderComment(commentId, token, readerToken) {
  return db.prepare(`
    SELECT id, parent_id FROM share_comments
    WHERE id = ? AND share_token = ? AND reader_token = ? AND author_email IS NULL
  `).get(commentId, token, readerToken);
}

function commentHasReplies(commentId) {
  return !!db.prepare('SELECT 1 FROM share_comments WHERE parent_id = ? LIMIT 1').get(commentId);
}

// Leser löscht einen eigenen Kommentar. Match über reader_token (kein Auth) +
// author_email IS NULL, damit nie ein Owner-/Fremd-Beitrag getroffen wird. Die
// „keine Antworten"-Vorbedingung prüft die Route (commentHasReplies) — Owner-
// Antworten dürfen nicht still per CASCADE mitgelöscht werden.
function deleteReaderComment(commentId, token, readerToken) {
  const r = db.prepare(`
    DELETE FROM share_comments
    WHERE id = ? AND share_token = ? AND reader_token = ? AND author_email IS NULL
  `).run(commentId, token, readerToken);
  return r.changes > 0;
}

// Leser markiert einen eigenen Root-Thread als erledigt / öffnet ihn wieder.
// Teilt sich die resolved_at-Spalte mit dem Owner-Resolve (eine Wahrheit pro
// Thread); Self-Identität via reader_token, nur eigene Roots (parent_id IS NULL).
function setReaderCommentResolved(commentId, token, readerToken, resolved) {
  const r = db.prepare(`
    UPDATE share_comments
    SET resolved_at = ${resolved ? NOW_ISO_SQL : 'NULL'}
    WHERE id = ? AND share_token = ? AND reader_token = ?
      AND author_email IS NULL AND parent_id IS NULL
  `).run(commentId, token, readerToken);
  return r.changes > 0;
}

// Vollständige Kommentare (Root + Antworten, inkl. resolved/author) über ALLE
// Links eines Owners zu einem Buch. Gleiche Spaltenliste wie listCommentsByToken;
// jede Zeile trägt share_token, damit Reply/Resolve/Delete den richtigen
// Link/Thread treffen. Zusätzlich der Link-Scope (`link_kind`/`link_page_id`),
// damit die Leseansicht-Leiste allgemeine (nicht-verankerte) Kommentare der
// richtigen Seite zuordnen kann (Page-Share → seine Seite). Verankerte
// Kommentare filtert der Client weiterhin per data-bid auf die gerenderte Seite.
function listCommentsByOwnerBook(ownerEmail, bookId) {
  return db.prepare(`
    SELECT sc.id, sc.share_token, sc.parent_id, sc.reader_name, sc.reader_token,
           sc.author_email, u.display_name AS author_display_name,
           sc.body, sc.created_at, sc.edited_at, sc.resolved_at,
           sc.anchor_bid, sc.anchor_quote, sc.anchor_start, sc.anchor_end,
           sl.kind AS link_kind, sl.page_id AS link_page_id
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

// Aktive (nicht widerrufene, nicht abgelaufene) Links eines Owners zu einem
// Buch — Rohdaten für den „Wie viele Links enthalten diese Seite?"-Zähler des
// Page-Action-Menüs. Seiten-Zuordnung (page/chapter/book → konkrete Seiten)
// passiert in der Route über die Content-Store-Facade.
function activeLinksForOwnerBook(ownerEmail, bookId) {
  return db.prepare(`
    SELECT kind, page_id, chapter_id
    FROM share_links
    WHERE owner_email = ? AND book_id = ?
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
  `).all(ownerEmail, bookId);
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
  recordShareView,
  setViewDuration,
  markOwnerSeen,
  insertComment,
  insertOwnerReply,
  resolveThreadRootId,
  getCommentById,
  setCommentResolved,
  listCommentsByToken,
  updateReaderIdentity,
  editReaderComment,
  deleteComment,
  getReaderComment,
  commentHasReplies,
  deleteReaderComment,
  setReaderCommentResolved,
  openReaderCommentsForBook,
  activeLinksForOwnerBook,
  listCommentsByOwnerBook,
  markOwnerSeenForBook,
  countRecentCommentsByTokenIp,
};
