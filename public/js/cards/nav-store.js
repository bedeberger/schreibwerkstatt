// Alpine.store('nav') — geteilter Navigations-State: welches Buch, welche
// Seitenliste, welcher Tree gerade aktiv sind. Von ~29 Karten-/Fachmodulen
// gelesen (allen voran `selectedBookId`), darum eine schmale, benannte
// Store-Oberfläche statt buried in der Root-God-State.
//
// Der Root spiegelt die Felder via Getter/Setter-Proxy (app.js), sodass
// `this.selectedBookId = …` / `this.tree.push(…)` aus Root-Methoden und
// `$app.selectedBookId` in Templates unverändert funktionieren. Neue Karten
// greifen direkt via `this.$store.nav` / `Alpine.store('nav')` zu — damit ist
// die Abhängigkeit sichtbar statt über `window.__app.<irgendwas>` ambient.
//
// Bewusst NICHT hier: booksLoaded/bookRoles/treeLoading u.ä. — das ist
// Lade-Mechanik, eng an Root-Methoden gekoppelt und nicht cross-card gelesen.

export function registerNavStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('nav', {
    books: [],
    selectedBookId: '',
    pages: [],
    tree: [],
  });
}
