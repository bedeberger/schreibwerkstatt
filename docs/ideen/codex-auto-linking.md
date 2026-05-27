# Codex-Auto-Linking (Entitäten-Erwähnungen im Text live verknüpfen)

- **Status:** Draft
- **Aufwand:** M
- **Severity:** medium

## Context

Figuren und Orte werden bereits aus dem fertigen Text **extrahiert** (Komplettanalyse → `figures`, `locations`, `page_figure_mentions`). Diese extrahierten Entitäten sind aber tote Listen in eigenen Karten — beim Lesen/Editieren einer Seite sieht der Autor nicht, **wo** welche Figur/welcher Ort vorkommt, und kommt nicht mit einem Klick zur Stammkarte.

Novelcrafters „Codex" verlinkt jede Erwähnung im Text live zur Entitäts-Karte (Hover-Vorschau, Klick → Detail). Wir bauen dasselbe, aber **strikt rückwärtsgerichtet**: kein Generieren neuer Inhalte, nur Sichtbarmachen dessen, was die Analyse aus dem Text bereits abgeleitet hat. Reines Read-Overlay über bestehenden Extraktions-Daten.

**Prinzip-Treue:** Die KI generiert hier nichts. Highlighting + Hover-Karte sind deterministische Text-Matches gegen bereits extrahierte Entitätsnamen. Reverse-Engineering bleibt Reverse-Engineering.

## Scope MVP

- Im **Notebook-Editor** (Einzelseiten-Edit-Modus, `.page-content-view`) werden Erwähnungen extrahierter Figuren + Orte der aktuellen Seite via CSS Custom Highlight markiert (zwei Highlight-Register: `codex-figure`, `codex-location`).
- Match client-seitig: kanonischer `figures.name` / `locations.name` gegen den gerenderten Seitentext (case-insensitiv, Wortgrenzen). Quelle der relevanten Entitäten pro Seite: `page_figure_mentions` (Figuren) bzw. Orte über bestehende Orte-Liste des Buchs.
- Hover/Klick auf ein Highlight → Popover mit Stammdaten der Entität (Name, Typ, Kurzbeschreibung, bei Figuren Soziogramm-Rolle; „Zur Karte springen"-Link).
- Toggle in der Notebook-Toolbar: Codex-Highlights an/aus (Default aus — kein erzwungenes visuelles Rauschen beim Schreiben).
- Read-only: kein Markup im gespeicherten HTML, keine `data-bid`-Berührung, keine Persistenz im Page-Body. Highlights sind reine Range-Overlays.

## Out-of-Scope

- **Kein** Vorwärts-Generieren: keine „neue Figur anlegen aus Markierung", kein AI-Vorschlag für fehlende Entitäten. (Erkennen, dass ein Name noch nicht extrahiert ist, wäre Phase 2 und müsste über die bestehende Extraktions-Pipeline laufen, nicht über Inline-Generierung.)
- **Focus-Editor** und **Bucheditor**: Phase 2. MVP nur Notebook-Editor (siehe Offene Fragen).
- Alias-/Spitznamen-Auflösung (z. B. „der Hauptmann" → Figur X). MVP matcht nur den kanonischen Namen + triviale Varianten. Echte Koreferenz ist Analyse-Aufgabe, kein Client-Match.
- Manuelles Editieren der Verknüpfungen.

## Done when

- Bei offener Seite mit aktiviertem Toggle sind alle Vorkommen extrahierter Figuren-/Orte-Namen sichtbar markiert (zwei unterscheidbare Highlight-Stile).
- Hover zeigt Popover mit korrekten Stammdaten; Klick auf „Zur Karte" öffnet die jeweilige Karte (Figuren/Orte) und schließt den Editor regelkonform via `_closeOtherMainCards`.
- Toggle aus → keine Highlights, keine Reste in `CSS.highlights`.
- Seitenwechsel/Edit räumt Highlight-Ranges auf (keine Stale-Ranges auf altem DOM).
- Gespeichertes Seiten-HTML enthält keinerlei Codex-Markup (Diff vor/nach Save identisch).

## Hard-Rule-Audit

- **Editor-Spezifikation:** Betrifft MVP **nur Notebook-Editor**. Explizit so im Scope; Focus/Bucheditor out-of-scope. Pflicht-Invarianten der Notebook-Doku prüfen (kein Eingriff in Save-Pipeline/Draft).
- **Styles nur in `public/css/`:** Highlight-Stile via `::highlight(codex-figure)` / `::highlight(codex-location)` in neuer CSS-Datei unter `editor/`. Akzentfarbe über bestehende Tokens, keine Inline-Styles.
- **i18n:** Toggle-Label, Popover-Strings („Zur Karte", Typ-Labels) in beide Locale-Dateien.
- **Content-Store-Facade:** nur lesend; keine neuen Schreibpfade auf `pages`.
- **x-html-Escape:** Popover rendert Entitäts-Felder (KI-/User-Herkunft) → `escHtml()` vor jeder Interpolation.
- **A11y:** Popover-Trigger tastatur-erreichbar; klickbare Spans via `.internal-link`-Konvention.
- **DB-Integrität:** MVP ohne Schema-Änderung.
- **SHELL_CACHE bumpen** (neue JS/CSS).
- **CSS Custom Highlight** bereits etabliert (find.js, LanguageTool) — Muster wiederverwenden, kein neues Highlight-Framework.

## Abhängigkeiten

- Komplettanalyse muss gelaufen sein (sonst keine `figures`/`locations`/`page_figure_mentions`). Bei leerer Extraktion: Toggle deaktiviert + Hinweis.
- CSS-Custom-Highlight-Infrastruktur aus [public/js/editor/find.js](../../public/js/editor/find.js) als Referenz-Pattern.
- Notebook-Toolbar (`editor-toolbar`) für den Toggle.

## Backend

- MVP: **keine neuen Endpoints**. Figuren-/Orte-Stammdaten + `page_figure_mentions` werden über bestehende Lade-Pfade (`loadFiguren`, Orte-Liste, Seiten-Mentions) bereitgestellt.
- Phase-2-Option (genauere Mehrfach-Offsets statt Client-Match): Erwägung, `page_figure_mentions` um eine Offset-Liste zu erweitern oder eine analoge `page_location_mentions`-Tabelle anzulegen — nur falls Client-Match qualitativ nicht reicht (siehe Offene Fragen).

## Frontend

- Neue Editor-Sub-Komponente bzw. Erweiterung in [public/js/editor/](../../public/js/editor/): `codex-highlight.js` — pure Funktionen `buildRanges(text, entities)` + `applyHighlights()` / `clearHighlights()`.
- Toggle-State im Notebook-Toolbar-Slice; Default aus.
- Popover über bestehendes Tooltip-/Popover-Muster (kein neues Overlay-System).
- Match-Engine pure + testbar (Name-Liste + Text rein, Range-Deskriptoren raus).

## CSS

- Neue Datei [public/css/editor/codex-highlight.css](../../public/css/editor/codex-highlight.css): `::highlight(codex-figure)` / `::highlight(codex-location)` (dezente Unterstreichung/Tönung, zwei Akzente). Link in `index.html`, `SHELL_CACHE` bumpen, DESIGN.md-Inventar ergänzen.

## i18n

- `codex.toggle`, `codex.gotoCard`, `codex.figure`, `codex.location`, `codex.empty` (de + en).

## DB

- MVP: `n/a`.
- Phase 2 (optional): Offset-Tabelle für Orte / Offset-Liste für Figuren — eigene Migration mit FK + Index, ERD-Update, `squash:regen`.

## Security

- Read-only, buch-scoped über bestehende ACL. Popover-Felder escaped. Kein neuer Angriffspfad.

## Telemetrie

- Optional: Counter „Codex-Toggle aktiviert" (Usage), niedrige Prio. `n/a` für MVP.

## Reversibilität

- Feature-Flag (`FEATURE_CODEX_LINKING` in app-state) → Toggle versteckt, Highlight-Code no-op. Kein Daten-Rückbau nötig (nichts persistiert).

## Tests

- **Unit:** `buildRanges` — Wortgrenzen, Case-Insensitivität, Überlappungen (Figur „Anna" vs. „Annabelle"), leere Entitätsliste.
- **Unit:** kein Codex-Markup im Save-Output (Invariante).
- **E2E (Notebook):** Toggle an → Highlights sichtbar; Hover → Popover; Klick → Karte; Toggle aus → sauber; Seitenwechsel → keine Stale-Ranges.

## Edge-Cases

- Gleicher Name als Figur **und** Ort → Priorität definieren (Offene Fragen).
- Teilstring-Kollisionen („Anna" in „Annabelle") → nur ganze Wörter matchen.
- Sehr häufige Kurznamen → Performance: Range-Bau auf sichtbaren Block beschränken / debounce.
- Name mit Sonderzeichen/Bindestrich → robuste Wortgrenzen-Definition.
- Während aktivem Edit (Cursor im Text) → Highlights bei Eingabe neu berechnen oder bis Idle pausieren (kein Konflikt mit Caret).

## Kritische Dateien

- **Modify:** [public/js/editor/toolbar.js](../../public/js/editor/toolbar.js) (Toggle), [public/css/editor/](../../public/css/editor/) + `index.html` (Link), [public/sw.js](../../public/sw.js) (`SHELL_CACHE`), [public/js/i18n/de.json](../../public/js/i18n/de.json) + [en.json](../../public/js/i18n/en.json), [DESIGN.md](../../DESIGN.md).
- **Create:** `public/js/editor/codex-highlight.js`, `public/css/editor/codex-highlight.css`, `tests/unit/codex-highlight.test.mjs`.

## Offene Fragen

- MVP wirklich nur Notebook-Editor, oder gleich Focus mitnehmen (teilen `editor/shared/`)?
- Client-seitiger Name-Match ausreichend, oder Offset-Persistenz (Phase-2-DB) für Genauigkeit bei häufigen/mehrdeutigen Namen nötig?
- Namens-Kollision Figur ↔ Ort: welche Priorität / beide markieren?
- Alias-Matching ganz raus, oder minimaler Varianten-Satz (Vor-/Nachname separat)?
