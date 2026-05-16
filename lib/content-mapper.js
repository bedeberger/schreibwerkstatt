'use strict';
// Uebersetzt BookStack-API-JSON in das App-eigene Domain-Shape (Book/Chapter/Page).
// Caller von routes/content.js und kuenftigen Konsumenten haengen damit nicht
// mehr an BookStack-spezifischen Feldern (`priority`, verschachteltes `owned_by`).
// Phase 1 des Exit-Plans (Read-Replica) befuellt dieselben Shapes aus lokalen
// Tabellen — der Mapper ist die SSoT fuer das Domain-Shape.

function _firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return null;
}

function mapBook(bs) {
  if (!bs || typeof bs !== 'object') return null;
  return {
    id: bs.id,
    name: bs.name || '',
    slug: bs.slug || null,
    description: bs.description || '',
    updated_at: bs.updated_at || null,
    created_at: bs.created_at || null,
  };
}

function mapChapter(bs) {
  if (!bs || typeof bs !== 'object') return null;
  return {
    id: bs.id,
    book_id: bs.book_id,
    name: bs.name || '',
    slug: bs.slug || null,
    book_slug: bs.book_slug || null,
    description: bs.description || '',
    position: _firstDefined(bs.priority),
    updated_at: bs.updated_at || null,
    created_at: bs.created_at || null,
  };
}

function mapPageMeta(bs) {
  if (!bs || typeof bs !== 'object') return null;
  return {
    id: bs.id,
    book_id: bs.book_id,
    chapter_id: bs.chapter_id || null,
    name: bs.name || '',
    slug: bs.slug || null,
    book_slug: bs.book_slug || null,
    position: _firstDefined(bs.priority),
    updated_at: bs.updated_at || null,
    created_at: bs.created_at || null,
    draft: !!bs.draft,
    template: !!bs.template,
  };
}

function mapPage(bs) {
  const meta = mapPageMeta(bs);
  if (!meta) return null;
  return {
    ...meta,
    html: bs.html || '',
    markdown: bs.markdown || null,
    raw_html: bs.raw_html || null,
    revision_count: typeof bs.revision_count === 'number' ? bs.revision_count : null,
    updated_by_name: bs.updated_by?.name || null,
  };
}

module.exports = { mapBook, mapChapter, mapPage, mapPageMeta };
