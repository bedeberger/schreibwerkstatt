# Figuren & Orte im Text (extrahierte Entitäten im Notebook-Editor sichtbar machen)

- **Status:** Ready
- **Aufwand:** M
- **Severity:** medium

## Context

Komplettanalyse extrahiert vier Entitäts-Typen aus dem fertigen Text:

- **Figuren** (`figures`) — benannte Personen, Inline-Erwähnungen via `page_figure_mentions`.
- **Orte** (`locations`) — benannte Schauplätze.
- **Szenen** (`figure_scenes`) — gegliederte Erzähleinheiten, gebunden an `page_id`/`chapter_id`.
- **Ereignisse** (`figure_events`) — figurgebundene Vorgänge, gebunden an `page_id`/`chapter_id`.

Diese Daten leben in eigenen Karten — beim Editieren einer Seite sieht der Autor nicht, **wer/was/welche Szene/welches Ereignis** auf dieser Seite vorkommt und kommt nicht mit einem Klick zur Stammkarte.

Vorbild: Novelcrafters „Codex" verknüpft Entitäten live mit dem Text. Wir bauen das **strikt rückwärtsgerichtet**: KI generiert nichts, das Entity-Linking macht nur sichtbar, was die Analyse bereits aus dem Text abgeleitet hat. Reverse-Engineering bleibt Reverse-Engineering.

Zwei Verknüpfungsmodi je nach Entitäts-Charakter:

| Typ | Bezug zum Text | Darstellung |
|---|---|---|
| Figur, Ort | benannt, mehrfach im Body | **Inline-Highlight** auf Namens-Vorkommen (CSS Custom Highlight) |
| Szene, Ereignis | an `page_id` gehängt, kein eigener Name im Body | **Seiten-Panel** „Auf dieser Seite" (Liste, kein Inline-Markup) |

## Scope MVP

- **Editor:** ausschließlich **Notebook-Editor** (Einzelseiten-Edit-Modus, `.page-content-view`). Focus-Editor und Bucheditor explizit out-of-scope (kein gemeinsamer Code-Pfad).
- **Inline-Highlights** (Figuren, Orte):
  - Match-Engine **Hybrid** — MVP-Default: **client-seitig** auf kanonischem `figures.name` / `locations.name` (case-insensitiv, ganze Wörter, Unicode-aware `\p{L}\p{M}`-Wortgrenzen). Phase-2-Option: pro Buch aktivierbare Offset-Persistenz (siehe DB-Sektion).
  - **Nur kanonischer Name**, keine Alias-/Spitznamen-/Vorname-Nachname-Splits. Aliase = Phase 2.
  - **Kollisionsregel Figur ↔ Ort:** Figur gewinnt. Bei gleichem Namen wird nur das `entity-figure`-Highlight gesetzt, das `entity-location`-Highlight übersprungen. Begründung: Figuren im Erzähltext häufiger gemeint, weniger visuelles Rauschen.
  - Zwei Highlight-Register: `entity-figure`, `entity-location`.
  - Hover/Klick auf Highlight → Popover mit Stammdaten (Name, Typ, Kurzbeschreibung, bei Figuren Soziogramm-Rolle; „Zur Karte"-Link).
- **Seiten-Panel** (Szenen, Ereignisse) — als **Klappschiene am rechten Editor-Rand** (`collapsible-toggle` + `history-chevron`-Pattern). Permanent sichtbar bei aktivem Toggle, nimmt Spaltenbreite weg. Mobile (Container-Query): nach unten ausgeklappt unter den Editor-Body. Zwei Listen mit je zwei Sektionen:
  - **Szenen**
    - Sektion „Auf dieser Seite": `figure_scenes` mit `page_id = aktuelle Seite`.
    - Sektion „Im Kapitel (ohne Seitenbezug)": `figure_scenes` mit `chapter_id = aktuelles Kapitel` **und** `page_id IS NULL` — sichtbar abgesetzt (gedimmter Stil, eigener Sektions-Header). Nur sichtbar wenn Inhalt vorhanden.
    - Karten-Inhalt: `titel`, optional `wertung`-Badge.
  - **Ereignisse**
    - Sektion „Auf dieser Seite": `figure_events` mit `page_id = aktuelle Seite`.
    - Sektion „Im Kapitel (ohne Seitenbezug)": `figure_events` mit `chapter_id = aktuelles Kapitel` **und** `page_id IS NULL`, identisch gestylt.
    - Karten-Inhalt: `ereignis`, `datum`, zugehörige Figur (Name via JOIN).
  - Klick auf Eintrag → öffnet jeweilige Karte (Szenen / Ereignisse) und scrollt zum Eintrag (bestehendes `gotoStelle`-/Card-Open-Muster).
- **Pro-Buch-Toggle, zwei Eintrittspunkte** (gemeinsamer State, kein localStorage):
  - **BookSettings-Karte**: Checkbox „Entitäten im Text hervorheben (Figuren/Orte + Szenen/Ereignisse-Panel)". Default aus.
  - **Notebook-Toolbar**: identischer Toggle als Quick-Access beim Schreiben. Klick persistiert sofort am Buch (PUT `/booksettings/:book_id`), beide Stellen bleiben synchron via `book:settings:updated`-Event.
  - Schaltet Highlights + Panel gemeinsam. Beim Buchwechsel wird der jeweilige Buch-Status geladen, kein User-Default über mehrere Bücher hinweg.
- Read-only: kein Markup im gespeicherten HTML, keine `data-bid`-Berührung, keine Persistenz im Page-Body. Highlights sind reine Range-Overlays, Panel ist Read-View über Stammdaten.

## Out-of-Scope

- **Kein** Vorwärts-Generieren: keine „neue Figur/Szene/Ereignis aus Markierung anlegen", kein AI-Vorschlag für fehlende Entitäten. Erkennen, dass ein Name nicht extrahiert ist → muss über bestehende Extraktions-Pipeline laufen, nicht über Inline-Generierung.
- **Focus-Editor** und **Bucheditor**: nicht im MVP, kein gemeinsamer Code mit Notebook-Pfad gebaut.
- **Alias-/Spitznamen-/Vorname-Nachname-Matching** (z. B. „der Hauptmann" → Figur X, „Anna" als Kurzform für „Anna Schmidt"). MVP matcht ausschließlich den kanonischen `figures.name`/`locations.name`. Aliase = Phase 2 (eigene Spalte `figures.aliases` + Prompt-Erweiterung).
- **DB-Offsets in der Default-Konfiguration.** Hybrid-Modell: Offset-Persistenz ist eine **Opt-in-Phase-2-Option pro Buch**, nicht MVP-Pflicht.
- **Editieren** der Entitäts-Stammdaten aus Popover/Panel — bleibt in den jeweiligen Karten.
- **Ereignisse/Szenen als Inline-Marker** (z. B. Block-Anker im Text). Sie haben keinen eigenen Textanker → bewusst kein erfundenes Inline-Markup. Panel-Liste reicht.

## Done when

- Bei offener Seite mit aktiviertem Toggle:
  - alle Vorkommen extrahierter Figuren-/Orte-Namen sichtbar markiert (zwei unterscheidbare Highlight-Stile);
  - Panel listet Szenen + Ereignisse der aktuellen Seite korrekt;
  - Panel zeigt zusätzlich Sektion „Im Kapitel (ohne Seitenbezug)" für Szenen + Ereignisse mit `page_id IS NULL` aber passender `chapter_id` (Sektion blendet sich aus, wenn leer).
- Hover auf Highlight → Popover mit Stammdaten; Klick → Karte öffnet via `_closeOtherMainCards` regelkonform.
- Klick auf Panel-Eintrag → Szenen-/Ereignisse-Karte öffnet + scrollt zum Eintrag.
- Toggle aus → keine Highlights, kein Panel, keine Reste in `CSS.highlights`.
- Seitenwechsel/Edit räumt Highlight-Ranges auf (keine Stale-Ranges auf altem DOM).
- Gespeichertes Seiten-HTML enthält keinerlei Entity-Linking-Markup (Diff vor/nach Save identisch).
- Leere Extraktion (keine Figuren/Orte/Szenen/Ereignisse) → Toggle deaktiviert + Empty-State im Panel mit Hinweis auf Komplettanalyse.

## Hard-Rule-Audit

- **Editor-Spezifikation:** Betrifft **nur Notebook-Editor**. Focus + Bucheditor explizit out-of-scope. Notebook-Pflicht-Invarianten ([docs/notebook-editor.md](../notebook-editor.md)) prüfen: kein Eingriff in Save-Pipeline, Draft, Stale-Write-Schutz, Findings-Mark-Watcher.
- **Styles nur in `public/css/`:** Highlight-Stile via `::highlight(entity-figure)` / `::highlight(entity-location)` in neuer CSS-Datei unter `editor/`. Panel-Styles in derselben Datei oder eigener `components/`-Datei. Akzentfarbe über bestehende Tokens, keine Inline-Styles.
- **i18n:** Toggle-Label, Popover-Strings, Panel-Überschriften, Empty-State in beide Locale-Dateien.
- **Content-Store-Facade:** nur lesend; keine neuen Schreibpfade auf `pages`.
- **x-html-Escape:** Popover + Panel rendern Entitäts-Felder (KI-/User-Herkunft) → `escHtml()` vor jeder Interpolation.
- **A11y:** Popover-Trigger + Panel-Einträge tastatur-erreichbar; klickbare Spans via `.internal-link`-Konvention.
- **DB-Integrität:** MVP-Migration ist additive Spalte auf `books`, kein FK nötig.
- **SHELL_CACHE bumpen** (neue JS/CSS).
- **CSS Custom Highlight** bereits etabliert (find.js, LanguageTool) — Muster wiederverwenden, kein neues Highlight-Framework.

## Abhängigkeiten

- Komplettanalyse muss gelaufen sein. Bei leerer Extraktion: Toggle deaktiviert + Hinweis.
- Stammdaten-Loader: `figures` (`loadFiguren`), `locations`, `figure_scenes` (`GET /scenes/:book_id`), `figure_events` (bestehende Ereignisse-Pipeline). Alle bereits im Frontend verfügbar — Entity-Linking konsumiert vorhandenen State, keine neuen Lade-Pfade nötig.
- CSS-Custom-Highlight-Infrastruktur aus [public/js/editor/find.js](../../public/js/editor/find.js) als Referenz-Pattern.
- Notebook-Toolbar (`editor-toolbar`) für den Toggle + Panel-Anker.

## Backend

- MVP: **keine neuen Endpoints**. Sämtliche Daten kommen über bestehende Lade-Pfade (Figuren, Orte, Szenen, Ereignisse, Mentions).
- `PUT /booksettings/:book_id` erweitern um Feld `entities_enabled` (Bool → 0/1). `saveBookSettings` in [db/schema.js](../../db/schema.js) bekommt neuen Parameter; `GET /booksettings/:book_id` und `getBookSettings` liefern das Feld mit. Validate-Schema in [routes/booksettings.js](../../routes/booksettings.js) ergänzen.
- Phase-2-Option (genauere Mehrfach-Offsets statt Client-Match): Erwägung, `page_figure_mentions` um Offset-Liste zu erweitern oder analoge `page_location_mentions`-Tabelle anzulegen — nur falls Client-Match qualitativ nicht reicht (siehe Offene Fragen).

## Frontend

- Neues Sub-Modul [public/js/editor/notebook/entities.js](../../public/js/editor/notebook/entities.js) (Notebook-spezifisch, Focus-shared-Layer **nicht** berührt):
  - pure Funktion `buildRanges(text, entities)` für Name-Match → Range-Deskriptoren;
  - `applyHighlights()` / `clearHighlights()` über `CSS.highlights`;
  - Selektor-Helper für „Szenen/Ereignisse mit `page_id = currentPageId`".
- Toggle-State kommt aus `currentBook.entities_enabled` (kein localStorage). Toolbar-Toggle ruft `PUT /booksettings/:book_id` mit aktuellem Wert + erwartet `{ entities_enabled }`-Response; dispatcht `book:settings:updated` → BookSettings-Karte + Entities-Sub aktualisieren ihren State.
- Popover über bestehendes Tooltip-/Popover-Muster (kein neues Overlay-System).
- Panel als Klappschiene neben Toolbar (collapsible-toggle + history-chevron-Pattern aus DESIGN.md).
- Match-Engine pure + testbar (Name-Liste + Text rein, Range-Deskriptoren raus; ohne DOM).

## CSS

- Neue Datei [public/css/editor/entities.css](../../public/css/editor/entities.css):
  - `::highlight(entity-figure)` / `::highlight(entity-location)` (zwei dezente Akzente, Tönung/Unterstreichung);
  - Panel-Layout (Klappschiene, eckige Badges, Mobile-Container-Query).
- Link in `index.html`, `SHELL_CACHE` bumpen, DESIGN.md-Inventar ergänzen.

## i18n

- `entities.toggle`, `entities.toggle.hint`, `entities.gotoCard`, `entities.figure`, `entities.location`, `entities.scene`, `entities.event`,
- `entities.panel.title`, `entities.panel.scenes`, `entities.panel.events`,
- `entities.panel.onPage`, `entities.panel.inChapter`, `entities.panel.empty`,
- `entities.empty.runAnalysis`,
- `booksettings.entities.label`, `booksettings.entities.hint` — in de + en.

## DB

- **MVP:** neue Migration → `ALTER TABLE books ADD COLUMN entities_enabled INTEGER NOT NULL DEFAULT 0`. Eintrag in [docs/erd.md](../erd.md) Book-Block ergänzen, `npm run squash:regen`, Drift-Tests gegen.
- **Phase 2 (Hybrid-Opt-in pro Buch):**
  - Erweiterung von `page_figure_mentions` um `offsets TEXT` (JSON-Array Int-Offsets, NULL bei nicht-persistierten Büchern), bzw. neue analoge Tabelle `page_location_mentions` mit `(page_id, location_id, count, offsets)` + FK auf `locations(id)` ON DELETE CASCADE + Index auf `page_id`.
  - Neue Spalte `books.entities_offsets_enabled INTEGER NOT NULL DEFAULT 0` als zweites Buch-Opt-in (unabhängig von `entities_enabled`, das nur das Feature aktiviert).
  - Backfill: Re-Extraktion oder dedizierter Offset-Backfill-Job auf vorhandenem Text — kein KI-Call, reines Index-Aufbauen.
  - Eigene Migration, ERD-Update, `npm run squash:regen` Pflicht.

## Security

- Read-only, buch-scoped über bestehende ACL. Popover- und Panel-Felder escaped. Kein neuer Angriffspfad.

## Telemetrie

- Optional: Counter „Entities-Toggle aktiviert", niedrige Prio. `n/a` für MVP.

## Reversibilität

- Feature-Flag (`FEATURE_ENTITY_LINKING` in app-state) → Toggle versteckt, Highlight + Panel no-op. Kein Daten-Rückbau nötig (nichts persistiert).

## Tests

- **Unit:** `buildRanges` — Wortgrenzen, Case-Insensitivität, Überlappungen (Figur „Anna" vs. „Annabelle"), Kollision Figur/Ort, leere Entitätsliste.
- **Unit:** Panel-Selektoren (Szenen/Ereignisse-Filter nach `page_id`).
- **Unit:** Save-Output enthält kein Entity-Linking-Markup (Invariante).
- **E2E (Notebook):** Toggle an → Highlights + Panel sichtbar; Hover → Popover; Klick → Karte öffnet; Panel-Klick → Szenen-/Ereignisse-Karte mit Scroll; Toggle aus → sauber; Seitenwechsel → keine Stale-Ranges.

## Edge-Cases

- Gleicher Name als Figur **und** Ort → Figur gewinnt, Orte-Highlight unterdrückt. Popover zeigt nur Figuren-Karte.
- Teilstring-Kollisionen („Anna" in „Annabelle") → nur ganze Wörter matchen.
- Sehr häufige Kurznamen → Performance: Range-Bau auf sichtbaren Block beschränken / debounce.
- Name mit Sonderzeichen/Bindestrich/Apostroph → robuste Wortgrenzen-Definition (`\p{L}\p{M}`-aware, nicht nur ASCII).
- Während aktivem Edit (Cursor im Text) → Highlights bei Eingabe neu berechnen oder bis Idle pausieren (kein Konflikt mit Caret).
- Szene/Ereignis ohne `page_id` (nur `chapter_id`) → eigene Sektion „Im Kapitel (ohne Seitenbezug)" pro Liste, gedimmt abgesetzt.
- Szene/Ereignis ohne `page_id` **und** ohne `chapter_id` → nicht im Panel (keine Bindung zur aktuellen Sicht).
- Mehrere Szenen/Ereignisse pro Seite → Liste sortiert nach `sort_order` (Szenen) bzw. `datum` (Ereignisse).
- Re-Extraktion während offener Notebook-View → Entity-State neu laden auf Daten-Event (`book:changed`, `figuren:updated`, `szenen:updated`).

## Kritische Dateien

- **Modify:** [public/js/editor/toolbar.js](../../public/js/editor/toolbar.js) (Toggle + Panel-Mount im Notebook-Pfad), [public/index.html](../../public/index.html) (CSS-Link), [public/sw.js](../../public/sw.js) (`SHELL_CACHE`), [public/js/i18n/de.json](../../public/js/i18n/de.json) + [en.json](../../public/js/i18n/en.json), [DESIGN.md](../../DESIGN.md), [db/migrations.js](../../db/migrations.js) (neue Migration), [db/schema.js](../../db/schema.js) (`saveBookSettings`, `getBookSettings`), [db/squashed-schema.js](../../db/squashed-schema.js) (Regen), [routes/booksettings.js](../../routes/booksettings.js) (Validate + Payload), [public/partials/book-settings.html](../../public/partials/book-settings.html) + [public/js/cards/book-settings-card.js](../../public/js/cards/book-settings-card.js) (Checkbox), [docs/erd.md](../erd.md) (Stand + Books-Block).
- **Create:** `public/js/editor/notebook/entities.js`, `public/css/editor/entities.css`, `tests/unit/entities-highlight.test.mjs`, `tests/unit/entities-panel-filter.test.mjs`.

## Offene Fragen

_Leer — alle Entscheidungen getroffen. Status kann auf `Ready` gesetzt werden._
