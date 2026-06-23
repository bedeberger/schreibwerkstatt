// Alpine.data('editorCommentsCard') — Kommentar-Leiste der Leseansicht
// (Notebook-Editor, Read-Modus). Zeigt verankerte Share-Link-Leser-Kommentare
// als Margin-Rail rechts neben dem Seitentext. Keine exklusive Karte (kein
// Feature-Registry-/Palette-/Hash-Router-Eintrag) — sie blendet sich allein
// datengetrieben ein, sobald die offene Seite verankerte Kommentare hat.
//
// Root behält: selectedBookId, currentPage, editMode, checkDone,
// renderedPageHtml, pageCommentRailOpen (Grid-Flag), t(), appConfirm().
// Zugriff via window.__app / $app.

import { editorCommentsRailMethods } from '../editor/comments-rail.js';

export function registerEditorCommentsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorCommentsCard', () => ({
    bookComments: [],     // Rohzeilen aller Link-Kommentare des Buchs
    pageThreads: [],      // Threads, die auf der aktuellen Seite verankert sind
    generalThreads: [],   // allgemeine (nicht-verankerte) Kommentare von Page-Shares dieser Seite
    selectedRootId: null,
    railVisible: false,  // Default verborgen; Sichtbarkeit über Toggle-Button in den Seiten-Actions
    replyDrafts: {},
    savingReply: null,
    savingResolve: null,
    // transiente Helfer (kein reaktiver State):
    _railAbort: null,
    _recomputeRaf: null,
    _loadingBookId: null,
    _pendingGotoBid: null,

    ...editorCommentsRailMethods,
  }));
}
