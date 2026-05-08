// Alpine.data('editorFigurLookupCard') — Sub-Komponente für das Figuren-Popover
// (Ctrl/Cmd-Klick auf Figurname im Edit-/Fokusmodus).
//
// Eigener State: showFigurLookup, figurLookupX, figurLookupY, figurLookupData,
//   _figurLookupReflowDetach, _figurLookupAnchor.
// Root behält: Lookup-Index + `_tryOpenFigurLookupAt` (synchroner Hit-Test für
//   Synonym-Kontextmenü). Root dispatcht `editor:figur-lookup:open { fig, x, y }`
//   und `editor:figur-lookup:close`; diese Sub hört darauf.

import { figurLookupCardMethods } from '../editor/figur-lookup.js';

export function registerEditorFigurLookupCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorFigurLookupCard', () => ({
    showFigurLookup: false,
    figurLookupX: 0,
    figurLookupY: 0,
    figurLookupData: null,
    _figurLookupReflowDetach: null,
    _figurLookupAnchor: null,
    _figurLookupAbort: null,

    init() {
      const abort = new AbortController();
      this._figurLookupAbort = abort;
      const { signal } = abort;

      window.addEventListener('editor:figur-lookup:open', (e) => {
        const { fig, x, y } = e.detail || {};
        if (!fig) return;
        this._openFigurLookup(fig, x, y);
      }, { signal });
      window.addEventListener('editor:figur-lookup:close', () => this.closeFigurLookup(), { signal });

      // Bei Buchwechsel/View-Reset Popover hart schliessen — sonst bleibt der
      // capture-phase Scroll-Listener nach Buchwechsel-Wegnavigation am Window.
      window.addEventListener('book:changed', () => this.closeFigurLookup?.(), { signal });
      window.addEventListener('view:reset',   () => this.closeFigurLookup?.(), { signal });
    },

    destroy() {
      this._figurLookupAbort?.abort();
      this._detachFigurLookupScroll();
    },

    ...figurLookupCardMethods,
  }));
}
