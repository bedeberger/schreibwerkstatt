// Sentence-Mode: Satz-Erkennung am Caret + CSS-Custom-Highlight für die
// nicht-aktiven Sätze des aktiven Blocks. Keine DOM-Mutation → kein Risiko
// eines Save-Diffs.

// Satzgrenzen via Intl.Segmenter (handhabt Abkürzungen wie „z. B." korrekt).
// Fallback Regex split nach .!? mit Whitespace. Liefert [start,end]-Paare.
export function findSentenceRanges(text, locale = 'de') {
  if (!text) return [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      const seg = new Intl.Segmenter(locale, { granularity: 'sentence' });
      const out = [];
      for (const s of seg.segment(text)) {
        const start = s.index;
        const end = start + s.segment.length;
        if (s.segment.trim()) out.push([start, end]);
      }
      return out;
    } catch { /* fallthrough */ }
  }
  const out = [];
  const re = /[^.!?]+[.!?]*\s*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim()) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

// Findet die Satz-Range im Block, die den Caret enthält.
export function findSentenceAtCaret(block, selection) {
  if (!block || !selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!block.contains(range.startContainer)) return null;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  let pos = 0;
  let caretPos = -1;
  let node;
  while ((node = walker.nextNode())) {
    if (node === range.startContainer) {
      caretPos = pos + range.startOffset;
      break;
    }
    pos += node.nodeValue.length;
  }
  if (caretPos < 0) caretPos = 0;
  const text = block.textContent || '';
  const ranges = findSentenceRanges(text);
  if (ranges.length === 0) return { sentence: [0, text.length], totalLength: text.length };
  for (const r of ranges) {
    if (caretPos >= r[0] && caretPos <= r[1]) return { sentence: r, totalLength: text.length };
  }
  return { sentence: ranges[ranges.length - 1], totalLength: text.length };
}

function rangeFromOffsets(block, startOffset, endOffset) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  let pos = 0;
  let startNode = null, startOff = 0, endNode = null, endOff = 0;
  let node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (!startNode && pos + len >= startOffset) {
      startNode = node;
      startOff = startOffset - pos;
    }
    if (pos + len >= endOffset) {
      endNode = node;
      endOff = endOffset - pos;
      break;
    }
    pos += len;
  }
  if (!startNode || !endNode) return null;
  const r = document.createRange();
  try {
    r.setStart(startNode, Math.max(0, Math.min(startOff, startNode.nodeValue.length)));
    r.setEnd(endNode, Math.max(0, Math.min(endOff, endNode.nodeValue.length)));
  } catch { return null; }
  return r;
}

// Nicht-aktive Sätze im aktiven Block werden via CSS-Custom-Highlight gedimmt.
export function applySentenceHighlight(block, selection) {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
  CSS.highlights.delete('focus-sentence-dim');
  if (!block) return;
  const info = findSentenceAtCaret(block, selection);
  if (!info) return;
  const [s, e] = info.sentence;
  const text = block.textContent || '';
  const ranges = [];
  if (s > 0) {
    const r = rangeFromOffsets(block, 0, s);
    if (r) ranges.push(r);
  }
  if (e < text.length) {
    const r = rangeFromOffsets(block, e, text.length);
    if (r) ranges.push(r);
  }
  if (ranges.length === 0) return;
  try {
    const hl = new Highlight(...ranges);
    CSS.highlights.set('focus-sentence-dim', hl);
  } catch { /* unsupported / Range invalid */ }
}
