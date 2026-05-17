'use strict';
// SSoT fuer Buch-Hierarchie.
//
// order_json-Format (zwei Ebenen, Buch -> Kapitel|Seite -> Seite):
//   [
//     { "type": "chapter", "id": 42, "children": [
//         { "type": "page", "id": 101 },
//         { "type": "page", "id": 102 }
//     ]},
//     { "type": "page", "id": 103 },
//     { "type": "chapter", "id": 43, "children": [] }
//   ]
//
// PUT-Hook validiert + materialisiert in einer Transaction:
//   - chapters.position (0-basiert, lueckenlos in Tree-Reihenfolge)
//   - pages.position    (0-basiert, lueckenlos pro Bucket: Kapitel oder Top-Level)
//   - pages.chapter_id  (NULL fuer Top-Level)
//
// Materialisierte Spalten sind nur fuer Querys/JOINs (Filter, Sort in
// figures/locations/jobs). SSoT bleibt order_json — bookTree liest daraus.

const { db } = require('./connection');
require('./migrations');

class TreeValidationError extends Error {
  constructor(code, detail = null) {
    super(`book_order tree invalid: ${code}${detail ? ` (${detail})` : ''}`);
    this.code = code;
    this.detail = detail;
    this.status = 400;
  }
}

function _knownIds(bookId) {
  const chapters = db.prepare('SELECT chapter_id FROM chapters WHERE book_id = ?').all(bookId);
  const pages = db.prepare('SELECT page_id FROM pages WHERE book_id = ?').all(bookId);
  return {
    chapterIds: new Set(chapters.map(r => r.chapter_id)),
    pageIds: new Set(pages.map(r => r.page_id)),
  };
}

function validateTree(tree, bookId) {
  if (!Array.isArray(tree)) throw new TreeValidationError('NOT_ARRAY');
  const { chapterIds, pageIds } = _knownIds(bookId);
  const seenChapters = new Set();
  const seenPages = new Set();

  for (const entry of tree) {
    if (!entry || typeof entry !== 'object') throw new TreeValidationError('ENTRY_NOT_OBJECT');
    if (entry.type !== 'chapter' && entry.type !== 'page') {
      throw new TreeValidationError('BAD_TYPE', String(entry.type));
    }
    if (!Number.isInteger(entry.id) || entry.id <= 0) {
      throw new TreeValidationError('BAD_ID', JSON.stringify(entry.id));
    }
    if (entry.type === 'chapter') {
      if (!chapterIds.has(entry.id)) throw new TreeValidationError('UNKNOWN_CHAPTER', entry.id);
      if (seenChapters.has(entry.id)) throw new TreeValidationError('DUPLICATE_CHAPTER', entry.id);
      seenChapters.add(entry.id);
      const children = entry.children || [];
      if (!Array.isArray(children)) throw new TreeValidationError('CHILDREN_NOT_ARRAY', entry.id);
      for (const child of children) {
        if (!child || typeof child !== 'object') throw new TreeValidationError('CHILD_NOT_OBJECT');
        if (child.type !== 'page') throw new TreeValidationError('NESTED_CHAPTER', entry.id);
        if (!Number.isInteger(child.id) || child.id <= 0) {
          throw new TreeValidationError('CHILD_BAD_ID', JSON.stringify(child.id));
        }
        if (!pageIds.has(child.id)) throw new TreeValidationError('UNKNOWN_PAGE', child.id);
        if (seenPages.has(child.id)) throw new TreeValidationError('DUPLICATE_PAGE', child.id);
        if ('children' in child && child.children && child.children.length) {
          throw new TreeValidationError('PAGE_HAS_CHILDREN', child.id);
        }
        seenPages.add(child.id);
      }
    } else {
      // page on top-level
      if (!pageIds.has(entry.id)) throw new TreeValidationError('UNKNOWN_PAGE', entry.id);
      if (seenPages.has(entry.id)) throw new TreeValidationError('DUPLICATE_PAGE', entry.id);
      if ('children' in entry && entry.children && entry.children.length) {
        throw new TreeValidationError('PAGE_HAS_CHILDREN', entry.id);
      }
      seenPages.add(entry.id);
    }
  }

  if (seenChapters.size !== chapterIds.size) {
    const missing = [...chapterIds].filter(id => !seenChapters.has(id));
    throw new TreeValidationError('MISSING_CHAPTER', JSON.stringify(missing.slice(0, 5)));
  }
  if (seenPages.size !== pageIds.size) {
    const missing = [...pageIds].filter(id => !seenPages.has(id));
    throw new TreeValidationError('MISSING_PAGE', JSON.stringify(missing.slice(0, 5)));
  }
}

// Materialisiert die Tree-Reihenfolge in chapters.position/pages.position/
// pages.chapter_id. 0-basiert, lueckenlos pro Bucket. Caller wrapped in Tx.
function materializeTree(bookId, tree) {
  const updateChapter = db.prepare('UPDATE chapters SET position = ?, priority = ? WHERE chapter_id = ? AND book_id = ?');
  const updatePage = db.prepare('UPDATE pages SET position = ?, priority = ?, chapter_id = ? WHERE page_id = ? AND book_id = ?');

  let chapterIdx = 0;
  let topPageIdx = 0;
  for (const entry of tree) {
    if (entry.type === 'chapter') {
      updateChapter.run(chapterIdx, chapterIdx, entry.id, bookId);
      chapterIdx++;
      let pageIdx = 0;
      for (const child of (entry.children || [])) {
        updatePage.run(pageIdx, pageIdx, entry.id, child.id, bookId);
        pageIdx++;
      }
    } else {
      updatePage.run(topPageIdx, topPageIdx, null, entry.id, bookId);
      topPageIdx++;
    }
  }
}

function _getRowStmt() {
  return db.prepare('SELECT book_id, order_json, updated_at, updated_by FROM book_order WHERE book_id = ?');
}

function getOrder(bookId) {
  const r = _getRowStmt().get(bookId);
  if (!r) return null;
  let tree = null;
  try { tree = JSON.parse(r.order_json); }
  catch { tree = null; }
  return { tree, updated_at: r.updated_at, updated_by: r.updated_by };
}

const _upsertStmt = db.prepare(`
  INSERT INTO book_order (book_id, order_json, updated_at, updated_by)
  VALUES (?, ?, datetime('now'), ?)
  ON CONFLICT(book_id) DO UPDATE SET
    order_json = excluded.order_json,
    updated_at = datetime('now'),
    updated_by = excluded.updated_by
`);

// Validiert + materialisiert + persistiert in einer Transaction.
function putOrder(bookId, tree, userEmail = null) {
  validateTree(tree, bookId);
  const json = JSON.stringify(tree);
  const tx = db.transaction(() => {
    materializeTree(bookId, tree);
    _upsertStmt.run(bookId, json, userEmail);
  });
  tx();
  return getOrder(bookId);
}

// Initial-Fill: Tree aus aktuellen pages.position/chapters.position (bzw.
// priority als Fallback) ableiten. Verwendet vom Backfill + bookTree-Read,
// wenn noch keine book_order-Row existiert.
function buildFromCurrentState(bookId) {
  const chapters = db.prepare(`
    SELECT chapter_id, COALESCE(position, priority, 0) AS pos
      FROM chapters WHERE book_id = ?
     ORDER BY COALESCE(position, priority, 0), chapter_id
  `).all(bookId);
  const pages = db.prepare(`
    SELECT page_id, chapter_id, COALESCE(position, priority, 0) AS pos
      FROM pages WHERE book_id = ?
     ORDER BY COALESCE(position, priority, 0), page_id
  `).all(bookId);

  const byChapter = new Map();
  const topPages = [];
  for (const p of pages) {
    if (p.chapter_id) {
      if (!byChapter.has(p.chapter_id)) byChapter.set(p.chapter_id, []);
      byChapter.get(p.chapter_id).push(p);
    } else {
      topPages.push(p);
    }
  }

  // Stable order: Kapitel + Top-Level-Seiten gemischt nach pos. Kapitel zuerst
  // bei Gleichstand (Page hat keinen eigenen Sortier-Slot relativ zu Chapter
  // im Bestandsmodell, also Heuristik: Chapter-First).
  const mixed = [
    ...chapters.map(c => ({ type: 'chapter', id: c.chapter_id, pos: c.pos })),
    ...topPages.map(p => ({ type: 'page', id: p.page_id, pos: p.pos })),
  ].sort((a, b) => {
    if (a.pos !== b.pos) return a.pos - b.pos;
    if (a.type !== b.type) return a.type === 'chapter' ? -1 : 1;
    return a.id - b.id;
  });

  return mixed.map(e => {
    if (e.type === 'chapter') {
      const children = (byChapter.get(e.id) || []).map(p => ({ type: 'page', id: p.page_id }));
      return { type: 'chapter', id: e.id, children };
    }
    return { type: 'page', id: e.id };
  });
}

// Reconciliation: stored tree mit aktuellem DB-Stand abgleichen. Items, die
// in der DB nicht (mehr) existieren, fliegen raus; neue Items werden ans Ende
// angehaengt (Kapitel als leeres Top-Level-Kapitel, Seiten als Top-Level).
// Verwendet vom Lese-Pfad nach BookStack-Sync oder nach
// CRUD-Operationen, die book_order nicht selbst pflegen.
function reconcile(bookId, storedTree) {
  const { chapterIds, pageIds } = _knownIds(bookId);
  const seenChapters = new Set();
  const seenPages = new Set();
  const reconciled = [];

  for (const entry of (storedTree || [])) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'chapter') {
      if (!chapterIds.has(entry.id) || seenChapters.has(entry.id)) continue;
      seenChapters.add(entry.id);
      const children = [];
      for (const child of (entry.children || [])) {
        if (!child || child.type !== 'page') continue;
        if (!pageIds.has(child.id) || seenPages.has(child.id)) continue;
        seenPages.add(child.id);
        children.push({ type: 'page', id: child.id });
      }
      reconciled.push({ type: 'chapter', id: entry.id, children });
    } else if (entry.type === 'page') {
      if (!pageIds.has(entry.id) || seenPages.has(entry.id)) continue;
      seenPages.add(entry.id);
      reconciled.push({ type: 'page', id: entry.id });
    }
  }

  // Fehlende Kapitel ans Ende, jeweils mit ihren Seiten.
  const missingChapters = [...chapterIds].filter(id => !seenChapters.has(id)).sort((a, b) => a - b);
  for (const chId of missingChapters) {
    const pagesOfCh = db.prepare(`
      SELECT page_id FROM pages
       WHERE book_id = ? AND chapter_id = ?
       ORDER BY COALESCE(position, priority, 0), page_id
    `).all(bookId, chId);
    const children = [];
    for (const p of pagesOfCh) {
      if (seenPages.has(p.page_id)) continue;
      seenPages.add(p.page_id);
      children.push({ type: 'page', id: p.page_id });
    }
    reconciled.push({ type: 'chapter', id: chId, children });
  }

  // Restliche Seiten (Top-Level oder Waisen mit chapter_id, das aber im Tree
  // fehlt) ans Top-Level-Ende.
  const missingPages = [...pageIds].filter(id => !seenPages.has(id)).sort((a, b) => a - b);
  for (const pId of missingPages) {
    reconciled.push({ type: 'page', id: pId });
  }

  return reconciled;
}

// Liefert die aktuelle Tree-Struktur. Mit Auto-Init: keine Row -> aus
// Bestand bauen + persistieren. Mit Auto-Reconcile: vorhandene Row gegen
// aktuellen DB-Stand abgleichen, falls Items hinzugekommen/verschwunden sind
// (z.B. nach BookStack-Sync, Direct-Insert via API ausserhalb des PUT-Hooks).
//
// Defensiv: kein books-Row → kein Auto-Init, sonst FK-Violation gegen
// books(book_id). Tritt bei bookstack-Backend auf, wenn das Buch noch nicht
// lokal gesynct ist; Caller (bookTree-Facade) faellt auf raw zurueck.
function ensureTree(bookId, userEmail = null) {
  const bookExists = db.prepare('SELECT 1 FROM books WHERE book_id = ?').get(bookId);
  if (!bookExists) return { tree: [], updated_at: null, updated_by: null };
  const existing = getOrder(bookId);
  if (!existing) {
    const tree = buildFromCurrentState(bookId);
    putOrder(bookId, tree, userEmail);
    return getOrder(bookId);
  }
  const reconciled = reconcile(bookId, existing.tree || []);
  const before = JSON.stringify(existing.tree || []);
  const after = JSON.stringify(reconciled);
  if (before === after) return existing;
  // Reconcile aendert nur die Menge, keine User-getriebene Reorder — ohne
  // updated_by-Update, damit „letzter Reorder durch X" valide bleibt.
  const tx = db.transaction(() => {
    materializeTree(bookId, reconciled);
    db.prepare(`UPDATE book_order SET order_json = ? WHERE book_id = ?`).run(after, bookId);
  });
  tx();
  return getOrder(bookId);
}

module.exports = {
  validateTree,
  materializeTree,
  getOrder,
  putOrder,
  buildFromCurrentState,
  reconcile,
  ensureTree,
  TreeValidationError,
};
