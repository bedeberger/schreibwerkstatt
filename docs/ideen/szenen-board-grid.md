# Szenen-Board & -Grid (Corkboard / Matrix über extrahierte Szenen)

- **Status:** Draft
- **Aufwand:** M
- **Severity:** medium

## Context

Szenen werden bereits aus dem fertigen Text **extrahiert** (`figure_scenes`: `titel`, `wertung`, `kommentar`, `sort_order`, `chapter_id`, `page_id`) und aktuell nur als Liste/Übersicht in der Szenen-Karte gezeigt ([public/partials/szenen.html](../../public/partials/szenen.html), GET `/scenes/:book_id` in [routes/figures.js](../../routes/figures.js)).

Plottr/Scrivener-Corkboard zeigen Szenen als **verschiebbare Karten** auf einem Board und als **Matrix/Grid** (Zeile = Szene, Spalte = Attribut). Das gibt dem Autor einen strukturellen Überblick übers ganze Buch: Pacing, POV-Verteilung, Kapitel-Balance.

**Prinzip-Treue:** Die Karten zeigen ausschließlich das, was die Analyse aus dem Text extrahiert hat. Die KI plant keine neuen Szenen vorwärts. Drag-and-Drop dient der **Kuratierung/Reorganisation** der extrahierten Daten (Reihenfolge, Kapitel-Zuordnung korrigieren), nicht dem Erfinden nicht-existenter Szenen. Reverse-Engineering bleibt Reverse-Engineering — das Board ist eine Sicht + Korrektur-Werkzeug, kein Plotting-Generator.

## Scope MVP

- Zwei neue **Ansichtsmodi** in der bestehenden Szenen-Karte (View-Toggle Liste / Board / Grid):
  - **Board (Corkboard):** Szenen als Karten, gruppiert in Spalten nach Kapitel (Standard) — optional gruppiert nach POV-Figur. Karte zeigt `titel`, Kapitel/Seite, `wertung`-Badge (eckig), Kommentar-Anriss.
  - **Grid (Matrix):** Tabelle Zeile = Szene, Spalten = Titel, Kapitel, Seite, Wertung, POV-Figur(en). Sortierbar.
- **Reorder + Reassign per DnD** (Board): Karte innerhalb Kapitel umsortieren (`sort_order`) bzw. in anderes Kapitel ziehen (`chapter_id`). Persistiert über neuen PUT-Endpoint.
- Klick auf Karte/Zeile → springt zur Seite (`page_id`) im Editor bzw. öffnet Detail.
- Reine Sicht auf vorhandene `figure_scenes`; keine Szenen-Anlage von Hand, keine AI-Generierung.

## Out-of-Scope

- **Kein** Vorwärts-Plotting: keine leeren Platzhalter-Szenen, keine „Szene hier einfügen → KI schreibt", keine Beat-Sheet-Templates (Save the Cat etc.). Das widerspräche dem Reverse-Engineering-Prinzip.
- Manuelles Anlegen/Löschen von Szenen (Szenen entstehen nur über Extraktion). Bearbeiten von `wertung`/`kommentar` als Kuratierung: Phase 2, offene Frage.
- Subplot-/Arc-Spalten als eigene Entität (gibt es im Schema nicht).
- Mobile-Drag-and-Drop-Feinschliff über Basis hinaus.

## Done when

- View-Toggle schaltet zwischen Liste/Board/Grid; Default bleibt aktuelle Liste.
- Board zeigt extrahierte Szenen korrekt nach Kapitel gruppiert; Grid zeigt sortierbare Matrix.
- DnD ändert `sort_order`/`chapter_id`, persistiert via PUT, übersteht Reload.
- Klick navigiert zur zugehörigen Seite.
- Leere Extraktion → Empty-State mit Hinweis auf Komplettanalyse.
- Keine Möglichkeit, eine Szene zu erzeugen, die nicht aus dem Text stammt.

## Hard-Rule-Audit

- **UI-Patterns aus DESIGN.md:** Board-Karten + View-Toggle vor Bau im Katalog prüfen; existiert kein Board-Pattern → erst in DESIGN.md dokumentieren (Markup + CSS + Use-Case), dann bauen. Badges eckig (`--radius-sm`).
- **sortableTable Pflicht:** Grid nutzt `Alpine.data('sortableTable')` (>3 Zeilen). Board (Kanban) ist die dokumentierte Ausnahme (kein nacktes `<table>`).
- **Combobox statt `<select>`:** Gruppierungs-/POV-Filter via `combobox`.
- **Styles nur in `public/css/`:** Board-Layout in neuer Datei unter `entities/` oder `analysis/`. Container-Query für Karten-Grid (variabler Slot). Akzentfarbe via `--card-accent` (Szenen-Karte erbt bestehenden Akzent).
- **i18n:** View-Toggle, Spaltenköpfe, Empty-State, Wertungs-Labels in de + en.
- **Content-Store-Facade / DB-Integrität:** Reorder-PUT schreibt nur `figure_scenes.sort_order`/`chapter_id` (gehört nicht zu Pages/Chapters/Books → kein Facade-Zwang, aber FK-konform: `chapter_id REFERENCES chapters ON DELETE SET NULL` existiert bereits).
- **DB-Timestamps:** Reorder-Update setzt `updated_at = ${NOW_ISO_SQL}`.
- **Logging-Context:** PUT-Handler `setContext({ book })` nach `toIntId`.
- **x-html-Escape:** Karten-Felder (`titel`, `kommentar` — KI-Herkunft) via `escHtml()`.
- **Buchorganizer-DnD-Pitfalls** ([docs/buchorganizer.md](../buchorganizer.md)) als Referenz für DnD-Implementierung (In-Place-Mirror, Mutationssequenz).
- **SHELL_CACHE bumpen.**

## Abhängigkeiten

- Komplettanalyse (Szenen-Extraktion) muss gelaufen sein.
- Bestehende Szenen-Karte ([public/js/cards/szenen-card.js](../../public/js/cards/szenen-card.js), [public/js/book/szenen.js](../../public/js/book/szenen.js)).
- sortableTable, combobox, DnD-Muster aus Buchorganizer.

## Backend

- **Neu:** `PUT /scenes/:book_id/reorder` (oder `/scenes/:scene_id`) in [routes/figures.js](../../routes/figures.js) — Body `{ sceneId, chapterId, sortOrder }` bzw. Batch-Liste. Validiert Zugehörigkeit zum Buch (ACL), schreibt `figure_scenes.sort_order`/`chapter_id` + `updated_at`. Kein KI-Call.
- Bestehender `GET /scenes/:book_id` liefert bereits alle nötigen Felder (inkl. `chapter_id`/`page_id`/`sort_order`).
- POV-Figur pro Szene: Schema hat aktuell keine direkte Szene↔Figur-Spalte → ableiten über `page_figure_mentions` der `page_id` oder offene Frage (siehe unten).

## Frontend

- Erweiterung der Szenen-Karte um `viewMode`-State (`'list' | 'board' | 'grid'`), persistiert (localStorage).
- Board-Render: pure Compute `_scenesByChapter()` / `_scenesByPov()` (memoized via `_memo`).
- Grid: `sortableTable` mit `rows`-Getter auf gefilterte Szenen.
- DnD: bestehendes Muster (In-Place-Mirror), Mutationssequenz analog Buchorganizer; nach Drop → PUT, optimistisch + Rollback bei Fehler.
- Keine neue Top-Level-Karte → keine `EXCLUSIVE_CARDS`/`FEATURES`/Hash-Router-Änderung nötig (bleibt innerhalb Szenen-Feature). (Alternative: eigene Karte — siehe Offene Fragen.)

## CSS

- Neue Datei `public/css/entities/szenen-board.css` (Board-Spalten, Karten, Container-Query). Grid nutzt bestehende Tabellen-Styles. Link in `index.html`, `SHELL_CACHE` bump, DESIGN.md-Inventar + neues Board-Pattern.

## i18n

- `szenen.view.list/board/grid`, `szenen.col.*` (Titel/Kapitel/Seite/Wertung/POV), `szenen.groupBy`, `szenen.empty`, Wertungs-Labels (de + en).

## DB

- **Kein neues Schema** für MVP — `figure_scenes` hat alle Felder. Nur neuer Schreibpfad auf bestehende Spalten.
- Falls POV als eigene Relation gewünscht (Phase 2): Bridge-Tabelle `scene_figures` (FK auf `figure_scenes.id` + `figures.id`, ON DELETE CASCADE, Index) — eigene Migration, ERD-Update, `squash:regen`.

## Security

- Reorder-PUT buch-scoped via ACL (Editor-Rolle nötig). Reader dürfen nur lesen. Felder escaped.

## Telemetrie

- `n/a` (optional Usage-Counter für View-Mode-Wechsel).

## Reversibilität

- View-Toggle hinter Feature-Flag; Default-Ansicht bleibt Liste. Reorder-Endpoint additiv, kein Datenverlust beim Ausbau (Spalten existieren ohnehin).

## Tests

- **Unit:** `_scenesByChapter`/`_scenesByPov`-Gruppierung + Sortierung; Reorder-Index-Berechnung.
- **Integration:** Reorder-PUT schreibt korrekt, respektiert ACL, FK-konform bei gelöschtem Kapitel (`SET NULL`).
- **E2E:** View-Toggle, DnD-Reorder persistiert über Reload, Klick → Seite, Empty-State.

## Edge-Cases

- Szene ohne `chapter_id` (nur `page_id` oder beides null) → eigene „Nicht zugeordnet"-Spalte im Board.
- Kapitel wird gelöscht während Board offen → `chapter_id` per `SET NULL` rutscht in „Nicht zugeordnet".
- Sehr viele Szenen → Board-Performance: virtualisieren/lazy bei Bedarf.
- Konkurrierende Reorder zweier User → Last-Write-Wins auf `updated_at`, kein harter Lock (akzeptabel für Kuratierung).
- Re-Extraktion (neue Komplettanalyse) überschreibt Szenen → `sort_order`/manuelle Zuordnung können verloren gehen (siehe Offene Fragen).

## Kritische Dateien

- **Modify:** [routes/figures.js](../../routes/figures.js) (Reorder-PUT), [public/js/cards/szenen-card.js](../../public/js/cards/szenen-card.js), [public/js/book/szenen.js](../../public/js/book/szenen.js), [public/partials/szenen.html](../../public/partials/szenen.html), [public/index.html](../../public/index.html) (CSS-Link), [public/sw.js](../../public/sw.js), [public/js/i18n/de.json](../../public/js/i18n/de.json) + [en.json](../../public/js/i18n/en.json), [DESIGN.md](../../DESIGN.md).
- **Create:** `public/css/entities/szenen-board.css`, `tests/unit/szenen-board.test.mjs`.

## Offene Fragen

- View-Modi in bestehende Szenen-Karte integrieren, oder eigene „Szenen-Board"-Karte (eigener `EXCLUSIVE_CARDS`/`FEATURES`/Hash-Router-Eintrag)?
- POV-Figur pro Szene: aus `page_figure_mentions` ableiten (ungenau) oder Bridge-Tabelle `scene_figures` aus der Extraktion füllen (Schema + Prompt-Erweiterung)?
- Soll manuelle Reorder/Kapitel-Zuordnung eine Re-Extraktion überleben (separates Kuratierungs-Feld vs. von Analyse überschrieben)?
- `wertung`/`kommentar` im Board editierbar machen (Kuratierung) — oder strikt read-only halten, um Prinzip-Reinheit zu wahren?
