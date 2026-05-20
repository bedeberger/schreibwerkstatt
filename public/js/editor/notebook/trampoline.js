// Root ↔ Notebook-Card-Events. Pendant zu editor/focus/trampoline.js.
//
// Aktuell minimaler Event-Vertrag — Root dispatched, Notebook-Sub hört:
//   - `editor:notebook:enter` — Notebook-Card soll Edit-Mode öffnen
//   - `editor:notebook:exit`  — Notebook-Card soll Edit-Mode schliessen
//
// Phase 4+: wenn startEdit/saveEdit/cancelEdit vollständig in die Sub
// wandern (heute noch Root-Methoden via editorEditMethods-Spread), ersetzen
// diese Events die Direkt-Aufrufe `this.startEdit()` aus der Root.

export const notebookTrampolineMethods = {
  enterNotebookEdit() {
    window.dispatchEvent(new CustomEvent('editor:notebook:enter'));
  },

  exitNotebookEdit() {
    window.dispatchEvent(new CustomEvent('editor:notebook:exit'));
  },
};
