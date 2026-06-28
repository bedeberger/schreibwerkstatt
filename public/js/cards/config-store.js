// Alpine.store('config') — read-only Settings, die einmalig aus /config beim
// Boot gesetzt werden (app-init.js) und danach nicht mehr mutieren. Vorher flach
// in der Root-God-State; jetzt eine schmale, benannte Store-Oberfläche.
//
// Anders als die Laufzeit-Stores (catalog/nav/stt/tts) ist das hier reine
// Konfiguration. Konsumenten greifen direkt zu (kein Root-Proxy): Templates via
// `$store.config.languagetoolEnabled`, Karten via `this.$store.config.mapTiles`
// (orte-map.js) bzw. `ctx.$store.config.researchChatEnabled` (research-chat.js),
// app-init.js setzt beim Boot `this.$store.config.*`, der Spellcheck-Dispatcher
// watcht `() => app.$store.config.languagetoolEnabled` (Getter-Watch statt
// String-Pfad). Keine gemeinsame Präfix-Kürzung — die Keys tragen ihre Domäne
// selbst.
//
// Feld-Bedeutung:
//   mapTiles — Tile-Server der Orte-Karte (/config → app_settings geocode.tiles.*).
//             Leaflet holt die Kacheln direkt im Browser; attribution leer →
//             orte-map.js fällt auf den i18n-Default zurück. Default deckt den
//             Hard-Refresh ab, bevor /config geladen ist.
//   languagetoolEnabled — LT-Spellcheck-Master-Switch (/config `languagetool.enabled`,
//             true wenn Admin enabled + URL gesetzt). Editor-Templates lesen ihn
//             via `:spellcheck="!$app.languagetoolEnabled"`.
//   languagetoolDebounceMs — Debounce (ms) zwischen Eingabe und LT-Check im
//             Editor-Controller (/config `languagetool.debounce_ms`). Form-Felder
//             nutzen eigene Defaults und ignorieren den Wert.
//   researchChatEnabled — Recherche-Chat-Umschalter (/config `researchChat.enabled`,
//             true wenn effektiver Provider Claude + API-Key + Kill-Switch an).

export function registerConfigStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('config', {
    mapTiles: { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '' },
    languagetoolEnabled: false,
    languagetoolDebounceMs: 1500,
    researchChatEnabled: false,
  });
}
