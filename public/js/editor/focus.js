// Vollbild-Fokusmodus mit Absatz-Hervorhebung + Typewriter-Scroll.
// Nur im Bearbeitungsmodus aktivierbar.
//
// Facade-Datei. Implementierung in `editor/focus/` aufgeteilt:
//   - constants.js   – Block-Tags/Selektoren, Timing-Konstanten, Feature-Detects
//   - storage.js     – Snapshot, Tagesbaseline, Edit-Counter
//   - dom-blocks.js  – Block-Lookup + active/near-Markierungen
//   - sentence.js    – Satz-Erkennung am Caret + CSS-Custom-Highlight
//   - typewriter.js  – Schwelle, Caret-Rect, Scroll-Delta
//   - trampoline.js  – Root-Methoden (Event-Dispatch an die Sub)
//   - card.js        – State-Machine + DOM-Handler in Alpine.data('editorFocusCard')

export { focusMethods } from './focus/trampoline.js';
export { focusCardMethods } from './focus/card.js';
export {
  readFocusSnapshot, clearFocusSnapshot,
  fmtSigned, dailyDelta, installEditCounter,
} from './focus/storage.js';
export {
  findBlockFromNode, pickCenterBlock, findBlockAtViewportCenter,
  setActiveBlock, setNearBlocks, clearAllFocusMarks,
} from './focus/dom-blocks.js';
export {
  findSentenceRanges, findSentenceAtCaret, applySentenceHighlight,
} from './focus/sentence.js';
export {
  TYPEWRITER_THRESHOLD_PX, dynamicTypewriterThreshold,
  getCaretRect, computeTypewriterDelta,
} from './focus/typewriter.js';
