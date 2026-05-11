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

export function getCaretRect(container, selection) {
  const sel = selection || (typeof document !== 'undefined' ? document.getSelection() : null);
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container || !container.contains(range.startContainer)) return null;
  const rects = range.getClientRects();
  if (rects.length > 0 && rects[0].height > 0) return rects[0];
  const rect = range.getBoundingClientRect();
  if (rect.height > 0) return rect;
  return null;
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
