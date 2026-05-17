// Side-by-Side Block-Diff fuer Revisions-Viewer.
// Pure-Function: keine DOM-/Alpine-Abhaengigkeit, damit testbar via node:test.
// Konsument lazy-loaded jsdiff (window.Diff) und reicht es als `diffLib` rein.
//
// Pipeline: parseBlocks(HTML) -> diffLib.diffArrays(blockTexts) -> Pair-Changes
// (zip adjacent del+add) -> collapseContext (1 Block vor/nach jeder Change,
// Rest als Skip) -> renderSideBySide (zwei Spalten, Word-Diff inline pro Seite).

import { escHtml } from './utils.js';

const BLOCK_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre'];
const BLOCK_RE = new RegExp(`<(${BLOCK_TAGS.join('|')})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');

// Identische HTML→Text-Normalisierung wie routes/sync.js und db/page-revisions.js.
export function htmlToPlainText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseBlocks(html) {
  const src = String(html || '');
  const matches = [...src.matchAll(BLOCK_RE)];
  if (!matches.length) {
    const text = htmlToPlainText(src);
    return text ? [{ tag: 'p', text }] : [];
  }
  const out = [];
  for (const m of matches) {
    const tag = m[1].toLowerCase();
    const text = htmlToPlainText(m[2]);
    if (text) out.push({ tag, text });
  }
  return out;
}

function attachBlocks(parts, oldBlocks, newBlocks) {
  const entries = [];
  let oldIdx = 0;
  let newIdx = 0;
  for (const part of parts) {
    const items = part.value || [];
    if (part.added) {
      for (let k = 0; k < items.length; k++) entries.push({ kind: 'add', block: newBlocks[newIdx++] });
    } else if (part.removed) {
      for (let k = 0; k < items.length; k++) entries.push({ kind: 'del', block: oldBlocks[oldIdx++] });
    } else {
      for (let k = 0; k < items.length; k++) {
        entries.push({ kind: 'eq', oldBlock: oldBlocks[oldIdx++], newBlock: newBlocks[newIdx++] });
      }
    }
  }
  return entries;
}

function pairChanges(raw) {
  const out = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i].kind === 'del') {
      const dels = [];
      while (i < raw.length && raw[i].kind === 'del') { dels.push(raw[i]); i++; }
      const adds = [];
      while (i < raw.length && raw[i].kind === 'add') { adds.push(raw[i]); i++; }
      const pair = Math.min(dels.length, adds.length);
      for (let k = 0; k < pair; k++) out.push({ kind: 'change', from: dels[k].block, to: adds[k].block });
      for (let k = pair; k < dels.length; k++) out.push(dels[k]);
      for (let k = pair; k < adds.length; k++) out.push(adds[k]);
    } else {
      out.push(raw[i]);
      i++;
    }
  }
  return out;
}

function collapseContext(entries, context = 1) {
  const isChange = entries.map(e => e.kind !== 'eq');
  const keep = entries.map((_, i) => {
    if (isChange[i]) return true;
    const from = Math.max(0, i - context);
    const to = Math.min(entries.length - 1, i + context);
    for (let j = from; j <= to; j++) if (isChange[j]) return true;
    return false;
  });
  const out = [];
  let skip = 0;
  for (let i = 0; i < entries.length; i++) {
    if (keep[i]) {
      if (skip) { out.push({ kind: 'skip', count: skip }); skip = 0; }
      out.push(entries[i]);
    } else {
      skip++;
    }
  }
  if (skip) out.push({ kind: 'skip', count: skip });
  return out;
}

// Bei Heading-Tags semantische Tags rendern, sonst <div>.
function cellTag(tag) {
  return /^h[1-6]$/.test(tag) ? tag : 'div';
}

function cellOpen(tag, modClasses) {
  const t = cellTag(tag);
  return `<${t} class="diff-cell diff-cell--${tag} ${modClasses}">`;
}
function cellClose(tag) {
  return `</${cellTag(tag)}>`;
}

// Renders only `removed` + `eq` parts (Alt-Spalte).
function renderWordsLeft(oldText, newText, diffLib) {
  const parts = diffLib.diffWords(oldText, newText);
  let html = '';
  for (const part of parts) {
    if (part.added) continue;
    const safe = escHtml(part.value);
    if (part.removed) html += `<del class="diff-del">${safe}</del>`;
    else html += `<span class="diff-eq">${safe}</span>`;
  }
  return html;
}

// Renders only `added` + `eq` parts (Neu-Spalte).
function renderWordsRight(oldText, newText, diffLib) {
  const parts = diffLib.diffWords(oldText, newText);
  let html = '';
  for (const part of parts) {
    if (part.removed) continue;
    const safe = escHtml(part.value);
    if (part.added) html += `<ins class="diff-add">${safe}</ins>`;
    else html += `<span class="diff-eq">${safe}</span>`;
  }
  return html;
}

function emptyCell(tag, side) {
  return `${cellOpen(tag, `diff-cell--empty diff-cell--${side}`)}<span class="diff-empty-mark" aria-hidden="true">·</span>${cellClose(tag)}`;
}

function defaultSkipLabel(n) {
  return `… ${n} ${n === 1 ? 'block' : 'blocks'} unchanged …`;
}

function renderEntries(view, diffLib, skipLabel) {
  let html = '';
  for (const e of view) {
    if (e.kind === 'eq') {
      const tag = e.newBlock?.tag || e.oldBlock?.tag || 'p';
      const safe = escHtml(e.newBlock?.text ?? e.oldBlock?.text ?? '');
      html += cellOpen(tag, 'diff-cell--eq diff-cell--left') + safe + cellClose(tag);
      html += cellOpen(tag, 'diff-cell--eq diff-cell--right') + safe + cellClose(tag);
    } else if (e.kind === 'add') {
      html += emptyCell(e.block.tag, 'left');
      html += cellOpen(e.block.tag, 'diff-cell--added diff-cell--right')
        + `<ins class="diff-add">${escHtml(e.block.text)}</ins>`
        + cellClose(e.block.tag);
    } else if (e.kind === 'del') {
      html += cellOpen(e.block.tag, 'diff-cell--removed diff-cell--left')
        + `<del class="diff-del">${escHtml(e.block.text)}</del>`
        + cellClose(e.block.tag);
      html += emptyCell(e.block.tag, 'right');
    } else if (e.kind === 'change') {
      html += cellOpen(e.from.tag, 'diff-cell--changed diff-cell--left')
        + renderWordsLeft(e.from.text, e.to.text, diffLib)
        + cellClose(e.from.tag);
      html += cellOpen(e.to.tag, 'diff-cell--changed diff-cell--right')
        + renderWordsRight(e.from.text, e.to.text, diffLib)
        + cellClose(e.to.tag);
    } else if (e.kind === 'skip') {
      const label = (typeof skipLabel === 'function' ? skipLabel(e.count) : defaultSkipLabel(e.count));
      html += `<div class="diff-cell diff-cell--skip">${escHtml(label)}</div>`;
    }
  }
  return html;
}

// Public API. Vergleicht oldHtml (linke Spalte, ältere Revision) gegen newHtml
// (rechte Spalte, jüngere Revision). `diffLib` ist das vom jsdiff-UMD-Bundle
// exportierte Modul (window.Diff). `opts.skipLabel(n)` rendert das i18n-Label
// fuer kollabierte Stretches; fehlt es, greift ein englischer Default.
export function renderSideBySide(oldHtml, newHtml, diffLib, opts) {
  if (!diffLib || typeof diffLib.diffWords !== 'function' || typeof diffLib.diffArrays !== 'function') {
    throw new Error('renderSideBySide: diffLib.diffWords/diffArrays missing');
  }
  const oldBlocks = parseBlocks(oldHtml);
  const newBlocks = parseBlocks(newHtml);
  const parts = diffLib.diffArrays(oldBlocks.map(b => b.text), newBlocks.map(b => b.text));
  const entries = attachBlocks(parts, oldBlocks, newBlocks);
  if (!entries.length || !entries.some(e => e.kind !== 'eq')) {
    return { html: '', unchanged: true };
  }
  const paired = pairChanges(entries);
  const view = collapseContext(paired, 1);
  const html = renderEntries(view, diffLib, opts?.skipLabel);
  return { html, unchanged: false };
}
