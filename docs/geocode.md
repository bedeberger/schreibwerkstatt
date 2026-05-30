# Geocoding & Orte-Karte (Geo-Map realer Schauplätze)

Reale Schauplätze auf einer Leaflet-Karte verorten. Pro Buch via `book_settings.orte_real` aktiviert (Default aus). **KI-first:** Jedes Schauplatz-Label wird zuerst per KI (`POST /jobs/geocode-resolve`, Job-Queue) auf eine präzise reale Anfrage normalisiert (z.B. „Badi Olten" → „Olten"), erst dann geocodet. **Why:** der externe Geocoder ist zu tolerant — auf das rohe Label („Badi Olten") liefert er oft einen falschen Treffer (irgendwo in DE) statt den realen Anker. Die Normalisierung liest bestehende Labels, generiert keinen Buchtext → rein rückwärtsgewandt, passt zur Produkt-Philosophie „KI rückwärtsgewandt". `GET /geocode` (reine Heuristik, kein KI) bleibt als Lookup-Endpoint + ist der Geocoding-Schritt, den der KI-Job nach der Normalisierung intern aufruft.

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

**Heuristik-Zwei-Pass:** `geocode()` fragt erst das rohe Label ab; bleibt es leer, schneidet `parseToponym()` einen führenden Beschreibungsteil vor einem lokativen Bindewort ab («Bar in Olten» → «Olten», Bindewörter: in/im/bei/am/an/auf/vor/zu/zur/zum/near/at/on) und fragt den Toponym erneut ab. Pure → unit-getestet. Greift kein Bindewort (z.B. «Marktplatz von Bern»), bleibt die KI-Stufe.

**App-Settings** (`lib/app-settings.js`, ENV-Override in Klammern):
- `geocode.provider` (`GEOCODE_PROVIDER`) — `nominatim` | `photon`
- `geocode.nominatim.url` (`NOMINATIM_URL`)
- `geocode.photon.url` (`PHOTON_URL`)
- `geocode.cron.enabled` — Cron läuft, ausser explizit `false`
- `geocode.cron.max_per_run` — Cap pro Lauf (Default 1000); Rest folgt im nächsten Lauf

## Route: `GET /geocode` (`routes/geocode.js`)

Auth-geschützt (globaler Guard). Params: `q` (Pflicht, ≤200 Zeichen, sonst 400), `lang` (`de`|`en`, Default `de`), `region` (2-Letter-CC). Antwort `{ candidates: [...] }`. Kein Server-Proxy für Tiles — die holt der Browser direkt von OSM (Betreiber-Sache, self-hosted OSS); App liefert nur Voreinstellung + Pflicht-Attribution.

## KI-Normalisierungs-Job: `POST /jobs/geocode-resolve` (`routes/jobs/geocode.js`)

Primärpfad der Orte-Karte (KI-first). Input: `{ book_id, items: [{ id, name }] }` (Batch, max 200). `runGeocodeResolveJob` schickt alle Labels in **einem** `callAI`-Call (Prompt/Schema in [public/js/prompts/geocode.js](../public/js/prompts/geocode.js): `buildSystemGeocodeResolve` + `buildGeocodeResolvePrompt` + `SCHEMA_GEOCODE_RESOLVE`), bekommt pro Label `{ ort, land }` (präzise reale Anfrage — Strasse+Stadt wenn das Label sie hergibt, sonst Stadt; nicht-geografische Beschreibungen wie Bar/Badi/Café entfernt; ISO-2-Code; leer = rein fiktiv, kein Anker), geocodet jeden via `geocode(ort, { region: land })` und liefert `{ results: [{ id, lat, lng }|null] }`. Kein Cache (kein `geocode_*_cache`), daher **nicht** in `_promptsContentHash`.

`aiResolveLocation(name, { language, region })` ist die Einzel-Label-Variante (nutzt `callAI` direkt, kein Job-Kontext) — exportiert für die Cron-DI.

**Frontend** ([public/js/book/orte-map.js](../public/js/book/orte-map.js)): `geocodeOrt`/`geocodeAllUnlocated` rufen direkt `_geocodeViaAI` → `POST /jobs/geocode-resolve` + `startPoll` (kein Heuristik-Vorab-Call mehr — der tolerante Geocoder würde sonst das rohe Label auf einen Fehltreffer ziehen). Bleibt ein Ort unverortet (rein fiktiv / kein Treffer), zeigt der Render-Pfad einen roten Pin in der Kartenmitte (User schiebt zurecht).

## Cron: Auto-Verortung (`geocodeAllBooks`, server.js 03:30)

Iteriert alle Bücher mit `orte_real=1`, sucht `locations` ohne Koordinaten (`lat IS NULL OR lng IS NULL`), verortet **KI-first** mit `lang = settings.language`, `region = settings.schauplatz_land` und schreibt den ersten Treffer direkt in `locations`. Respektiert `max_per_run`-Cap. User korrigiert danach per Marker-Drag. **KI-Normalisierung:** server.js reicht `aiResolveLocation` via DI (`geocodeAllBooks({ aiResolve })`) — lib bleibt frei von `routes/jobs`-Imports. Pro Ort: erst KI-Normalisierung → geocoden; nur wenn kein Resolver injiziert ist oder die KI keinen realen Anker liefert, fällt der Cron auf das rohe Label (Heuristik) zurück.

## Frontend

- **Orte-Karte** (`orte-card.js` + `public/js/book/orte-map.js` + `orte.html`): dritter View-Mode `map`, Tab nur sichtbar bei `book_settings.orte_real`. Leaflet lazy via `loadLeaflet()` ([public/js/lazy-libs.js](../public/js/lazy-libs.js), vendored `public/vendor/leaflet-1.9.4/`). Map-Instanz als transienter Handle (`_map`/`_markers`), Teardown via `map.remove()` in `destroy` + auf `book:changed`/`view:reset`. Pro Ort „Geocodieren"-Button → `GET /geocode`, Marker draggable, `dragend` schreibt zurück, Speichern über bestehendes `saveOrte()`. Marker-Popup-HTML via `escHtml()`.
- **BookSettings** (`book-settings-card.js`): Toggle `orte_real` + Feld `schauplatz_land`.
- UI-Pattern + CSS-Inventar: [DESIGN.md](../DESIGN.md) „Geo-Karte (Leaflet)". CSS [public/css/entities/orte-map.css](../public/css/entities/orte-map.css).

## Tests

- [tests/unit/geocode.test.mjs](../tests/unit/geocode.test.mjs) — Response-Parsing (beide Provider) + Range-Clamp + `parseToponym`-Heuristik.
- Migrationen via `squash-drift` + `erd-drift` gegated.
