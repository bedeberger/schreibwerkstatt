'use strict';
// jsdiff lazy laden (vendor, cache-first; nur wenn eine Stelle seit dem
// Kommentar geändert wurde) + Wort-Diff „Quote (damals) → aktueller Text" als
// del/ins-DOM-Knoten. Bewusst minimal statt page-revision-diff.js + utils.js zu
// importieren — hält das anonyme Reader-Bundle schlank.

import { el } from './dom.js';

let _diffPromise = null;
function loadDiffLib() {
  if (typeof window.Diff !== 'undefined') return Promise.resolve(window.Diff);
  if (!_diffPromise) {
    _diffPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/diff-9.0.0.min.js';
      s.onload = () => resolve(window.Diff);
      s.onerror = reject;
      document.head.appendChild(s);
    }).catch((e) => { _diffPromise = null; throw e; });
  }
  return _diffPromise;
}

// Wort-Diff „Quote (damals) → aktueller Text" als del/ins-DOM-Knoten anhängen
// (textContent → kein XSS). Gleiche .diff-add/.diff-del-Optik wie der Editor.
export function appendQuoteDiff(container, oldText, newText) {
  loadDiffLib().then((Diff) => {
    if (!Diff || typeof Diff.diffWords !== 'function') return;
    const wrap = el('div', 'comment-rail-diff');
    for (const part of Diff.diffWords(oldText || '', newText || '')) {
      if (part.added) wrap.appendChild(el('ins', 'diff-add', part.value));
      else if (part.removed) wrap.appendChild(el('del', 'diff-del', part.value));
      else wrap.appendChild(el('span', null, part.value));
    }
    container.appendChild(wrap);
  }).catch(() => {});
}
