# Ereignisse-Ausbau

- **Status:** In Progress — Phase 1+2 erledigt (Commit b2580922 + Folge-Detail-Commits), Phase 3–6 offen
- **Aufwand:** L (Phase 3 niedrige Prio; Phase 4–6 je M–L)
- **Severity:** low (Grundfunktionalität trägt; offene Phasen sind Komfort/Visualisierung)

## Context

Die Ereignisse-Karte (Zeitstrahl, [public/partials/ereignisse.html](../../public/partials/ereignisse.html), Daten via `zeitstrahl_events` + `figure_events`) hat mit Phase 1+2 strukturierte Datum-Felder (`datum_year/month/day` plus `datum_ende_*`), Sub-Typen mit Farben/Icons, Spannen-Layout, einen „unbekannt"-Bucket für Fuzzy-Daten und Multi-Kapitel-Goto. Backend-Sortierung in [routes/figures.js](../../routes/figures.js#L?) sortiert deterministisch nach `(datum_year, datum_month, datum_day, sort_order)`; KI liefert die strukturierten Felder direkt im Komplettanalyse-Schema. Storylines-Tabelle ist angelegt (`storylines`, FK SET NULL), aber noch ohne UI.

Verbleibende Schwächen:

- **Kein Handlungsstrang-UI**: Schema (`storyline_id` FK SET NULL auf `storylines`) liegt vor; Filter/Edit/Visualisierung fehlt.
- **Visualisierung flach**: Lineare Liste. Eine Swimlane-Sicht (Figur × Zeit) und ein Plot-Chart (Spannungsbogen) sind etablierte Tools für Autor:innen.
- **Inline-Edit fehlt**: Events sind reiner KI-Output, manuelles Hinzufügen einer Welt-Linie ist nicht vorgesehen. **Niedrige Priorität** — manuelle Events bleiben Edge-Case im KI-driven Workflow; `manually_edited`-Flag ist im Schema, Phase 3 entscheidet, wie viel Edit-UI sich lohnt.
- **Konflikt-Marker isoliert**: Kontinuitäts-Check schreibt Issues; auf dem Zeitstrahl tauchen sie nicht auf.
- **Legacy-toter-Code in [routes/jobs/komplett/remap.js:81+84](../../routes/jobs/komplett/remap.js#L81): `ev.datum` wird gelesen (existiert seit Phase 1 nicht mehr im KI-Output) → Dedup-Key kollabiert auf `ereignis.toLowerCase()`, Sort ist No-Op (`parseInt(undefined)` → 0). Aufräumen.**

Produkt-Bezug: Ereignis-/Zeitstrahl-Werkzeuge sind ein Kerndifferenzierer gegenüber Standard-Schreibsoftware; mit Phase 1+2 ist die Basis tragfähig, Phase 4 (Swimlane) hebt das nochmal sichtbar.

## Scope MVP

MVP (Phase 1+2) ist erledigt. Verbleibend: Phasen 3–6 als separat shipbare Folge-Iterationen. Reihenfolge nach Wert/Aufwand: **4 vor 5 vor 6 vor 3** (Phase 3 ist niedrig priorisiert, weil manuelle Events im KI-driven Workflow Edge-Case bleiben).

**Phase 3 — Inline-Edit + manueller Anlegen** (niedrige Priorität, evtl. komplett verworfen)
- Event-CRUD-Modal als `eventEditCard`-Komponente. CRUD-Endpoints: `POST/PUT/DELETE /figures/zeitstrahl/:book_id/events/:id?`.
- Storyline-CRUD: inline neben Filter-Bar (Combobox + „+ Strang"-Button öffnet Mini-Modal). Auch ohne Phase 3 vorerst möglich, weil Storyline-Tabelle existiert — KI könnte Strang-Zuordnung selbst übernehmen (siehe Out-of-Scope).
- Drag-to-reorder bei gleichem Jahr (mutiert `sort_order`). Lib: **SortableJS via `loadSortable()` aus `lazy-libs.js`** — dieselbe Lib wie Buchorganizer ([public/js/book-organizer/dnd.js](../../public/js/book-organizer/dnd.js)). Keine neue Dep.
- **Entscheidungsfrage** (siehe Offene Fragen): Wie viel Edit-UI lohnt sich, wenn Re-Run der Komplettanalyse die Quelle der Wahrheit bleibt? `manually_edited=1` schützt vor Overwrite, aber der User muss dann zwei Welten pflegen.

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

- KI-getriebene automatische Plot-Strang-Erkennung (Storyline-Zuordnung im KI-Output). Sobald Phase 4 Swimlane braucht, müsste das eigentlich rein — aktuell aber bewusst raus, weil unklar ist, ob die KI Stränge zuverlässig identifizieren kann. Eigener Plan, falls Phase 4 darauf angewiesen ist.
- Drei-Achs-Visualisierungen (Zeit × Ort × Figur). Phase 4 bleibt auf zwei Achsen.
- Cross-Book-Timelines (Saga-übergreifend).
- Versionierung von Events (Undo-History pro Event).

## Done when

**Phase 3** (optional): Event/Storyline-CRUD aus UI nutzbar; manuelle Edits überleben Komplettanalyse-Re-Run (`manually_edited=1` ist schon im Schema, Code-Pfad in `updateFigurenEvents` schützt bereits per `DELETE … WHERE manually_edited = 0`).

**Phase 4:** Liste/Swimlane/Storyline-Toggle persistiert; > 500 Events ohne UI-Block (Lazy-Render oder Virtualisierung).

**Phase 5:** Konflikt-Badge am Event sichtbar; Klick scrollt zur Kontinuitäts-Karte auf den Issue.

**Phase 6:** Plot-Chart-Tab zeigt Spannungsbogen; manuelle `tension`-Werte überschreiben AI-Default (oder bleibt rein KI-getrieben, siehe Offene Fragen).

**Cleanup** (Mini-Aufgabe, jederzeit): toter `parseInt(ev.datum)`-Sort + `ev.datum`-Dedup-Key in [routes/jobs/komplett/remap.js:81+84](../../routes/jobs/komplett/remap.js#L81) entfernen — `ev.datum` existiert seit Phase 1 nicht mehr im KI-Output, Dedup-Key auf `(year, month, day, ereignis.toLowerCase())` umstellen.

## Hard-Rule-Audit

Phase 1+2 wurden gegen die Hard-Rules implementiert; verbleibend für Phasen 3–6:

- **Editor-Spezifikation**: nicht betroffen.
- **UI-Patterns aus DESIGN.md**: Tab-Strip (Phase 4) prüfen — existiert für Graph 3 Modi. Storyline-Color-Picker als neues Mini-Pattern dokumentieren (Phase 3).
- **Prompts**: Phase 6 (Tension-Schätzung) ergänzt eigenes Schema — `PROMPTS_VERSION` bumpen. Phase 4 ohne Prompt-Change, ausser Storyline-Auto-Erkennung kommt rein (siehe Out-of-Scope).
- **KI-Calls nur via Job-Queue**: Phase 3-CRUD ist sync. Phase 6 (Tension) braucht neuen Job-Typ `tension-estimate`.
- **`callAI` gibt nur JSON**: Phase 6 ergänzt Schema-Validierung.
- **Styles nur in `public/css/`**: neue Dateien für Swimlane (P4) + Plot-Chart (P6). `SHELL_CACHE` bumpen.
- **UI-Strings nur in `i18n`**: alle neuen Keys (Tab-Namen, Modal-Texte, Plot-Achsen) in beiden Locales.
- **Logging-Context `book`**: neue Phase-3-CRUD-Routen via `router.param('book_id', bookParamHandler)`.
- **A11y**: neue klickbare Spans (Konflikt-Badge P5) bekommen `.internal-link`.
- **`sortableTable`**: Event-Liste in P3-Modal ggf. via `sortableTable`. Timeline selbst ist kein Tabellen-Layout.
- **Combobox statt `<select>`**: Storyline-Filter (P3+P4) via `combobox`.
- **`numInput` statt `type=number`**: Jahr-/Tension-Felder im P3-Edit-Modal mit `integer: true, grouping: false`.
- **LanguageTool**: `ereignis`, `bedeutung`, Storyline-`name` (P3) bekommen `data-spellcheck="spelling"`.
- **Memo-Pattern**: `filteredEreignisse()` läuft schon über `_memoFiltered`. Bei weiteren Filtern (Storyline P3) Deps erweitern.
- **State explizit deklariert**: neue Felder (`viewMode` P4, `selectedStorylineId`, Edit-Modal-State P3) als Initial-Felder in `ereignisseCard`.
- **Mobile-Strategie**: Swimlane P4 braucht Mobile-Plan (horizontaler Scroll? Kompakt-Modus?).
- **DB-Timestamps: ISO+Z**: für P5/P6-Migrationen via `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`.

## Abhängigkeiten

- **Kontinuitäts-Check** (Phase 5): braucht `continuity_issues.zeitstrahl_event_id`-Spalte + Verknüpfungs-Logik im Job.
- **Figuren-Werkstatt**: Lebensereignisse-Editor dort konsumiert die strukturierten Felder bereits (Phase 1 hat das angepasst); P3-Inline-Edit muss dieselbe Schreib-Pfad-Invariante einhalten (`manually_edited=1` setzen).
- **Hash-Router**: bei Tab-Wechsel (Phase 4) ggf. URL-Sub-State `#ereignisse/swimlane`.
- **Storyline-KI-Zuordnung** (Out-of-Scope-Frage): falls Phase 4 ohne Storylines wertlos wirkt, muss vorher entschieden werden, ob die Strang-Zuordnung in `prompts/komplett.js` ergänzt wird → `PROMPTS_VERSION` bumpen.

## Backend

**Cleanup (jederzeit, klein):** [routes/jobs/komplett/remap.js:81+84](../../routes/jobs/komplett/remap.js#L81) — `ev.datum`-basierter Dedup-Key + `parseInt(ev.datum)`-Sort streichen. `ev.datum` ist seit Phase 1 nicht mehr im KI-Output, beide Stellen sind tot. Dedup-Key auf `(ev.datum_year, ev.datum_month, ev.datum_day, ev.ereignis.toLowerCase())` umstellen. Sortierung dort komplett raus — `updateFigurenEvents` schreibt `sort_order = j` (Schleifen-Index = KI-Reihenfolge), DB-Lesepfad sortiert per ORDER BY auf strukturierten Feldern.

**Phase 3**
- `POST /figures/zeitstrahl/:book_id/events` — Anlegen, setzt `manually_edited=1`.
- `PUT /figures/zeitstrahl/:book_id/events/:id` — Update, setzt `manually_edited=1`.
- `DELETE /figures/zeitstrahl/:book_id/events/:id` — Löschen.
- `POST /figures/zeitstrahl/:book_id/events/:id/figuren` + `DELETE …/figuren/:figure_id` — M:N-Pflege.
- Storylines: `GET/POST/PUT/DELETE /books/:book_id/storylines/:id?`.
- Komplettanalyse-Merge respektiert `manually_edited=1` bereits in [db/figures.js](../../db/figures.js#L155) (DELETE-Pfad in `updateFigurenEvents`) und [db/schema.js](../../db/schema.js#L120) (zeitstrahl-events).

**Phase 4** — kein Backend, ausser KI-Storyline-Zuordnung wird beschlossen (dann Schema-Erweiterung in `prompts/komplett.js`).

**Phase 5**
- Migration: `continuity_issues` ADD `zeitstrahl_event_id INT REFERENCES zeitstrahl_events(id) ON DELETE SET NULL`.
- Kontinuitäts-Job: Mapping Issue → Event-ID via Datum+Ereignis-Lookup oder ID-Pass-Through aus Phase 1.

**Phase 6** — gemäss „KI-driven, manuell = Edge-Case" eher rein-KI:
- ALTER `zeitstrahl_events` ADD `tension INTEGER NULL`. Render-Pfad: `tension` direkt aus DB.
- Neuer Job-Typ `tension-estimate` in `routes/jobs/tension-estimate.js`: extrahiert pro Event den Story-Kontext (Page-Texte aus den verknüpften Kapiteln/Seiten) und ruft `callAI` mit Tension-Schema (0–10 INT + Begründung).
- Re-Run der Komplettanalyse überschreibt `tension` standardmässig (KI-driven). Wenn manueller Override gebraucht wird, dann analog zu `manually_edited` Pattern (`tension_manual` separat).
- Manuelles Override-UI ist optional und folgt der Phase-3-Edge-Case-Logik.

## Frontend

**Phase 3**
- Neue Sub-Komponente `eventEditCard` (Modal).
- Storyline-Mini-Modal (`storylineEditCard`) — Color-Picker + Name.
- Drag-to-reorder via SortableJS (bereits Dep — siehe `lazy-libs.js#loadSortable()`).

**Phase 4**
- Tab-Strip in `card-header`; `viewMode` persistiert in LocalStorage (Key `ereignisse.viewMode`), konsistent mit `sortableTable`-Persistenz. Kein DB-Sync.
- Swimlane-Render als eigene Datei `public/js/cards/ereignisse-swimlane.js` (lazy-load on first tab-click) auf Basis von **vis-timeline** (separates Modul der vis-Familie; via `lazy-libs.js#loadVisTimeline()` parallel zum bestehenden `loadVisNetwork()`).
- Storyline-View analog, gleicher Renderer mit anderem Group-Mapping (`group = storyline_id` statt `group = figure_id`).

**Phase 5** — Badge-Render am `gz-item` bei `ev.continuity_issue_id`.

**Phase 6** — Plot-Chart-Tab; Chart.js lazy.

**Card-Recipe-Schritte:** Ereignisse-Karte existiert bereits in `EXCLUSIVE_CARDS` + `FEATURES` — kein neuer Eintrag. Neue Modale (Event/Storyline-Edit) sind keine Top-Level-Karten, sondern Sub-Karten via Overlay-Pattern.

## CSS

Verbleibend für Phase 4:
- `public/css/entities/ereignisse-swimlane.css`.
- `public/css/entities/ereignisse-storyline.css`.

`SHELL_CACHE` in [public/sw.js](../../public/sw.js) bei jeder JS/CSS-Änderung bumpen.

DESIGN.md ergänzen (Phase 3+4): Storyline-Color-Picker-Pattern, Tab-Strip-Pattern (prüfen, ob Graph-3-Modi-Pattern wiederverwendbar ist).

## i18n

Phase 1+2-Keys (`events.subtyp.*`, `events.unknownDate`) sind drin. Verbleibend in beiden Locales (`public/js/i18n/{de,en}.json`):

- `events.storyline.title`, `events.storyline.add`, `events.storyline.edit`, `events.storyline.delete` (Phase 3).
- `events.viewMode.liste`, `events.viewMode.swimlane`, `events.viewMode.storyline`, `events.viewMode.plot` (Phase 4).
- `events.edit.title`, `events.edit.span`, `events.edit.tension`, `events.edit.save`, `events.edit.delete`, … (Phase 3).
- `events.conflict.badge`, `events.conflict.openIssue` (Phase 5).

Server-seitig: neuer Job-Status-Key `job.phase.tensionEstimate` (Phase 6).

## DB

Migration 156 (Phase 1) ist appliziert: `zeitstrahl_events` + `figure_events` mit `datum_year/month/day`, `datum_ende_*`, `datum_label`, `story_tag`, `subtyp`, `storyline_id` FK SET NULL, `manually_edited`. `storylines`-Tabelle existiert. Indexe gesetzt.

Verbleibende Migrationen:

- **Phase 5:** `continuity_issues` ADD `zeitstrahl_event_id INTEGER REFERENCES zeitstrahl_events(id) ON DELETE SET NULL`.
- **Phase 6:** `zeitstrahl_events` ADD `tension INTEGER NULL` (optional `tension_manual` für Override-Pattern, siehe Backend Phase 6).

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

Bereits vorhanden:
- `tests/unit/datum-parse.test.mjs` — Parser-Stufen.
- `tests/unit/event-sort.test.mjs` — Sortierung mit strukturierten Feldern, Tiebreaker `sort_order`, „unbekannt"-Bucket ans Ende.
- `tests/unit/ereignisse-card-filter.test.mjs` — Subtyp-/Storyline-/Figur-/Kapitel-/Seiten-Filter kombiniert (uncommitted, gemäss git status).
- `tests/integration/komplett-events-schema.test.js` — Komplettanalyse-Pipeline schreibt strukturierte Felder + Subtyp + Storyline-NULL (uncommitted).
- `tests/e2e/ereignisse.spec.js` — Karte rendert mit Mix aus Punkt/Span/unbekannt; Filter-Combobox (uncommitted).

Verbleibend pro Phase:
- **Phase 3:** `tests/integration/event-crud.test.js` — POST/PUT/DELETE, ACL.
- **Phase 4:** E2E-Erweiterung um Tab-Wechsel + Swimlane-Render.
- **Phase 5:** Integration: Kontinuitäts-Job verlinkt korrekt auf `zeitstrahl_event_id`.
- **Phase 6:** Integration: `tension-estimate`-Job schreibt 0–10-INT.

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

Verbleibend für Phasen 3–6.

**Modify:**
- [routes/jobs/komplett/remap.js](../../routes/jobs/komplett/remap.js) (Cleanup tote `datum`-Pfade, jederzeit machbar)
- [db/migrations.js](../../db/migrations.js) (Phase 5 + 6)
- [db/squashed-schema.js](../../db/squashed-schema.js) (via `npm run squash:regen` nach jeder neuen Migration)
- [docs/erd.md](../erd.md) (nach jeder Migration)
- [routes/figures.js](../../routes/figures.js) (Phase 3 CRUD-Routen)
- [routes/jobs/komplett/phases.js](../../routes/jobs/komplett/phases.js) (Phase 5: Konflikt-Mapping)
- [public/js/cards/ereignisse-card.js](../../public/js/cards/ereignisse-card.js) (Phase 4 ViewMode, Phase 5 Konflikt-Badge)
- [public/partials/ereignisse.html](../../public/partials/ereignisse.html) (Phase 4 Tab-Strip)
- [public/sw.js](../../public/sw.js) (SHELL_CACHE bei jeder Phase)
- [public/js/i18n/de.json](../../public/js/i18n/de.json), [public/js/i18n/en.json](../../public/js/i18n/en.json)
- [DESIGN.md](../../DESIGN.md) (Tab-Strip + Color-Picker-Pattern, wenn Phase 3/4 startet)

**Create:**
- `public/css/entities/ereignisse-swimlane.css` (Phase 4)
- `public/css/entities/ereignisse-storyline.css` (Phase 4)
- `public/js/cards/event-edit-card.js` (Phase 3)
- `public/js/cards/storyline-edit-card.js` (Phase 3)
- `public/js/cards/ereignisse-swimlane.js` (Phase 4)
- `public/js/cards/ereignisse-plot-chart.js` (Phase 6)
- `routes/jobs/tension-estimate.js` (Phase 6)
- `tests/integration/event-crud.test.js` (Phase 3)

## Offene Fragen

1. **Sortier-Strategie für Fuzzy-Daten und Ties.** Aktuell sortiert [routes/figures.js](../../routes/figures.js) `ORDER BY datum_year, datum_month, datum_day, sort_order`. Bei NULL-Feldern (`"Frühling 1985"` → year=1985, month=NULL) oder identischen strukturierten Werten greift `sort_order`, gesetzt als Schleifen-Index in `updateFigurenEvents` ([db/figures.js:191](../../db/figures.js#L191)) = KI-Output-Reihenfolge. Optionen:
   - **Status quo:** Lassen wie es ist; KI-Reihenfolge entscheidet bei Ties. Genug, wenn die KI Events ohnehin grob narrativ/chronologisch ausgibt.
   - **KI sortiert explizit:** Prompt-Anweisung in [public/js/prompts/komplett.js](../../public/js/prompts/komplett.js) ergänzen: „`lebensereignisse` chronologisch sortieren (frühestes zuerst); bei unscharfen Daten (`Frühling 1985`, `nach dem Krieg`) Position so wählen, wie es im Lebenslauf der Figur stimmig ist." `sort_order` (= Schleifen-Index) reflektiert dann die KI-Chronologie. **Empfehlung**, weil günstig (keine Schema-/Code-Änderung ausser Prompt + `PROMPTS_VERSION`-Bump) und konsistent mit dem „KI-driven, manuell = Edge-Case"-Leitbild.
   - **Server-Parser für Fuzzy-Monate:** `lib/datum-parse.js` um Heuristik erweitern (`Frühling → month=4`, `Sommer → month=7`, …). Riskant bei Genre-/Sprach-Drift; ergänzt sich aber mit Option B.
   - **Separates Schema-Feld (`datum_sort_iso`):** Über-Engineering, wenn manuelle Edits selten sind.

2. **Phase 3 ganz verwerfen?** Im KI-driven Workflow ist die zentrale Frage: Welche Mehrwerte hat ein Inline-Edit über der nächsten Komplettanalyse? Vorschlag — Phase 3 zurückstellen bis ein konkreter User-Pain-Point auftaucht („KI bekommt Event X partout nicht richtig hin"). Wenn Phase 3 nur Storyline-Pflege braucht, reicht ein minimales Storyline-CRUD ohne Event-Edit.

3. **Storyline-Quelle.** Phase 4 (Swimlane/Storyline-View) ist ohne befüllte Storylines wertlos. Entweder Phase 3 priorisieren (manuelle Anlage) **oder** die KI in Phase 1+2 erweitern, sodass sie Stränge selbst identifiziert + zuordnet (Out-of-Scope-Punkt aufheben). Letzteres passt zum KI-driven Leitbild, ist aber unsicher in der Trefferquote.

4. **Tension-Override-Pattern in Phase 6.** Falls Phase 6 kommt: rein KI-getrieben (`tension` direkt) oder Hybrid (`tension_ai` + `tension_manual` mit `COALESCE`)? Gemäss Leitbild eher KI-only; Hybrid nur, wenn Phase 3 ohnehin Edit-UI bekommt.
