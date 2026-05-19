'use strict';
// localdb-Variante der Content-Store-Facade. Liest/Schreibt ausschliesslich lokale SQLite-Tabellen
// (books/chapters/pages). Vertrag identisch zu backends/bookstack.js.
//
// Domain-Shape spiegelt content-mapper.js (SSoT): Felder `id`, `name`, `html`,
// `position`, `chapter_id`, `book_id`, `slug`, `book_slug`, `updated_at`,
// `created_at` exakt wie aus BookStack.
//
// Sentinel-Werte: page_id=0 fuer Buch-Scope-Sessions wird respektiert; localdb
// vergibt fuer Neu-Items IDs >= 1_000_001 dank Wasserzeichen aus Migration 106.
//
// **ctx**-Argument wird ignoriert (kein Token noetig). Akzeptiert fuer
// API-Symmetrie mit backends/bookstack.js.

const { db } = require('../../../db/connection');
const { cleanPageHtml } = require('../../html-clean');

function _cleanHtmlSafe(html) {
  try { return cleanPageHtml(html); }
  catch { return html; }
}

function _nowIso() { return new Date().toISOString(); }

function _notFound(kind, id) {
  const e = new Error(`${kind} ${id} not found`);
  e.code = 'NOT_FOUND';
  e.status = 404;
  return e;
}

function _bookRow(r, bookSlug = null) {
  if (!r) return null;
  return {
    id: r.book_id,
    name: r.name || '',
    slug: r.slug || null,
    description: r.description || '',
    updated_at: r.updated_at || null,
    created_at: r.created_at || null,
  };
}

function _chapterRow(r) {
  if (!r) return null;
  return {
    id: r.chapter_id,
    book_id: r.book_id,
    name: r.chapter_name || '',
    slug: r.slug || null,
    book_slug: r._book_slug || null,
    description: r.description || '',
    position: r.position ?? r.priority ?? null,
    parent_chapter_id: r.parent_chapter_id ?? null,
    updated_at: r.updated_at || null,
    created_at: r.updated_at || null,
  };
}

function _pageMetaRow(r) {
  if (!r) return null;
  return {
    id: r.page_id,
    book_id: r.book_id,
    chapter_id: r.chapter_id || null,
    name: r.page_name || '',
    slug: r.slug || null,
    book_slug: r._book_slug || null,
    position: r.position ?? r.priority ?? null,
    updated_at: r.local_updated_at || r.updated_at || null,
    created_at: r.updated_at || null,
    draft: false,
    template: false,
  };
}

function _pageRow(r) {
  const meta = _pageMetaRow(r);
  if (!meta) return null;
  return {
    ...meta,
    html: r.body_html || '',
    markdown: r.body_markdown || null,
    raw_html: null,
    revision_count: null,
    last_editor_email: r.last_editor_email || null,
    updated_by_name: r._last_editor_display || r.last_editor_email || null,
  };
}

// ── Books ────────────────────────────────────────────────────────────────────

async function listBooks(_ctx) {
  const rows = db.prepare(`
    SELECT book_id, name, slug, description, created_at, updated_at, owner_email
      FROM books
     ORDER BY name COLLATE NOCASE
  `).all();
  return rows.map(r => _bookRow(r));
}

async function loadBook(bookId, _ctx) {
  const r = db.prepare(`
    SELECT book_id, name, slug, description, created_at, updated_at, owner_email
      FROM books WHERE book_id = ?
  `).get(bookId);
  if (!r) throw _notFound('Book', bookId);
  return _bookRow(r);
}

async function createBook({ name, description, owner_email = null }, _ctx) {
  const now = _nowIso();
  const result = db.prepare(`
    INSERT INTO books (name, description, owner_email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, description || null, owner_email, now, now);
  return loadBook(result.lastInsertRowid);
}

async function updateBook(bookId, body, _ctx) {
  const sets = [];
  const args = [];
  if (typeof body?.name === 'string')        { sets.push('name = ?');        args.push(body.name); }
  if (typeof body?.description === 'string') { sets.push('description = ?'); args.push(body.description); }
  if (!sets.length) {
    const err = new Error('updateBook called without changes');
    err.code = 'EMPTY_BODY';
    throw err;
  }
  sets.push('updated_at = ?'); args.push(_nowIso());
  args.push(bookId);
  const result = db.prepare(`UPDATE books SET ${sets.join(', ')} WHERE book_id = ?`).run(...args);
  if (!result.changes) throw _notFound('Book', bookId);
  return loadBook(bookId);
}

async function deleteBook(bookId, _ctx) {
  const result = db.prepare(`DELETE FROM books WHERE book_id = ?`).run(bookId);
  if (!result.changes) throw _notFound('Book', bookId);
  return { ok: true };
}

// ── Chapters ────────────────────────────────────────────────────────────────

const _chaptersByBookStmt = db.prepare(`
  SELECT c.chapter_id, c.book_id, c.chapter_name, c.slug, c.description,
         c.position, c.priority, c.parent_chapter_id, c.updated_at, b.slug AS _book_slug
    FROM chapters c
    LEFT JOIN books b ON b.book_id = c.book_id
   WHERE c.book_id = ?
   ORDER BY COALESCE(c.position, c.priority, 0), c.chapter_name COLLATE NOCASE
`);

async function listChapters(bookId, _ctx) {
  return _chaptersByBookStmt.all(bookId).map(r => _chapterRow(r));
}

async function loadChapter(chapterId, _ctx) {
  const r = db.prepare(`
    SELECT c.chapter_id, c.book_id, c.chapter_name, c.slug, c.description,
           c.position, c.priority, c.parent_chapter_id, c.updated_at, b.slug AS _book_slug
      FROM chapters c
      LEFT JOIN books b ON b.book_id = c.book_id
     WHERE c.chapter_id = ?
  `).get(chapterId);
  if (!r) throw _notFound('Chapter', chapterId);
  return _chapterRow(r);
}

async function createChapter({ book_id, name, position, description, parent_chapter_id }, _ctx) {
  const now = _nowIso();
  let pos = Number.isFinite(position) ? position : null;
  if (pos === null) {
    // Position-Scope: bei Sub-Chapter innerhalb des Parents zaehlen, sonst
    // top-level Kapitel des Buches.
    const r = parent_chapter_id
      ? db.prepare(
          'SELECT COALESCE(MAX(COALESCE(position, priority)), 0) AS m FROM chapters WHERE book_id = ? AND parent_chapter_id = ?'
        ).get(book_id, parent_chapter_id)
      : db.prepare(
          'SELECT COALESCE(MAX(COALESCE(position, priority)), 0) AS m FROM chapters WHERE book_id = ? AND parent_chapter_id IS NULL'
        ).get(book_id);
    pos = (r?.m || 0) + 1;
  }
  const result = db.prepare(`
    INSERT INTO chapters (book_id, chapter_name, description, position, priority, parent_chapter_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    book_id,
    name,
    typeof description === 'string' ? description : null,
    pos,
    pos,
    Number.isFinite(parent_chapter_id) ? parent_chapter_id : null,
    now,
  );
  return loadChapter(result.lastInsertRowid);
}

async function updateChapter(chapterId, body, _ctx) {
  const sets = [];
  const args = [];
  if (typeof body?.name === 'string')        { sets.push('chapter_name = ?'); args.push(body.name); }
  if (typeof body?.description === 'string') { sets.push('description = ?');  args.push(body.description); }
  if (Number.isFinite(body?.position)) {
    sets.push('position = ?'); args.push(body.position);
    sets.push('priority = ?'); args.push(body.position);
  }
  if (!sets.length) {
    const err = new Error('updateChapter called without changes');
    err.code = 'EMPTY_BODY';
    throw err;
  }
  sets.push('updated_at = ?'); args.push(_nowIso());
  args.push(chapterId);
  const result = db.prepare(`UPDATE chapters SET ${sets.join(', ')} WHERE chapter_id = ?`).run(...args);
  if (!result.changes) throw _notFound('Chapter', chapterId);
  return loadChapter(chapterId);
}

async function deleteChapter(chapterId, _ctx) {
  const result = db.prepare(`DELETE FROM chapters WHERE chapter_id = ?`).run(chapterId);
  if (!result.changes) throw _notFound('Chapter', chapterId);
  return { ok: true };
}

// ── Pages ────────────────────────────────────────────────────────────────────

const _pagesByBookStmt = db.prepare(`
  SELECT p.page_id, p.book_id, p.chapter_id, p.page_name, p.slug,
         p.position, p.priority, p.updated_at, p.local_updated_at,
         b.slug AS _book_slug
    FROM pages p
    LEFT JOIN books b ON b.book_id = p.book_id
   WHERE p.book_id = ?
   ORDER BY COALESCE(p.position, p.priority, 0), p.page_name COLLATE NOCASE
`);

async function listPages(bookId, _ctx) {
  return _pagesByBookStmt.all(bookId).map(r => _pageMetaRow(r));
}

async function loadPage(pageId, _ctx) {
  const r = db.prepare(`
    SELECT p.page_id, p.book_id, p.chapter_id, p.page_name, p.slug,
           p.position, p.priority, p.updated_at, p.local_updated_at,
           p.body_html, p.body_markdown, p.last_editor_email,
           b.slug AS _book_slug,
           u.display_name AS _last_editor_display
      FROM pages p
      LEFT JOIN books b ON b.book_id = p.book_id
      LEFT JOIN app_users u ON u.email = p.last_editor_email
     WHERE p.page_id = ?
  `).get(pageId);
  if (!r) throw _notFound('Page', pageId);
  return _pageRow(r);
}

function _conflictError(pageId, currentUpdatedAt, currentEditorEmail, currentEditorDisplay) {
  const e = new Error(`Page ${pageId} updated by another writer`);
  e.code = 'PAGE_CONFLICT';
  e.status = 409;
  e.serverUpdatedAt = currentUpdatedAt;
  e.serverEditorEmail = currentEditorEmail;
  e.serverEditorDisplay = currentEditorDisplay;
  return e;
}

async function savePage(pageId, body, ctx) {
  const sets = [];
  const args = [];
  const hasHtml = typeof body?.html === 'string';
  if (hasHtml)                                { sets.push('body_html = ?');     args.push(_cleanHtmlSafe(body.html)); }
  if (typeof body?.markdown === 'string')    { sets.push('body_markdown = ?'); args.push(body.markdown); }
  if (typeof body?.name === 'string')        { sets.push('page_name = ?');     args.push(body.name); }
  if (Number.isFinite(body?.position)) {
    sets.push('position = ?'); args.push(body.position);
    sets.push('priority = ?'); args.push(body.position);
  }
  if (body?.chapter_id !== undefined)        { sets.push('chapter_id = ?');    args.push(body.chapter_id || null); }
  if (!sets.length) {
    const err = new Error('savePage called without changes');
    err.code = 'EMPTY_BODY';
    throw err;
  }

  // Editor-Email nur bei Body-Change setzen — reine Rename/Reorder bewahren
  // den letzten Body-Autor (sonst springt der Tree-/History-Hinweis bei jedem
  // Drag-Drop um). userEmail kommt aus ctx.session, sonst null.
  const userEmail = ctx?.session?.user?.email || null;
  if (hasHtml) {
    sets.push('last_editor_email = ?'); args.push(userEmail);
  }

  const now = _nowIso();
  sets.push('local_updated_at = ?'); args.push(now);
  sets.push('updated_at = ?');       args.push(now);

  // Optimistic-Concurrency-Guard: wenn der Caller einen Snapshot-Zeitstempel
  // mitliefert, MUSS die DB-Row noch genau diesen Stand haben. Sonst hat ein
  // anderer User dazwischen gespeichert → 409, kein Overwrite. Atomar via
  // WHERE im UPDATE, kein TOCTOU-Fenster zwischen Pre-Check und Write.
  const expectedUpdatedAt = body?.expected_updated_at || null;
  let sql;
  if (expectedUpdatedAt) {
    sql = `UPDATE pages SET ${sets.join(', ')} WHERE page_id = ? AND updated_at = ?`;
    args.push(pageId, expectedUpdatedAt);
  } else {
    sql = `UPDATE pages SET ${sets.join(', ')} WHERE page_id = ?`;
    args.push(pageId);
  }
  const result = db.prepare(sql).run(...args);
  if (!result.changes) {
    // Existiert die Page ueberhaupt? Wenn ja und Stamp passte nicht → Conflict.
    const cur = db.prepare(`
      SELECT p.updated_at, p.last_editor_email, u.display_name AS display
        FROM pages p
        LEFT JOIN app_users u ON u.email = p.last_editor_email
       WHERE p.page_id = ?
    `).get(pageId);
    if (cur && expectedUpdatedAt) {
      throw _conflictError(pageId, cur.updated_at, cur.last_editor_email, cur.display);
    }
    throw _notFound('Page', pageId);
  }
  return loadPage(pageId);
}

async function createPage({ book_id, chapter_id, name, html }, _ctx) {
  if (!book_id) {
    const err = new Error('createPage: book_id required');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  const now = _nowIso();
  const cleanHtml = _cleanHtmlSafe(typeof html === 'string' ? html : '<p></p>');
  const r = db.prepare(
    'SELECT COALESCE(MAX(COALESCE(position, priority)), 0) AS m FROM pages WHERE book_id = ?'
  ).get(book_id);
  const pos = (r?.m || 0) + 1;
  const result = db.prepare(`
    INSERT INTO pages (book_id, chapter_id, page_name, body_html, position, priority, updated_at, local_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(book_id, chapter_id || null, name || '', cleanHtml, pos, pos, now, now);
  return loadPage(result.lastInsertRowid);
}

async function deletePage(pageId, _ctx) {
  const result = db.prepare(`DELETE FROM pages WHERE page_id = ?`).run(pageId);
  if (!result.changes) throw _notFound('Page', pageId);
  return { ok: true };
}

// ── Higher-level helpers ────────────────────────────────────────────────────

async function bookTree(bookId, _ctx) {
  const chapters = await listChapters(bookId);
  const pages = await listPages(bookId);
  const byChapter = new Map(chapters.map(c => [c.id, { ...c, pages: [] }]));
  const topPages = [];
  for (const p of pages) {
    const bucket = p.chapter_id ? byChapter.get(p.chapter_id) : null;
    if (bucket) bucket.pages.push(p);
    else topPages.push(p);
  }
  return { chapters: Array.from(byChapter.values()), topPages };
}

async function loadPagesBatch(pageMetas, _ctx, _opts = {}) {
  // Lokale Reads sind synchron + billig — kein Concurrency-Cap noetig.
  // onError-Hook bleibt fuer API-Symmetrie: missing Page → null statt throw.
  const { onError = null } = _opts;
  const out = [];
  for (const p of pageMetas) {
    try {
      out.push(await loadPage(p.id));
    } catch (e) {
      if (onError) {
        const fallback = onError(p, e);
        if (fallback) out.push(fallback);
      } else throw e;
    }
  }
  return out;
}

// ── Search ──────────────────────────────────────────────────────────────────
// Simple Substring-Suche auf page_name + body_html als Fallback;
// die echte Volltextsuche laeuft ueber FTS5 in lib/search.js.
// ACL via book_id-Param (Caller filtert separat).

async function searchPages(query, { bookId, count = 20 } = {}, _ctx) {
  const q = (query || '').toString().trim();
  if (q.length < 2) return [];
  const safeCount = Math.min(Math.max(parseInt(count, 10) || 20, 1), 100);
  const pattern = `%${q.replace(/[%_]/g, ch => `\\${ch}`)}%`;
  const sql = bookId
    ? `SELECT p.page_id, p.book_id, p.chapter_id, p.page_name, p.slug,
              p.position, p.priority, p.updated_at, p.local_updated_at,
              b.slug AS _book_slug
         FROM pages p
         LEFT JOIN books b ON b.book_id = p.book_id
        WHERE p.book_id = ?
          AND (p.page_name LIKE ? ESCAPE '\\' OR p.body_html LIKE ? ESCAPE '\\')
        LIMIT ?`
    : `SELECT p.page_id, p.book_id, p.chapter_id, p.page_name, p.slug,
              p.position, p.priority, p.updated_at, p.local_updated_at,
              b.slug AS _book_slug
         FROM pages p
         LEFT JOIN books b ON b.book_id = p.book_id
        WHERE p.page_name LIKE ? ESCAPE '\\' OR p.body_html LIKE ? ESCAPE '\\'
        LIMIT ?`;
  const args = bookId
    ? [bookId, pattern, pattern, safeCount]
    : [pattern, pattern, safeCount];
  return db.prepare(sql).all(...args).map(r => _pageMetaRow(r));
}

module.exports = {
  listBooks, loadBook, createBook, updateBook, deleteBook,
  listChapters, loadChapter, createChapter, updateChapter, deleteChapter,
  listPages, loadPage, savePage, createPage, deletePage,
  bookTree, loadPagesBatch, searchPages,
};
