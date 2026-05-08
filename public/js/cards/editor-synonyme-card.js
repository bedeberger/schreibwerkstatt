// Alpine.data('editorSynonymeCard') — Sub-Komponente für das Synonym-
// Kontextmenü und den Picker (Rechtsklick auf Wort im Edit-Mode).
//
// Eigener State: showSynonymMenu, synonymMenuX/Y, showSynonymPicker,
//   synonymThesList/Loading/Error/Disabled, synonymKiList/Loading/Error,
//   _synonymRange, _synonymWord, _synonymPollTimer, _synonymReflowDetach,
//   _synonymJobId.
// Root behält: `_onEditContextMenu` (Trigger am contenteditable extrahiert
//   Range+Word und dispatcht `editor:synonym:open {range, word, x, y}`),
//   Trampoline `closeSynonymMenu/closeSynonymPicker` und `requestSynonyms`
//   dispatchen an die Sub. `_startPoll` bleibt Root-Utility.

import { synonymCardMethods } from '../editor-synonyme.js';

export function registerEditorSynonymeCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorSynonymeCard', () => ({
    showSynonymMenu: false,
    synonymMenuX: 0,
    synonymMenuY: 0,
    showSynonymPicker: false,
    synonymThesList: [],
    synonymThesLoading: false,
    synonymThesError: '',
    synonymThesDisabled: false,
    synonymKiList: [],
    synonymKiLoading: false,
    synonymKiError: '',
    _synonymRange: null,
    _synonymWord: '',
    _synonymPollTimer: null,
    _synonymReflowDetach: null,
    _synonymJobId: null,
    _synonymAbort: null,

    init() {
      const abort = new AbortController();
      this._synonymAbort = abort;
      const { signal } = abort;
      window.addEventListener('editor:synonym:open',         (e) => this._openSynonymMenu(e.detail || {}), { signal });
      window.addEventListener('editor:synonym:close-menu',   () => this.closeSynonymMenu(),               { signal });
      window.addEventListener('editor:synonym:close-picker', () => this.closeSynonymPicker(),             { signal });
      window.addEventListener('editor:synonym:request',      () => this.requestSynonyms(),                { signal });
    },

    destroy() {
      if (this._synonymPollTimer) { clearInterval(this._synonymPollTimer); this._synonymPollTimer = null; }
      this._detachSynonymScroll();
      this._synonymAbort?.abort();
    },

    ...synonymCardMethods,
  }));
}
