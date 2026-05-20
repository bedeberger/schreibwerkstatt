// Alpine.data('editorFocusCard') — Sub-Komponente für den Vollbild-Fokusmodus
// mit Absatz-Hervorhebung und Typewriter-Scroll.
//
// Eigener State: _focusState ('idle'|'entering'|'active'|'exiting'),
//   _focusGen, _focusListeners, _focusVisibleBlocks, _focusRaf.
// Root behält: `focusActive` (als sichtbare Flag für Templates, CSS, body-Class,
//   editor-toolbar/figur-lookup-Checks), `editMode`, `editDirty`, `editSaving`,
//   `saveOffline`, `lastDraftSavedAt`. Die Sub schreibt `window.__app.focusActive`.
//
// Trigger-Events aus dem Root (Trampoline in editor/focus/trampoline.js):
//   - `editor:focus:enter`               — explizit betreten (muss editMode sein)
//   - `editor:focus:exit`                — verlassen
//   - `editor:focus:enter-from-pageview` — Page-View-Direkteinstieg: Sub
//     trampolinet Edit-Mode hoch und tritt dann in Fokus ein.

import { focusCardMethods, readFocusSnapshot, clearFocusSnapshot } from '../editor/focus.js';
import { readDraft } from '../editor/draft-storage.js';

export function registerEditorFocusCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorFocusCard', () => ({
    _focusState: 'idle',
    _focusGen: 0,
    _focusListeners: null,
    _focusVisibleBlocks: null,
    _focusRaf: null,
    _focusAbort: null,

    _restoreSnapshot: null,

    init() {
      const abort = new AbortController();
      this._focusAbort = abort;
      const { signal } = abort;
      window.addEventListener('editor:focus:enter',               () => this.enterFocusMode(),         { signal });
      window.addEventListener('editor:focus:exit',                () => this.exitFocusMode(),          { signal });
      window.addEventListener('editor:focus:enter-from-pageview', () => this.enterFocusFromPageview(), { signal });

      // Live-Switch: User ändert Granularität in den Settings, während Focus
      // aktiv ist → Cardroot-Class + State sofort umstellen, ohne Exit/Re-Enter.
      this.$watch(() => window.__app?.focusGranularity, (g) => {
        if (this._focusState !== 'active') return;
        const focusEl = document.querySelector('.focus-editor');
        if (!focusEl) return;
        focusEl.classList.remove('focus-mode--paragraph', 'focus-mode--sentence', 'focus-mode--window-3', 'focus-mode--typewriter-only');
        focusEl.classList.add('focus-mode--' + (g || 'paragraph'));
        this._focusUpdateActive(false);
      });

      // Auto-Restore: Reload (z.B. via Session-Banner-Relogin oder manuelles
      // F5) soll den Fokusmodus wieder einnehmen, wenn die ursprüngliche Seite
      // geladen ist. Snapshot wird beim Eintritt in editor/focus.js geschrieben
      // und beim regulären Exit gelöscht.
      this._restoreSnapshot = readFocusSnapshot();
      if (this._restoreSnapshot) {
        const tryRestore = () => this._tryRestoreFocus();
        this.$watch(() => window.__app?.currentPage?.id, tryRestore);
        this.$watch(() => window.__app?.renderedPageHtml, tryRestore);
        this.$watch(() => window.__app?.showEditorCard, tryRestore);
        // Initial check für den Fall, dass beim Mount bereits alles da ist.
        queueMicrotask(tryRestore);
      }
    },

    _tryRestoreFocus() {
      const snap = this._restoreSnapshot;
      if (!snap) return;
      const app = window.__app;
      if (!app) return;
      if (this._focusState !== 'idle') return;
      if (!app.showEditorCard) return;
      if (!app.currentPage || app.currentPage.id !== snap.pageId) return;
      if (!app.renderedPageHtml) return;

      // Snapshot konsumieren — auch bei späterem Misserfolg nicht erneut
      // versuchen, sonst Loop bei kaputter Seite.
      this._restoreSnapshot = null;
      // Snapshot wird in startEdit/enterFocusMode wieder gesetzt; hier vorab
      // löschen, falls enterFocusFromPageview bricht (z.B. checkLoading aktiv).
      clearFocusSnapshot();
      // Restore nur, wenn ungespeicherter Inhalt da ist. Snapshot allein
      // (User hat Edit/Fokus betreten ohne zu tippen, dann zurück nach view)
      // soll User nicht in Edit-Modus zwingen.
      const draft = readDraft(snap.pageId);
      if (!draft || !draft.html || draft.html === app.renderedPageHtml) return;
      this.enterFocusFromPageview();
    },

    destroy() {
      this._focusAbort?.abort();
      // Defensive: falls bei destroy noch Listener offen sind (z.B. Hot-Reload)
      if (this._focusListeners) {
        try { this._focusTeardown(); } catch (e) { /* ignorieren */ }
      }
    },

    ...focusCardMethods,
  }));
}
