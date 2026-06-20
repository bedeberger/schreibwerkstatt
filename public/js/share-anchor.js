// Gemeinsame Re-Anchor-Logik für Share-Kommentare (Reader-View + Owner-Vorschau).
// Eine verankerte Anmerkung haftet an einem Block via dessen data-bid +
// markiertem Quote-Text. Der Inhalt ist live (Autor editiert weiter), darum ist
// der Quote der Robustheits-Anker: Block per data-bid finden, Quote darin suchen
// (Offsets nur als Hinweis). Findet sich der Quote nicht, gibt locateRange null
// (Aufrufer markiert den Thread als „Stelle geändert").
//
// SSoT — wird von public/js/share-reader.js (Reader) und der Owner-Karte
// (public/js/cards/share-links-card.js, via share-anchor-preview) konsumiert.

// Zeichen-Offset eines (Container, Offset)-Punkts relativ zum Block-Textanfang.
export function charOffset(block, container, offset) {
  if (container.nodeType === Node.ELEMENT_NODE) {
    let total = 0;
    for (let i = 0; i < offset && i < container.childNodes.length; i++) {
      total += (container.childNodes[i].textContent || '').length;
    }
    const before = container === block ? 0 : textOffsetOf(block, container);
    return before + total;
  }
  return textOffsetOf(block, container) + offset;
}

export function textOffsetOf(block, node) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  let total = 0, n;
  while ((n = walker.nextNode())) {
    if (n === node) return total;
    total += n.nodeValue.length;
  }
  return total;
}

export function rangeFromOffsets(block, start, end) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  const range = document.createRange();
  let total = 0, n, didStart = false, didEnd = false;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    if (!didStart && start <= total + len) { range.setStart(n, start - total); didStart = true; }
    if (!didEnd && end <= total + len) { range.setEnd(n, end - total); didEnd = true; break; }
    total += len;
  }
  return (didStart && didEnd) ? range : null;
}

// Live-Range einer gespeicherten Anmerkung in `rootEl` finden (re-anchor by quote).
export function locateRange(rootEl, anchor) {
  if (!rootEl || !anchor || !anchor.bid) return null;
  let block;
  try { block = rootEl.querySelector(`[data-bid="${CSS.escape(anchor.bid)}"]`); } catch { block = null; }
  if (!block) return null;
  const txt = block.textContent;
  let s = anchor.start, e = anchor.end;
  const q = anchor.quote || '';
  if (!(Number.isInteger(s) && Number.isInteger(e) && txt.slice(s, e) === q)) {
    if (!q) return null;
    const idx = txt.indexOf(q);
    if (idx < 0) return null;
    s = idx; e = idx + q.length;
  }
  return rangeFromOffsets(block, s, e);
}
