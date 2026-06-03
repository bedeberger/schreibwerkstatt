# Tagebuch-Overview-Kacheln (Lücken & Konsistenz · Wochentag-Rhythmus · Rückblick-Heatmap)

- **Status:** Ready
- **Aufwand:** M
- **Severity:** low

## Context

Die Buch-Overview blendet bei `buchtyp === 'tagebuch'` die narrativen Analyse-Kacheln (Figuren-/Schauplatz-Matrix, Szenen-Wertung, Kapitel-Verteilung/-Findings) aus — sie sind für Ich-Perspektive-Tagebücher bedeutungslos. Dadurch entsteht Platz. Statt nur zu strippen sollen Kacheln dazukommen, die zur eigentlichen Tagebuch-Achse passen: **Rhythmus, Konsistenz und Rückblick-Abdeckung**. Das macht aus der gestrippten Roman-Overview ein echtes Tagebuch-Dashboard.

Alle Kacheln sind **rückwärtsgewandt/auswertend** (kein generatives Schreiben in den Text) — konsistent mit der App-Philosophie „KI nur für Überwachung + Weltaufbau". Die ersten beiden Kacheln sind rein clientseitig; die **Rückblick-Heatmap** liest zusätzlich die Historie der bereits umgesetzten KI-Rückblicke (`tagebuch_rueckblicke`) und navigiert in die vorhandene Rückblick-Karte.

Der nicht-KI-Rückblick „vor einem Jahr heute" lebt **nicht** hier, sondern als eigenes Feature in [tagebuch-an-diesem-tag.md](tagebuch-an-diesem-tag.md) (Kalender-Header-Panel, mehrere Vorjahre, Zeitraum-Suche). Bewusst dort konsolidiert, um die Resurfacing-Logik nicht an zwei Surfaces zu duplizieren.

## Scope MVP

Drei neue Kacheln, **exklusiv** sichtbar bei `overviewIsTagebuch()`:

- **Lücken & Konsistenz** — Tage seit letztem Eintrag, längste Lücke (Tage), aktuelle Tages-Streak (aufeinanderfolgende Tage mit Eintrag bis heute), Einträge diesen Monat vs. Vormonat.
- **Wochentag-Rhythmus** — Mo–So-Balken: Anzahl Einträge pro Wochentag (locale-abhängige Wochentags-Reihenfolge), Σ-Zeichen pro Wochentag als `data-tip`.
- **Rückblick-Heatmap** — Jahr×Monat-Raster: Zell-Intensität (4 Stufen + leer) nach Anzahl datierter Einträge pro Monat (Quartil-Bucketing analog `overviewStreakHeatmap`); Marker auf Monaten/Jahren, für die schon ein KI-Rückblick (`YYYY-MM` bzw. `YYYY`) existiert; Klick auf eine Zelle öffnet die Rückblick-Karte mit vorausgewähltem Zeitraum (kein Auto-Run); Hover-Tooltip mit Zeitraum, Eintragszahl und „Rückblick vorhanden seit \<Datum\>" bzw. „noch kein Rückblick".

Datenbasis der ersten beiden Kacheln: ausschliesslich clientseitig vorhandene Quellen — `window.__app.pages` (Seitenname = ISO-Datum) + `window.__app.tokEsts` (Zeichen/Seite), **kein neuer Endpoint**. Die Rückblick-Heatmap braucht **einen** zusätzlichen Lese-Endpoint (`GET /history/rueckblick-coverage/:book_id`, Aggregat-Read, kein KI-Call, kein Job).

## Out-of-Scope

- **Rückblick „vor einem Jahr heute" / „An diesem Tag"** — eigenes Feature in [tagebuch-an-diesem-tag.md](tagebuch-an-diesem-tag.md) (Kalender-Header-Panel). Bewusst nicht als Overview-Kachel, um die Resurfacing-Logik nicht zu duplizieren.
- Weitere KI-Kacheln (Stimmungsverlauf, Themen-Wolke) — eigenes Feature, eigener Plan, eigener Job + Cache.
- Auto-Generieren eines Rückblicks per Klick auf eine Heatmap-Zelle (kostet Tokens; bleibt expliziter User-Trigger in der Karte).
- Heatmap-Intensität nach Zeichen/Wörtern statt Eintragszahl (Phase 2; Eintragszahl ist die natürliche Tagebuch-Aktivitätsgrösse).
- Orte-Mini-Karte (Geo) — separat.
- Konfigurierbarkeit (welche Kacheln, Reihenfolge) — fix.
- Anwendung auf andere Buchtypen — bewusst tagebuch-only.

## Done when

- Bei einem Buch mit `buchtyp === 'tagebuch'` und datierten Einträgen erscheinen die drei Kacheln im Overview-Grid; bei anderen Buchtypen erscheinen sie nie (kein leeres Tile, kein Fetch).
- „Lücken & Konsistenz" zeigt korrekte Tageswerte (verifiziert per Unit-Test gegen synthetische Datums-Sets inkl. Streak über Monatsgrenze).
- „Wochentag-Rhythmus" verteilt Einträge korrekt auf Wochentage (TZ-aware Parse, kein Off-by-one durch UTC).
- „Rückblick-Heatmap": Monate mit Einträgen sind nach Dichte eingefärbt, leere Monate als leere Zelle erkennbar; Monate/Jahre mit vorhandenem Rückblick tragen den Marker (erscheint nach Generieren eines neuen Rückblicks beim nächsten Overview-Load); Klick öffnet die Rückblick-Karte mit passendem Zeitraum.
- `npm test` grün (neue Unit-Tests inkl.); Smoke-Test (Kafka-Seed = kein Tagebuch) unverändert grün.

## Hard-Rule-Audit

- **Editor-Spezifikation:** n/a — keine Editor-Änderung.
- **UI-Patterns aus DESIGN.md:** betroffen — Heatmap-Zellen folgen dem `overviewStreakHeatmap`-Vorbild (Level-0..4-Buckets), Bar-Visualisierung nutzt das bestehende `.overview-*-bar`-Pattern bzw. die `--progress`-Konvention. Eckige Zellen/Badges (`var(--radius-sm)`). Fällt das Monats-Heatmap-Markup nicht 1:1 unter ein bestehendes Pattern → vorher in DESIGN.md als Variante dokumentieren.
- **i18n:** betroffen — neue Keys `overview.diary.*` + `overview.rueckblickHeatmap.*` in **beiden** Locale-Dateien (de = Fallback, en = Übersetzung). Wochentags-/Monats-/Datumslabels via `Intl` + `tzOpts`, nicht hartcodiert.
- **CSS:** betroffen — neue Dateien `public/css/book-overview/diary.css` + `public/css/book-overview/rueckblick-heatmap.css`; keine Inline-Styles. Heatmap-Intensität über `--rb-level`-Custom-Prop + Klassen (kein `:style="'background:'+…"`). Mobile via Container-Query (Tiles in variablem Grid-Slot). Registrierung: `<link>` in [public/index.html](public/index.html), `SHELL_CACHE`-Bump, DESIGN.md „CSS-File-Inventar".
- **Content-Store-Facade:** die ersten beiden Kacheln read-only aus geladenem State. Der Heatmap-Endpoint liest **nur Metadaten** (`pages.page_name`, `page_id`) zur Datums-Aggregation — kein Buch-**Inhalt** (HTML-Body). Folgt der etablierten Praxis in [routes/history.js](../../routes/history.js) (`/fehler-heatmap`, `/page-ages`, `/style-stats` joinen `pages` direkt für Stats). Buch-Inhalt bleibt facade-exklusiv.
- **DB-Integrität:** n/a — keine Migration, keine Tabelle (reuse `tagebuch_rueckblicke`, `pages`).
- **Job-Queue / KI-Calls / `callAI` JSON-Only / truncated:** n/a — kein KI-Call, reiner SQL-Read.
- **x-html-Escape:** nicht betroffen — Rendering ausschliesslich via `x-text` bzw. attribut-gebundenes `:data-tip` (Alpine-escaped), **keine** neuen `x-html`-Sinks.
- **Combobox / numInput / LanguageTool:** n/a — keine Eingabefelder.
- **sortableTable:** n/a — Wochentag-Rhythmus + Heatmap sind Visualisierungen (feste Zeilen/Raster), keine sortierbaren Datentabellen (Ausnahme analog Heatmap/Presence-Matrix).
- **Logging-Context book-slot:** betroffen — der neue Endpoint mit `:book_id` läuft unter dem bestehenden `router.param('book_id', aclParamGuard('viewer'))` in history.js, der den Context bereits füllt.
- **Memo-Pattern (ein Helper pro Modul):** Compute-Methoden nutzen den bestehenden `this._memo` aus book-overview (gemeinsamer `this._memos`-Speicher) — **kein** zweiter Helper. Pure Bodies als `_computeDiaryXxx` / `_computeRueckblickHeatmap` extrahiert (Alpine-frei testbar).
- **State explizit:** `overviewRueckblickCoverage` als Initial-Feld + Reset in `resetBookOverview`. Die ersten beiden Kacheln brauchen kein neues Card-State-Feld (Compute aus `window.__app.pages`); `overviewBuchtyp`/`overviewIsTagebuch()` existieren bereits.
- **Card-Animationen / Progress-Bars / Eckige Badges / Doppelpunkt-Separator / keine Icons / Swiss-Decimals / tzOpts+localIsoDate:** eingehalten. Rückblick-vorhanden-Marker als Border/Eckpunkt (kein Icon).
- **Mobile-Breakpoints / SHELL_CACHE bumpen:** ja (JS + CSS + Partial).

## Abhängigkeiten

- Bestehendes Tagebuch-Gating: `overviewIsTagebuch()` + `overviewBuchtyp` ([public/js/book-overview/load.js](public/js/book-overview/load.js)) — vorhanden.
- Seite↔Datum-Mechanik des Diary-Kalenders: dieselbe ISO-Datum-aus-Seitenname-Logik wie [public/js/book/diary-calendar.js](public/js/book/diary-calendar.js) (`diaryCalendarPagesMap`, Regex `^\d{4}-\d{2}-\d{2}`). Entry-Datum = **Seitenname**, nicht `updated_at` (User kann Einträge rückdatieren).
- Umgesetztes KI-Rückblick-Feature: Karte + `tagebuch_rueckblicke`-Historie ([routes/jobs/rueckblick.js](../../routes/jobs/rueckblick.js), [public/js/cards/tagebuch-rueckblick-card.js](../../public/js/cards/tagebuch-rueckblick-card.js)) — vorhanden. Datums-Parsing [routes/jobs/rueckblick-dates.js](../../routes/jobs/rueckblick-dates.js) (`entryDate`) wird serverseitig wiederverwendet (SSoT für Eintragsdatierung).
- Card-Select-Event-Muster (analog `kapitel-review:select`) für die Zeitraum-Vorauswahl beim Heatmap-Klick.
- TZ-Helper: `localIsoDate` / `tzOpts` aus [public/js/utils.js](public/js/utils.js).

## Backend

Für „Lücken & Konsistenz" + „Wochentag-Rhythmus": **n/a** — keine neuen Routen/Jobs/Libs. Genutzte (bestehende) Quellen: `window.__app.pages`, `window.__app.tokEsts`. `/history/page-stats/:bookId` wird bereits geladen.

Für „Rückblick-Heatmap": **ein** neuer Endpoint in [routes/history.js](../../routes/history.js):

`GET /history/rueckblick-coverage/:book_id` (viewer+, via bestehendem `aclParamGuard`)
- Liest `page_name` + `page_id` aller Seiten des Buchs (`SELECT p.page_name, p.page_id FROM pages p WHERE p.book_id = ?`).
- Datiert jede Seite via `entryDate(name)` aus `rueckblick-dates` → bucket nach `monthKey` (`YYYY-MM`) und `year`.
- Liest distinct `zeitraum` + `MAX(created_at)` + jüngste `id` aus `tagebuch_rueckblicke WHERE book_id = ? AND user_email = ?` (user-spezifisch wie die Historie).
- Antwort:
  ```jsonc
  {
    "months": { "2024-03": { "entries": 12, "rueckblick": { "id": 7, "created_at": "…Z" } | null }, … },
    "years":  { "2024":    { "entries": 140, "rueckblick": { "id": 9, "created_at": "…Z" } | null }, … },
    "minYear": 2022, "maxYear": 2025
  }
  ```
- Kein KI-Call, kein Job. Datums-Parsing bleibt serverseitig (SSoT) — Frontend bekommt fertige Buckets.

## Frontend

Alle Kacheln leben in der bestehenden `bookOverviewCard` — **keine** Card-Recipe-Schritte (Registry/Hash-Router/Exklusivität).

**Lücken & Konsistenz + Wochentag-Rhythmus:** neue Methodengruppe `diaryMethods` in **neuer Datei** `public/js/book-overview/diary.js`, re-exportiert in der Facade [public/js/book-overview.js](public/js/book-overview.js) (spread in `bookOverviewMethods`). Methoden (memoized via `this._memo`, deps `[window.__app.pages, app.tokEsts]`):
- `diaryGapsConsistency()` → `{ daysSinceLast, longestGap, currentStreak, entriesThisMonth, entriesPrevMonth }`.
- `diaryWeekdayRhythm()` → `[{ weekday, count, chars, pct }]` in locale-Reihenfolge (Mo-first de, Sun-first en via `Intl`).
- Pure Bodies extrahiert als `_computeDiaryGapsConsistency(dates, todayIso)` / `_computeDiaryWeekdayRhythm(dates, tokEsts, …)`.
- Helper `_diaryEntryDates(pages)` → sortierte `YYYY-MM-DD`-Liste (Regex-Filter), gemeinsam genutzt.

**Rückblick-Heatmap:**
- **State** ([public/js/app/app-state.js](../../public/js/app/app-state.js)): `overviewRueckblickCoverage: null`. Reset in `resetBookOverview` ([book-overview/load.js](../../public/js/book-overview/load.js)).
- **Load:** in `loadBookOverview` nur bei Tagebuch zusätzlich `fetchJsonRetry('/history/rueckblick-coverage/' + bookId)` (parallel zu den übrigen Overview-Fetches, `.catch(() => null)`).
- **Compute:** `overviewRueckblickHeatmap()` (memoized via `_memo`) ruft `_computeRueckblickHeatmap(coverage)` → `{ years: [{ year, hasRueckblick, months: [{ key, monthIdx, entries, level, hasRueckblick, createdAt } × 12] }], maxEntries }`. Quartil-Bucketing für `level` 1..4. In [book-overview/stats.js](../../public/js/book-overview/stats.js).
- **Navigation:** Root-Methode `openRueckblickFor(zeitraum)` ([app-view.js](../../public/js/app/app-view.js)): dispatcht `rueckblick:select { zeitraum }` und ruft `toggleTagebuchRueckblickCard()` (bzw. nur Flag-Set wenn schon offen, analog `kapitel-review:select`). Die Rückblick-Karte hört auf das Event → setzt `rueckblickZeitraum`, lädt Historie, zeigt vorhandenen Eintrag (kein Auto-Run). Scroll-to übernimmt der bestehende Toggle-Pfad.
- **Hash-Router (optional):** `#rueckblick`-Branch ([app-hash-router.js](../../public/js/app/app-hash-router.js)) um optionalen `:zeitraum`-Suffix erweitern für Deep-Links. MVP: Event-basiert ausreichend.

**Partials:** zwei neue Dateien — `public/partials/bookoverview-diary.html` (zwei `<template x-if="overviewIsTagebuch() && …">`-Tiles) und `public/partials/bookoverview-rueckblick-heatmap.html` (`x-show="overviewIsTagebuch()"`, `x-for` über Jahre/Monate, `@click="$app.openRueckblickFor(cell.key)"`, `:class` für Level + Marker, `:data-tip` für Tooltip). Placeholder `<div id="partial-bookoverview-diary"></div>` + `<div id="partial-bookoverview-rueckblick-heatmap"></div>` in [public/partials/bookoverview.html](public/partials/bookoverview.html), platziert nahe `partial-bookoverview-charts` bzw. der Review-Gruppe. Loader-Registrierung analog der übrigen `bookoverview-*`-Partials.

## CSS

Zwei neue Dateien in `public/css/book-overview/`:
- `diary.css`: `.overview-consistency-*` (Kennzahlen-Grid Wert + Label), `.overview-weekday-*` (7 Balken; `--progress`-Konvention bzw. Reuse `.overview-chapter-bar-*`).
- `rueckblick-heatmap.css`: Grid-Layout (12 Spalten + Jahres-Label-Spalte), eckige Zellen (`var(--radius-sm)`), Level-Farben über `--rb-level`/Klassen abgeleitet aus `var(--card-accent)`, „Rückblick vorhanden"-Marker als Border/Eckpunkt (kein Icon), `max-height` + `overflow` für sehr lange Tagebücher.

Beide: Akzentfarbe erbt den Overview-Akzent (keine neue Hue). Mobile via Container-Query. Pflicht-Folgeschritte: `<link>` in [public/index.html](public/index.html), `SHELL_CACHE`-Bump in [public/sw.js](public/sw.js), Einträge in [DESIGN.md](DESIGN.md) „CSS-File-Inventar".

## i18n

Neue Key-Bereiche in [public/js/i18n/de.json](public/js/i18n/de.json) + [public/js/i18n/en.json](public/js/i18n/en.json):
- `overview.diary.consistency` (Label), `…daysSinceLast`, `…longestGap`, `…currentStreak`, `…thisMonth`, `…prevMonth`, Einheiten `…unit.days`, `…unit.entries`
- `overview.diary.weekday` (Label), `…weekdayTip` (Σ-Zeichen-Tooltip mit `{chars}`)
- `overview.rueckblickHeatmap.title`, `…subtitle`/`…legend`, `…tooltip.entries` („{n} Einträge"), `…tooltip.hasRueckblick` („Rückblick vorhanden seit {date}"), `…tooltip.noRueckblick`, `…empty`

Wochentags-/Monatsnamen + Datumsformat über `Intl.DateTimeFormat` mit `tzOpts`, nicht als statische Keys.

## DB

n/a — reuse `tagebuch_rueckblicke`, `pages`, optional `page_stats`. Keine Migration, kein ERD-Update.

## Security

Auth-Scope unverändert (Overview hinter Session-Guard + ACL). Heatmap-Endpoint viewer+ via `aclParamGuard('viewer')` (bestehend); Rückblick-Marker user-spezifisch (`user_email`-Scope), da `tagebuch_rueckblicke` persönlich ist. Kein PII-Leak: nur Aggregat-Zahlen + Zeitraum-Strings, keine Eintragsinhalte. Rendering via `x-text`/escaped Attribute — kein `x-html`. Rate-Limit `n/a` (read, ACL-geschützt).

## Telemetrie

n/a (keine neue Metrik). Optional Phase 2: Usage-Track beim Sprung von Heatmap → Rückblick — nicht im MVP.

## Reversibilität

Vollständig additiv. Ausbau = `diaryMethods`-Import + zwei Partial-Placeholder + CSS-`<link>`s + Heatmap-Endpoint + i18n-Keys + State/Compute entfernen, `SHELL_CACHE` bumpen. Keine Daten-Migration, kein Schema-Rückbau. Kein Feature-Flag nötig (Gating über `overviewIsTagebuch()`).

## Tests

- **Unit** (`tests/unit/book-overview-diary.test.mjs`, neu): `_computeDiaryGapsConsistency`, `_computeDiaryWeekdayRhythm` gegen synthetische Datums-/tokEsts-Sets. Abdeckung: leeres Set, einzelner Eintrag, Streak über Monats-/Jahresgrenze, Lücke korrekt, kein Off-by-one beim Wochentag (TZ-aware).
- **Unit** (`tests/unit/rueckblick-heatmap.test.mjs`, neu): `_computeRueckblickHeatmap` — Bucketing (Quartile), Jahr-Range (min/max), Monats-Lücken als Level 0, Marker-Zuordnung Monat vs. Jahr, leere Coverage → leeres Ergebnis (analog [streak-heatmap.test.mjs](../../tests/unit/streak-heatmap.test.mjs)).
- **Unit (Server):** Datums-Bucketing des Endpoints — `entryDate`-Wiederverwendung gegen gemischte Page-Namen (datiert/undatiert), Jahres- vs. Monats-Rückblick-Match.
- **Smoke:** Kafka-Seed ist kein Tagebuch → Kacheln dürfen nicht erscheinen, kein Alpine-Fehler (bestehender Smoke deckt Card-Open ab).
- **E2E** (optional): Fixture-Harness mit Tagebuch-Mock-Daten, prüft Render der drei Tiles + Klick auf Heatmap-Zelle → Karte öffnet mit Zeitraum.

## Edge-Cases

- **Keine datierten Einträge / Seitennamen nicht ISO:** Kacheln rendern nicht (x-if leer); Heatmap-Endpoint liefert leere `months`/`years` → Tile zeigt `.empty`-Hinweis statt leeres Raster.
- **Mehrere Einträge am selben Tag** (Seitennamen-Kollision/Suffix): Konsistenz-Zählung dedupliziert auf Tagesebene (ein Tag = ein Eintrag), analog Diary-Kalender.
- **DST/Jahreswechsel:** Datums-Arithmetik über Mittags-Anker (`T12:00:00`) statt Millisekunden-Math; Bucketing via `localIsoDate`/`tzOpts`.
- **`tokEsts` noch nicht befüllt** (lazy Backfill läuft): Σ-Zeichen im Wochentag-`data-tip` optional — Count + Existenz reichen; Memo invalidiert beim tokEsts-Reassign (gleicher Mechanismus wie Streak-Heatmap).
- **Rückblick für Zeitraum ohne Einträge** (Einträge nachträglich gelöscht): Zelle Level 0, aber Marker vorhanden → „verwaister" Rückblick bleibt sichtbar; Tooltip nennt 0 Einträge.
- **Sehr lange Tagebücher** (viele Jahre): Heatmap-Raster scrollt vertikal innerhalb des Tiles (max-height + overflow), nicht das ganze Overview-Grid sprengen.
- **Undatierte/teil-datierte Seiten** (nur Jahr ohne Monat): zählen in den Jahres-Bucket, nicht in einen Monat (`monthKey === null` → nur `years`).
- **Buchwechsel/Stale:** Coverage über bestehenden `_staleCheckBookId`-Guard + Reset in `resetBookOverview` schützen.
- **Locale-Spaltenköpfe** (Monatsnamen): via `Intl.DateTimeFormat(tag, tzOpts({ month: 'short' }))` wie bei den übrigen Overview-Charts.

## Kritische Dateien

- **Modify:**
  - [routes/history.js](../../routes/history.js) — neuer `GET /rueckblick-coverage/:book_id`.
  - [public/js/book-overview.js](public/js/book-overview.js) — `diaryMethods` importieren + spreaden.
  - [public/js/book-overview/load.js](../../public/js/book-overview/load.js) — Coverage-Fetch (nur Tagebuch) + Reset-Feld.
  - [public/js/book-overview/stats.js](../../public/js/book-overview/stats.js) — `overviewRueckblickHeatmap` + `_computeRueckblickHeatmap`.
  - [public/js/app/app-state.js](../../public/js/app/app-state.js) — `overviewRueckblickCoverage`-State.
  - [public/js/app/app-view.js](../../public/js/app/app-view.js) — `openRueckblickFor(zeitraum)`.
  - [public/js/cards/tagebuch-rueckblick-card.js](../../public/js/cards/tagebuch-rueckblick-card.js) — `rueckblick:select`-Listener.
  - [public/partials/bookoverview.html](public/partials/bookoverview.html) — Placeholder `partial-bookoverview-diary` + `partial-bookoverview-rueckblick-heatmap`.
  - Partial-Loader (Registrierung der neuen Partial-Dateien).
  - [public/index.html](public/index.html) — CSS-`<link>`s.
  - [public/sw.js](public/sw.js) — `SHELL_CACHE`-Bump.
  - [public/js/i18n/de.json](public/js/i18n/de.json) + [public/js/i18n/en.json](public/js/i18n/en.json) — `overview.diary.*` + `overview.rueckblickHeatmap.*`.
  - [public/js/app/app-hash-router.js](../../public/js/app/app-hash-router.js) — optionaler `#rueckblick:<zeitraum>`-Branch.
  - [DESIGN.md](DESIGN.md) — CSS-File-Inventar (+ ggf. neues Tile-/Heatmap-Pattern).
- **Create:**
  - `public/js/book-overview/diary.js`
  - `public/partials/bookoverview-diary.html`
  - `public/partials/bookoverview-rueckblick-heatmap.html`
  - `public/css/book-overview/diary.css`
  - `public/css/book-overview/rueckblick-heatmap.css`
  - `tests/unit/book-overview-diary.test.mjs`
  - `tests/unit/rueckblick-heatmap.test.mjs`

## Offene Fragen

Keine — der nicht-KI-Rückblick „vor einem Jahr heute" lebt in [tagebuch-an-diesem-tag.md](tagebuch-an-diesem-tag.md); die drei Kacheln hier sind entscheidungsfrei.
