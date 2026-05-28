# Szenen-Board & -Grid (Corkboard / Matrix über extrahierte Szenen)

- **Status:** Draft
- **Aufwand:** M
- **Severity:** medium

## Context

Szenen werden bereits aus dem fertigen Text **extrahiert** und liegen in `figure_scenes` (`titel`, `wertung`, `kommentar`, `sort_order`, `chapter_id`, `page_id`) plus den Bridge-Tabellen `scene_figures` und `scene_locations`. Aktuelle Sicht: nur Liste/Übersicht in der Szenen-Karte ([public/partials/szenen.html](../../public/partials/szenen.html), GET `/figures/scenes/:book_id` in [routes/figures.js](../../routes/figures.js); liefert bereits `fig_ids` + `ort_ids` pro Szene).

Plottr/Scrivener-Corkboard zeigen Szenen als **verschiebbare Karten** auf einem Board und als **Matrix/Grid** (Zeile = Szene, Spalte = Attribut). Das gibt dem Autor strukturellen Überblick übers ganze Buch: Pacing, POV-Verteilung, Kapitel-Balance, Wertungs-Cluster.

**Prinzip-Treue (Reverse-Engineering):** Karten zeigen ausschliesslich, was die Analyse aus dem Text extrahiert hat. Die KI plant keine neuen Szenen vorwärts. Drag-and-Drop dient der **Kuratierung** der extrahierten Daten — Reihenfolge korrigieren, falsche Kapitel-Zuordnung beheben — nicht dem Erfinden nicht-existenter Szenen. Das Board ist eine **Sicht + Korrektur-Werkzeug**, kein Plotting-Generator. Damit konsistent zur App-Philosophie „KI nur rückwärtsgewandt".

## Scope MVP

- **View-Toggle** in der bestehenden Szenen-Karte: `Liste` (Default, bestehend) / `Board` / `Grid`. Toggle als `tabs`-Komponente neben der Filter-Leiste, Auswahl persistiert in localStorage pro User (Key `szenen.viewMode`).
- **Bestehende `szenenFilters`** (Suche, Wertung, Figur, Kapitel, Ort) wirken in allen drei Views identisch. Board/Grid lesen dieselbe `$app.szenenFiltered`-Liste.
- **Board (Corkboard):**
  - Spalten = Kapitel (Standard-Gruppierung), nach `chapters.sort_order` bzw. Hierarchie. Spalten-Header zeigt `chapter_name` + Total + Wertungs-Dot-Strip (Reuse aus bestehender Übersichts-Box).
  - Optional zweite Gruppierungs-Achse via `combobox`: `Kapitel` (Default) / `Wertung` / `POV-Figur`.
  - Karte zeigt: `wertung`-Severity-Tag, `titel`, Seiten-Badge (klickbar → Editor), POV-Figuren-Chips (max 3, Rest als `+N`), Kommentar-Anriss (clamp 2 Zeilen).
  - „Nicht zugeordnet"-Spalte für Szenen mit `chapter_id IS NULL`. Bei Gruppierung nach Wertung: Spalten `Stark / Mittel / Schwach / Ohne`. Bei POV: eine Spalte pro Figur, die in `fig_ids` mindestens einer Szene vorkommt, plus „Ohne POV".
- **Grid (Matrix):** `<table>` mit `Alpine.data('sortableTable')`. Spalten: Wertung, Titel, Kapitel, Seite, POV-Figuren (komma-separiert), Orte, Kommentar (truncate). Zeilen-Klick → Detail-Aufklappen (analog Listen-View) oder direkt Seite-Goto via Seiten-Badge.
- **DnD im Board (nur Gruppierung = Kapitel):**
  - Karte innerhalb Spalte umsortieren → ändert `figure_scenes.sort_order` für betroffene Szenen.
  - Karte in andere Kapitel-Spalte ziehen → ändert `chapter_id` + `sort_order`.
  - Bei Gruppierung Wertung/POV: DnD deaktiviert (nicht sinnvoll, da `wertung` Analyse-Output ist und POV mehrwertig).
- **Klick auf Seiten-Badge oder Karten-Body** → `gotoPageById(page_id)`. Konsistent mit Listen-View.
- **Empty-State:** wenn keine Szenen, dieselbe Karte wie heute (`common.noDataYet`-Hinweis + Verweis auf Komplettanalyse). Board/Grid-Toggle bleibt ausgeblendet, solange `$app.szenen.length === 0`.

## Out-of-Scope

- **Kein Vorwärts-Plotting:** keine leeren Platzhalter-Szenen, kein „Szene hier einfügen → KI schreibt", keine Beat-Sheet-Templates (Save the Cat, 3-Akt-Schablonen). Widerspräche dem Reverse-Engineering-Prinzip.
- Manuelles Anlegen/Löschen von Szenen — Szenen entstehen nur über Extraktion. Inline-Edit von `wertung`/`titel`/`kommentar` als Kuratierung: Phase 2.
- Subplot-/Arc-Spalten als eigene Entität — gibt es im Schema nicht.
- Multi-Select + Bulk-Reorder.
- Mobile-Drag-and-Drop-Feinschliff über Basis hinaus (Touch funktioniert via sortable.js-Polyfill, Feinheiten Phase 2).
- Virtualisierung des Boards (erst nötig bei realen Performance-Problemen ab ~500 Szenen).

## Done when

- View-Toggle schaltet zwischen `Liste / Board / Grid`. Default bleibt `Liste`. Auswahl überlebt Reload (localStorage).
- Board zeigt extrahierte Szenen nach gewählter Achse (Kapitel/Wertung/POV) gruppiert; Spalten-Reihenfolge deterministisch.
- Grid zeigt sortierbare Tabelle aller gefilterten Szenen, jede Spalte sortierbar via `sortableTable`.
- Bestehende `szenenFilters` wirken in allen drei Views identisch (gleiche Treffer-Anzahl).
- DnD im Board (Gruppierung Kapitel) ändert `sort_order`/`chapter_id`, persistiert via Batch-PUT, übersteht Reload, ist optimistisch + rollt zurück bei Fehler.
- Klick auf Seiten-Badge → Editor öffnet die zugehörige Seite.
- Leere Extraktion → Empty-State, Toggle versteckt.
- Keine Möglichkeit, eine Szene zu erzeugen, die nicht aus dem Text stammt (kein „Hinzufügen"-Knopf).
- Nach Re-Extraktion: kuratierte Reorder/Kapitel-Zuordnung bleibt erhalten (siehe DB-Abschnitt + Offene Fragen).

## Hard-Rule-Audit

- **Editor-Spezifikation:** unberührt — Feature lebt in der Szenen-Karte, kein Editor-Pfad. Klick → `gotoPageById` öffnet bestehenden Notebook-Editor (Standard-Sprungverhalten).
- **UI-Patterns aus DESIGN.md:** View-Toggle nutzt bestehendes `.tabs`-Pattern. Board-Spalte + Karten-Pattern existiert noch nicht → vor Bau in DESIGN.md ergänzen (Markup-Snippet + CSS-Datei + Use-Case + Akzent-Erbung). Severity-Tags + Kapitel-Badges via bestehender Klassen (`.severity-tag`, `.kapitel-badge`). Badges eckig (`--radius-sm`).
- **Combobox statt `<select>`:** Gruppierungs-Achse via `combobox` (mit `compact: true`-Default).
- **sortableTable Pflicht:** Grid nutzt zwingend `sortableTable({ rows: () => $app.szenenFiltered, defaultKey: 'titel', types: { seite: 'string', wertung: 'string' }, persistKey: 'szenen.grid' })`. Board (Kanban) ist die dokumentierte Ausnahme.
- **Styles nur in `public/css/`:** Board-Layout in neuer Datei `public/css/entities/szenen-board.css`. Container-Query für Karten-Grid in jeder Spalte (Tile-bezogen, nicht Viewport-bezogen — Board lebt in variablem Karten-Slot). Akzentfarbe erbt `--card-accent` der Szenen-Karte; eigene Tokens nicht nötig. Grid nutzt bestehende `.sortable-table`-Styles.
- **i18n:** alle neuen Strings (View-Labels, Spaltenköpfe, Gruppierungs-Achsen, Empty-Hint im Board, „Nicht zugeordnet", „Ohne POV") in beiden Locale-Dateien.
- **Content-Store-Facade:** unberührt — `figure_scenes` gehört nicht zur Pages/Chapters/Books-Domäne, sondern zur Figuren-/Analyse-Domäne. Reorder-Endpoint schreibt direkt via `db/`. FK-konform: `chapter_id` ist bereits `REFERENCES chapters(chapter_id) ON DELETE SET NULL`.
- **DB-Timestamps:** Reorder-UPDATE setzt `updated_at = ${NOW_ISO_SQL}` aus [db/now.js](../../db/now.js). Kein `datetime('now')`.
- **Logging-Context:** Reorder-Handler `setContext({ book: bookId })` nach `toIntId`-Validierung. Buch-ID kommt aus Route-Param.
- **x-html-Escape:** Karten zeigen `titel`/`kommentar` aus KI-Output. Beide via `x-text` (kein `x-html`) — kein Escape-Risiko. Falls später Highlight/Markup nötig: über `escHtml()` aus utils.js.
- **`callAI`/Job-Queue:** kein KI-Call im Feature. Reine Persistenz auf bestehende Spalten. Job-Queue-Regel nicht berührt.
- **Combobox/numInput/LanguageTool:** keine Zahlenfelder, keine Prosatextfelder, keine `<select>` — nur Combobox für Gruppierung.
- **`SHELL_CACHE` bumpen** beim Commit (neue CSS + JS).
- **Card-Animationen, Ein-Attribut-eine-Deklaration, Selektor-Unique pro Datei, Mobile-Strategie pro Komponente, `x-cloak`:** beim Bau einhalten, Standard-Disziplin.

## Abhängigkeiten

- Komplettanalyse (Szenen-Extraktion in `routes/jobs/komplett/`) muss mindestens einmal gelaufen sein.
- Bestehende Szenen-Karte: [public/js/cards/szenen-card.js](../../public/js/cards/szenen-card.js), [public/js/book/szenen.js](../../public/js/book/szenen.js), [public/partials/szenen.html](../../public/partials/szenen.html).
- `Alpine.data('sortableTable')` aus [public/js/sortable-table.js](../../public/js/sortable-table.js).
- `Alpine.data('combobox')` aus [public/js/app.js](../../public/js/app.js).
- DnD-Muster + In-Place-Mirror + Mutationssequenz aus [docs/buchorganizer.md](../buchorganizer.md).
- `gotoPageById` (Root-Methode, bereits Listen-View-Konsument).
- `setContext` aus [lib/log-context.js](../../lib/log-context.js).

## Backend

**Neu:** `PUT /figures/scenes/:book_id/reorder` in [routes/figures.js](../../routes/figures.js) — Batch-Endpoint für eine ganze Drop-Operation. Eine Drop-Op kann mehrere Szenen-Updates auslösen (Karte zwischen Kapiteln → neues Kapitel verschiebt Indizes in der Quell- + Ziel-Spalte).

**Request-Body:**

```json
{
  "expected_updated_at": "2026-05-28T09:12:33.421Z",
  "updates": [
    { "scene_id": 42, "chapter_id": 7, "sort_order": 3 },
    { "scene_id": 41, "chapter_id": 7, "sort_order": 4 },
    { "scene_id": 17, "chapter_id": 5, "sort_order": 1 }
  ]
}
```

**Vertrag:**
- ACL: User muss `editor`- oder `owner`-Rolle für `bookId` haben (via `requireBookAccess('editor')` aus [lib/acl.js](../../lib/acl.js)). Reader → 403.
- Validierung: alle `scene_id` müssen zu `bookId` + `userEmail` gehören (genau wie GET-Pfad). Quergeschriebene IDs → 404 für die ganze Operation (alles-oder-nichts).
- `chapter_id` muss zum selben Buch gehören (JOIN-Check) oder `null` sein. Fremdes Kapitel → 400.
- `sort_order` Integer ≥ 0, kein Unique-Constraint nötig (Sortierung ist „best effort", Kollisionen werden client- und serverseitig stabilisiert via `(sort_order, id)`-Tiebreak).
- Optimistic Concurrency: `expected_updated_at` wird gegen `MAX(updated_at)` aller betroffenen Szenen verglichen. Bei Drift → 409 `STALE_SZENEN`, Client lädt neu + zeigt Toast.
- Transaktion: alle Updates in einem `db.transaction()`-Block. `updated_at = ${NOW_ISO_SQL}` für jede gemutete Zeile.
- Logging-Context: `setContext({ book: bookId })` nach `toIntId`.
- Response: `{ ok: true, updated_at: '<new ISO>', scenes: [{ id, sort_order, chapter_id, updated_at }] }`. Client patcht den Store ohne kompletten Reload.

**Bestehender `GET /figures/scenes/:book_id` bleibt unverändert** — liefert bereits `fig_ids` (POV) + `ort_ids`, was Board/Grid brauchen. Keine API-Erweiterung im MVP.

**Kein KI-Call, kein Job, keine Cache-Invalidierung.**

## Frontend

**Szenen-Karte erweitern**, **keine** neue Top-Level-Karte:
- View bleibt im Szenen-Feature → kein `EXCLUSIVE_CARDS`/`FEATURES`/Hash-Router-Eintrag nötig.
- Persistenter Deep-Link auf einen View-Mode entfällt im MVP (Hash zeigt Karte, nicht View-Mode). Falls später gewünscht → Hash-Suffix `#szenen?view=board`, eigener Pflegeaufwand.

**`szenenCard`-State ergänzen** ([public/js/cards/szenen-card.js](../../public/js/cards/szenen-card.js)):

```js
viewMode: localStorage.getItem('szenen.viewMode') || 'list', // 'list' | 'board' | 'grid'
groupBy: localStorage.getItem('szenen.groupBy') || 'chapter', // 'chapter' | 'wertung' | 'pov'
_dragSceneId: null,
_dragRollback: null,
```

`$watch('viewMode', v => localStorage.setItem('szenen.viewMode', v))` analog für `groupBy`. Bei `viewMode === 'board' && groupBy !== 'chapter'` → DnD-Handler deaktivieren (CSS-Klasse `.szenen-board--readonly`).

**Compute-Helper** als pure Funktionen, memoized via `_memo`-Pattern (eine Helper-Funktion pro Modul, [`book-overview/load.js`](../../public/js/book-overview/load.js#L1) als Referenz):

```js
_scenesByChapter() { return this._memo('byChapter', [$app.szenenFiltered, $app.chapters], …); }
_scenesByWertung() { return this._memo('byWertung', [$app.szenenFiltered], …); }
_scenesByPov()     { return this._memo('byPov',     [$app.szenenFiltered, $app.figuren], …); }
```

Pure Compute-Bodies (`_computeScenesByChapter` …) liegen in einem neuen Submodul `public/js/book/szenen-grouping.js` und werden von szenen-card.js + Unit-Tests konsumiert.

**Board-Render** in `public/partials/szenen.html` als zusätzlicher Block neben der Liste:
- `<div class="szenen-board" x-show="viewMode === 'board'">` mit `<template x-for="col in groupedColumns">`.
- Spalten-Body: `<template x-for="s in col.scenes" :key="s.id">` mit Karten-Markup. `draggable="true"` + `@dragstart`/`@dragover.prevent`/`@drop` direkt am Karten-Wrapper.
- DnD-Mutationssequenz (analog Buchorganizer-Pitfalls):
  1. `dragstart`: `_dragSceneId = s.id`, `_dragRollback = structuredClone($app.szenen)` (vollständiger Snapshot für sauberen Rollback).
  2. `drop` auf Ziel-Karte/-Spalte:
     - Locale Mutation am Store (`Alpine.store('catalog').szenen` ist die Quelle für `$app.szenen`): `chapter_id` der bewegten Szene setzen, `sort_order` für Quell-Spalte und Ziel-Spalte neu nummerieren (`array.splice` + sequenzielle Reindex auf nur die beiden Spalten — nicht buchweit).
     - Diff-Set bauen: alle Szenen, deren `chapter_id` oder `sort_order` sich geändert hat.
     - Optimistic PUT mit Diff + `expected_updated_at = max(updated_at) der betroffenen Szenen`.
  3. Erfolg (`200`): Response in Store patchen (neue `updated_at`-Werte übernehmen). `_dragRollback = null`.
  4. Fehler (`409`/`5xx`): Store mit `_dragRollback` zurücksetzen, Toast via `notifications`-System (`__i18n:szenen.reorder.failed__`), `loadSzenen(bookId)` refresht.

**Grid-Render** als `<table class="sortable-table" x-show="viewMode === 'grid'">` mit `Alpine.data('sortableTable')`. Spalten gemäss Done-when. Zeilen-Klick auf Seiten-Badge → `gotoPageById`. Detail-Expand analog Listen-View (selbe `entity-detail`-Klasse).

**Karten-Inhalt-Helper** (`_renderSceneCard` / `_renderSceneRow`) bleiben templates in HTML — kein dynamischer `x-html`-Sink.

## CSS

- **Neue Datei:** `public/css/entities/szenen-board.css`:
  - `.szenen-board` als CSS-Grid mit `grid-template-columns` auf Container-Query-Basis: `@container (min-width: 60rem) { .szenen-board { grid-auto-columns: 18rem; grid-auto-flow: column; overflow-x: auto; } }`. Mobile/schmale Slots: einspaltig mit Accordion-Headern.
  - `.szenen-board-col` mit eigener Akzent-Tönung (erbt `--card-accent`).
  - `.szenen-board-card` mit `.draggable`-Cursor, Hover-Schatten, Wertungs-Tag oben.
  - DnD-Visual-Cue: `.szenen-board-card--dragging` (Opacity 0.4) + `.szenen-board-col--dropzone` (Inset-Outline) auf Dragover.
  - `.szenen-board--readonly` deaktiviert `cursor: grab` + `draggable` (Lese-Modus bei Gruppierung ≠ Kapitel).
- **In `public/index.html`** als eigenen `<link>` einbinden.
- **DESIGN.md:** neuen Pattern-Eintrag „Szenen-Board (Corkboard)" mit Markup-Snippet + Use-Case („Kanban-artige Übersicht über extrahierte Szenen, gruppiert nach Kapitel/Wertung/POV; DnD nur bei Kapitel-Gruppierung"). CSS-File-Inventar ergänzen.
- **Grid** nutzt bestehende `.sortable-table`-Styles aus [public/css/components/](../../public/css/components/) — keine neue Datei nötig.
- **`SHELL_CACHE`** in [public/sw.js](../../public/sw.js) bumpen.

## i18n

Neue Keys in beiden Locale-Dateien:

- `szenen.view.list` / `szenen.view.board` / `szenen.view.grid`
- `szenen.viewLabel` („Ansicht" / „View")
- `szenen.groupBy.label`, `szenen.groupBy.chapter`, `szenen.groupBy.wertung`, `szenen.groupBy.pov`
- `szenen.unassigned` („Nicht zugeordnet" / „Unassigned")
- `szenen.noPov` („Ohne POV" / „No POV")
- `szenen.col.titel` / `szenen.col.kapitel` / `szenen.col.seite` / `szenen.col.wertung` / `szenen.col.pov` / `szenen.col.orte` / `szenen.col.kommentar`
- `szenen.reorder.failed` (für Toast bei DnD-Fehler — auch als `__i18n:`-Marker in Server-Response-Fallback)
- `szenen.reorder.stale` (bei 409)
- `szenen.board.empty` („Keine Szenen in diesem Kapitel" / „No scenes in this chapter")

## DB

**Kein neues Schema im MVP.** `figure_scenes` hat alle Felder. Nur neuer Schreibpfad (`PUT /figures/scenes/:book_id/reorder`).

**Phase 2 — Kuratierungs-Schicht** (löst die „Re-Extraktion überschreibt"-Frage):

- Neue Spalten `figure_scenes.curated_sort_order INTEGER NULL` und `figure_scenes.curated_chapter_id INTEGER NULL REFERENCES chapters(chapter_id) ON DELETE SET NULL`.
- Reorder-PUT schreibt nicht in `sort_order`/`chapter_id`, sondern in `curated_*`. Re-Extraktion überschreibt nur die unkuratierten Felder.
- GET liefert `chapter_id = COALESCE(curated_chapter_id, chapter_id)`, `sort_order = COALESCE(curated_sort_order, sort_order)`. Frontend sieht keinen Unterschied.
- Eigene Migration via Recreate-Pattern nicht nötig (additive Spalten via `ALTER TABLE ADD COLUMN`). FK auf neue Spalte braucht aber Recreate-Pattern. ERD-Update + `squash:regen` Pflicht.

Phase 2 hängt an der Antwort auf die entsprechende offene Frage.

## Security

- Reorder-PUT buch-scoped, `editor`-Rolle nötig (via `requireBookAccess`). Reader → 403.
- Cross-User-Schutz: `WHERE book_id = ? AND user_email = ?` filtert Szenen, die nicht zur Session gehören.
- Cross-Book-Schutz: `chapter_id` wird per JOIN gegen `chapters.book_id == bookId` validiert.
- `titel`/`kommentar` werden im Frontend ausschliesslich via `x-text` gerendert → kein XSS-Risiko, keine `escHtml`-Pflicht. (Sicherheitsnetz: würde ein späterer Refactor `x-html` einführen, gilt die Escape-Invariante aus CLAUDE.md.)
- Kein Rate-Limit nötig — Endpoint ist Edit-Wide, low-frequency.

## Telemetrie

`n/a` für MVP. Optional Phase 2: Counter `szenen_view_mode_switch_total{mode=list|board|grid}` und `szenen_reorder_total` über `/telemetry`-Endpoint analog Merge-Telemetrie.

## Reversibilität

- View-Toggle hinter Feature-Flag `FEATURE_SZENEN_BOARD` in [public/js/app/app-state.js](../../public/js/app/app-state.js). Auf `false` → Karte rendert nur Listen-Mode wie heute.
- Reorder-Endpoint additiv. Datenrückbau bei Ausbau: `sort_order`-/`chapter_id`-Werte bleiben in der DB, schaden nicht. Falls Phase 2 mit `curated_*`-Spalten gelandet ist → Spalten droppen via Recreate-Migration; Werte gehen verloren, aber Original-Extraktionswerte bleiben unberührt.
- localStorage-Keys (`szenen.viewMode`, `szenen.groupBy`, `sortable.persist:szenen.grid`) sind selbst-heilend, kein Cleanup nötig.

## Tests

**Unit** (`tests/unit/szenen-grouping.test.mjs`, neu):
- `_computeScenesByChapter`: korrekte Gruppierung, „Nicht zugeordnet"-Bucket für `chapter_id == null`, Spalten in Buchorganizer-Reihenfolge.
- `_computeScenesByWertung`: vier Buckets (stark/mittel/schwach/`null`).
- `_computeScenesByPov`: Szene mit mehreren `fig_ids` erscheint in mehreren Spalten; Szene ohne `fig_ids` → „Ohne POV".
- `_computeReorderDiff(prev, next)`: liefert nur tatsächlich geänderte Szenen, Reindex stabil bei Drop in leere Spalte.
- Sortier-Stabilität: `(sort_order, id)`-Tiebreak.

**Integration** (`tests/integration/szenen-reorder.test.js`, neu):
- Reorder-PUT schreibt korrekt (in-memory SQLite + Seed-Szenen).
- ACL: Reader → 403, fremder User → 404 für die Szenen-IDs, fremdes Buch → 404.
- `chapter_id` aus fremdem Buch → 400.
- `expected_updated_at` veraltet → 409, DB unverändert.
- Cascade: Kapitel gelöscht → `chapter_id` rutscht auf `null`, Board zeigt Szene in „Nicht zugeordnet".
- Transaktion: ein invalides Update im Batch → ganze Operation rollt zurück, kein Teil-Schreiben.

**E2E** (`tests/e2e/szenen-board.spec.js`, neu, Playwright):
- View-Toggle wechselt zwischen List/Board/Grid, Auswahl überlebt Reload.
- Bestehende Filter wirken in allen drei Views (gleiche Treffer-Anzahl).
- DnD: Karte in andere Spalte → PUT geht raus, Board zeigt Karte im Ziel, Reload bestätigt.
- DnD-Fehler simuliert (Mock-Server 500) → Toast erscheint, Board ist visuell auf Vorher-Stand.
- Grid-Spalten sind sortierbar, persistKey funktioniert.
- Klick auf Seiten-Badge öffnet die richtige Seite im Notebook-Editor.

## Edge-Cases

- **Szene ohne `chapter_id` (nur `page_id` oder beides `null`):** eigene Spalte „Nicht zugeordnet" am Anfang des Boards. Drop in normale Spalte → setzt `chapter_id`. Drop zurück in „Nicht zugeordnet" → `chapter_id = null`.
- **Kapitel wird gelöscht während Board offen:** FK `ON DELETE SET NULL` greift, betroffene Szenen rutschen in „Nicht zugeordnet". Frontend bemerkt via Reload-Trigger nicht automatisch — beim nächsten `loadSzenen` korrekt. Akzeptabel.
- **Sehr viele Szenen (>500):** Board ohne Virtualisierung wird langsam. MVP: akzeptiert. Wenn Performance-Problem real → Container-Query bleibt, Spalten-Body via `IntersectionObserver` lazy rendern.
- **Konkurrierende Reorder zweier User auf demselben Buch:** `expected_updated_at` schlägt fehl → 409, User B sieht „aktualisiert" und lädt neu. Last-Write-Wins ist explizit unerwünscht — wir wollen Drift sichtbar machen.
- **Re-Extraktion (neue Komplettanalyse) überschreibt Szenen:** im MVP gehen kuratierte Reorder verloren. Mit Phase 2 (`curated_*`-Spalten) überlebt Kuratierung. Bis Phase 2 entschieden: Hinweis-Toast im Board nach erfolgreicher Komplettanalyse, falls kuratierte Daten erkannt werden (`updated_at > extracted_at` heuristisch).
- **Szene mit `fig_ids = []` bei Gruppierung POV:** in „Ohne POV"-Spalte. DnD ohnehin disabled.
- **Wertung `null` oder unbekannt:** Fallback `'mittel'` (konsistent mit Listen-View, vgl. szenen.html#L141).
- **`sort_order = 0` bei allen Szenen einer Spalte** (Initial-Extraktion): Tiebreak via `id ASC`. Erste Drop-Operation in dieser Spalte schreibt explizite Werte für alle Szenen der Spalte.

## Kritische Dateien

- **Modify:**
  - [routes/figures.js](../../routes/figures.js) — Reorder-PUT-Handler
  - [public/js/cards/szenen-card.js](../../public/js/cards/szenen-card.js) — `viewMode`/`groupBy`-State + DnD-Handler + `_memo`-Helper
  - [public/js/book/szenen.js](../../public/js/book/szenen.js) — optional `reorderSzenen(bookId, updates, expected)`-Methode am Root-Spread
  - [public/partials/szenen.html](../../public/partials/szenen.html) — View-Toggle + Board-Block + Grid-Block
  - [public/index.html](../../public/index.html) — CSS-Link
  - [public/sw.js](../../public/sw.js) — `SHELL_CACHE`-Bump
  - [public/js/i18n/de.json](../../public/js/i18n/de.json) + [public/js/i18n/en.json](../../public/js/i18n/en.json)
  - [DESIGN.md](../../DESIGN.md) — Pattern-Eintrag + CSS-File-Inventar
  - [public/js/app/app-state.js](../../public/js/app/app-state.js) — `FEATURE_SZENEN_BOARD`-Flag
- **Create:**
  - `public/css/entities/szenen-board.css`
  - `public/js/book/szenen-grouping.js` (pure Compute-Helper, testbar ohne Alpine)
  - `tests/unit/szenen-grouping.test.mjs`
  - `tests/integration/szenen-reorder.test.js`
  - `tests/e2e/szenen-board.spec.js`

## Offene Fragen

1. **Kuratierung über Re-Extraktion retten?** Phase-2-`curated_*`-Spalten bauen (Migration + Spalten + COALESCE in GET), oder MVP-Verhalten akzeptieren (Re-Extraktion macht Kuratierung platt)? Empfehlung: MVP ohne, Phase 2 aufnehmen sobald User-Feedback zeigt, dass Reorder häufig genutzt wird.
2. **Inline-Edit `wertung`/`kommentar` im Board** als Kuratierung, oder strikt read-only halten? Read-only wahrt Prinzip-Reinheit. Argument für Edit: Wertung ist ohnehin ein Best-Guess der KI, User-Korrektur ist nicht „Erfinden". Empfehlung: read-only im MVP, evaluiert in Phase 2.
3. **POV-Gruppierung sinnvoll oder Spielerei?** Bei vielen Figuren wird die Achse breit. Alternativ: nur Haupt-POV (erste `fig_ids`-Entry, falls die Extraktion ordnet) als Schlüssel — verliert Mehrwertigkeit. Entscheidung vor Bau.
4. **View-Mode in URL-Hash spiegeln** (Deep-Link „Board offen") oder localStorage genügt? localStorage genügt im MVP; URL-Hash nur, wenn User explizit Deep-Links teilen wollen.
