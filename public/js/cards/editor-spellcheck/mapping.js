// Plain-Text-Extraktion + Offset->Range-Mapping fuer LanguageTool-Overlay.
//
// buildOffsetTable(root):
//   Walks Text-/Element-Nodes innerhalb von `root` und baut zwei Outputs:
//     - text:      Plain-Text-Stream, der ans LT-API geht.
//     - positions: Array von { node, start, end } pro Text-Node — start/end
//                  sind Offsets im `text`-Stream (UTF-16 Code Units = JS
//                  String.length = LT-Offset-Semantik).
//   Block-Element-Boundaries fuegen `\n\n` ein (LT interpretiert das als
//   Paragraph-Break), `<br>` fuegt `\n` ein. Whitespace innerhalb von
//   Text-Nodes bleibt unangetastet — LT-Engine handhabt Tokenisierung.
//
// rangeFromOffset(table, offset, length):
//   Liefert eine DOM-Range, deren Start/End auf Text-Nodes innerhalb von
//   `root` zeigen. Match darf ueber mehrere Text-Nodes hinwegspannen.
//   Returns null wenn Offsets ausserhalb der Tabelle liegen (z.B. nach
//   DOM-Mutation zwischen Build und Lookup).

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'PRE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
  'MAIN', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION', 'TR',
]);

// SHOW_ELEMENT=1, SHOW_TEXT=4 als rohe Bitmask (statt NodeFilter.SHOW_*),
// damit das Modul auch in linkedom laeuft (kein NodeFilter-Constructor).
const SHOW_ELEMENT_AND_TEXT = 1 | 4;

// LT-eigene UI-Inseln (Popover, Badge) leben innerhalb des Editor-Roots,
// damit Scroll sie nativ mitnimmt. Ihre Texte (Regelmeldungen, Buttons) sollen
// NICHT in den LT-Eingabe-Stream wandern — sonst pruefte LT seine eigene UI.
function _isSkippedIsland(el) {
  if (!el || el.nodeType !== 1) return false;
  const cl = el.classList;
  if (!cl) return false;
  return cl.contains('lt-popover') || cl.contains('lt-badge');
}

export function buildOffsetTable(root) {
  if (!root) return { text: '', positions: [] };
  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, SHOW_ELEMENT_AND_TEXT, null);

  let text = '';
  const positions = [];
  let pendingBreak = '';
  let skipRoot = null; // gesetzt solange Walker im Subtree einer LT-Insel laeuft
  let cur = walker.nextNode();
  while (cur) {
    if (skipRoot && !skipRoot.contains(cur)) skipRoot = null;
    if (skipRoot) { cur = walker.nextNode(); continue; }
    if (cur.nodeType === 1 /* ELEMENT */) {
      if (_isSkippedIsland(cur)) {
        skipRoot = cur;
        cur = walker.nextNode();
        continue;
      }
      const tag = cur.tagName;
      if (tag === 'BR') {
        pendingBreak = '\n';
      } else if (BLOCK_TAGS.has(tag)) {
        // Doppelter Break nicht stapeln; \n\n reicht.
        if (pendingBreak !== '\n\n') pendingBreak = '\n\n';
      }
    } else if (cur.nodeType === 3 /* TEXT */) {
      const v = cur.nodeValue || '';
      if (v) {
        if (pendingBreak && text) {
          text += pendingBreak;
        }
        pendingBreak = '';
        const start = text.length;
        text += v;
        positions.push({ node: cur, start, end: start + v.length });
      }
    }
    cur = walker.nextNode();
  }
  return { text, positions };
}

// Lokalisiert Offset-Range in der Positions-Tabelle (pure, testbar ohne Range).
// Liefert { startNode, startOffset, endNode, endOffset } oder null.
export function locateOffset(table, offset, length) {
  if (!table || !table.positions || length <= 0) return null;
  const end = offset + length;
  let startNode = null;
  let startOffset = 0;
  let endNode = null;
  let endOffset = 0;
  for (const p of table.positions) {
    if (startNode === null && offset >= p.start && offset < p.end) {
      startNode = p.node;
      startOffset = offset - p.start;
    }
    if (end > p.start && end <= p.end) {
      endNode = p.node;
      endOffset = end - p.start;
      break;
    }
  }
  if (!startNode || !endNode) return null;
  return { startNode, startOffset, endNode, endOffset };
}

export function rangeFromOffset(table, offset, length) {
  const loc = locateOffset(table, offset, length);
  if (!loc) return null;
  const doc = loc.startNode.ownerDocument || document;
  const range = doc.createRange();
  try {
    range.setStart(loc.startNode, loc.startOffset);
    range.setEnd(loc.endNode, loc.endOffset);
  } catch {
    return null;
  }
  return range;
}
