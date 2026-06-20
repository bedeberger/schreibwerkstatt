// Buch-Level-Diff zwischen zwei Manuskript-Fassungen (book_snapshots).
// Pure-Function: keine DOM-/Alpine-Abhaengigkeit → testbar via node:test.
// Die eigentliche Seiten-Diff-Darstellung (Word-Level, Side-by-Side) macht
// weiterhin page-revision-diff.js#renderSideBySide — hier wird nur strukturell
// ausgerichtet (welche Seite kam dazu / fiel weg / wurde umbenannt / verschoben /
// inhaltlich geaendert) und die HTML-Bodies der gemeinsamen Seiten durchgereicht.
//
//   flattenSnapshot(content) -> [{ srcId, name, html, chapterPath, order }]
//   diffSnapshots(from, to)  -> { summary, entries }
//
// Ausrichtung erfolgt ueber srcId (= Quell-page_id, von treeToNodes inline
// gesetzt). Seiten ohne srcId (Legacy/Defekt) werden positionsfrei behandelt
// und landen als added/removed — Snapshots aus diesem Code tragen immer srcId.

import { htmlToPlainText } from './html-text.js';

// content = { book, tree:[node…] }  (buildBookJson-Format) ODER direkt das
// Node-Array. Liefert die Seiten in Lesereihenfolge mit ihrem Kapitelpfad.
export function flattenSnapshot(content) {
  const nodes = Array.isArray(content) ? content : (content && Array.isArray(content.tree) ? content.tree : []);
  const out = [];
  let order = 0;
  (function walk(list, chapterPath) {
    for (const node of (list || [])) {
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'page') {
        out.push({
          srcId: Number.isFinite(node.srcId) ? node.srcId : null,
          name: typeof node.name === 'string' ? node.name : '',
          html: typeof node.html === 'string' ? node.html : '',
          chapterPath: chapterPath.slice(),
          order: order++,
        });
      } else if (node.type === 'chapter') {
        walk(node.children, chapterPath.concat([typeof node.name === 'string' ? node.name : '']));
      }
    }
  })(nodes, []);
  return out;
}

function _pathEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function _sumChars(pages) {
  let n = 0;
  for (const p of pages) n += htmlToPlainText(p.html).length;
  return n;
}

// Vergleicht Fassung `from` (aelter) gegen `to` (juenger).
// entries: Reihenfolge = `to`-Lesereihenfolge; entfernte Seiten am Ende in
// `from`-Reihenfolge. Jeder Eintrag traegt fromHtml/toHtml fuer die spaetere
// Word-Level-Darstellung.
export function diffSnapshots(from, to) {
  const fromPages = flattenSnapshot(from);
  const toPages = flattenSnapshot(to);

  const fromById = new Map();
  for (const p of fromPages) if (p.srcId != null) fromById.set(p.srcId, p);
  const toById = new Map();
  for (const p of toPages) if (p.srcId != null) toById.set(p.srcId, p);

  const entries = [];
  const summary = {
    added: 0, removed: 0, changed: 0, unchanged: 0,
    renamed: 0, moved: 0,
    totalFrom: fromPages.length, totalTo: toPages.length,
    charsFrom: _sumChars(fromPages), charsTo: _sumChars(toPages),
  };

  // `to`-Reihenfolge durchgehen.
  for (const tp of toPages) {
    const fp = tp.srcId != null ? fromById.get(tp.srcId) : null;
    if (!fp) {
      entries.push({
        srcId: tp.srcId, status: 'added', renamed: false, moved: false,
        name: tp.name, oldName: null,
        chapterPath: tp.chapterPath, oldChapterPath: null,
        fromHtml: '', toHtml: tp.html,
      });
      summary.added += 1;
      continue;
    }
    const renamed = fp.name !== tp.name;
    const moved = !_pathEq(fp.chapterPath, tp.chapterPath);
    const textChanged = htmlToPlainText(fp.html) !== htmlToPlainText(tp.html);
    const status = textChanged ? 'changed' : 'unchanged';
    entries.push({
      srcId: tp.srcId, status, renamed, moved,
      name: tp.name, oldName: renamed ? fp.name : null,
      chapterPath: tp.chapterPath, oldChapterPath: moved ? fp.chapterPath : null,
      fromHtml: fp.html, toHtml: tp.html,
    });
    if (status === 'changed') summary.changed += 1; else summary.unchanged += 1;
    if (renamed) summary.renamed += 1;
    if (moved) summary.moved += 1;
  }

  // Entfernte Seiten (in `from`, nicht in `to`).
  for (const fp of fromPages) {
    const stillThere = fp.srcId != null && toById.has(fp.srcId);
    if (stillThere) continue;
    entries.push({
      srcId: fp.srcId, status: 'removed', renamed: false, moved: false,
      name: fp.name, oldName: null,
      chapterPath: fp.chapterPath, oldChapterPath: null,
      fromHtml: fp.html, toHtml: '',
    });
    summary.removed += 1;
  }

  return { summary, entries };
}
