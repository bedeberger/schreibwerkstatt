'use strict';
// Phase 0b (BookStack-Exit, docs/bookstack-exit.md): Vollabzug aller BookStack-
// Buecher/Kapitel/Seiten in die lokale DB. Idempotent — Re-Run aktualisiert
// bestehende Rows, fuegt fehlende hinzu. Pflicht-Reihenfolge pro Buch:
// books → chapters → pages, alles in einer Transaktion, foreign_key_check
// am Ende. Pages kommen mit body_html + body_markdown bereits angereichert.
//
// `owner_email` wird beim Backfill nur dann gesetzt, wenn das Buch noch keinen
// Owner hat — erster Backfiller „erbt" das Buch, Phase 4b regelt Sharing.

const { db } = require('./connection');
const logger = require('../logger');

const _stmtUpsertBookFull = db.prepare(`
  INSERT INTO books (book_id, name, slug, description, created_at, updated_at, last_seen_at, owner_email)
  VALUES (@book_id, @name, @slug, @description, @created_at, @updated_at, @last_seen_at, @owner_email)
  ON CONFLICT(book_id) DO UPDATE SET
    name         = excluded.name,
    slug         = excluded.slug,
    description  = excluded.description,
    updated_at   = excluded.updated_at,
    last_seen_at = excluded.last_seen_at,
    -- owner_email darf bei Re-Backfill nicht ueberschrieben werden, sobald gesetzt
    owner_email  = COALESCE(books.owner_email, excluded.owner_email)
`);

const _stmtUpsertChapterFull = db.prepare(`
  INSERT INTO chapters (chapter_id, book_id, chapter_name, description, position, priority, slug, updated_at, last_seen_at)
  VALUES (@chapter_id, @book_id, @chapter_name, @description, @position, @priority, @slug, @updated_at, @last_seen_at)
  ON CONFLICT(chapter_id) DO UPDATE SET
    book_id      = excluded.book_id,
    chapter_name = excluded.chapter_name,
    description  = excluded.description,
    position     = excluded.position,
    priority     = excluded.priority,
    slug         = excluded.slug,
    updated_at   = excluded.updated_at,
    last_seen_at = excluded.last_seen_at
`);

const _stmtUpsertPageFull = db.prepare(`
  INSERT INTO pages (
    page_id, book_id, page_name, chapter_id, slug,
    body_html, body_markdown,
    position, priority,
    updated_at, last_seen_at,
    local_updated_at, remote_updated_at, dirty
  ) VALUES (
    @page_id, @book_id, @page_name, @chapter_id, @slug,
    @body_html, @body_markdown,
    @position, @priority,
    @updated_at, @last_seen_at,
    @local_updated_at, @remote_updated_at, 0
  )
  ON CONFLICT(page_id) DO UPDATE SET
    book_id           = excluded.book_id,
    page_name         = excluded.page_name,
    chapter_id        = excluded.chapter_id,
    slug              = excluded.slug,
    body_html         = excluded.body_html,
    body_markdown     = excluded.body_markdown,
    position          = excluded.position,
    priority          = excluded.priority,
    updated_at        = excluded.updated_at,
    last_seen_at      = excluded.last_seen_at,
    local_updated_at  = excluded.local_updated_at,
    remote_updated_at = excluded.remote_updated_at,
    -- dirty bleibt unangetastet bei Re-Backfill, weil der User in der
    -- Zwischenzeit lokal editiert haben koennte (Phase 1 Sync-Worker).
    dirty             = pages.dirty
`);

// Akzeptiert das von lib/content-mapper.js gelieferte Domain-Shape
// ({ id, name, slug, description, updated_at, created_at }) plus owner_email.
function upsertBookFromBackfill(book, { ownerEmail, seenAt }) {
  if (!book || !book.id) return false;
  _stmtUpsertBookFull.run({
    book_id:      book.id,
    name:         book.name || `Buch ${book.id}`,
    slug:         book.slug || null,
    description:  book.description || null,
    created_at:   book.created_at || seenAt,
    updated_at:   book.updated_at || seenAt,
    last_seen_at: seenAt,
    owner_email:  ownerEmail || null,
  });
  return true;
}

// mapChapter-Shape: { id, book_id, name, slug, description, position, updated_at, created_at }
function upsertChapterFromBackfill(chapter, { seenAt }) {
  if (!chapter || !chapter.id) return false;
  _stmtUpsertChapterFull.run({
    chapter_id:   chapter.id,
    book_id:      chapter.book_id,
    chapter_name: chapter.name || `Kapitel ${chapter.id}`,
    description:  chapter.description || null,
    position:     Number.isFinite(chapter.position) ? chapter.position : null,
    // BookStack haelt die Sortierung in `priority`; Phase 1 (Sync-Worker)
    // schreibt sie 1:1 dort hin. mapChapter exposed sie als `position`.
    priority:     Number.isFinite(chapter.position) ? chapter.position : null,
    slug:         chapter.slug || null,
    updated_at:   chapter.updated_at || null,
    last_seen_at: seenAt,
  });
  return true;
}

// mapPage-Shape (Volltext): { id, book_id, chapter_id, name, slug, position,
//                             updated_at, html, markdown, raw_html, ... }
function upsertPageFromBackfill(page, { seenAt }) {
  if (!page || !page.id) return false;
  const remoteUpd = page.updated_at || null;
  _stmtUpsertPageFull.run({
    page_id:           page.id,
    book_id:           page.book_id,
    page_name:         page.name || `Seite ${page.id}`,
    chapter_id:        page.chapter_id || null,
    slug:              page.slug || null,
    body_html:         page.html || null,
    body_markdown:     page.markdown || null,
    position:          Number.isFinite(page.position) ? page.position : null,
    priority:          Number.isFinite(page.position) ? page.position : null,
    updated_at:        remoteUpd,
    last_seen_at:      seenAt,
    local_updated_at:  remoteUpd,
    remote_updated_at: remoteUpd,
  });
  return true;
}

// Transaktion pro Buch — books → chapters → pages, foreign_key_check am Ende.
// Liefert `{ chapterCount, pageCount }`. Wirft bei FK-Verstoss; Caller markiert
// den Job als failed und Transaktion rollt zurueck.
function backfillBookTransactional({ book, chapters, pages, ownerEmail }) {
  const seenAt = new Date().toISOString();
  let chapterCount = 0;
  let pageCount = 0;

  // db.transaction wirft Exceptions weiter, Rollback ist automatisch.
  db.transaction(() => {
    upsertBookFromBackfill(book, { ownerEmail, seenAt });
    for (const c of chapters) {
      if (upsertChapterFromBackfill(c, { seenAt })) chapterCount++;
    }
    for (const p of pages) {
      if (upsertPageFromBackfill(p, { seenAt })) pageCount++;
    }
  })();

  const fkErrors = db.pragma('foreign_key_check');
  if (fkErrors.length) {
    // Bei FK-Verstoss kann die Transaktion bereits committed sein (better-sqlite3
    // committed beim Verlassen der Closure). Loggen + werfen, damit Caller den
    // Job als error markiert. Daten-Rollback ist hier nicht trivial — defensiv
    // sollte das aber praktisch nie passieren, weil Reihenfolge stimmt.
    const sample = JSON.stringify(fkErrors.slice(0, 5));
    logger.error(`Backfill Buch ${book.id}: foreign_key_check meldet ${fkErrors.length} Verstoesse: ${sample}`);
    const err = new Error('job.error.backfillFkViolation');
    err.i18nParams = { count: fkErrors.length, bookId: book.id };
    throw err;
  }
  return { chapterCount, pageCount };
}

module.exports = {
  upsertBookFromBackfill,
  upsertChapterFromBackfill,
  upsertPageFromBackfill,
  backfillBookTransactional,
};
