// Word-Level-Diff fuer Revisions-Viewer (Phase 2, BookStack-Exit).
// Pure-Function: keine DOM-/Alpine-Abhaengigkeit, damit testbar via node:test.
// Konsument lazy-loaded jsdiff (window.Diff) und reicht es als `diffLib` rein.

import { escHtml } from './utils.js';

// Identische HTML→Text-Normalisierung wie routes/sync.js, db/page-revisions.js
// und public/js/tree.js. Pflicht-Konsistenz (siehe CLAUDE.md).
export function htmlToPlainText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Rendert Word-Level-Diff zu HTML-String. add → <ins>, removed → <del>,
// unchanged → plain. Jeder Token via escHtml; Output ist x-html-safe.
//
// `diffLib` ist das vom jsdiff-UMD-Bundle exportierte Modul (window.Diff).
// Wir injizieren statt zu importieren, weil die Lib lazy via <script>-Tag
// kommt und nicht als ESM verfuegbar ist.
export function renderWordDiff(oldHtml, newHtml, diffLib) {
  if (!diffLib || typeof diffLib.diffWords !== 'function') {
    throw new Error('renderWordDiff: diffLib.diffWords missing');
  }
  const oldText = htmlToPlainText(oldHtml);
  const newText = htmlToPlainText(newHtml);
  const parts = diffLib.diffWords(oldText, newText);
  if (!parts.length || (parts.length === 1 && !parts[0].added && !parts[0].removed)) {
    return { html: '', unchanged: true };
  }
  let html = '';
  for (const part of parts) {
    const safe = escHtml(part.value);
    if (part.added) html += `<ins class="diff-add">${safe}</ins>`;
    else if (part.removed) html += `<del class="diff-del">${safe}</del>`;
    else html += `<span class="diff-eq">${safe}</span>`;
  }
  return { html, unchanged: false };
}
