// Root-Trampoline: dispatcht Events an Alpine.data('editorFocusCard').
// Root hält `focusMode` als sichtbare Flag (CSS, body-Class, Template-Checks)
// und die Live-Counter `focusCountWords`/`focusCountChars`, die der Header im
// Fokus-Modus zeigt. State-Felder leben in `focusModeState` ([app-state.js]) —
// damit liegen alle vier Editor-Modi-Flags in einem konsistenten Slice.

export const focusMethods = {
  toggleFocusMode() {
    window.dispatchEvent(new CustomEvent('editor:focus:toggle'));
  },

  startFocusEdit() {
    // Root wechselt in Edit-Mode (falls nicht bereits), Sub tritt dann in Fokus ein.
    window.dispatchEvent(new CustomEvent('editor:focus:start-edit'));
  },

  enterFocusMode() {
    window.dispatchEvent(new CustomEvent('editor:focus:enter'));
  },

  exitFocusMode() {
    window.dispatchEvent(new CustomEvent('editor:focus:exit'));
  },

  // Global Cmd/Ctrl+Shift+E-Hotkey. Läuft auf dem Body-Listener (siehe index.html),
  // damit der Fokusmodus auch aus dem Lesemodus heraus einschaltbar ist.
  // Cmd+Shift+F ist für die BookStack-Volltextsuche reserviert.
  handleFocusHotkey(event) {
    const isCmdShiftE = (event.ctrlKey || event.metaKey)
      && event.shiftKey && !event.altKey
      && event.code === 'KeyE';
    if (!isCmdShiftE) return;
    if (!this.showEditorCard) return;
    event.preventDefault();
    if (this.focusMode) {
      window.dispatchEvent(new CustomEvent('editor:focus:exit'));
    } else if (this.editMode) {
      window.dispatchEvent(new CustomEvent('editor:focus:enter'));
    } else {
      window.dispatchEvent(new CustomEvent('editor:focus:start-edit'));
    }
  },
};
