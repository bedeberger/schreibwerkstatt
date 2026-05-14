// Typewriter-Scroll: hält die Cursor-Zeile in der Viewport-Mitte.
//
// Schwelle dynamisch aus computed line-height — Tippen innerhalb derselben
// Zeile löst dank Caret-Rect-Jitter sonst Mini-Scrolls aus, die den Editor
// unruhig wirken lassen.

import { TYPEWRITER_THRESHOLD_PX, prefersReducedMotion } from './constants.js';

export { TYPEWRITER_THRESHOLD_PX };

export function dynamicTypewriterThreshold(block, fallback = TYPEWRITER_THRESHOLD_PX) {
  if (!block || typeof window === 'undefined' || !window.getComputedStyle) return fallback;
  try {
    const lh = parseFloat(window.getComputedStyle(block).lineHeight);
    if (Number.isFinite(lh) && lh > 0) return Math.max(fallback, lh * 0.5);
  } catch { /* ignore */ }
  return fallback;
}

// Range um 1 Position erweitern, Rect lesen, Probe wegwerfen. Browser liefern
// für collapsed Ranges am Soft-Wrap-Bruch / direkt nach <br> regelmässig
// leere getClientRects() und Höhe-0-BoundingClientRect. Eine non-collapsed
// Probe-Range liefert deterministisch den Rect der angrenzenden Glyphe — und
// damit die korrekte visuelle Zeile.
function expandRangeRect(range) {
  const node = range.startContainer;
  if (!node) return null;
  const off = range.startOffset;
  const len = node.nodeType === 3 ? (node.nodeValue || '').length : node.childNodes.length;
  const probe = range.cloneRange();
  try {
    if (off < len) probe.setEnd(node, off + 1);
    else if (off > 0) probe.setStart(node, off - 1);
    else return null;
  } catch { return null; }
  const rects = probe.getClientRects();
  if (rects.length > 0 && rects[0].height > 0) return rects[0];
  const bb = probe.getBoundingClientRect();
  if (bb && bb.height > 0) return bb;
  return null;
}

// Liefert das Rect der visuellen Zeile, in der der Caret sitzt. Drei Stufen:
// 1) `getClientRects()[0]` — schnellster Pfad, deckt 95 % der Fälle.
// 2) `getBoundingClientRect()` — Fallback wenn Step 1 leer (manche Browser).
// 3) **Range um 1 Zeichen expandieren** — fängt collapsed-Range-Bug am
//    Soft-Wrap-Bruch und direkt nach `<br>`: dort liefern Browser sonst Höhe 0
//    bzw. leere Rect-Liste, der Recenter würde auf Block-BBox zurückfallen
//    (Block-Mitte stillgestanden → Typewriter scrollte bei langem Absatz mit
//    Soft-Wraps oder shift-enter-Bruchen nicht mit).
export function getCaretRect(container, selection) {
  const sel = selection || (typeof document !== 'undefined' ? document.getSelection() : null);
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container || !container.contains(range.startContainer)) return null;
  const rects = range.getClientRects();
  if (rects.length > 0 && rects[0].height > 0) return rects[0];
  const rect = range.getBoundingClientRect();
  if (rect && rect.height > 0) return rect;
  return expandRangeRect(range);
}

// Pure: wie weit muss gescrollt werden, damit targetRect auf containerRect-
// Mitte sitzt? Unter Schwelle → no-op. Schwelle ist grob eine Zeilenhöhe,
// damit Tippen innerhalb derselben Textzeile (Caret-Rect-Jitter, subpixel-
// Shifts) keinen Mini-Scroll auslöst und der Editor „ruhig" wirkt.
export function computeTypewriterDelta(containerRect, targetRect, threshold = TYPEWRITER_THRESHOLD_PX) {
  if (!containerRect || !targetRect) return 0;
  const targetCenter = targetRect.top + targetRect.height / 2;
  const containerCenter = containerRect.top + containerRect.height / 2;
  const delta = targetCenter - containerCenter;
  return Math.abs(delta) < threshold ? 0 : delta;
}

export function typewriterScroll(container, targetRect, ctx, threshold = TYPEWRITER_THRESHOLD_PX) {
  if (!container || !targetRect) return 0;
  const delta = computeTypewriterDelta(container.getBoundingClientRect(), targetRect, threshold);
  if (delta === 0) return 0;
  // Programmatischen Scroll vorab im Counter ankündigen, damit onScroll uns
  // nicht für eine User-Interaktion hält und unnötig recentert.
  if (ctx) ctx.expectedScroll++;
  // prefers-reduced-motion: User hat System-Weit angegeben „kein Animation-
  // Overhead". Zwei-Schritt-Scroll überspringen und direkt den Zielwert
  // setzen, damit aktiver Absatz trotzdem passt.
  if (prefersReducedMotion()) {
    container.scrollTop += delta;
    return delta;
  }
  container.scrollBy({ top: delta, behavior: 'auto' });
  return delta;
}
