# Orte-Karte (Geo-Map realer Schauplätze)

- **Status:** Ready
- **Aufwand:** M
- **Severity:** low

## Context

Bücher mit realen Schauplätzen (Sachbuch, Reise, Autobiografie, Blog, historisch) profitieren von einer geografischen Darstellung ihrer Orte. Aktuell sind `locations` rein textuell (Name/Typ/Beschreibung/Stimmung) ohne Koordinaten. Fiktive Welten haben keinen Geo-Bezug — darum darf die Karte **nicht** global an sein, sondern wird pro Buch explizit als „Orte real" konfiguriert. Passt zur Produkt-Linie „KI rückwärtsgewandt": die Karte ist reine Kuration/Visualisierung bestehender Orte, kein generativer Eingriff in den Text. Geocoding ist Lookup, kein KI-Call.

## Scope MVP

- Neuer Per-Buch-Schalter `orte_real` (BookSettings) — Default aus: steuert, ob Orte als real-geografisch behandelt werden.
- Zwei neue nullable Koordinaten-Spalten auf `locations`: `lat`, `lng`.
- Orte-Karte als **dritter View-Mode** (`map`) in der bestehenden Orte-Karte, Tab nur sichtbar wenn `orte_real = 1`.
- Leaflet (vendored, lazy) rendert OSM-Tiles + einen Marker pro Ort mit gesetzten Koordinaten.
- Geocoding: Server-Proxy zu OSM-Nominatim schlägt Koordinaten aus Ortsname (+ optional Beschreibung/Region) vor; User korrigiert per Drag des Markers. Speichern über bestehenden `saveOrte`-Pfad (`lat`/`lng` mitgeführt).
- Marker-Popup zeigt Name/Typ; Klick navigiert wie Listeneintrag (erste Erwähnung).
- OSM-Attribution sichtbar (Pflicht).

## Out-of-Scope

- Fiktive Story-Karten / Freiform-Canvas (separate Idee, andere Richtung).
- Routen/Wege zwischen Orten, Heatmaps, Zeitachsen-Animation auf der Karte.
- Eigener Tileserver / API-Key-Tiles (Phase 2: konfigurierbare Tile-URL als App-Setting).
- Automatisches Bulk-Geocoding aller Orte als Job. MVP: Geocode pro Ort on-demand.
- Reverse-Geocoding, Polygon/Flächen, Custom-Marker-Icons pro Typ.

## Done when

- Buch mit `orte_real = 0`: Orte-Karte zeigt **nur** Liste/Grid, kein Karten-Tab.
- Buch mit `orte_real = 1`: Karten-Tab erscheint; geocodete Orte erscheinen als Marker; Marker-Drag + Geocode-Button setzen `lat`/`lng`; Speichern persistiert; Reload zeigt Marker an gleicher Stelle.
- Nominatim-Ausfall/leeres Ergebnis bricht nichts — UI zeigt „kein Treffer", manueller Pin bleibt möglich.
- `npm test` grün, inkl. neuer Unit-Tests (Geocode-Parsing, BookSettings-Validator).

## Hard-Rule-Audit

- **Editor-Spezifikation:** n/a — kein Editor berührt.
- **UI-Patterns (DESIGN.md):** View-Mode-Tabs existieren bereits in Orte-Karte (Liste/Grid) → 3. Tab im selben Pattern. Karten-Container ist neue Komponente → in DESIGN.md „Geo-Map (Leaflet)" dokumentieren vor Verwendung.
- **i18n:** betroffen — neue Keys (Tab-Label, Geocode-Button, Settings-Toggle, Attribution, Status) in de + en, ungefragt.
- **CSS:** betroffen — Map-Container + Tab in `public/css/` (kein Inline-Style). Leaflet-CSS vendored, via `<link>` lazy injiziert.
- **Content-Store-Facade:** n/a — `locations` läuft über `routes/locations.js` + `db`, nicht über die Pages/Chapters/Books-Facade.
- **DB-Integrität:** betroffen — neue Spalten auf bestehender Tabelle, keine neuen FK nötig. Migration mit `foreign_key_check` + ERD-Update + `squash:regen`.
- **Job-Queue / KI-Calls:** **nicht** betroffen — Geocoding ist kein KI-Call; normale Route erlaubt. Kein `callAI`.
- **x-html-Escape:** betroffen — Marker-Popup mit Ortsname/Typ muss durch `escHtml()` (Leaflet `bindPopup` mit HTML-String).
- **Combobox/numInput/LanguageTool:** Toggle nutzt bestehendes Toggle-Pattern; kein neues Select/Number-Feld. Geocode-Suchfeld (falls Freitext) = Suchfeld → **kein** Spellcheck (Ausnahme).
- **SHELL_CACHE:** betroffen — neue JS/CSS + vendored Leaflet → `public/sw.js` bumpen, Leaflet-Assets in `SHELL_CACHE`-Liste.
- **DB-Timestamps:** `locations.updated_at` via `NOW_ISO_SQL` (bestehender Pfad).
- **Logging-Context book:** Geocode-Route ist nicht buch-scoped (reiner Proxy) → `book`-Slot n/a; falls `book_id` mitgegeben, `setContext` setzen.

## Abhängigkeiten

- Bestehende Orte-Karte (`orte-card.js`, `orte.js`, `orte.html`) + `routes/locations.js`.
- BookSettings (`routes/booksettings.js`, `book-settings-card.js`, `book-settings.html`).
- Lazy-Lib-Loader (`public/js/lazy-libs.js`) + Vendor-Verzeichnis `public/vendor/`.

## Backend

- **`GET /geocode?q=<text>&region=<cc>`** (neue `routes/geocode.js`) — proxyt OSM-Nominatim `search` (Format json, `limit=5`, `accept-language` aus User-Sprache), setzt Pflicht-`User-Agent`-Header, In-Memory-Rate-Limit (≤1 req/s global, Nominatim-Policy). Antwort: `{ candidates: [{ lat, lng, displayName }] }`. Fehler/Timeout → `{ candidates: [] }` (non-fatal). Auth-geschützt wie alle Routen.
- **`GET /booksettings/:book_id`** — Antwort um `orteReal` (0/1) erweitern.
- **`PUT /booksettings/:book_id`** — `orteReal` validieren (Boolean→0/1) + persistieren.
- **`GET /locations/:book_id`** — pro Ort `lat`/`lng` mitliefern.
- **`PUT /locations/:book_id`** — `lat`/`lng` (nullable REAL, Range-Clamp lat ∈ [-90,90], lng ∈ [-180,180]) in Full-Replace persistieren.

## Frontend

- **Orte-Karte (`orte.html` + `orte-card.js` + `orte.js`):**
  - `viewMode` um `'map'` erweitern; Tab `x-show` an `$app.bookSettingsOrteReal` gebunden (Setting in Root spiegeln).
  - Bei Wechsel auf `map`: `loadLeaflet()` (lazy), Map initialisieren, Marker aus `orte.filter(o => o.lat != null)` setzen. `fitBounds` auf Marker.
  - Pro Ort in Liste/Map: „Geocodieren"-Button → `GET /geocode`, erstes/gewähltes Candidate setzt `lat`/`lng`, Marker draggable; `dragend` schreibt zurück in `orte[i]`. Speichern via bestehendes `saveOrte()`.
  - Map-Lifecycle: bei Tab-Verlassen / `destroy()` / `book:changed` `map.remove()` (Leak-Schutz), Instanz auf `null`.
  - Marker-Popup-HTML via `escHtml()`.
- **BookSettings (`book-settings.html` + `book-settings-card.js` + `book-settings.js`):**
  - State `bookSettingsOrteReal`; Toggle im bestehenden Toggle-Pattern; in `saveBookSettings` PUT-Body aufnehmen; Root spiegelt Wert für die Orte-Karte.
- **Lazy-Lib (`lazy-libs.js`):** `loadLeaflet()` — vendored JS laden + Leaflet-CSS via injiziertem `<link>` (einmalig), `window.L` zurückgeben. Marker-Icon-Pfade auf vendored Image-Ordner setzen (`L.Icon.Default.imagePath`).
- **Keine neue Registry-Karte** (View-Mode statt eigener Karte) → kein `FEATURES`/`EXCLUSIVE_CARDS`/`ALLOWED_KEYS`/Hash-Router-Eintrag nötig.

## CSS

- Neue Datei `public/css/entities/orte-map.css` (Map-Container-Höhe, Tab-aktiv-State, Attribution, Geocode-Button). In `index.html` als `<link>` + Eintrag DESIGN.md CSS-Inventar + `SHELL_CACHE` bump.
- Leaflet-eigene CSS vendored (nicht in `public/css/`, da Third-Party-Asset wie vis-network) — via Lazy-`<link>`.
- Keine Inline-Styles; Map-Höhe über Klasse, nicht `style`-Attribut.

## i18n

Neuer Key-Bereich (de + en):
- `orte.map.tab` („Karte" / „Map")
- `orte.map.geocode` („Koordinaten suchen" / „Find coordinates")
- `orte.map.noResult` („Kein Treffer" / „No match")
- `orte.map.attribution` (OSM-Attribution-Text)
- `orte.map.dragHint` (Hinweis Marker ziehen)
- `booksettings.orteReal` („Orte sind reale Schauplätze" / „Locations are real places")
- `booksettings.orteReal.desc` (Erklärtext: aktiviert die geografische Karte)

## DB

Migration **162** (`db/migrations.js`):
- `ALTER TABLE book_settings ADD COLUMN orte_real INTEGER NOT NULL DEFAULT 0;`
- `ALTER TABLE locations ADD COLUMN lat REAL;`
- `ALTER TABLE locations ADD COLUMN lng REAL;`
- Kein neuer FK, keine neuen Indexe (Koordinaten nicht gequeried, nur gelesen).
- Abschluss: `foreign_key_check` + `UPDATE schema_version SET version = 162`.
- Danach `npm run squash:regen` + [docs/erd.md](erd.md) bumpen (Stand-Zeile + `book_settings`/`locations`-Block-Spalten).

## Security

- Geocode-Route auth-geschützt (Session-Guard greift global). Query-Param escapen/encodieren vor Nominatim-Call.
- Rate-Limit gegen Nominatim-Policy-Verstoss (In-Memory-Bucket, analog Share-Link).
- Nominatim-Antwort ist Fremd-Input → `lat`/`lng` als Number parsen + Range-clampen, `displayName` im Frontend via `escHtml()`.
- Marker-Popup (Ortsname) escapen.
- Tile-Requests gehen vom Browser direkt an OSM (kein Server-Proxy) → Betreiber-Sache (self-hosted OSS); App liefert nur Voreinstellung + Attribution.

## Telemetrie

n/a (kein Counter im MVP).

## Reversibilität

- Feature-Default aus (`orte_real = 0`) → Karten-Tab für alle Bücher unsichtbar, keine Verhaltensänderung.
- Vollständiger Rückbau: View-Mode + Toggle + `routes/geocode.js` + Leaflet-Vendor entfernen; Spalten `orte_real`/`lat`/`lng` per Recreate-Migration droppen (oder belassen, da nullable + additiv).

## Tests

- **Unit:** Geocode-Response-Parsing/Range-Clamp (`tests/unit/geocode.test.mjs`); BookSettings-Validator akzeptiert/normalisiert `orteReal`; `locations`-PUT clampt `lat`/`lng`.
- **Integration:** n/a (kein Job, keine Pipeline).
- **E2E:** optional — Orte-Karte Tab sichtbar nur bei `orte_real`, Marker-Drag persistiert. Mock-Nominatim. (Kann Phase 2, falls Aufwand.)
- Drift-Tests: `squash-drift` + `erd-drift` müssen nach Migration grün sein.

## Edge-Cases

- Ort ohne Koordinaten → kein Marker, in Liste „nicht verortet"-Hinweis + Geocode-Button.
- Nominatim down/leer → `noResult`, manueller Pin bleibt.
- Buch von `orte_real=1` auf `0` zurückgeschaltet → Tab verschwindet; `lat`/`lng` bleiben erhalten (nicht gelöscht), erscheinen wieder bei Re-Aktivierung.
- Alle Orte ohne Koordinaten → Map zeigt Default-View (Welt/zentriert), kein `fitBounds`-Crash.
- Map-Resize bei Tab-Wechsel → `map.invalidateSize()` nach Sichtbarwerden.
- Mehrfaches Tab-Hin-und-Her → genau eine Map-Instanz, sonst Leak (Lifecycle-Guard).

## Kritische Dateien

- **Modify:**
  - `db/migrations.js` (Migration 162), `db/squashed-schema.js` (regen), `docs/erd.md`
  - `routes/booksettings.js`, `routes/locations.js`
  - `public/js/cards/orte-card.js`, `public/js/book/orte.js`, `public/partials/orte.html`
  - `public/js/cards/book-settings-card.js`, `public/js/book/book-settings.js`, `public/partials/book-settings.html`
  - `public/js/lazy-libs.js`, `public/index.html`, `public/sw.js`
  - `public/js/i18n/de.json`, `public/js/i18n/en.json`, `DESIGN.md`
- **Create:**
  - `routes/geocode.js` (+ Mount in `server.js`)
  - `public/css/entities/orte-map.css`
  - `public/vendor/leaflet-1.9.4/` (leaflet.js, leaflet.css, marker-images)
  - `tests/unit/geocode.test.mjs`

## Offene Fragen

(keine — Status Ready)
