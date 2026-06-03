# Tagebuch-Rückblick-Heatmap in der Buch-Übersicht

- **Status:** Draft <!-- Draft → Ready erst wenn „Offene Fragen" leer -->
- **Aufwand:** M
- **Severity:** low

## Context

Der Tagebuch-Rückblick ([routes/jobs/rueckblick.js](../../routes/jobs/rueckblick.js), [docs](../../routes/jobs/rueckblick-dates.js)) verdichtet datierte Einträge eines Zeitraums (`YYYY` oder `YYYY-MM`) rückwärtsgewandt per KI. Generierte Rückblicke landen dauerhaft in `tagebuch_rueckblicke` (re-öffenbar). Heute sieht man diese Historie **nur** in der Rückblick-Karte selbst (`rueckblickHistory`, Liste der letzten 20).

Lücke: In der Buch-Übersicht (`bookOverviewCard`, nur sinnvoll bei `buchtyp === 'tagebuch'` → `overviewIsTagebuch()`) fehlt jeglicher Bezug zum Rückblick. Der User sieht nicht auf einen Blick, **welche** Monate/Jahre er schon verdichtet hat und wo noch „weisse Flecken" sind — also wo sich ein neuer Rückblick lohnt, weil dort Einträge liegen, aber noch keiner generiert wurde.

Ziel: Ein Übersichts-Tile, das pro Monat/Jahr zeigt (a) wie viele datierte Einträge existieren (Heatmap-Intensität = Aktivität) und (b) ob für diesen Zeitraum schon ein Rückblick generiert wurde (Marker). Klick auf eine Zelle springt in die Rückblick-Karte mit vorausgewähltem Zeitraum. Passt zur App-Philosophie (KI rückwärtsgewandt/überwachend, nie generativ in den Text — siehe Memory `user_app_philosophy`): die Heatmap ist reine Lese-/Navigations-Visualisierung.

## Scope MVP

- Neues Übersichts-Tile **„Rückblick-Heatmap"**, nur sichtbar bei `overviewIsTagebuch()`.
- Jahr×Monat-Raster: Zeilen = Jahre (vom frühesten bis spätesten datierten Eintrag), Spalten = Jan–Dez.
- Zell-Intensität (4 Stufen + leer) nach Anzahl datierter Einträge im Monat (Quartil-Bucketing analog `overviewStreakHeatmap`).
- Marker auf Zellen, für die bereits ein Monats-Rückblick (`YYYY-MM`) existiert; Jahres-Marker am Zeilen-Label, wenn ein Jahres-Rückblick (`YYYY`) existiert.
- Klick auf Monats-Zelle / Jahres-Label → öffnet Rückblick-Karte mit vorausgewähltem `rueckblickZeitraum` (kein Auto-Run; existiert ein Eintrag in der Historie, lädt die Karte ihn aus `rueckblickHistory`).
- Hover-Tooltip pro Zelle: Zeitraum, Eintragszahl, „Rückblick vorhanden seit \<Datum\>" bzw. „noch kein Rückblick" (via `data-tip`, siehe Memory `feedback_tooltip_data_tip`).
- Read-only Endpoint, kein KI-Call, kein Job.

## Out-of-Scope

- Auto-Generieren eines Rückblicks per Klick (kostet Tokens; bleibt expliziter User-Trigger in der Karte).
- Anzeige in der **globalen** Mehr-Buch-Übersicht / Buchauswahl (nur die Per-Buch-`bookOverviewCard`).
- Heatmap-Intensität nach Zeichen/Wörtern statt Eintragszahl (Phase 2; Eintragszahl ist die natürliche Tagebuch-Aktivitätsgrösse).
- Wochen-/Tages-Granularität (die `overviewStreakHeatmap` deckt Tagesaktivität bereits ab; hier geht es um Rückblick-Zeiträume = Monat/Jahr).

## Done when

- Bei einem Tagebuch mit datierten Einträgen über mehrere Monate erscheint das Tile mit korrektem Jahr×Monat-Raster.
- Monate mit Einträgen sind nach Dichte eingefärbt; leere Monate sind als leere Zelle erkennbar.
- Monate/Jahre mit vorhandenem Rückblick tragen den Marker; nach Generieren eines neuen Rückblicks erscheint der Marker beim nächsten Overview-Load.
- Klick auf eine Zelle öffnet die Rückblick-Karte mit passendem Zeitraum.
- Bei `buchtyp !== 'tagebuch'` wird das Tile nicht gerendert (kein leeres Tile, kein Fetch).
- `npm test` grün (neue Unit-Tests inkl.).

## Hard-Rule-Audit

- **Editor-Spezifikation:** nicht betroffen — kein Editor im Spiel (reines Übersichts-Tile + Lese-Endpoint).
- **UI-Patterns aus DESIGN.md:** betroffen. Heatmap-Zellen folgen dem `overviewStreakHeatmap`-Vorbild (Level-0..4-Buckets). Eckige Zellen (`var(--radius-sm)`, Memory `feedback_eckige_badges`). Falls das Monats-Heatmap-Markup nicht 1:1 unter ein bestehendes Pattern fällt → vorher in DESIGN.md als Variante dokumentieren.
- **i18n:** betroffen — neue `overview.rueckblickHeatmap.*`-Keys in **beiden** Locales (de + en).
- **Styles nur in `public/css/`:** betroffen — neue Datei [public/css/book-overview/rueckblick-heatmap.css](../../public/css/book-overview/), `<link>` in [index.html](../../public/index.html), `SHELL_CACHE`-Bump, DESIGN.md-CSS-Inventar. Keine Inline-Styles; Intensität über `--rb-level`-Custom-Prop + Klassen (kein `:style="'background:'+…"`).
- **Content-Store-Facade:** der Endpoint liest **nur Metadaten** (`pages.page_name`, `page_id`, optional `page_stats`) zur Datums-Aggregation — kein Buch-**Inhalt** (HTML-Body). Das folgt der etablierten Praxis in [routes/history.js](../../routes/history.js) (`/fehler-heatmap`, `/page-ages`, `/style-stats` joinen `pages` direkt für Stats). Buch-Inhalt bleibt facade-exklusiv.
- **KI-Calls nur via Job-Queue:** nicht betroffen — kein KI-Call; reiner SQL-Read.
- **x-html-Escape:** nicht betroffen — Rendering ausschliesslich via `x-text` / statische Templates, kein neuer `x-html`-Sink.
- **Combobox / numInput / LanguageTool:** nicht betroffen — keine Eingabefelder.
- **DB-Timestamps / FK-Integrität / Migration:** nicht betroffen — keine Schemaänderung.
- **Logging-Context book-slot:** betroffen — neuer Endpoint mit `:book_id` läuft unter dem bestehenden `router.param('book_id', aclParamGuard('viewer'))` in history.js, der den Context bereits füllt (`_guardBook`/`setContext`).
- **Memo-Pattern:** betroffen — `overviewRueckblickHeatmap()` wird im Template mehrfach gerendert → über den einen `_memo`-Helfer in book-overview memoizieren; Compute-Body als `_computeRueckblickHeatmap` extrahieren (testbar ohne Alpine).
- **State explizit:** betroffen — `overviewRueckblickCoverage` als Initial-Feld + Reset in `resetBookOverview`.
- **SHELL_CACHE:** betroffen — Bump bei JS/CSS-Änderung (Memory `feedback_shell_cache_bump`).
- **Mobile-Breakpoints:** betroffen — Tile bekommt im selben Commit Mobile-Regeln (Container-Query bevorzugt, da Tile im dichten Overview-Grid lebt; Memory `feedback_mobile_breakpoints`).
- **Keine Icons ohne Aufforderung:** Marker als Text-/Form-Marker (z.B. Eckpunkt/Border), kein neues Icon (Memory `feedback_no_icons`).
- **tzOpts:** betroffen, falls Tooltip ein „vorhanden seit"-Datum zeigt → `tzOpts()` wrappen (Memory).

## Abhängigkeiten

- Tagebuch-Rückblick-Feature (Karte + `tagebuch_rueckblicke`-Historie) — vorhanden.
- `bookOverviewCard` + `overviewIsTagebuch()` Gate — vorhanden.
- Datums-Parsing [routes/jobs/rueckblick-dates.js](../../routes/jobs/rueckblick-dates.js) (`entryDate`) — wird serverseitig wiederverwendet (SSoT für Eintragsdatierung).
- Card-Select-Event-Muster (analog `kapitel-review:select`) für die Zeitraum-Vorauswahl.

## Backend

**Neuer Endpoint** in [routes/history.js](../../routes/history.js):

`GET /history/rueckblick-coverage/:book_id` (viewer+, via bestehendem `aclParamGuard`)
- Liest `page_name` + `page_id` aller Seiten des Buchs (`SELECT p.page_name, p.page_id FROM pages p WHERE p.book_id = ?`).
- Datiert jede Seite via `entryDate(name)` aus `rueckblick-dates` → bucket nach `monthKey` (`YYYY-MM`) und `year`.
- Liest die distinct `zeitraum` + `MAX(created_at)` + jüngste `id` aus `tagebuch_rueckblicke WHERE book_id = ? AND user_email = ?` (user-spezifisch wie die Historie).
- Antwort:
  ```jsonc
  {
    "months": { "2024-03": { "entries": 12, "rueckblick": { "id": 7, "created_at": "…Z" } | null }, … },
    "years":  { "2024":    { "entries": 140, "rueckblick": { "id": 9, "created_at": "…Z" } | null }, … },
    "minYear": 2022, "maxYear": 2025
  }
  ```
- Kein KI-Call, kein Job. Reiner Aggregations-Read.

Datums-Parsing bleibt serverseitig (SSoT) — Frontend bekommt fertige Buckets, kein Port von `parseDatum` nötig.

## Frontend

**Card:** `bookOverviewCard` (kein neues Card — Tile lebt in der bestehenden Übersicht).

- **State** ([public/js/app/app-state.js](../../public/js/app/app-state.js) bzw. Overview-State): `overviewRueckblickCoverage: null`. Reset in `resetBookOverview` ([book-overview/load.js](../../public/js/book-overview/load.js)).
- **Load:** in `loadBookOverview` (load.js) nur bei Tagebuch zusätzlich `fetchJsonRetry('/history/rueckblick-coverage/' + bookId)` (parallel zu den übrigen Overview-Fetches, `.catch(() => null)`).
- **Compute:** neues Modul-Method-Paar in [book-overview/stats.js](../../public/js/book-overview/stats.js): `overviewRueckblickHeatmap()` (memoized via `_memo`) ruft `_computeRueckblickHeatmap(coverage)` → liefert `{ years: [{ year, hasRueckblick, months: [{ key, monthIdx, entries, level, hasRueckblick, createdAt } × 12] }], maxEntries }`. Quartil-Bucketing der Eintragszahlen für `level` 1..4.
- **Navigation:** Root-Methode `openRueckblickFor(zeitraum)` ([app-view.js](../../public/js/app/app-view.js)): dispatcht `rueckblick:select { zeitraum }` und ruft `toggleTagebuchRueckblickCard()` (bzw. nur Flag-Set wenn schon offen, analog `kapitel-review:select`). Die Rückblick-Karte hört auf das Event → setzt `rueckblickZeitraum`, lädt Historie, zeigt vorhandenen Eintrag falls vorhanden (kein Auto-Run). Scroll-to übernimmt der bestehende Toggle-Pfad.
- **Hash-Router:** optional — `#rueckblick` Branch ([app-hash-router.js](../../public/js/app/app-hash-router.js)) um optionalen `:zeitraum`-Suffix erweitern, damit Deep-Links auf einen Zeitraum funktionieren. MVP: Event-basiert ausreichend, Hash-Erweiterung als Nice-to-have.
- **Partial:** neues [public/partials/bookoverview-rueckblick-heatmap.html](../../public/partials/) mit `x-show="overviewIsTagebuch()"`, eingehängt als `<div id="partial-bookoverview-rueckblick-heatmap"></div>` in [bookoverview.html](../../public/partials/bookoverview.html) (Tile-Reihenfolge: nahe Recent/Review, da review-Gruppe). Rendering via `x-for` über Jahre/Monate, `x-text` für Zahlen, `@click="$app.openRueckblickFor(cell.key)"`, `:class` für Level + Marker, `:data-tip` für Tooltip.

## CSS

Neue Datei [public/css/book-overview/rueckblick-heatmap.css](../../public/css/book-overview/):
- Grid-Layout (12 Spalten + Jahres-Label-Spalte), eckige Zellen (`var(--radius-sm)`).
- Level-Farben über `--rb-level`/Klassen, abgeleitet aus dem Karten-Akzent (`var(--card-accent)`) — keine neue Akzentfarbe nötig (Tile erbt den Overview-Akzent).
- Marker für „Rückblick vorhanden" als Border/Eckpunkt (kein Icon).
- Mobile/Container-Query: Zellgrösse + Label-Spalte schrumpfen.
- `<link>` in [index.html](../../public/index.html), `SHELL_CACHE` in [sw.js](../../public/sw.js) bumpen, Eintrag im DESIGN.md-CSS-Inventar.

## i18n

Neue Keys (de + en) im Bereich `overview.rueckblickHeatmap.*`:
- `.title` („Rückblick-Heatmap" / „Retrospective heatmap")
- `.subtitle`/`.legend` (Aktivität / Rückblick vorhanden)
- `.tooltip.entries` („{n} Einträge")
- `.tooltip.hasRueckblick` („Rückblick vorhanden seit {date}")
- `.tooltip.noRueckblick` („Noch kein Rückblick")
- `.empty` („Keine datierten Einträge")

## DB

`n/a` — reuse `tagebuch_rueckblicke`, `pages`, optional `page_stats`. Keine Migration, kein ERD-Update.

## Security

- Endpoint: viewer+ via `aclParamGuard('viewer')` (bestehend). Rückblick-Marker user-spezifisch (`user_email`-Scope), da `tagebuch_rueckblicke` persönlich ist.
- Kein PII-Leak: nur Aggregat-Zahlen + Zeitraum-Strings, keine Eintragsinhalte.
- Kein neues Escape nötig (x-text-only). Rate-Limit `n/a` (read, ACL-geschützt).

## Telemetrie

`n/a` — kein Counter geplant. (Optional Phase 2: Usage-Track beim Sprung von Heatmap → Rückblick.)

## Reversibilität

Vollständig additiv. Ausbau = Tile-Partial + `<link>` + Endpoint + i18n-Keys + State/Compute entfernen. Keine Datenmigration, keine Schemaänderung. Kein Feature-Flag nötig (Tile rein additiv, hinter Tagebuch-Gate).

## Tests

- **Unit:** `_computeRueckblickHeatmap` — Bucketing (Quartile), Jahr-Range (min/max), Monats-Lücken als Level 0, Marker-Zuordnung Monat vs. Jahr, leere Coverage → leeres Ergebnis. (Pures Compute ohne Alpine, analog [streak-heatmap.test.mjs](../../tests/unit/streak-heatmap.test.mjs).)
- **Unit (Server):** Datums-Bucketing des Endpoints — `entryDate`-Wiederverwendung gegen gemischte Page-Namen (datiert/undatiert), Jahres- vs. Monats-Rückblick-Match.
- **E2E/Smoke:** Tile erscheint im Tagebuch-Overview (Smoke deckt Overview-Öffnen bereits ab; ggf. Fixture-Harness mit Mock-Coverage für Klick → Karte-öffnet-mit-Zeitraum).

## Edge-Cases

- **Keine datierten Einträge:** Endpoint liefert leere `months`/`years` → Tile zeigt `.empty`-Hinweis statt leeres Raster.
- **Rückblick für Zeitraum ohne Einträge** (Einträge nachträglich gelöscht): Zelle Level 0, aber Marker vorhanden → Marker bleibt sichtbar (zeigt „verwaister" Rückblick); Tooltip nennt 0 Einträge.
- **Sehr lange Tagebücher** (viele Jahre): Raster scrollt vertikal innerhalb des Tiles (max-height + overflow), nicht das ganze Overview-Grid sprengen.
- **Undatierte/teil-datierte Seiten** (nur Jahr ohne Monat): zählen in den Jahres-Bucket, nicht in einen Monat (`monthKey === null` → nur `years`).
- **Buchwechsel/Stale:** Coverage über bestehenden `_staleCheckBookId`-Guard + Reset in `resetBookOverview` schützen.
- **Locale-Spaltenköpfe** (Monatsnamen): via `Intl.DateTimeFormat(tag, tzOpts({ month: 'short' }))` wie bei den übrigen Overview-Charts.

## Kritische Dateien

- **Modify:**
  - [routes/history.js](../../routes/history.js) — neuer `GET /rueckblick-coverage/:book_id`.
  - [public/js/book-overview/load.js](../../public/js/book-overview/load.js) — Coverage-Fetch (nur Tagebuch) + Reset-Feld.
  - [public/js/book-overview/stats.js](../../public/js/book-overview/stats.js) — `overviewRueckblickHeatmap` + `_computeRueckblickHeatmap`.
  - [public/js/app/app-state.js](../../public/js/app/app-state.js) — `overviewRueckblickCoverage`-State.
  - [public/js/app/app-view.js](../../public/js/app/app-view.js) — `openRueckblickFor(zeitraum)`.
  - [public/js/cards/tagebuch-rueckblick-card.js](../../public/js/cards/tagebuch-rueckblick-card.js) — `rueckblick:select`-Listener.
  - [public/partials/bookoverview.html](../../public/partials/bookoverview.html) — Tile-Container.
  - [public/index.html](../../public/index.html) — CSS-`<link>`.
  - [public/sw.js](../../public/sw.js) — `SHELL_CACHE`-Bump.
  - [public/js/i18n/de.json](../../public/js/i18n/de.json), [public/js/i18n/en.json](../../public/js/i18n/en.json) — neue Keys.
  - [DESIGN.md](../../DESIGN.md) — CSS-Inventar (+ ggf. Heatmap-Pattern-Variante).
  - [public/js/app/app-hash-router.js](../../public/js/app/app-hash-router.js) — optionaler `#rueckblick:<zeitraum>`-Branch.
- **Create:**
  - [public/partials/bookoverview-rueckblick-heatmap.html](../../public/partials/)
  - [public/css/book-overview/rueckblick-heatmap.css](../../public/css/book-overview/)
  - `tests/unit/rueckblick-heatmap.test.mjs`

## Offene Fragen

- Keine.
