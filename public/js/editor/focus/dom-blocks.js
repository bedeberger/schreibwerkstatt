// Block-Selektion und Markierungs-Helpers für den Fokusmodus.
//
// - Block-Erkennung um Caret bzw. Viewport-Center.
// - Trailing-Paragraph-Slot beim Eintritt in den Fokusmodus.
// - active/near-Markierungen samt Cleanup ohne residuales `class=""`-Attribut
//   (würde sonst BookStack-Revisionen beim nächsten Save erzeugen).

import { BLOCK_TAGS, BLOCK_SEL } from './constants.js';
import { ensureTrailingParagraph } from '../shared/auto-slot.js';
import { getActiveEditorContainer } from '../shared/active-editor.js';
export { isEmptyParagraph } from '../shared/auto-slot.js';

// Beim Eintritt in den Fokusmodus: Caret an Buchende. Letzter Absatz schon
// leer → wiederverwenden, sonst neuen `<p><br></p>` anhängen. Slot-DOM-Logik
// lebt in shared/auto-slot.js — gemeinsam mit dem Normal-Editor. Hier bleibt
// nur die Focus-spezifische Erweiterung: Caret an den Slot, Container
// re-fokussieren (Chrome-Caret-Paint-Bug nach Mid-Focus-Mutation), scrollIntoView.
//
// NICHT als dirty markieren – der neue Absatz ist nur ein „Schreib-Slot".
// Bleibt er leer und der User schliesst Focus-Mode wieder, räumt
// exitFocusMode den Slot via removeAutoAddedParagraph ab → keine
// Phantom-Revision in BookStack.
export function jumpToTrailingParagraph(container) {
  if (!container) return null;
  const added = ensureTrailingParagraph(container);
  const target = added || container.lastElementChild;
  if (!target) return null;
  // Aktiv-Markierung synchron setzen, sonst gilt die Dim-Regel
  // (opacity 0.35) für den frisch erzeugten Slot bis `_focusUpdateActive`
  // im nächsten RAF aufräumt — Caret rendert dann bei 35% Alpha und ist
  // auf leerer Seite optisch unsichtbar. RAF reconciliiert später korrekt.
  target.classList.add('focus-paragraph-active');
  const range = document.createRange();
  range.setStart(target, 0);
  range.collapse(true);
  const sel = document.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
  // Chrome verliert nach Mid-Focus-Mutation den Caret-Paint — explizit den
  // contenteditable-Container re-fokussieren. `preventScroll: true` damit
  // der nachfolgende scrollIntoView die Centerung übernimmt (sonst zwei
  // konkurrierende Scrolls).
  if (typeof container.focus === 'function') {
    try { container.focus({ preventScroll: true }); }
    catch { container.focus(); }
  }
  // Direkter Sync-Scroll auf den Ziel-Absatz. scrollIntoView ist synchron,
  // triggert Reflow und ist deterministisch — verlässlicher als ein späterer
  // RAF-getriebener Delta-Check, der je nach Layout-Timing knapp unter der
  // Schwelle bleiben kann.
  try { target.scrollIntoView({ block: 'center', behavior: 'auto' }); }
  catch { /* alte Browser ohne ScrollIntoViewOptions */ }
  return added;
}

export function getScrollContainer() {
  // Fokusmodus läuft ausschliesslich im Edit-Modus (Guard in enterFocusMode),
  // also ist `--editing` immer der gewünschte Scroll-Container.
  return getActiveEditorContainer();
}

// Gibt den *äussersten* Block-Ancestor unterhalb von `root` zurück. Grund:
// Bei verschachtelten Blöcken (z.B. `<blockquote><p>…</p></blockquote>` oder
// `<li><p>…</p></li>`) würde ein innermost-Match nur den inneren `<p>` aktiv
// markieren. Der äussere Wrapper (`<blockquote>`/`<li>`) bekäme weiter
// opacity:0.5 — und da opacity im Stacking-Context multipliziert wird, wäre
// der vermeintlich aktive `<p>` trotzdem halb-gedimmt. Outermost-Wahl löst
// das auf: der sichtbare Container-Block wird aktiv, CSS dimmt ihn nicht,
// Kinder erben volle opacity.
export function findBlockFromNode(node, root, blockTags = BLOCK_TAGS) {
  let cur = node && node.nodeType === 3 ? node.parentNode : node;
  let outermost = null;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && blockTags.has(cur.tagName)) outermost = cur;
    cur = cur.parentNode;
  }
  return outermost;
}

// Nimmt beliebiges Iterable von Elementen mit getBoundingClientRect(). Für
// Unit-Tests reicht {getBoundingClientRect: () => ({top, bottom, height})}.
export function pickCenterBlock(containerRect, blocks) {
  const centerY = containerRect.top + containerRect.height / 2;
  let best = null;
  let bestDist = Infinity;
  for (const el of blocks) {
    const r = el.getBoundingClientRect();
    if (r.height === 0) continue;
    const dist = Math.abs((r.top + r.bottom) / 2 - centerY);
    if (dist < bestDist) { bestDist = dist; best = el; }
  }
  return best;
}

export function findBlockAtViewportCenter(container, visibleBlocks, blockSel = BLOCK_SEL) {
  if (!container) return null;
  const pool = (visibleBlocks && visibleBlocks.size > 0)
    ? visibleBlocks
    : container.querySelectorAll(blockSel);
  return pickCenterBlock(container.getBoundingClientRect(), pool);
}

// Räumt defensiv ALLE Active-Markierungen ab und setzt – falls gewünscht –
// genau eine neue. querySelectorAll statt querySelector, weil Chromium beim
// Paragraph-Split in contenteditable die Klasse auf beide <p> kopiert (Enter
// im aktiven Absatz); ohne Vollscan bleibt die „Leiche" stehen und es wirkt,
// als seien zwei Absätze aktiv. block=null → alles ausgrauen.
export function setActiveBlock(container, block) {
  if (!container) return;
  const prevs = container.querySelectorAll('.focus-paragraph-active');
  for (const prev of prevs) {
    if (prev !== block) {
      prev.classList.remove('focus-paragraph-active');
      // classList.remove leert das Attribut nur, entfernt es aber nicht.
      // Zurück bleibt `class=""` und produziert sonst eine BookStack-Revision
      // beim nächsten Save (Diff zur ursprünglichen, attributlosen Fassung).
      if (prev.classList.length === 0) prev.removeAttribute('class');
    }
  }
  if (block && !block.classList.contains('focus-paragraph-active')) {
    block.classList.add('focus-paragraph-active');
  }
}

// Window-Mode: Vorgänger + Nachfolger des aktiven Blocks bleiben hell.
export function setNearBlocks(container, block, blockSel = BLOCK_SEL) {
  if (!container) return;
  const olds = container.querySelectorAll('.focus-paragraph-near');
  for (const el of olds) {
    el.classList.remove('focus-paragraph-near');
    if (el.classList.length === 0) el.removeAttribute('class');
  }
  if (!block) return;
  const sib = (el, dir) => {
    let n = el?.[dir];
    while (n && (n.nodeType !== 1 || !n.matches(blockSel))) n = n[dir];
    return n;
  };
  const tag = (el) => {
    if (!el || el === block) return;
    if (!el.classList.contains('focus-paragraph-near')) el.classList.add('focus-paragraph-near');
  };
  tag(sib(block, 'previousElementSibling'));
  tag(sib(block, 'nextElementSibling'));
}

// Räumt sowohl active- als auch near-Klassen + Custom-Highlight ab.
export function clearAllFocusMarks(container) {
  if (!container) return;
  for (const el of container.querySelectorAll('.focus-paragraph-active, .focus-paragraph-near')) {
    el.classList.remove('focus-paragraph-active');
    el.classList.remove('focus-paragraph-near');
    if (el.classList.length === 0) el.removeAttribute('class');
  }
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    CSS.highlights.delete('focus-sentence-dim');
  }
}
