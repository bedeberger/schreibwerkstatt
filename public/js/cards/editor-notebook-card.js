// Alpine.data('editorNotebookCard') — Sub-Komponente für den Normal-Editor
// (Notizbuch-Modus). Pendant zu editorFocusCard.
//
// Aktueller Scope: Reload-Wiederaufnahme aus `normal.snapshot` (Pendant zu
// _tryRestoreFocus). Edit-Pipeline (startEdit/saveEdit/cancelEdit/quickSave)
// liegt noch im Root als `notebookMethods`-Spread.

import { notebookCardMethods } from '../editor/notebook/card.js';

export function registerEditorNotebookCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorNotebookCard', () => ({
    _notebookRestoreSnapshot: null,

    init() {
      this._setupNotebookRestore();
    },

    ...notebookCardMethods,
  }));
}
