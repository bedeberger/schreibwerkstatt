// Alpine.data('editorFindCard') — Sub-Komponente für Find & Replace im Edit-Mode.
//
// Eigener State: findOpen, findTerm, findReplace, findCaseSensitive,
//   findWholeWord, findMatches, findIndex, findX, findY, _findRecomputeTimer,
//   _findReflowDetach.
// Root behält: editMode, focusMode, selectedBookId, setStatus(), t(),
//   _markEditDirty(). Zugriff via window.__app / $app.

import { editorFindCardMethods } from '../editor/find.js';

export function registerEditorFindCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorFindCard', () => ({
    findOpen: false,
    findTerm: '',
    findReplace: '',
    findCaseSensitive: false,
    findWholeWord: false,
    findMatches: [],
    findIndex: -1,
    findX: 0,
    findY: 0,
    _findRecomputeTimer: null,
    _findReflowDetach: null,
    _findAbort: null,

    init() {
      const abort = new AbortController();
      this._findAbort = abort;
      const { signal } = abort;

      // Ctrl/Cmd+F: im Edit-Mode Finder öffnen, sonst BookStack-Suche fokussieren.
      // Bewusst im Sub statt auf dem Body-Keydown: hält die Logik beim Feature.
      window.addEventListener('keydown', (event) => {
        const isFind = (event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'f' || event.key === 'F');
        if (!isFind) return;
        const app = window.__app;
        if (!app) return;
        if (app.editMode && !app.focusMode) {
          event.preventDefault();
          this.openFind();
        } else if (app.selectedBookId) {
          event.preventDefault();
          const input = document.querySelector('.bookstack-search-input');
          if (input) { input.focus(); input.select?.(); }
        }
      }, { signal });

      // Find-Widget muss bei Buchwechsel/View-Reset geschlossen werden, sonst
      // bleibt der capture-phase Scroll-Listener am Window kleben (per Sub-
      // mount akkumuliert).
      window.addEventListener('book:changed', () => this.closeFind?.(), { signal });
      window.addEventListener('view:reset',   () => this.closeFind?.(), { signal });
    },

    destroy() {
      if (this._findRecomputeTimer) { clearTimeout(this._findRecomputeTimer); this._findRecomputeTimer = null; }
      if (this._findReflowDetach) { this._findReflowDetach(); this._findReflowDetach = null; }
      this._findAbort?.abort();
    },

    ...editorFindCardMethods,
  }));
}
