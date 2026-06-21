// Alpine.store('catalog') — geteilte Fach-Daten, die von mehreren Karten
// gelesen/geschrieben werden: `figuren`, `orte`, `szenen`, `globalZeitstrahl`.
// Der Root spiegelt sie via Getter/Setter-Proxy (app.js), Karten greifen direkt
// via this.$store.catalog zu.

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
