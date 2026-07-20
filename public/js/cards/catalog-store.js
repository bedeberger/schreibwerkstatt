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
    // Kanonische Zeitstrahl-Daten (zeitstrahl_events) sind geladen. Verhindert,
    // dass der figuren-basierte Fallback (_buildGlobalZeitstrahl) die vom Server
    // geladene SSoT überschreibt — sonst clobbert ein paralleles loadFiguren die
    // datierten Events und das Jahres-Band flackert/verschwindet. Reset bei
    // Buchwechsel via clear().
    zeitstrahlServerLoaded: false,

    clear() {
      this.figuren = [];
      this.orte = [];
      this.songs = [];
      this.szenen = [];
      this.globalZeitstrahl = [];
      this.zeitstrahlChronology = null;
      this.zeitstrahlServerLoaded = false;
    },
  });
}
