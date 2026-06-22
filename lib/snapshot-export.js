'use strict';

// Adapter: Fassungs-`content_json` (book_snapshots) -> Export-Bundle.
//
// Reader, alle Format-Builder (lib/export-builders/*) und der PDF-Render
// (lib/pdf-render) arbeiten gegen dieselbe Struktur, die sonst lib/load-contents
// aus dem Live-Buch baut:
//   { scope:'book', book:{ id, name, slug, description }, groups:[…] }
//   groups = [{ chapterId, chapter:{ id, name, parent_chapter_id, slug }|null,
//               pages:[{ p:{ id, name, slug }, pd:{ html } }] }]
//
// Hier wird dieselbe Form aus dem selbsttragenden Snapshot-Tree gebaut
// (buildBookJson-Format aus lib/book-bundle.js: { book, tree:[node…] } mit
// Seiten-HTML inline), damit eine Fassung exportiert/gelesen werden kann, ohne
// den aktuellen Buchstand anzufassen.
//
// Pure — keine DB, kein Express. node:test-bar.

const { slugify } = require('./slug');

// Node-Shapes (lib/book-bundle.js):
//   { type:'chapter', name, srcId, children:[node…] }
//   { type:'page',    name, html, srcId }
//
// Gruppierung spiegelt lib/load-contents.js#_groupByChapter: pro zusammen-
// haengendem Kapitel-Lauf eine Gruppe; kapitellose Top-Seiten je eigene
// chapterId:null-Gruppe. Reihenfolge = Lesereihenfolge (depth-first).
function snapshotToBundle(content, { bookId = null, bookName = '', bookDescription = '' } = {}) {
  const nodes = Array.isArray(content?.tree) ? content.tree : [];
  const groups = [];
  let synthChapterId = 0; // synthetische, in sich konsistente Kapitel-IDs

  function walk(list, parentChapterId, parentChapter) {
    let run = null; // aktuelle Seiten-Gruppe innerhalb dieses Kapitels
    for (const node of (list || [])) {
      if (!node || typeof node !== 'object') continue;

      if (node.type === 'page') {
        const page = {
          p: {
            id: Number.isFinite(node.srcId) ? node.srcId : null,
            name: typeof node.name === 'string' ? node.name : '',
            slug: slugify(typeof node.name === 'string' ? node.name : ''),
          },
          pd: { html: typeof node.html === 'string' ? node.html : '' },
        };
        if (parentChapterId == null) {
          // Kapitellose Top-Seite: eigene Gruppe (kein Lauf).
          groups.push({ chapterId: null, chapter: null, pages: [page] });
          run = null;
        } else {
          if (!run) {
            run = { chapterId: parentChapterId, chapter: parentChapter, pages: [] };
            groups.push(run);
          }
          run.pages.push(page);
        }
      } else if (node.type === 'chapter') {
        const id = ++synthChapterId;
        const name = typeof node.name === 'string' ? node.name : '';
        const chapter = { id, name, parent_chapter_id: parentChapterId, slug: slugify(name) };
        walk(node.children, id, chapter);
        // Ein Kapitelblock beendet den laufenden Top-/Eltern-Lauf.
        run = null;
      }
    }
  }

  walk(nodes, null, null);

  const name = (typeof content?.book?.name === 'string' && content.book.name) || bookName || '';
  const description = (typeof content?.book?.description === 'string' && content.book.description)
    || bookDescription || '';

  return {
    scope: 'book',
    book: { id: bookId, name, slug: slugify(name), description },
    groups,
  };
}

module.exports = { snapshotToBundle };
