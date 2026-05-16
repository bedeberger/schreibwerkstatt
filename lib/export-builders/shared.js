'use strict';
// Gemeinsame Helpers fuer Format-Builder. Halten XML/HTML-Escape, Intro-HTML-
// Resolution und Scope-aware Titel.

function escXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function chapterIntroHtml(chapter) {
  if (!chapter) return '';
  if (chapter.description_html) return chapter.description_html;
  if (chapter.description) return `<p>${escXml(chapter.description)}</p>`;
  return '';
}

// Scope-aware Dokument-Titel fuer Filename-Slug + Title-Page.
function resolveTitle({ scope, book, chapter, page }) {
  if (scope === 'chapter' && chapter) return chapter.name || book?.name || 'Chapter';
  if (scope === 'page' && page) return page.name || book?.name || 'Page';
  return book?.name || 'Book';
}

function resolveSlug({ scope, book, chapter, page }) {
  if (scope === 'chapter' && chapter) return chapter.slug || chapter.name || book?.slug || 'chapter';
  if (scope === 'page' && page) return page.slug || page.name || book?.slug || 'page';
  return book?.slug || book?.name || 'book';
}

module.exports = { escXml, chapterIntroHtml, resolveTitle, resolveSlug };
