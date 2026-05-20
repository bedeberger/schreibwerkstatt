// Alpine.data('editorNotebookCard') — Sub-Komponente für den Normal-Editor
// (Notizbuch-Modus). Pendant zu editorFocusCard.
//
// Heutiger Scope (Phase 4):
//   - Reload-Wiederaufnahme aus `normal.snapshot` (Pendant zu _tryRestoreFocus).
//   - Trampoline-Listener für `editor:notebook:{enter,exit}` (Wachstumsfläche).
//
// Phase 4+: startEdit/saveEdit/cancelEdit/Auto-Save-Timer/Lock-Erwerb/Listener-
// Cleanup/`_notebookGen` ziehen aus dem Root hierher (heute via
// `editorEditMethods`-Spread in app.js). Bis dahin lebt die Edit-Pipeline
// im Root; die Sub übernimmt nur Lifecycle-Aspekte, die schon eindeutig
// Notebook-spezifisch sind.

import { notebookCardMethods } from '../editor/notebook/card.js';

export function registerEditorNotebookCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorNotebookCard', () => ({
    _notebookRestoreSnapshot: null,
    _notebookAbort: null,

    init() {
      const abort = new AbortController();
      this._notebookAbort = abort;
      const { signal } = abort;
      window.addEventListener('editor:notebook:enter', () => window.__app?.startEdit?.(), { signal });
      window.addEventListener('editor:notebook:exit',  () => window.__app?.cancelEdit?.(), { signal });

      this._setupNotebookRestore();
    },

    destroy() {
      this._notebookAbort?.abort();
    },

    ...notebookCardMethods,
  }));
}
