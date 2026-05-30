# Geocoding & Orte-Karte (Geo-Map realer Schauplätze)

Reale Schauplätze auf einer Leaflet-Karte verorten. Pro Buch via `book_settings.orte_real` aktiviert (Default aus). Geocoding ist reiner Lookup (kein KI-Call) → normale Route, keine Job-Queue. Passt zur Produkt-Philosophie „KI rückwärtsgewandt": reine Kuration/Visualisierung bestehender Orte.

## Datenmodell

- `book_settings.orte_real` (INTEGER, Default 0) — schaltet Karten-Tab + Auto-Verortung pro Buch frei.
- `book_settings.schauplatz_land` (TEXT, nullable) — Länder-Hint (Region) fürs Geocoding, schränkt Nominatim/Photon-Treffer ein.
- `locations.lat` / `locations.lng` (REAL, nullable) — Koordinaten. Range-geclampt (lat ∈ [-90,90], lng ∈ [-180,180]) im `PUT /locations`-Pfad.
- `locations.land` (TEXT, nullable) — pro-Ort-Land.

Migrationen 162 (`orte_real` + `lat`/`lng`) und 163 (`schauplatz_land` + `locations.land`).

## Geocode-Lib (`lib/geocode.js`)

Geteilter Kern für die On-Demand-Route **und** den nächtlichen Cron.

**Zwei Provider**, gewählt via App-Setting `geocode.provider`:
- `nominatim` (Default) — OSM-Nominatim `search`, jsonv2. Public-Instanz hat Rate-Limit (≤1 req/s, Pflicht-`User-Agent`); `_schedule` serialisiert Calls. Self-hosted via `geocode.nominatim.url`.
- `photon` — Komoot-Photon (self-hosted), GeoJSON. Kein Rate-Limit. Braucht zwingend `geocode.photon.url`; fehlt sie → Provider liefert leer + Warn-Log.

Antwort-Normalisierung: `parseNominatimResults` / `parsePhotonResults` → `[{ lat, lng, displayName }]`. Fehler/Timeout → `[]` (non-fatal, nie throw in Request-Pfad).

**App-Settings** (`lib/app-settings.js`, ENV-Override in Klammern):
- `geocode.provider` (`GEOCODE_PROVIDER`) — `nominatim` | `photon`
- `geocode.nominatim.url` (`NOMINATIM_URL`)
- `geocode.photon.url` (`PHOTON_URL`)
- `geocode.cron.enabled` — Cron läuft, ausser explizit `false`
- `geocode.cron.max_per_run` — Cap pro Lauf (Default 1000); Rest folgt im nächsten Lauf

## Route: `GET /geocode` (`routes/geocode.js`)

Auth-geschützt (globaler Guard). Params: `q` (Pflicht, ≤200 Zeichen, sonst 400), `lang` (`de`|`en`, Default `de`), `region` (2-Letter-CC). Antwort `{ candidates: [...] }`. Kein Server-Proxy für Tiles — die holt der Browser direkt von OSM (Betreiber-Sache, self-hosted OSS); App liefert nur Voreinstellung + Pflicht-Attribution.

## Cron: Auto-Verortung (`geocodeAllBooks`, server.js 03:30)

Iteriert alle Bücher mit `orte_real=1`, sucht `locations` ohne Koordinaten (`lat IS NULL OR lng IS NULL`), geocodet sequenziell mit `lang = settings.language`, `region = settings.schauplatz_land`, schreibt ersten Treffer direkt in `locations`. Respektiert `max_per_run`-Cap. User korrigiert danach per Marker-Drag.

## Frontend

- **Orte-Karte** (`orte-card.js` + `public/js/book/orte-map.js` + `orte.html`): dritter View-Mode `map`, Tab nur sichtbar bei `book_settings.orte_real`. Leaflet lazy via `loadLeaflet()` ([public/js/lazy-libs.js](../public/js/lazy-libs.js), vendored `public/vendor/leaflet-1.9.4/`). Map-Instanz als transienter Handle (`_map`/`_markers`), Teardown via `map.remove()` in `destroy` + auf `book:changed`/`view:reset`. Pro Ort „Geocodieren"-Button → `GET /geocode`, Marker draggable, `dragend` schreibt zurück, Speichern über bestehendes `saveOrte()`. Marker-Popup-HTML via `escHtml()`.
- **BookSettings** (`book-settings-card.js`): Toggle `orte_real` + Feld `schauplatz_land`.
- UI-Pattern + CSS-Inventar: [DESIGN.md](../DESIGN.md) „Geo-Karte (Leaflet)". CSS [public/css/entities/orte-map.css](../public/css/entities/orte-map.css).

## Tests

- [tests/unit/geocode.test.mjs](../tests/unit/geocode.test.mjs) — Response-Parsing (beide Provider) + Range-Clamp.
- Migrationen via `squash-drift` + `erd-drift` gegated.
