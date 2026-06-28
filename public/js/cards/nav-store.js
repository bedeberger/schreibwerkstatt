// Alpine.store('nav') — geteilter Navigations-State: welches Buch, welche
// Seitenliste, welcher Tree gerade aktiv sind. Von ~29 Karten-/Fachmodulen
// gelesen (allen voran `selectedBookId`), darum eine schmale, benannte
// Store-Oberfläche statt buried in der Root-God-State.
//
// Kein Root-Proxy (wie catalog/tts/stt/config/collab/jobs): alle Konsumenten
// greifen direkt zu — Root-Computeds/-Slices + in den Root gespreadete
// Fachmodule via `this.$store.nav.*`, Karten/Helper via `Alpine.store('nav').*`,
// Templates via `$store.nav.*`. Der Buchorganizer mutiert `tree`/`pages`
// in-place (push/splice/sort) direkt auf dem reaktiven Store-Array. Der
// Hash-Router watcht `selectedBookId` per Getter (`() => this.$store.nav.
// selectedBookId`), nicht per String-Pfad.
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
