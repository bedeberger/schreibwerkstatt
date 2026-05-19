'use strict';

// Server-seitiger HTML-Sanitizer für BookStack-Page-Writes. Catched Doppel-Abstände
// (`<p></p>`, `<p><br></p>`, `<p>&nbsp;</p>`-Runs, `<br><br>`-Runs) bevor sie in
// BookStack landen — verhindert dass spätere Exporte oder Renderer doppelte
// Abstände zeigen. Spiegelung von public/js/utils.js (collapseEmptyBlocks +
// stripTrailingEmptyBlocks) auf linkedom. Idempotent.

const { parseHTML } = require('linkedom');

const _STRUCTURAL_LEAF = 'img,iframe,video,audio,table,figure,hr,object,embed,canvas,svg,input,button';

function _isBlankTrailing(node) {
  if (!node) return false;
  if (node.nodeType === 3) return !node.textContent.replace(/ /g, ' ').trim();
  if (node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (tag !== 'P' && tag !== 'DIV' && tag !== 'BR') return false;
  if (tag === 'BR') return true;
  if ((node.textContent || '').replace(/ /g, ' ').trim()) return false;
  if (node.querySelector(_STRUCTURAL_LEAF)) return false;
  return true;
}

function _parseFragment(html) {
  const wrapped = '<!DOCTYPE html><html><body><div id="r">' + html + '</div></body></html>';
  const { document } = parseHTML(wrapped);
  return document.getElementById('r');
}

function _serialize(root) {
  let out = '';
  for (const child of root.childNodes) {
    out += child.nodeType === 3 ? child.textContent : (child.outerHTML || '');
  }
  return out;
}

// Bare Text-Nodes und Inline-Elemente direkt unter dem Root in <p> verpacken.
// BookStack speichert sonst die Roh-Bytes ohne Block-Wrapper (kein bkmrk-ID,
// kein Absatz-Margin). Pendant zu `normalizeEditorBlocks` in
// public/js/editor/edit.js. Idempotent.
const _ROOT_BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'LI', 'PRE', 'UL', 'OL', 'TABLE',
  'FIGURE', 'HR', 'DIV', 'DL', 'SECTION', 'ARTICLE',
  'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'MAIN', 'FORM',
]);

function wrapOrphanBlocks(html) {
  if (!html) return html;
  const root = _parseFragment(html);
  if (!root) return html;
  const doc = root.ownerDocument;
  let group = [];
  const flushBefore = (target) => {
    if (!group.length) return;
    const hasContent = group.some(n =>
      (n.nodeType === 3 && n.textContent.replace(/ /g, ' ').trim()) ||
      (n.nodeType === 1)
    );
    if (!hasContent) { group = []; return; }
    const p = doc.createElement('p');
    for (const n of group) p.appendChild(n);
    if (target) root.insertBefore(p, target);
    else root.appendChild(p);
    group = [];
  };
  const children = Array.from(root.childNodes);
  for (const child of children) {
    if (child.nodeType === 1 && _ROOT_BLOCK_TAGS.has(child.tagName)) {
      flushBefore(child);
    } else {
      group.push(child);
    }
  }
  flushBefore(null);
  return _serialize(root);
}

function collapseEmptyBlocks(html) {
  if (!html) return html;
  const root = _parseFragment(html);
  if (!root) return html;

  let node = root.firstChild;
  while (node) {
    const next = node.nextSibling;
    if (_isBlankTrailing(node)) {
      let probe = next;
      while (probe) {
        const probeNext = probe.nextSibling;
        if (probe.nodeType === 3 && !probe.textContent.replace(/ /g, ' ').trim()) {
          probe.remove();
          probe = probeNext;
          continue;
        }
        if (_isBlankTrailing(probe)) {
          probe.remove();
          probe = probeNext;
          continue;
        }
        break;
      }
    }
    node = next;
  }

  root.querySelectorAll('br').forEach(br => {
    let s = br.nextSibling;
    while (s) {
      const sn = s.nextSibling;
      if (s.nodeType === 3 && !s.textContent.replace(/ /g, ' ').trim()) {
        s.remove();
        s = sn;
        continue;
      }
      if (s.nodeType === 1 && s.tagName === 'BR') {
        s.remove();
        s = sn;
        continue;
      }
      break;
    }
  });

  return _serialize(root);
}

// Editor-Cursor-Anker (`&#160;` am Block-Ende) erzeugen Phantom-Revisionen:
// byte-different, aber visuell identisch (NBSP kollabiert in jeder Stats-/
// Diff-Pipeline). Pre-Persist pro Block leading/trailing Whitespace inkl.
// NBSP aus dem ersten/letzten Text-Node strippen — mid-Block-NBSPs bleiben.
const _EDGE_TRIM_BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div,td,th,dd,dt,figcaption';

function _firstTextNodeIn(el) {
  let n = el.firstChild;
  while (n) {
    if (n.nodeType === 3) return n;
    if (n.nodeType === 1) {
      const inner = _firstTextNodeIn(n);
      if (inner) return inner;
    }
    n = n.nextSibling;
  }
  return null;
}
function _lastTextNodeIn(el) {
  let n = el.lastChild;
  while (n) {
    if (n.nodeType === 3) return n;
    if (n.nodeType === 1) {
      const inner = _lastTextNodeIn(n);
      if (inner) return inner;
    }
    n = n.previousSibling;
  }
  return null;
}

function stripBlockEdgeNbsp(html) {
  if (!html) return html;
  const root = _parseFragment(html);
  if (!root) return html;
  // JS `\s` matcht NBSP ( ) und alle anderen Unicode-Whitespaces.
  for (const el of root.querySelectorAll(_EDGE_TRIM_BLOCKS)) {
    const last = _lastTextNodeIn(el);
    if (last) last.textContent = last.textContent.replace(/[\s ]+$/u, '');
    const first = _firstTextNodeIn(el);
    if (first) first.textContent = first.textContent.replace(/^[\s ]+/u, '');
  }
  return _serialize(root);
}

function stripTrailingEmptyBlocks(html) {
  if (!html) return html;
  const root = _parseFragment(html);
  if (!root) return html;
  let last = root.lastChild;
  while (last && _isBlankTrailing(last)) {
    const prev = last.previousSibling;
    root.removeChild(last);
    last = prev;
  }
  return _serialize(root);
}

// Defense-in-Depth Sanitizer für Page-HTML auf Schreibvorgängen Richtung BookStack.
// Reihenfolge: erst orphan Text-/Inline-Runs in <p> verpacken, danach Leer-Blöcke
// kollabieren — sonst sieht collapseEmptyBlocks die Roh-Bytes ohne Block-Struktur.
function cleanPageHtml(html) {
  if (!html || typeof html !== 'string') return html;
  const out = stripTrailingEmptyBlocks(
    stripBlockEdgeNbsp(
      collapseEmptyBlocks(wrapOrphanBlocks(html))
    )
  );
  return out || '<p></p>';
}

module.exports = { cleanPageHtml, wrapOrphanBlocks, collapseEmptyBlocks, stripTrailingEmptyBlocks, stripBlockEdgeNbsp };
