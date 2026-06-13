# Plot-Werkstatt (Beat-Board)

Planendes Pendant zur rückwärtsgewandten Szenen-/Ereignis-Analyse: Der User skizziert die Handlung seines Buches als Kanban-artiges Beat-Board — **Akte** als Spalten (`plot_acts`), **Beats** (einzelne Handlungspunkte) als Karten darin (`plot_beats`). KI assistiert ausschliesslich **planend/überwachend** (Brainstorm + Consistency gegen die Buchrealität), schreibt nie Fliesstext ins Manuskript (App-Philosophie: KI nur rückwärtsgewandt/weltaufbauend, nie generativ in den Buchtext).

Pro **Buch + User** skopiert (lokaler Karten-State, nicht im `catalog-store` — Plot ist nicht mit Figuren/Orten geteilt). Code: [db/plot.js](../db/plot.js), [routes/plot.js](../routes/plot.js), [routes/jobs/plot.js](../routes/jobs/plot.js), [public/js/cards/plot-card.js](../public/js/cards/plot-card.js), [public/js/book/plot.js](../public/js/book/plot.js), [public/partials/plot.html](../public/partials/plot.html), [public/css/book/plot-board.css](../public/css/book/plot-board.css), [public/js/prompts/plot.js](../public/js/prompts/plot.js).

Trigger: `tile.plot` (Quick-Pill / Palette-Aliase `handlung|beat|board|akt|struktur|outline|dramaturgie|story|wendepunkt`). Hash-Permalink `#book/:bookId/plot`. Gruppe `world`, `minRole: 'editor'` (planendes Werkzeug, kein Lesezugang).

## Datenmodell

```
plot_acts (id, book_id→books CASCADE, user_email, name, farbe, position, created_at, updated_at)
   └── 1:N plot_beats (id, book_id→books CASCADE, act_id→plot_acts CASCADE, user_email,
                       titel, beschreibung, status, chapter_id→chapters SET NULL,
                       sort_order, created_at, updated_at)
          ├── M:N plot_beat_figures (beat_id→plot_beats CASCADE, figure_id→figures CASCADE,
          │                          PK(beat_id, figure_id))
          └── M:N plot_beat_draft_figures (beat_id→plot_beats CASCADE,
                                           draft_figure_id→draft_figures CASCADE,
                                           PK(beat_id, draft_figure_id))
```

- **`plot_acts`** — Board-Spalten (Akte/Phasen), geordnet via `position`. `farbe` optional (max 32 chars).
- **`plot_beats`** — Karten in einem Akt, geordnet via `sort_order`. `status ∈ {geplant, entwurf, im_buch, verworfen}` (CHECK-Constraint) hält „geplant → schon geschrieben" nach. `chapter_id` (SET NULL) verknüpft den Beat mit dem Zielkapitel im Manuskript.
- **`plot_beat_figures`** — M:N-Brücke Beat ↔ Katalog-Figur (`figures.id`, INTEGER-FK), welche Figuren ein Handlungspunkt involviert. Nach aussen wird die TEXT-`fig_id` exponiert (Frontend-Identität), Schreib-/Lesepfad übersetzt via `resolveFigureIds`.
- **`plot_beat_draft_figures`** — parallele M:N-Brücke Beat ↔ Werkstatt-Figur (`draft_figures.id`, INTEGER-FK). Anders als bei Katalog-Figuren IST die `draft_figures.id` bereits die Frontend-Identität (keine TEXT-Indirektion). So kann ein Beat sowohl bereits extrahierte Buch-Figuren als auch vorwärts-entwickelte, evtl. noch nicht im Manuskript stehende Werkstatt-Figuren involvieren.
- Migration **184** (Akte/Beats/Katalog-Brücke) + **185** (`plot_beat_draft_figures`) ([db/migrations.js](../db/migrations.js)). ERD-Block + thematisches Sub-Diagramm in [erd.md](erd.md).

## Routen (CRUD)

Alle unter `/plot` ([routes/plot.js](../routes/plot.js)), ACL via `requireBookAccess(req, bookId, 'editor')`. Akt-/Beat-Mutationen prüfen zusätzlich `user_email`-Owner.

| Methode | Pfad | Zweck |
|---------|------|-------|
| `GET`    | `/?book_id=X`      | Board laden → `{ acts, beats }`. Beats inkl. `chapter_name` (LEFT JOIN) + `fig_ids[]` |
| `POST`   | `/acts`            | `{ book_id, name, farbe? }` — neuer Akt ans Spaltenende |
| `PATCH`  | `/acts/:id`        | `{ name?, farbe? }` umbenennen/umfärben |
| `DELETE` | `/acts/:id`        | Akt löschen — `plot_beats` hängen via CASCADE dran |
| `PUT`    | `/acts/order`      | `{ book_id, order:[actId,…] }` — Spalten-Reihenfolge (`position`) |
| `POST`   | `/beats`           | `{ book_id, act_id, titel, beschreibung?, status?, chapter_id?, figure_ids?, draft_figure_ids? }` |
| `PATCH`  | `/beats/:id`       | Partielles Update (nur übergebene Felder); `figure_ids`/`draft_figure_ids` (Array) ersetzen die jeweiligen Links komplett |
| `DELETE` | `/beats/:id`       | Beat löschen |
| `PUT`    | `/beats/order`     | `{ book_id, order:[{actId, beatIds:[…]}] }` — setzt `act_id` + `sort_order` für DnD |

**Validierung (Server-seitig, Pflicht):**
- `resolveFigureIds(bookId, userEmail, fig_ids)` filtert die Katalog-Figuren aufs Subset, das wirklich zu (Buch, User) gehört, und übersetzt TEXT-`fig_id` → INTEGER `figures.id` — verhindert Fremd-Verschmutzung der M:N-Tabelle.
- `resolveDraftFigureIds(bookId, userEmail, draft_figure_ids)` analog für Werkstatt-Figuren: filtert die INTEGER-IDs aufs (Buch, User)-Subset von `draft_figures`. Unbekannte/Fremd-IDs fallen still raus.
- `_validChapterId(bookId, chapterId)` erzwingt, dass das Kapitel zum Buch gehört, sonst `NULL`.
- Beim Beat-Anlegen/-Verschieben muss der Ziel-Akt zum selben Buch + User gehören (`ACT_MISMATCH` sonst).
- Limits: Titel 200, Beschreibung 4000, Akt-Name 120, Farbe 32 Zeichen.

## KI-Jobs

Beide via Job-Queue ([routes/jobs/plot.js](../routes/jobs/plot.js), gemountet in [routes/jobs.js](../routes/jobs.js)), Prompts + Schemas in [public/js/prompts/plot.js](../public/js/prompts/plot.js) (re-exportiert über die Facade [public/js/prompts.js](../public/js/prompts.js)). **Rein planend/überwachend — nie generativ in den Text.**

| Job-Typ | Endpunkt | dedupId | Eingabe | Output |
|---------|----------|---------|---------|--------|
| `plot-brainstorm`  | `POST /jobs/plot-brainstorm`  | `${bookId}\|brainstorm\|${actId}` | `{ book_id, act_id }` | `{ vorschlaege:[{label, begruendung}], actId }` |
| `plot-consistency` | `POST /jobs/plot-consistency` | `${bookId}`                       | `{ book_id }`         | `{ konflikte:[{beat, schwere, problem, vorschlag}], fazit }` |

**Eigener System-Prompt** (`buildPlotSystemPrompt`): self-contained, **ohne** Locale-Config-Abhängigkeit (Dramaturg-/Lektor-Rolle + `_jsonOnly()`). Anders als die Figuren-Werkstatt nutzt Plot keinen `SYSTEM_FIGUREN`.

**Kontext-Loader** (beide Jobs grundieren mit Buch-Realität):
- `_figurenContext` — Katalog-Figuren-Ensemble (Name + Typ) aus `getFiguren`.
- `_werkstattFigurenContext` — Werkstatt-Figuren-Ensemble (Name + Archetyp) aus `listDraftFigures` (Direkt-Require von `db/draft-figures`, kein pages/chapters/books). Best-effort: bei Fehler `[]`. Fliesst als eigener Prompt-Block `FIGUREN-WERKSTATT (in Entwicklung …)`. So kennt Brainstorm geplante Figuren als Beat-Material, und Consistency beanstandet einen Beat, der eine Werkstatt-Figur referenziert, nicht als „unbekannte Figur".
- `_kapitelContext` — Kapitelnamen in echter Buchorganizer-Reihenfolge **über die Content-Store-Facade** (`loadOrderedBookContents`, kein Direkt-SQL auf `chapters`). Best-effort: bei Fehler `[]`.
- `_szenenContext` (nur Consistency) — extrahierte Szenen mit Kapitel + beteiligten Figuren aus `figure_scenes`/`scene_figures` (Direkt-SQL erlaubt — keine pages/chapters/books; `chapter_name` via JOIN, LIMIT 150).

**Brainstorm:** schlägt 3–7 prägnante Beats (3–10 Wörter Label + 1-Satz-Begründung) für **einen** Akt vor, passend zum bisherigen Board + Buchkontext + Katalog- + Werkstatt-Figuren. Bestehende Beats des Akts gehen als „NICHT wiederholen"-Liste in den Prompt.

**Consistency:** prüft den geplanten Plot in sich + gegen die Buchrealität — Beats mit `im_buch` ohne Szenen-Entsprechung, geschriebene-aber-noch-`geplant`-Drift, Chronologie-Brüche (Beat-Reihenfolge vs. verknüpfte Kapitel), Logiklücken, fehlende Wendepunkte, verworfene-aber-noch-präsente Inhalte. Werkstatt-Figuren gelten als legitime, geplante Figuren (kein „nicht im Buch"-Befund allein deswegen). Leeres `konflikte`-Array + bestätigendes `fazit` bei Stimmigkeit.

**Severity-Skala** `kritisch|stark|mittel|schwach|niedrig` (Schema-enforced enum `PLOT_SEVERITY_ENUM`), kompatibel zu `.severity-tag--*` aus [DESIGN.md](../DESIGN.md) — gleiche Skala wie die [Figuren-Werkstatt](figur-werkstatt.md).

**Job-Labels:** `job.label.plotBrainstorm` (`{ akt }`-Param) / `job.label.plotConsistency`. Dedup via `findActiveJobId(type, entityKey, userEmail)`.

## Frontend-Card

Sub-Komponente `plotCard` ([public/js/cards/plot-card.js](../public/js/cards/plot-card.js)), Methoden in [public/js/book/plot.js](../public/js/book/plot.js) (`plotMethods`). Buchebenen-Karte, exklusiv (`EXCLUSIVE_CARDS`-Eintrag in [feature-registry.js](../public/js/cards/feature-registry.js), `flag: showPlotCard`, `toggle: togglePlotCard`, `onReclick: refresh`).

**Lifecycle:** `setupCardLifecycle({ name:'plot', showFlag:'showPlotCard', timerKeys:['_brainstormPollTimer','_consistencyPollTimer'], onShow: loadBoard, onBookChanged: reset+reload, onViewReset: resetPlot, onCardRefresh: loadBoard })`.

**Memo:** genau ein `_memo(key, deps[], fn)`-Helper (Array-Deps shallow `===`); `beatsForAct` + `boardStats` memoized, `this._memos = {}` bei jeder Daten-Mutation/`loadBoard`.

**Akt-Reordering** per Pfeil-Button (`moveAct(act, dir)`, a11y statt Spalten-Drag) → `PUT /plot/acts/order`.

**Beat-Reordering** per HTML5-Drag-&-Drop (`onBeatDragStart`/`onBeatDrop`/`_persistOrder`): optimistisch lokal umsortiert (inkl. Neu-Nummerierung der Quell- + Ziel-Spalte), dann `PUT /plot/beats/order`. Bei Persist-Fehler `loadBoard()` als Rollback auf Server-Stand.

**Quick-Status:** Klick aufs Status-Badge (`cycleBeatStatus`) schaltet `geplant → entwurf → im_buch → verworfen` zyklisch durch (einzelnes `PATCH`).

**Beat-Edit:** Inline-Editor mit Status-Tabs, Kapitel-Combobox (aus `$app.tree`-Kapiteln) und **zwei** Figuren-Picker: Katalog-Chips (aus `$app.figuren`) und Werkstatt-Chips (aus `draftFiguren`, lokal in der Karte via `GET /draft-figures/:bookId` geladen, gestrichelter Werkstatt-Akzent). Beat-Meta-Badges sind klickbar: Kapitel → `$app.openKapitelByName`, Katalog-Figur-Tags → `$app.openFigurById`, Werkstatt-Figur-Tags (`.tag--werkstatt`) → `$app.openWerkstattDraftById`. Filter-Leiste hat eine eigene Werkstatt-Figur-Combobox (`catalogFilter('werkstattFigur')`), sichtbar nur wenn Beats Werkstatt-Figuren verknüpfen.

**Brainstorm-UI:** pro Akt ein Button → Job-Poll (`startPoll` aus [job-helpers.js](../public/js/cards/job-helpers.js)) → Vorschlags-Panel im Akt. `applyBrainstorm(idx)` legt aus dem Vorschlag direkt einen Beat an (`label`→`titel`, `begruendung`→`beschreibung`) und entfernt ihn aus der Liste.

**Consistency-UI:** Button im Card-Header (deaktiviert bei leerem Board) → Panel mit `fazit` + aufklappbarer Konflikt-Liste (Severity-Tag + betroffener Beat + Vorschlag).

## i18n

Alle Keys unter `plot.*` (Titel, Stats, Status-Labels, Severity, Brainstorm-/Consistency-UI, Fehler) in [public/js/i18n/de.json](../public/js/i18n/de.json) / [en.json](../public/js/i18n/en.json). Server-Status-Keys: `job.plot.brainstorm.aiReply`, `job.plot.consistency.aiReply`. Fehler: `job.error.plot.{actMissing|vorschlaegeMissing|boardEmpty|konflikteMissing|fazitMissing}`. Job-Labels: `job.label.plotBrainstorm|plotConsistency`.

## Pflicht-Invarianten

- **Nie generativ in den Text** — beide KI-Jobs liefern nur Struktur-Stichpunkte (Beats) bzw. Befunde, nie Prosa. Der System-Prompt erzwingt das explizit; bleibt bei Änderungen erhalten (App-Philosophie: KI rückwärtsgewandt/weltaufbauend, nie in den Buchtext schreibend).
- **`truncated` vor `parseJSON` prüfen + Pflichtfeld-Check** nach jedem `aiCall` (`vorschlaege`/`konflikte`/`fazit`) — sonst Partial-Daten. Bereits in [routes/jobs/plot.js](../routes/jobs/plot.js) umgesetzt.
- **Scoping `WHERE book_id = ? AND user_email = ?`** in jedem DB-Pfad — Plot ist pro Buch **und** User isoliert (kein geteilter Katalog).
- **Figuren-/Kapitel-Refs validieren** (`resolveFigureIds`/`resolveDraftFigureIds`/`_validChapterId`) vor jedem Write — keine Fremd-Verweise in den beiden M:N-Tabellen oder in `chapter_id`. Katalog- und Werkstatt-Figuren sind getrennte Brücken (`fig_ids` = TEXT-`fig_id`, `draft_fig_ids` = INTEGER `draft_figures.id`); Frontend hält sie in `beatDraft.figure_ids` vs. `beatDraft.draft_figure_ids` getrennt.
- **Kapitel-Kontext nur über die Content-Store-Facade** (`loadOrderedBookContents`), kein Direkt-SQL auf `chapters`/`pages`/`books`.
