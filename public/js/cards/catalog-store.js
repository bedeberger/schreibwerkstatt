// Alpine.store('catalog') — geteilte Fach-Daten, die von mehreren Karten
// gelesen/geschrieben werden: `figuren`, `orte`, `songs`, `szenen`,
// `globalZeitstrahl`, `zeitstrahlChronology`. Kein Root-Proxy: alle Konsumenten
// greifen direkt zu — Root-Computeds/-Slices + in den Root gespreadete
// Fachmodule (book/figuren.js etc.) via `this.$store.catalog.*`, Karten/Helper
// via `Alpine.store('catalog').*`, Templates via `$store.catalog.*`. Die
// Root-Lookup-Maps `figurenById`/`orteById`/`szenenById` lesen ebenfalls hier.

export function registerCatalogStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('catalog', {
    figuren: [],
    orte: [],
    songs: [],
    szenen: [],
    globalZeitstrahl: [],
    // Abgeleitete Jahres-Kennzahlen der Zeitstrahl-Ansicht (nur bei
    // book_settings.zeitlinie_real befüllt, sonst null). Siehe ereignisse.js.
    zeitstrahlChronology: null,

    clear() {
      this.figuren = [];
      this.orte = [];
      this.songs = [];
      this.szenen = [];
      this.globalZeitstrahl = [];
      this.zeitstrahlChronology = null;
    },
  });
}
