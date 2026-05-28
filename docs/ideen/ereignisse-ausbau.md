# Ereignisse-Ausbau

- **Status:** Ready
- **Aufwand:** XL (Phasen 1–6; einzeln M–L)
- **Severity:** medium

## Context

Die Ereignisse-Karte (Zeitstrahl, [public/partials/ereignisse.html](../../public/partials/ereignisse.html), Daten via `zeitstrahl_events` + `figure_events`) zeigt heute eine lineare Liste, sortiert ausschliesslich nach `parseInt(datum)`. Mehrere Schwächen:

- **Datum-Parsing droppt Events stumm**: alles ohne führende Jahreszahl (`"Mai 1850"`, `"vor der Reise"`, `"Tag 3"`) fällt aus `parseInt(...)` raus und verschwindet aus der Anzeige.
- **Nur Punkt-Events**: keine Spannen (Krieg, Reise, Schwangerschaft) — Start+Ende lassen sich nicht abbilden.
- **`sort_order` in DB existiert, wird in der UI nicht verwendet** — bei mehreren Events im selben Jahr ist die Reihenfolge undefiniert.
- **Kein Handlungsstrang-Konzept**: Events sind nur Figuren zugeordnet, nicht Plot-Strängen (Haupt-/Nebenplot). Filter nach Strang fehlt.
- **`typ` nur `persoenlich|extern`** — keine Sub-Kategorien (Geburt/Tod/Wendepunkt/…); Färbung/Icon-Mapping nicht möglich.
- **Visualisierung flach**: Lineare Liste. Eine Swimlane-Sicht (Figur × Zeit) und ein Plot-Chart (Spannungsbogen) sind etablierte Tools für Autor:innen.
- **Inline-Edit fehlt**: Events sind nur AI-Output, indirekt über Figuren-Werkstatt editierbar; manuelles Hinzufügen einer Welt-Linie ist nicht vorgesehen.
- **Konflikt-Marker isoliert**: Kontinuitäts-Check schreibt Issues; auf dem Zeitstrahl tauchen sie nicht auf.
- **Multi-Kapitel-Goto greift nur das erste Kapitel** (`gotoStelle(kap, null)` mit `kap = ev.kapitel[0]`).

Produkt-Bezug: Ereignis-/Zeitstrahl-Werkzeuge sind ein Kerndifferenzierer gegenüber Standard-Schreibsoftware; aktuelle Karte schöpft das Potenzial nicht aus.

## Scope MVP

MVP = Phasen 1+2 (Datenmodell + Sub-Typen/Spannen). Phasen 3–6 als Folge-Iterationen mit eigenen Akzeptanzkriterien innerhalb dieses Plans, aber jeweils separat shipbar.

**Phase 1 — Datenmodell + Quick Wins**
- `zeitstrahl_events` erweitern: `datum_year INT`, `datum_month INT`, `datum_day INT`, `datum_ende_year INT`, `datum_ende_month INT`, `datum_ende_day INT`, `datum_label TEXT` (User-/AI-lesbarer Original-String), `story_tag INT` (relative Story-Zeit), `subtyp TEXT` (Whitelist, siehe Phase 2), `storyline_id INT NULL REFERENCES storylines(id) ON DELETE SET NULL`.
- Neue Tabelle `storylines (id, book_id FK CASCADE, name TEXT, farbe TEXT, sort_order INT, created_at, updated_at)`, UNIQUE(book_id, name).
- `figure_events` analog erweitern (Symmetrie zur Pre-Konsolidierungs-Quelle).
- Backend-Sortierung in `routes/figures.js#GET /zeitstrahl/:book_id`: `ORDER BY COALESCE(datum_year, 9999), COALESCE(datum_month, 99), COALESCE(datum_day, 99), sort_order` (Events ohne Jahr ans Ende, „unbekannt"-Bucket).
- Datum-Parser-Lib (`lib/datum-parse.js`) extrahiert `{year, month, day}` aus Freitext (Regex-Stufen, ohne KI). `prompts/komplett.js`-Schema fordert die strukturierten Felder bereits vom Modell — Parser ist Fallback für Legacy/manuelle Eingaben.
- Render-Pfad in `_reloadZeitstrahl()` joint Kapitel/Seite via FK (server-side, neue Spalten `chapter_name`/`page_name` aus JOIN — kein Snapshot in DB).
- `sort_order` als Tiebreaker im Frontend.
- `gotoStelle`-Bug: bei Multi-Kapitel-Event Dropdown statt erstes Element.

**Phase 2 — Sub-Typen + Spannen**
- `subtyp`-Whitelist in `prompt-config.json` pro Sprache: `geburt`, `tod`, `hochzeit`, `reise`, `konflikt`, `wendepunkt`, `entdeckung`, `verlust`, `sieg`, `extern_politisch`, `extern_natur`, `extern_kulturell`, `sonstiges`. Default `sonstiges`.
- Färbung via `--card-accent`-Variante pro Subtyp (Token in `public/css/tokens/colors.css`, Mapping in `public/css/entities/ereignisse-subtyp.css`).
- Icon-Mapping über Lucide-Sprite (vgl. [Lucide-Sprite](feedback_lucide_icons.md)).
- Spannen-Render: `<span class="gz-marker">` wird zu `<div class="gz-span">` mit `min-height` proportional zu Jahr-Differenz (CSS-Custom-Prop `--span-years`).
- Externe Welt-Events: eigener Layer/Lane oberhalb der Figur-Events (CSS-Grid-Row).

**Phase 3 — Inline-Edit + manueller Anlegen**
- Event-CRUD-Modal als `eventEditCard`-Komponente. CRUD-Endpoints: `POST/PUT/DELETE /figures/zeitstrahl/:book_id/events/:id?`.
- Storyline-CRUD: inline neben Filter-Bar (Combobox + „+ Strang"-Button öffnet Mini-Modal).
- Drag-to-reorder bei gleichem Jahr (mutiert `sort_order`). Lib: **SortableJS via `loadSortable()` aus `lazy-libs.js`** — dieselbe Lib wie Buchorganizer ([public/js/book-organizer/dnd.js](../../public/js/book-organizer/dnd.js)). Keine neue Dep.

**Phase 4 — Swimlane-Visualisierung**
- Toggle `viewMode: 'liste' | 'swimlane' | 'storyline'` (Tab-Strip in Karten-Header, persisted via `view_prefs`).
- Lazy-Lib: vis-network-Variante oder Custom-SVG (entscheidend: Performance bei 500+ Events).
- X-Achse: kontinuierlich (Jahr-Float) ODER ordinal (Story-Tag-Sequenz) — Toggle.
- Y-Achse: Figuren (Modus „swimlane") bzw. Storylines (Modus „storyline").

**Phase 5 — Konflikt-Marker**
- `continuity_issues` mit Bezug auf `zeitstrahl_event_id` (neue Spalte via Migration, FK SET NULL).
- Kontinuitäts-Job verlinkt erkannte Widersprüche auf Event-IDs.
- Frontend rendert Warn-Badge am betroffenen `gz-item` (Klick → Kontinuitäts-Karte mit Anker).

**Phase 6 — Plot-Chart**
- Spannungs-/Bogenkurve. `tension INT 0–10` an `zeitstrahl_events`; `subtyp=wendepunkt` markiert Hochpunkte.
- Chart via Chart.js (bereits lazy in `lazy-libs.js`).

## Out-of-Scope

- KI-getriebene automatische Plot-Strang-Erkennung (Phase 3 fordert manuelles Anlegen). Auto-Vorschlag ist eigener Plan.
- Drei-Achs-Visualisierungen (Zeit × Ort × Figur). Phase 4 bleibt auf zwei Achsen.
- Cross-Book-Timelines (Saga-übergreifend).
- Versionierung von Events (Undo-History pro Event).

## Done when

**MVP (Phase 1+2):**
- DB-Migration N angewendet, `foreign_key_check` clean, squashed-Schema regeneriert.
- Events mit Monat/Tag werden korrekt einsortiert; Events ohne Jahr landen sichtbar im „unbekannt"-Bucket statt zu verschwinden.
- Sub-Typen-Farben sichtbar; Spannen-Events haben sichtbare Höhe proportional zur Dauer.
- Unit-Test für `lib/datum-parse.js` deckt Legacy-Formate ab.
- E2E: Ereignisse-Karte rendert ohne Fehler bei Mix aus Punkten/Spannen/unbekannt-Bucket.
- `gotoStelle`-Multi-Kapitel-Bug behoben (Dropdown statt erstes Element).

**Phase 3:** Event/Storyline-CRUD aus UI nutzbar; manuelle Edits überleben Komplettanalyse-Re-Run (Schutz vor Merge-Overwrite via `manually_edited`-Flag).

**Phase 4:** Liste/Swimlane/Storyline-Toggle persistiert; > 500 Events ohne UI-Block (Lazy-Render oder Virtualisierung).

**Phase 5:** Konflikt-Badge am Event sichtbar; Klick scrollt zur Kontinuitäts-Karte auf den Issue.

**Phase 6:** Plot-Chart-Tab zeigt Spannungsbogen; manuelle `tension`-Werte überschreiben AI-Default.

## Hard-Rule-Audit

- **Editor-Spezifikation**: nicht betroffen (kein Editor).
- **UI-Patterns aus DESIGN.md**: betroffen (neue Subtyp-Badges, Tab-Strip, Spannen-Balken). Vor Bau: Pattern in DESIGN.md eintragen. Subtyp-Badge nutzt bestehendes Badge-Pattern (eckig, `var(--radius-sm)`). Tab-Strip in DESIGN.md prüfen (existiert für Graph 3 Modi).
- **Prompts unter `public/js/prompts/`**: betroffen. `prompts/komplett.js` ergänzt strukturierte Datum-Felder + Subtyp-Whitelist im Extraktions-Schema. **`PROMPTS_VERSION` bumpen** (invalidiert chapter/book-extract-cache).
- **KI-Calls nur via Job-Queue**: Phase 1 hat keinen neuen Job. Phase 3-Anlegen ist sync (CRUD ohne KI). Falls Phase 6 KI-gestützte Tension-Schätzung bekommt, neuer Job-Typ.
- **`callAI` gibt nur JSON**: betroffen (Komplett-Schema ändert). Schema-Validierung in `phases.js` ergänzen.
- **Styles nur in `public/css/`**: neue Datei `public/css/entities/ereignisse-subtyp.css`. In `public/index.html` `<link>` ergänzen. `SHELL_CACHE` bumpen.
- **UI-Strings nur in `i18n/{de,en}.json`**: alle Subtyp-Labels, Tab-Namen, Modal-Texte als Keys.
- **Content-Store-Facade**: nicht betroffen (Ereignisse sind nicht Page-Content).
- **Block-IDs**: nicht betroffen.
- **Page-Stats-Normalisierung**: nicht betroffen.
- **Job-Ergebnisse mit `updatedAt`**: nicht betroffen (kein positions-basierter Snapshot).
- **401-Handling**: zentral, nicht betroffen.
- **Logging-Context `book`**: betroffen — neue CRUD-Routen via `router.param('book_id', bookParamHandler)`.
- **`x-html` nur mit Escape**: keine neuen `x-html`-Sinks geplant; Subtyp-Label sind statische i18n-Keys.
- **A11y**: neue klickbare Spans bekommen `.internal-link`-Klasse.
- **Progress-Bars**: nicht betroffen.
- **Card-Animationen**: nicht betroffen (bestehende Karte).
- **`SHELL_CACHE`**: bumpen bei JS/CSS-Änderungen.
- **`sortableTable`**: Event-Liste in Modal (Phase 3) ggf. via `sortableTable`. Reine Timeline-Karte ist kein Tabellen-Layout.
- **Combobox statt `<select>`**: Storyline-Filter + Subtyp-Filter via `combobox`. Storyline-CRUD-Modal mit Color-Picker (eigenes Mini-Pattern, dann DESIGN.md).
- **`numInput` statt `type=number`**: Jahr-/Tension-Felder im Edit-Modal via `numInput` mit `integer: true, grouping: false` (Jahre).
- **LanguageTool auf Prosa-Feldern**: `ereignis`, `bedeutung`, Storyline-`name` bekommen `data-spellcheck="spelling"`.
- **File-Limits**: `ereignisse.js` (77 LOC) bleibt klein. Neue Datei `lib/datum-parse.js` < 200 LOC, `public/js/cards/event-edit-card.js` ggf. ab Phase 3.
- **Memo-Pattern**: `filteredEreignisse()` wird im Template mehrfach evaluiert. Aktuell Helper-Funktion; bei wachsender Komplexität (Subtyp-Filter, Storyline-Filter) auf `_memo`-Pattern umstellen.
- **State explizit deklariert**: neue Felder (`viewMode`, `selectedStorylineId`, Edit-Modal-State) als Initial-Felder in `ereignisseCard`.
- **Ein Attribut, eine Deklaration**: einhalten.
- **CSS: Selektor unique**: einhalten.
- **Mobile-Strategie**: Swimlane Phase 4 braucht Mobile-Plan (horizontaler Scroll? Kompakt-Modus?).
- **DB-Timestamps: ISO+Z**: alle neuen `*_at`-Defaults via `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`; alle INSERT/UPDATE via `${NOW_ISO_SQL}`.
- **Frontend-Datums-Display: `tzOpts()`**: betroffen, wo Events-Karte `updated_at` zeigt.

## Abhängigkeiten

- **Komplettanalyse-Pipeline**: Phase-1-DB-Schema erfordert Anpassung von `prompts/komplett.js` (Extraktions-Schema) und `routes/jobs/komplett/phases.js` (save-Pfad). `PROMPTS_VERSION` bumpen.
- **Kontinuitäts-Check** (Phase 5): braucht `continuity_issue_zeitstrahl_event_id`-Spalte + Verknüpfungs-Logik im Job.
- **Figuren-Werkstatt**: Lebensereignisse-Editor dort muss neue strukturierte Felder annehmen.
- **Hash-Router**: bei Tab-Wechsel (Phase 4) ggf. URL-Sub-State `#ereignisse/swimlane`.
- **Cache-Invalidierung**: bei DB-Schema-Change Migration löscht/migriert bestehende `zeitstrahl_events.datum`-Werte via Parser.

## Backend

**Phase 1**
- Anpassung `GET /figures/zeitstrahl/:book_id` ([routes/figures.js](../../routes/figures.js)): SELECT um neue Spalten erweitert; JOIN auf `chapters`/`pages` für Live-Namen; ORDER BY neu.
- `lib/datum-parse.js` (neu): `parseDatum(input: string): { year, month, day, label }` — Regex-Stufen für DE/EN-Monatsnamen, ISO-Form, Nur-Jahr, Story-Tag.
- Migration N: ALTER `zeitstrahl_events` ADD COLUMN je Feld; ALTER `figure_events` analog; CREATE TABLE `storylines`; CREATE INDEX `idx_zs_storyline ON zeitstrahl_events(storyline_id)`. Pre-Cleanup: aktuelle `datum`-Werte einmalig durch `parseDatum` schleusen + strukturierte Felder befüllen.

**Phase 2** — kein Backend-Change ausser Schema-Whitelist-Validation in `phases.js` (Subtyp-Default bei Unbekannt).

**Phase 3**
- `POST /figures/zeitstrahl/:book_id/events` — Anlegen.
- `PUT /figures/zeitstrahl/:book_id/events/:id` — Update; setzt `manually_edited=1`.
- `DELETE /figures/zeitstrahl/:book_id/events/:id` — Löschen.
- `POST /figures/zeitstrahl/:book_id/events/:id/figuren` + `DELETE …/figuren/:figure_id` — M:N-Pflege.
- Storylines: `GET/POST/PUT/DELETE /books/:book_id/storylines/:id?`.
- Komplettanalyse-Merge respektiert `manually_edited=1` (überschreibt nicht).

**Phase 4** — kein Backend.

**Phase 5**
- Migration: `continuity_issues` ADD `zeitstrahl_event_id INT REFERENCES zeitstrahl_events(id) ON DELETE SET NULL`.
- Kontinuitäts-Job: Mapping Issue → Event-ID via Datum+Ereignis-Lookup oder ID-Pass-Through aus Phase 1.

**Phase 6** — Hybrid (AI-Vorschlag + manueller Override):
- ALTER `zeitstrahl_events` ADD `tension INTEGER NULL`, ADD `tension_ai INTEGER NULL`, ADD `tension_manual INTEGER NULL`. Render-Pfad: `tension = COALESCE(tension_manual, tension_ai)`. Override-Erkennung via `tension_manual IS NOT NULL`.
- Neuer Job-Typ `tension-estimate` in `routes/jobs/tension-estimate.js`: extrahiert pro Event den Story-Kontext (Page-Texte aus den verknüpften `zeitstrahl_event_pages`) und ruft `callAI` mit Tension-Schema (0–10 INT + Begründung). Speichert in `tension_ai`. `manually_edited`-Flag bleibt unberührt.
- User-Edit setzt `tension_manual`; UI zeigt Indikator („AI-Vorschlag überschrieben"), Reset-Knopf nullt `tension_manual`.

## Frontend

**Phase 1**
- `public/js/book/ereignisse.js`: `_buildGlobalZeitstrahl()` nutzt strukturierte Felder statt `parseInt`. „Unbekannt"-Bucket sichtbar am Listen-Ende.
- `public/js/cards/ereignisse-card.js`: `filteredEreignisse()` zusätzlich nach Subtyp/Storyline filterbar. Tiebreaker via `sort_order`. Multi-Kapitel-Goto-Dropdown.

**Phase 2**
- Neue Subtyp-Combobox in der Filter-Bar.
- Render-Logik: Spannen-CSS-Klasse + Subtyp-Klasse am `gz-item`.

**Phase 3**
- Neue Sub-Komponente `eventEditCard` (Modal).
- Storyline-Mini-Modal (`storylineEditCard`) — Color-Picker + Name.
- Drag-to-reorder via SortableJS (bereits Dep? sonst lazy).

**Phase 4**
- Tab-Strip in `card-header`; `viewMode` persistiert in LocalStorage (Key `ereignisse.viewMode`), konsistent mit `sortableTable`-Persistenz. Kein DB-Sync.
- Swimlane-Render als eigene Datei `public/js/cards/ereignisse-swimlane.js` (lazy-load on first tab-click) auf Basis von **vis-timeline** (separates Modul der vis-Familie; via `lazy-libs.js#loadVisTimeline()` parallel zum bestehenden `loadVisNetwork()`).
- Storyline-View analog, gleicher Renderer mit anderem Group-Mapping (`group = storyline_id` statt `group = figure_id`).

**Phase 5** — Badge-Render am `gz-item` bei `ev.continuity_issue_id`.

**Phase 6** — Plot-Chart-Tab; Chart.js lazy.

**Card-Recipe-Schritte:** Ereignisse-Karte existiert bereits in `EXCLUSIVE_CARDS` + `FEATURES` — kein neuer Eintrag. Neue Modale (Event/Storyline-Edit) sind keine Top-Level-Karten, sondern Sub-Karten via Overlay-Pattern.

## CSS

Neue Dateien:
- `public/css/entities/ereignisse-subtyp.css` — Subtyp-Badge-Farben + Icon-Mapping.
- `public/css/entities/ereignisse-span.css` — Spannen-Balken-Layout.
- `public/css/entities/ereignisse-swimlane.css` (Phase 4).
- `public/css/entities/ereignisse-storyline.css` (Phase 4).

Token-Erweiterung in `public/css/tokens/colors.css`: pro Subtyp `--card-accent-event-<subtyp>`. Mapping in `public/css/card-accents.css` über Variant-Klasse.

Mobile-Breakpoints im selben Commit pro Datei (vgl. [Mobile-Breakpoints-Memory](../../public/js/cards/...) — Container-Query bevorzugt).

`SHELL_CACHE` in [public/sw.js](../../public/sw.js) bumpen.

DESIGN.md ergänzen: Subtyp-Badge-Pattern, Tab-Strip-Pattern (falls noch nicht vorhanden), Storyline-Color-Picker.

## i18n

Neue Key-Bereiche in beiden Locales (`public/js/i18n/{de,en}.json`):
- `events.subtyp.<key>` für alle Subtyp-Labels.
- `events.storyline.title`, `events.storyline.add`, `events.storyline.edit`, `events.storyline.delete`.
- `events.viewMode.liste`, `events.viewMode.swimlane`, `events.viewMode.storyline`, `events.viewMode.plot`.
- `events.unknownDate` für „unbekannt"-Bucket.
- `events.edit.title`, `events.edit.span`, `events.edit.tension`, `events.edit.save`, `events.edit.delete`, etc.
- `events.conflict.badge`, `events.conflict.openIssue`.

Server-seitig: neue Job-Status-Keys (`job.phase.tensionEstimate` Phase 6).

## DB

Migration N (Phase 1) — Recreate-Pattern für FK-Integrität:

1. `zeitstrahl_events` erweitern via Recreate (neue Spalten + neue FK auf `storylines`):
   - Spalten: `datum_year, datum_month, datum_day, datum_ende_year, datum_ende_month, datum_ende_day INTEGER NULL`; `datum_label TEXT`; `story_tag INTEGER NULL`; `subtyp TEXT DEFAULT 'sonstiges'`; `storyline_id INTEGER NULL REFERENCES storylines(id) ON DELETE SET NULL`; `manually_edited INTEGER NOT NULL DEFAULT 0`.
2. `figure_events` analog.
3. `storylines (id, book_id FK CASCADE, name UNIQUE per book, farbe, sort_order, created_at, updated_at)`.
4. Daten-Migration: aktuelle `datum`-TEXT-Werte einmalig durch `parseDatum` → strukturierte Felder befüllen. Original-String in `datum_label` mitlaufen. **Zusätzlich Lazy-Fallback** in `routes/figures.js#GET /zeitstrahl/:book_id`: liefert SELECT ein Event mit `datum_label IS NOT NULL AND datum_year IS NULL AND datum_month IS NULL AND datum_day IS NULL AND story_tag IS NULL` (Parser hat in der Migration nichts erkannt), läuft `parseDatum` erneut beim Read — fängt nachträglich verbesserte Parser-Regeln und manuell eingegebene Legacy-Strings (Phase 3 erlaubt Freitext-`datum_label` ohne strukturierte Felder).
5. Index `idx_zs_storyline ON zeitstrahl_events(storyline_id)`, `idx_zs_year ON zeitstrahl_events(datum_year)`, `idx_fe_storyline ON figure_events(storyline_id)`.
6. `foreign_key_check` Pflicht-Assert.
7. `schema_version` hochzählen.

Migration N+1 (Phase 5): `continuity_issues` ADD `zeitstrahl_event_id`.

Migration N+2 (Phase 6): `zeitstrahl_events` ADD `tension INTEGER`.

**Pflicht nach Migration**: `npm run squash:regen` + ERD ([docs/erd.md](../erd.md)) aktualisieren (Stand-Zeile, Blocks, FK-Kanten).

## Security

- Alle neuen Routen unter Auth-Guard (Standard).
- ACL-Check in `eventEditCard`-Endpoints: nur Owner/Editor des Buchs darf CRUD.
- `farbe` in `storylines` als Hex-Validierung (`/^#[0-9a-f]{6}$/i`) — sonst XSS-Vektor in CSS-Custom-Prop.
- `ereignis`/`bedeutung` über `escHtml()`, da im Template aktuell `x-text` gerendert wird; bleibt so.

## Telemetrie

Counter (exponiert über `/metrics`):
- `events_created_total{source="ai"|"manual"}`
- `events_edited_total`
- `storylines_total{book_id}`
- `events_unknown_date_total` (Anteil Events ohne Jahr — Datenqualitäts-Indikator)
- `events_view_mode_total{mode="liste"|"swimlane"|"storyline"|"plot"}`

## Reversibilität

- Phasen sind unabhängig deploybar; jede Phase ist additiv (neue Spalten nullable, neue Endpoints, neue Komponenten).
- Frontend-Feature-Flags pro Phase nicht nötig: alle neuen Spalten haben sinnvolle Defaults (`subtyp='sonstiges'`, `storyline_id=NULL`), UI degradiert sauber.
- Rollback: Migration via `DOWN`-Pfad theoretisch möglich, in der Praxis nur durch Restore eines DB-Backups vor der Migration (Pattern hier üblich — keine Down-Migrationen).
- DB-Felder ohne Konsumenten = totes Schema, aber kein Daten-Verlust.

## Tests

**Unit**
- `tests/unit/datum-parse.test.mjs` — Parser-Stufen für DE/EN-Monate, ISO, nur Jahr, Story-Tag, „unbekannt".
- `tests/unit/event-sort.test.mjs` — Sortierung mit strukturierten Feldern, Tiebreaker `sort_order`, „unbekannt"-Bucket ans Ende.
- `tests/unit/ereignisse-card-filter.test.mjs` — Subtyp-, Storyline-, Figur-, Kapitel-, Seiten-Filter kombiniert.

**Integration**
- `tests/integration/komplett-events-schema.test.js` — Komplettanalyse-Pipeline schreibt strukturierte Felder + Subtyp + Storyline-NULL.
- `tests/integration/event-crud.test.js` (Phase 3) — POST/PUT/DELETE, ACL.

**E2E**
- `tests/e2e/ereignisse.spec.js` — Karte rendert mit Mix aus Punkt/Span/unbekannt; Filter-Combobox; Modal-Edit (Phase 3); Tab-Wechsel (Phase 4).

## Edge-Cases

- **Event mit nur Monat ohne Jahr** (`"Mai"`) → `year=NULL, month=5`. Sortierung: ans Ende.
- **Spanne über Jahreswechsel** (`Dez 1849 – Mär 1850`) → korrekt anhand `datum_ende_*`.
- **Storyline gelöscht, während Events daran hängen** → `ON DELETE SET NULL`; UI rendert als „kein Strang".
- **Komplettanalyse-Re-Run überschreibt manuelle Edits**: `manually_edited=1` schützt Event vor Merge-Overwrite.
- **Subtyp aus KI nicht in Whitelist** → Default `sonstiges`, Log-Warn.
- **Migration auf grosser DB**: einmalige `parseDatum`-Pass über alle Bestands-Events kann dauern. Innerhalb der Transaktion akzeptabel (single-user-DB).
- **`datum_label` leer + alle structured-Felder NULL** → „unbekannt"-Bucket.
- **Mehrere Events mit identischem `(year, month, day, sort_order)`** → stabil via Insertion-Order (`id`-Tiebreaker).

## Kritische Dateien

**Modify:**
- [db/migrations.js](../../db/migrations.js)
- [db/squashed-schema.js](../../db/squashed-schema.js) (via `npm run squash:regen`)
- [docs/erd.md](../erd.md)
- [routes/figures.js](../../routes/figures.js)
- [routes/jobs/komplett/phases.js](../../routes/jobs/komplett/phases.js)
- [public/js/prompts/komplett.js](../../public/js/prompts/komplett.js) (Schema-Erweiterung + `PROMPTS_VERSION`-Bump in [public/js/prompts/core.js](../../public/js/prompts/core.js))
- [public/js/book/ereignisse.js](../../public/js/book/ereignisse.js)
- [public/js/cards/ereignisse-card.js](../../public/js/cards/ereignisse-card.js)
- [public/partials/ereignisse.html](../../public/partials/ereignisse.html)
- [public/css/tokens/colors.css](../../public/css/tokens/colors.css)
- [public/css/card-accents.css](../../public/css/card-accents.css)
- [public/index.html](../../public/index.html) (neue `<link>`-Tags)
- [public/sw.js](../../public/sw.js) (SHELL_CACHE)
- [public/js/i18n/de.json](../../public/js/i18n/de.json), [public/js/i18n/en.json](../../public/js/i18n/en.json)
- [DESIGN.md](../../DESIGN.md)

**Create:**
- `lib/datum-parse.js`
- `db/storylines.js`
- `public/css/entities/ereignisse-subtyp.css`
- `public/css/entities/ereignisse-span.css`
- `public/css/entities/ereignisse-swimlane.css` (Phase 4)
- `public/css/entities/ereignisse-storyline.css` (Phase 4)
- `public/js/cards/event-edit-card.js` (Phase 3)
- `public/js/cards/storyline-edit-card.js` (Phase 3)
- `public/js/cards/ereignisse-swimlane.js` (Phase 4)
- `public/js/cards/ereignisse-plot-chart.js` (Phase 6)
- `tests/unit/datum-parse.test.mjs`
- `tests/unit/event-sort.test.mjs`
- `tests/unit/ereignisse-card-filter.test.mjs`
- `tests/integration/komplett-events-schema.test.js`
- `tests/integration/event-crud.test.js` (Phase 3)
- `tests/e2e/ereignisse.spec.js`

## Offene Fragen

Keine.
