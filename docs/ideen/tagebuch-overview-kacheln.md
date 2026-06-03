# Tagebuch-Overview-Kacheln (Lücken & Konsistenz · Wochentag-Rhythmus)

- **Status:** Ready
- **Aufwand:** S
- **Severity:** low

## Context

Die Buch-Overview blendet bei `buchtyp === 'tagebuch'` die narrativen Analyse-Kacheln (Figuren-/Schauplatz-Matrix, Szenen-Wertung, Kapitel-Verteilung/-Findings) aus — sie sind für Ich-Perspektive-Tagebücher bedeutungslos. Dadurch entsteht Platz. Statt nur zu strippen sollen zwei Kacheln dazukommen, die zur eigentlichen Tagebuch-Achse passen: **Rhythmus und Konsistenz**. Das macht aus der gestrippten Roman-Overview ein echtes Tagebuch-Dashboard.

Der Rückblick „vor einem Jahr heute" lebt **nicht** hier, sondern als eigenes Feature in [tagebuch-rueckblick.md](tagebuch-rueckblick.md) (Kalender-Header-Panel, mehrere Vorjahre, Zeitraum-Suche). Bewusst dort konsolidiert, um die Resurfacing-Logik nicht an zwei Surfaces zu duplizieren.

Beide Kacheln sind **rückwärtsgewandt/auswertend** (kein generatives Schreiben in den Text) — konsistent mit der App-Philosophie „KI nur für Überwachung + Weltaufbau".

## Scope MVP

Zwei neue Kacheln, **exklusiv** sichtbar bei `overviewIsTagebuch()`:

- **Lücken & Konsistenz** — Tage seit letztem Eintrag, längste Lücke (Tage), aktuelle Tages-Streak (aufeinanderfolgende Tage mit Eintrag bis heute), Einträge diesen Monat vs. Vormonat.
- **Wochentag-Rhythmus** — Mo–So-Balken: Anzahl Einträge pro Wochentag (locale-abhängige Wochentags-Reihenfolge), Σ-Zeichen pro Wochentag als `data-tip`.

Datenbasis: ausschliesslich clientseitig vorhandene Quellen — `window.__app.pages` (Seitenname = ISO-Datum) + `window.__app.tokEsts` (Zeichen/Seite). **Kein neuer Endpoint.**

## Out-of-Scope

- **Rückblick „vor einem Jahr heute" / „An diesem Tag"** — eigenes Feature in [tagebuch-rueckblick.md](tagebuch-rueckblick.md) (Kalender-Header-Panel). Bewusst nicht als Overview-Kachel, um die Resurfacing-Logik nicht zu duplizieren.
- KI-Kacheln (Stimmungsverlauf, Themen-Wolke) — eigenes Feature, eigener Plan, eigener Job + Cache.
- Orte-Mini-Karte (Geo) — separat.
- Konfigurierbarkeit (welche Kacheln, Reihenfolge) — fix.
- Anwendung auf andere Buchtypen — bewusst tagebuch-only.

## Done when

- Bei einem Buch mit `buchtyp === 'tagebuch'` und datierten Einträgen erscheinen die zwei Kacheln im Overview-Grid; bei anderen Buchtypen erscheinen sie nie.
- „Lücken & Konsistenz" zeigt korrekte Tageswerte (verifiziert per Unit-Test gegen synthetische Datums-Sets inkl. Streak über Monatsgrenze).
- „Wochentag-Rhythmus" verteilt Einträge korrekt auf Wochentage (TZ-aware Parse, kein Off-by-one durch UTC).
- `npm test` grün; Smoke-Test (Kafka-Seed = kein Tagebuch) unverändert grün.

## Hard-Rule-Audit

- **Editor-Spezifikation:** n/a — keine Editor-Änderung.
- **i18n:** betroffen — neue Keys `overview.diary.*` in **beiden** Locale-Dateien (de = Fallback, en = Übersetzung). Wochentags-/Datumslabels via `Intl` + `tzOpts`, nicht hartcodiert.
- **CSS:** betroffen — neue Datei `public/css/book-overview/diary.css`; keine Inline-Styles. Bar-Visualisierung nutzt die `--progress`-Custom-Prop-Konvention bzw. das bestehende `.overview-*-bar`-Pattern (DESIGN.md prüfen, nicht neu erfinden). Mobile-Regeln im selben File (Container-Query, da Tile in variablem Grid-Slot). Registrierung: `<link>` in [public/index.html](public/index.html), `SHELL_CACHE`-Bump, DESIGN.md „CSS-File-Inventar".
- **Content-Store-Facade:** n/a — read-only, rein clientseitig aus bereits geladenem State.
- **DB-Integrität:** n/a — keine Migration, keine Tabelle.
- **Job-Queue / KI-Calls:** n/a — kein KI-Call.
- **`callAI` JSON-Only / truncated:** n/a.
- **x-html-Escape:** nicht betroffen — die Kacheln zeigen nur aggregierte Zahlen/Labels über `x-text` bzw. attribut-gebundenes `:data-tip` (Alpine-escaped), **keine** neuen `x-html`-Sinks.
- **Combobox / numInput / LanguageTool:** n/a — keine Eingabefelder.
- **sortableTable:** n/a — Wochentag-Rhythmus ist eine Bar-Visualisierung (7 feste Zeilen), keine sortierbare Datentabelle (Ausnahme analog Heatmap/Presence-Matrix).
- **Memo-Pattern (ein Helper pro Modul):** Compute-Methoden nutzen den bestehenden `this._memo` aus `loadMethods` (gemeinsamer `this._memos`-Speicher, gleiche Card-Instanz) — **kein** zweiter Helper. Pure Bodies als `_computeDiaryXxx` extrahiert (Alpine-frei testbar).
- **State explizit:** kein neues Card-State-Feld nötig (Kacheln sind Compute aus `window.__app.pages`); `overviewBuchtyp` existiert bereits.
- **Card-Animationen / Progress-Bars / Eckige Badges / Doppelpunkt-Separator / keine Icons / Swiss-Decimals / tzOpts+localIsoDate:** eingehalten.
- **SHELL_CACHE bumpen:** ja (JS + CSS + Partial).

## Abhängigkeiten

- Bestehendes Tagebuch-Gating: `overviewIsTagebuch()` + `overviewBuchtyp` ([public/js/book-overview/load.js](public/js/book-overview/load.js)) — bereits vorhanden.
- Seite↔Datum-Mechanik des Diary-Kalenders: dieselbe ISO-Datum-aus-Seitenname-Logik wie [public/js/book/diary-calendar.js](public/js/book/diary-calendar.js) (`diaryCalendarPagesMap`, Regex `^\d{4}-\d{2}-\d{2}`). Entry-Datum = **Seitenname**, nicht `updated_at` (User kann Einträge rückdatieren).
- TZ-Helper: `localIsoDate` / `tzOpts` aus [public/js/utils.js](public/js/utils.js).

## Backend

n/a — keine neuen Routen/Jobs/Libs. Genutzte (bestehende) Quellen: `window.__app.pages`, `window.__app.tokEsts`. `/history/page-stats/:bookId` wird bereits geladen; kein zusätzlicher Call.

## Frontend

Neue Methodengruppe `diaryMethods` in **neuer Datei** `public/js/book-overview/diary.js`, re-exportiert in der Facade [public/js/book-overview.js](public/js/book-overview.js) (spread in `bookOverviewMethods`). Methoden (jeweils memoized via `this._memo` mit deps `[window.__app.pages, app.tokEsts]`):

- `diaryGapsConsistency()` → `{ daysSinceLast, longestGap, currentStreak, entriesThisMonth, entriesPrevMonth }`. Aus sortiertem Datums-Set der Tagebuch-Einträge.
- `diaryWeekdayRhythm()` → `[{ weekday, count, chars, pct }]` in locale-Reihenfolge (Mo-first de, Sun-first en via `Intl`).
- Pure Bodies extrahiert als `_computeDiaryGapsConsistency(dates, todayIso)` / `_computeDiaryWeekdayRhythm(dates, tokEsts, …)` (Test-Einstieg ohne Alpine).
- Helper `_diaryEntryDates(pages)` → sortierte `YYYY-MM-DD`-Liste (Regex-Filter auf Seitenname), gemeinsam genutzt.

Partial: **eine** neue Datei `public/partials/bookoverview-diary.html` mit zwei `<template x-if="overviewIsTagebuch() && …">`-Tiles. Placeholder `<div id="partial-bookoverview-diary"></div>` in [public/partials/bookoverview.html](public/partials/bookoverview.html), platziert direkt nach `partial-bookoverview-charts` (Schreibstats-/Rhythmus-Cluster zusammen). Loader-Registrierung analog der übrigen `bookoverview-*`-Partials.

Keine Card-Recipe-Schritte (Registry/Hash-Router/Exklusivität) nötig — die Kacheln leben in der bestehenden `bookOverviewCard`.

## CSS

Neue Datei `public/css/book-overview/diary.css`:
- `.overview-consistency-*` (Kennzahlen-Grid: Wert + Label).
- `.overview-weekday-*` (7 Balken; `--progress`-Konvention bzw. Reuse `.overview-chapter-bar-*`).
- Akzentfarbe: bestehende `--card-accent` der Overview (keine neue Hue).
- Mobile via Container-Query (Tile in variablem Grid-Slot).
- Pflicht-Folgeschritte: `<link>` in [public/index.html](public/index.html), `SHELL_CACHE`-Bump in [public/sw.js](public/sw.js), Eintrag in [DESIGN.md](DESIGN.md) „CSS-File-Inventar".

## i18n

Neuer Key-Bereich `overview.diary.*` in [public/js/i18n/de.json](public/js/i18n/de.json) + [public/js/i18n/en.json](public/js/i18n/en.json):
- `overview.diary.consistency` (Label), `…daysSinceLast`, `…longestGap`, `…currentStreak`, `…thisMonth`, `…prevMonth`, Einheiten `…unit.days`, `…unit.entries`
- `overview.diary.weekday` (Label), `…weekdayTip` (Σ-Zeichen-Tooltip mit `{chars}`)

Wochentags-Namen + Datumsformat über `Intl.DateTimeFormat` mit `tzOpts`, nicht als statische Keys.

## DB

n/a.

## Security

Auth-Scope unverändert (Overview liegt hinter Session-Guard + ACL des Buchs). Keine neuen Endpoints, kein PII-Transfer. Seitennamen/Anrisse via `x-text`/escaped Attribute — kein `x-html`.

## Telemetrie

n/a (keine neue Metrik). Optional Phase 2: Usage-Tracking, falls relevant — nicht im MVP.

## Reversibilität

Vollständig additiv und client-seitig. Ausbau = `diaryMethods`-Import + Partial-Placeholder + CSS-`<link>` entfernen, `SHELL_CACHE` bumpen. Keine Daten-Migration, kein Schema-Rückbau. Kein Feature-Flag nötig (Gating bereits über `overviewIsTagebuch()`).

## Tests

- **Unit** (`tests/unit/book-overview-diary.test.mjs`, neu): `_computeDiaryGapsConsistency`, `_computeDiaryWeekdayRhythm` gegen synthetische Datums-/tokEsts-Sets. Abdeckung: leeres Set, einzelner Eintrag, Streak über Monats-/Jahresgrenze, Lücke korrekt, kein Off-by-one beim Wochentag (TZ-aware).
- **Smoke**: Kafka-Seed ist kein Tagebuch → Kacheln dürfen nicht erscheinen, kein Alpine-Fehler (bestehender Smoke deckt Card-Open ab).
- **E2E** (optional): Fixture-Harness mit Tagebuch-Mock-Daten, prüft Render der drei Tiles. Nur falls Aufwand vertretbar.

## Edge-Cases

- **Keine datierten Einträge / Seitennamen nicht ISO**: Kacheln rendern nicht (x-if leer) — wie die bestehenden Daten-abhängigen Tiles.
- **Mehrere Einträge am selben Tag** (Seitennamen-Kollision/Suffix): Konsistenz-Zählung dedupliziert auf Tagesebene (ein Tag = ein Eintrag), analog Diary-Kalender.
- **DST/Jahreswechsel**: Datums-Arithmetik über Mittags-Anker (`T12:00:00`) statt Millisekunden-Math; Bucketing via `localIsoDate`/`tzOpts`.
- **`tokEsts` noch nicht befüllt** (lazy Backfill läuft): Σ-Zeichen im Wochentag-`data-tip` optional — Count + Existenz reichen für Render; Memo invalidiert beim tokEsts-Reassign (gleicher Mechanismus wie Streak-Heatmap).

## Kritische Dateien

- **Modify:**
  - [public/js/book-overview.js](public/js/book-overview.js) — `diaryMethods` importieren + spreaden
  - [public/partials/bookoverview.html](public/partials/bookoverview.html) — Placeholder `partial-bookoverview-diary`
  - Partial-Loader (Registrierung der neuen Partial-Datei)
  - [public/index.html](public/index.html) — CSS-`<link>`
  - [public/sw.js](public/sw.js) — `SHELL_CACHE`-Bump
  - [public/js/i18n/de.json](public/js/i18n/de.json) + [public/js/i18n/en.json](public/js/i18n/en.json) — `overview.diary.*`
  - [DESIGN.md](DESIGN.md) — CSS-File-Inventar (+ ggf. neues Tile-Pattern dokumentieren)
- **Create:**
  - `public/js/book-overview/diary.js`
  - `public/partials/bookoverview-diary.html`
  - `public/css/book-overview/diary.css`
  - `tests/unit/book-overview-diary.test.mjs`

## Offene Fragen

Keine — der Rückblick-Teil wurde nach [tagebuch-rueckblick.md](tagebuch-rueckblick.md) konsolidiert; die verbleibenden zwei Kacheln sind entscheidungsfrei.
