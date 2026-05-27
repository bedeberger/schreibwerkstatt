# schreibwerkstatt

Schreiben, Lektorat und Buchanalyse mit KI. Inhalte (Bücher/Kapitel/Seiten) liegen lokal in SQLite und werden ausschliesslich über die Content-Store-Facade ([lib/content-store/](lib/content-store/)) gelesen und geschrieben. Deployment (LXC + systemd) und Env-Variablen: siehe [README.md](README.md).

**Lokal starten:** `npm install && npm start` (Port 3737). Tests: `npm test` (Playwright, erstmalig `npx playwright install chromium`).

## Vertiefende Dokus

Themen-Spickzettel ausgelagert (Drift-Schutz: CLAUDE.md-Regeln, Details in den Spickzetteln):

- [docs/jobs.md](docs/jobs.md) — Job-Queue: Lifecycle, `createJob`/`updateJob`/`failJob`, Dedup, Polling, Reconnect-Events.
- [docs/i18n.md](docs/i18n.md) — Key-Konvention, `t/tRaw`, Server-Status-Keys, `__i18n:`-Marker für persistierte Nachrichten.
- [docs/ai-providers.md](docs/ai-providers.md) — `callAI`-Vertrag, JSON-Parse-Fallback, Token-Budgets, Caching, Mutex bei Ollama/Llama, Retries.
- [docs/testing.md](docs/testing.md) — Wann Unit/Integration/E2E, Mock-AI-Setup, Harness-Konventionen, häufige Fallen.
- [docs/erd.md](docs/erd.md) — Schema-ERD (Mermaid) + offene Schema-Verbesserungen.
- [docs/figur-werkstatt.md](docs/figur-werkstatt.md) — Figuren-Werkstatt: jsMind-Mindmap, Import aus `figures`, Brainstorm-/Consistency-Jobs, Run-Historie, Hash-Permalinks.
- [docs/buchchat-tools.md](docs/buchchat-tools.md) — Agentic Buch-Chat: Tool-Inventar (20 Stück inkl. `final_answer`-Endpunkt), `ctx`-Vertrag, Truncation, Loop-Constraints, neues Tool anlegen.
- **Drei unabhängige Editoren — bei Änderungen MUSS der User nennen, welcher gemeint ist** (siehe Harte Regel „Editor-Spezifikation" weiter unten):
  - [docs/notebook-editor.md](docs/notebook-editor.md) — Notebook-Editor (Einzelseiten-Edit-Modus): `notebookEditMethods` am Root, Toolbar/Bubble/Slash-Card, Autosave (Idle 60 s / Max 120 s), Draft-Pipeline, Stale-Write-Schutz, Findings-Mark-Watcher, Snapshot, Pflicht-Invarianten.
  - [docs/focus-editor.md](docs/focus-editor.md) — Focus-Editor (Vollbild-Schreibmodus auf einer Seite): State-Machine, Submodule (`focus/`), Trampoline-Pattern, Granularitäten, Recenter-Pipeline, Auto-`<p>`-Slot, Snapshot, Pflicht-Invarianten.
  - [docs/book-editor.md](docs/book-editor.md) — Bucheditor (Manuskript-Stream über das ganze Buch): Block-Liste, Klick-aktiviert-Block, Save-Queue, Pre-Conflict-Check, Find/Replace via CSS Custom Highlight, Outline/TOC, Pflicht-Invarianten.
- [docs/state-modell.md](docs/state-modell.md) — Frontend-State-Modell: 3 Ebenen (Root/Sub/Store), 14 Slices, Lifecycle, `setupCardLifecycle`, Event-Bus, Editor-Modi (Notebook/Focus-Flags + Bucheditor-Karte, Invarianten, erlaubte Kombinationen).
- [docs/buchorganizer.md](docs/buchorganizer.md) — Buchorganizer: Slice-Layout, In-Place-Mirror, Undo/Redo-Regeln, DnD-Pitfalls, Pflicht-Mutationssequenz.
- [docs/graph.md](docs/graph.md) — Figuren-Graph: 3 Modi (Swimlane/Familie/Soziogramm), vis-network-Internals, deterministisches Layout, neuen Beziehungstyp einbinden.
- [docs/finetuning.md](docs/finetuning.md) — Finetune-Export.
- [docs/folder-import.md](docs/folder-import.md) — Folder-Import: ZIP mit YYYY/Monat/Tag-Struktur, Kapitel pro Jahr, Date-Detect mit AI-Fallback.
- [docs/chapter-hierarchy.md](docs/chapter-hierarchy.md) — Kapitel-Hierarchie (max 3 Ebenen): Schema (`parent_chapter_id`), SSoT-Tree, Organizer-DnD/Tab-Indent, Sidebar-Indent, Kapitel-Review inkl. Sub-Kapitel, PDF/Export-Builder Depth-Mapping, Pflicht-Invarianten.
- [docs/languagetool.md](docs/languagetool.md) — LanguageTool-Integration (Self-Hosted, regelbasiert, sync Proxy als Ausnahme zur Job-Queue-Regel): Dispatch über 3 Editoren + Form-Felder, CSS-Custom-Highlights für Squiggles, Chunking + Per-Page-Cache, Custom-Dictionary, Extension-Konflikt-Detection, Pflicht-Invarianten.
- [docs/share-link.md](docs/share-link.md) — Share-Link (Page/Chapter public via opaken Token): SSR-Reader-View ohne Alpine, Mount **vor** Auth-Guard, In-Memory-Rate-Limit + Honeypot, IP-Hash für GDPR, Owner-Karte mit Unread-Tracking via `owner_last_seen_at`.
- [docs/metrics-api.md](docs/metrics-api.md) — Metrics-API: `GET /metrics` im Prometheus-Text-Format (HA/Grafana/Prometheus), Bearer-Token-Auth mit Scopes, `api_tokens`-Lifecycle, exponierte Kennzahlen-Liste, Pflicht-Invarianten.
- [docs/blog-sync.md](docs/blog-sync.md) — Blog-Sync (Buch ↔ WordPress, Buchtyp `blog`): Initial-Import + Pull + Push, LWW-Konfliktstrategie, Gutenberg-Block-Mapping, Buchorganizer-Status-Badges.
- [docs/hubspot-sync.md](docs/hubspot-sync.md) — HubSpot-Sync (Buch ↔ HubSpot-Blog, Buchtyp `blog`): einmaliger Initial-Import + Create-Draft-Push (kein Update, kein Pull-Back), PAT-Auth, Rate-Limit-Bucket.
- [docs/homeassistant/](docs/homeassistant/) — Home-Assistant-Integration: `rest`-Sensor-Config + Template-Sensoren + fertiges Lovelace-Dashboard, deckt alle Metriken ab.

## Feature-Pläne

Neue grössere Features werden vor Implementierung als Plan unter [docs/ideen/](docs/ideen/) festgehalten — Skelett: [docs/ideen/_template.md](docs/ideen/_template.md) (verbindliche Sektionsreihenfolge: Header mit Status/Aufwand/Severity, Context, Scope MVP, Out-of-Scope, Done when, Hard-Rule-Audit, Abhängigkeiten, Backend, Frontend, CSS, i18n, DB, Security, Telemetrie, Reversibilität, Tests, Edge-Cases, Kritische Dateien Modify/Create, Offene Fragen). Plan kopieren, Status `Draft` → `Ready` erst wenn „Offene Fragen" leer. Optionale Sektionen als `n/a` markieren statt entfernen (Drift sichtbar).

## Doku-Stil dieser Datei

CLAUDE.md beschreibt **ausschliesslich den aktuellen Stand**. Keine Historie, keine Migrationsanleitungen, keine „statt X" / „ersetzt Y" / „alte Variante" / „vorher war …" / „Bug-Symptom"-Erzählungen mit konkreten Symptom-Werten. Wer wissen will, was früher anders war, liest `git log`/`git blame`. Beim Refactor: alten Pfad ersatzlos aus der Datei entfernen, nicht als „migriert von" mitschleppen. **Why:**/**Begründungen** für aktuelle Constraints und Invarianten bleiben — sie erklären den aktuellen Code; Bug-Narrative aber nicht.

## Harte Regeln

- **Editor-Spezifikation Pflicht** — die App hat **drei unabhängige Editoren**: **Notebook-Editor** (Einzelseiten-Edit-Modus, [docs/notebook-editor.md](docs/notebook-editor.md), Code `public/js/editor/notebook/`, Klassen `.page-content-view*`), **Focus-Editor** (Vollbild-Schreibmodus auf einer Seite, [docs/focus-editor.md](docs/focus-editor.md), Code `public/js/editor/focus/`, Klassen `.focus-editor*`) und **Bucheditor** (Manuskript-Stream über das ganze Buch, [docs/book-editor.md](docs/book-editor.md), Code [public/js/cards/book-editor-card.js](public/js/cards/book-editor-card.js), Klassen `.book-editor-*`). Bei Änderungs-/Bugfix-/Refactor-Wünschen **immer** zuerst klären, welcher Editor gemeint ist — Begriffe wie „der Editor", „Edit-Modus", „im Editor" sind mehrdeutig. Bei Unklarheit explizit nachfragen, nicht raten. Gilt auch für Cross-Cutting-Änderungen (Save-Pipeline, Toolbar, Find/Replace): wenn eine Änderung nur einen Editor betreffen soll, das im Diff sichtbar machen; wenn sie alle drei betrifft, jeden Editor einzeln auflisten und Pflicht-Invarianten der jeweiligen Doku prüfen. Notebook + Focus teilen `public/js/editor/shared/` (Save-Pipeline, html-clean) — das ist Implementierungs-Detail, nicht „die zwei sind ein Editor".
- **UI-Patterns nur aus [DESIGN.md](DESIGN.md)** — vor jeder neuen UI-Komponente (Karte, Toggle, Badge, Liste, Status, …) den Pattern-Katalog prüfen. Wiederverwenden statt parallel neu erfinden. Existiert das Pattern nicht: erst dokumentieren in `DESIGN.md` (Markup-Snippet + CSS-Datei + Use-Case), dann verwenden. Klappbare Sections nutzen ausschliesslich das `.collapsible-toggle` + `.history-chevron`-Pattern (kein `<details>`/`<summary>`, kein neuer Marker). Akzentfarben pro Karte über `--card-accent-xxx` aus `tokens.css`.
- **Prompts nur unter `public/js/prompts/` (Facade `public/js/prompts.js`)** — einzige Quelle für alle Prompt-Schemas und Build-Logik. Externe Imports gehen ausschliesslich über die Facade `prompts.js`; Submodule (`prompts/lektorat.js`, `prompts/komplett.js`, `prompts/chat.js`, …) sind interne Aufteilung. Server importiert die Facade via dynamic `import()`. NIEMALS Prompts in Route-Handlern, Config-Dateien oder anderswo duplizieren.
- **KI-Calls nur via Job-Queue** — neue Features implementieren einen Job-Typ in `routes/jobs/` (Funktion `runXxxJob` + `router.post`). Direkte synchrone KI-Calls aus Route-Handlern sind verboten.
- **`callAI` gibt nur JSON zurück** — jeder Systemprompt muss JSON-Only erzwingen (`JSON_ONLY`-Konstante in `prompts/state.js`). Nach jedem `callAI`-Aufruf Pflichtfeld prüfen (z.B. `fehler`, `gesamtnote`, `figuren`). Fehler werfen statt falsche Daten rendern. **`truncated`-Flag IMMER vor `parseJSON` prüfen und werfen** — `jsonrepair` ist tolerant und liefert sonst Partial-Daten zurück (verhindert „silent partial"-Bug).
- **Styles nur in `public/css/`** — keine Inline-`style`-Attribute, keine `<style>`-Blöcke im HTML. CSS in 8 thematische Subfolder aufgeteilt: [layout/](public/css/layout/), [components/](public/css/components/), [page/](public/css/page/), [editor/](public/css/editor/), [entities/](public/css/entities/), [analysis/](public/css/analysis/), [admin/](public/css/admin/), [book/](public/css/book/). Plus [book-overview/](public/css/book-overview/) (dichtes Tile-Grid) und [tokens/](public/css/tokens/) (Custom-Properties). Root behält nur Facade ([tokens.css](public/css/tokens.css), [card-accents.css](public/css/card-accents.css)) + Solitäre ohne Geschwister ([chat.css](public/css/chat.css), [search.css](public/css/search.css), [tokens-est.css](public/css/tokens-est.css), [landing.css](public/css/landing.css)). Cascade-Reihenfolge via `@layer base, components, utilities;` in [public/css/tokens.css](public/css/tokens.css) (Facade — `@import` der Token-Module aus [public/css/tokens/](public/css/tokens/); tokens unlayered, Custom-Props global). Neue Datei → in passenden Subfolder einsortieren oder neue Datei anlegen + in [public/index.html](public/index.html) als `<link>` ergänzen + `SHELL_CACHE` in [public/sw.js](public/sw.js) bumpen + Eintrag in [DESIGN.md](DESIGN.md) „CSS-File-Inventar" ergänzen. [tests/fixtures/focus-harness.html](tests/fixtures/focus-harness.html) lädt absichtlich nur Minimal-CSS für Focus-Editor-E2E-Tests (tokens, editor/focus-mode, components/job-toast, page/page-revision-viewer, components/user-chip) — neue Datei dort **nur** ergänzen, wenn der Focus-Editor-DOM-Pfad sie konsumiert; Reihenfolge dann analog index.html. **Neues Token (Farbe, Spacing, Motion, Z-Index, Scale): in passende Datei in `public/css/tokens/` ergänzen — der Facade-`<link>` reicht (kein zusätzlicher Link nötig).** **Karten-Akzentfarbe: Hue als `--card-accent-<key>` in [public/css/tokens/colors.css](public/css/tokens/colors.css) (Light + Dark) + Mapping `.card--<key> { --card-accent: var(--card-accent-<key>); }` in [public/css/card-accents.css](public/css/card-accents.css) (SSoT). Pro-Karten-CSS konsumiert `var(--card-accent)`, deklariert nicht selbst.**
- **UI-Strings nur in `public/js/i18n/{de,en}.json`** — keine hartcodierten deutschen/englischen Texte in HTML-Partials, JS-Modulen oder Alpine-Templates. Immer `t('bereich.feld')` (bzw. `tRaw()` ausserhalb von Alpine) verwenden. Neuer String → Key in **beiden** Locale-Dateien ergänzen (de = Fallback, en = Übersetzung). Key-Konvention: `bereich.feld` (z.B. `profile.title`). Platzhalter via `{name}` + Parameter-Map.
  - **Gilt auch serverseitig:** `updateJob`/`failJob`-`statusText` immer als i18n-Key setzen (z.B. `'job.phase.aiReply'`), dynamische Werte als `statusParams`-Objekt. Job-Labels via `{ key, params }` an `createJob`. Fehler-Messages, die der User sieht, ebenfalls als Key.
  - **Automatisch übersetzen, ungefragt:** jeder neue User-sichtbare String wird beim Hinzufügen sofort in beide Locale-Dateien eingetragen — egal ob Frontend-Label, Server-Status, Fehlertext, Placeholder oder Tooltip. Nie nur DE (oder nur EN) committen und auf „mach ich später" verschieben.
  - **Persistierte User-Nachrichten (z.B. Chat-Fallbacks in DB):** als `__i18n:bereich.feld__`-Marker speichern; Frontend löst beim Rendern via `t()` auf. So bleibt die Locale-Wahl des späteren Betrachters massgeblich.
  - **Ausnahme:** Winston-Logs (`logger.info/warn/error`) bleiben vorläufig deutsch — sie gehen nur in `schreibwerkstatt.log`/Console, nicht an den User.
- **Content-Store-Facade als einziger Eintrittspunkt für Buchinhalte** — Pages/Chapters/Books werden ausschliesslich via `require('lib/content-store')` gelesen und geschrieben. Direkte SQL-Zugriffe auf `pages`/`chapters`/`books` aus Route-/Job-Handlern sind verboten.
- **Block-IDs (`data-bid`) als Write-Path-Invariante** — `lib/html-clean.js#ensureBlockIds` vergibt stabile 8-Byte-Hex-IDs auf allen Block-Tags (`p,h1-h6,ul,ol,blockquote,pre,hr,figure,table,div.poem`). Aufruf **nur** am Page-Write-Chokepoint ([lib/content-store/backends/localdb.js](lib/content-store/backends/localdb.js)#`_cleanHtmlSafe`), **nicht** in `cleanPageHtml` (sonst landen IDs auch in Export/WP-Sync). Idempotent (bestehende IDs bleiben), Duplikate werden neu vergeben. Basis für den Block-Level-Merge ([public/js/editor/shared/block-merge.js](public/js/editor/shared/block-merge.js)) bei Stale-Write in **Notebook + Focus** (Flag `FEATURE_BLOCK_MERGE` in [app-state.js](public/js/app/app-state.js)): `base = originalHtml`, kollisionsfrei → stiller Auto-Merge, echte Block-Kollision → Auflösungs-Modal ([partials/conflict-resolution.html](public/partials/conflict-resolution.html), Previews via `x-text`). `data-bid` nicht strippen; Merge-Engine ist pure + client-seitig. Bucheditor unberührt. Details: [docs/notebook-editor.md](docs/notebook-editor.md#block-level-merge-bei-stale-write). Tests: [tests/unit/block-merge.test.mjs](tests/unit/block-merge.test.mjs), [tests/unit/html-clean-blockids.test.mjs](tests/unit/html-clean-blockids.test.mjs).
- **HTML→Text-Normalisierung für Stats: Frontend MUSS Server matchen** — `page_stats.chars`/`words`/`tok` werden auf zwei Pfaden befüllt: a) Server-Sync ([routes/sync.js](routes/sync.js)#htmlToText: Tags zu Single-Space, `\s+` collapsed, getrimmt) und b) Frontend nach Page-Save ([tree.js](public/js/book/tree.js)#`_syncPageStatsAfterSave`). Beide Pfade MÜSSEN dieselbe Normalisierung verwenden. `DOMParser().body.textContent` behält Whitespace zwischen Block-Tags und bläst `tokEsts.chars` gegenüber dem Cron-Snapshot auf — Frontend-Save-Pfad nutzt deshalb dieselben zwei Regex-Replacements wie Server. `tok = Math.round(chars / CHARS_PER_TOKEN)` (Text-Tokens, gleiche Quelle wie chars; kein Prompt-Overhead). Beide Pfade müssen die Formel synchron halten. `/history/page-stats/batch` persistiert blind, kein Server-Recompute. Test: [tests/unit/page-stats-normalization.test.mjs](tests/unit/page-stats-normalization.test.mjs).
- **Job-Ergebnisse mit `updatedAt`-Staleness-Check** — Server-Jobs, deren Resultate auf einem Snapshot des Seitenstands operieren (Lektorat-Findings mit Positionen, Chat-Antworten mit `vorschlaege.original`), liefern `updatedAt: pd.updated_at`. Der Client vergleicht im `onDone` mit `currentPage.updated_at`; weicht es ab (User hat während der Analyse gespeichert), wird das Ergebnis verworfen statt angewandt.
- **401-Handling zentral** — ein globaler `window.fetch`-Wrapper in `public/js/app.js` fängt alle 401-Antworten ab und dispatcht `session-expired`; Alpine zeigt daraufhin den Session-Banner. Feature-Module prüfen 401 nicht selbst und dürfen das Event nicht unterdrücken. Kein Auto-Redirect – User soll ungespeicherte Inhalte retten können.
- **Logging-Context: `book` immer mitgeben** — jede neue Route mit Buchscope MUSS den `book`-Slot im Log-Tag `[scope|user|book|jobId]` füllen, damit Buch-scoped Requests filterbar bleiben.
  - **URL-Param-Routes (`:book_id`):** im Router einmalig `router.param('book_id', bookParamHandler)` aus [lib/log-context.js](lib/log-context.js) registrieren — deckt alle `:book_id`-Routes dieses Routers ab.
  - **Body/Query-Routes:** Handler nach `toIntId`-Validierung `setContext({ book: bookId })` (Import aus `lib/log-context`). Bei Routen, die `bookId` indirekt laden (z.B. via `session.book_id`, `draft.book_id`), nach DB-Read setzen.
  - **Job-Worker:** automatisch — `routes/jobs/shared/queue.js#drainQueue` zieht `job.bookId` in den ALS-Context. Pflicht ist nur, dass `createJob(type, bookId, …)` korrekt gefüllt wird.
  - **Why:** Worker-Logs zeigten Buch-ID; HTTP-Routes nicht → inkonsistente Tags. Sucht man Logs zu einem Buch, fehlt sonst die halbe Lifecycle-Spur (POST + Job + Sync).
- **`x-html` nur mit vorab-escaptem Content** — jede Stelle, die ins `x-html` fliesst, muss KI-/User-Felder vor der Interpolation durch `escHtml()` aus `utils.js` geschleust haben. Gilt für Status-Strings (`_runningJobStatus`), Review-Renderer (`_renderReviewHtml`, `_renderKapitelReviewHtml`), Lektorat-Output (`analysisOut`), Chat-Markdown (`renderChatMarkdown` escaped als erstes). Keine neuen `x-html`-Sinks ohne dieses Escape. Keine Runtime-Sanitizer wie DOMPurify – die Escape-Invariante reicht.
- **A11y: klickbare Nicht-Buttons** — Elemente mit Klasse `.internal-link` (spans/divs mit `@click`) werden global in `app.js` via MutationObserver + Event-Delegation tastatur-erreichbar gemacht (`role="button"`, `tabindex="0"`, Enter/Space → click). Nicht pro Element wiederholen. Neue klickbare Nicht-Buttons → einfach `.internal-link` setzen.
- **Kein globaler Fokus-Ring** — Browser-Default-Outline bleibt aktiv; per-Element-Fokus-Styles für Tab-Navigation (Skip-Link, `.page-item`, `.tree-chapter-header`, `.lektorat-split-findings .finding`) leben in [public/css/layout/base.css](public/css/layout/base.css). Komponenten mit eigenem Fokus-Signal (Border-Color, Background-Tönung, Inset-Outline) setzen `outline: none` ohne `!important`. Kein wildcard-`:focus-visible`-Token mehr; kein `!important`-Override für Outline-Disable.
- **Progress-Bars** — `.progress-bar` liest die Breite aus CSS-Custom-Prop `--progress`. Binding: `:style="{ '--progress': xProgress + '%' }"`, nicht `:style="'width:' + ... + '%'"`.
- **Card-Animationen nur via CSS** — `.card` fadet via `cardFadeIn` (in [public/css/components/card-form.css](public/css/components/card-form.css)) ein. Kein `x-transition` zusätzlich auf `.card`-Elementen, sonst doppelt (CSS translateY + Alpine scale konkurrieren, wirkt wabbelig). Neue Karte: nur `x-show="..." x-cloak`, keine Alpine-Transition.
- **`SHELL_CACHE` bumpen** — bei JS/CSS-Änderungen Konstante in [public/sw.js](public/sw.js) hochzählen. Sonst halten Mobile-Browser via Service-Worker alte Bundle-Versionen fest.
- **`sortableTable` Pflicht für Tabellen** — jede `<table>` mit >3 Datenzeilen nutzt `Alpine.data('sortableTable')` aus [public/js/sortable-table.js](public/js/sortable-table.js). Kein nacktes `<table>` für Listen-/Admin-/Verwaltungs-Views. Pflicht-Pattern: `x-data="sortableTable({ rows: () => …, defaultKey, types, persistKey })"` am `<table>`; jede sortierbare `<th>` bekommt `class="sortable-th"` + `:class="sortClass('key')"` + `:aria-sort="ariaSort('key')"` + `@click="sortBy('key')"`; `<tbody>` rendert `sorted` (nicht die Quell-Liste). `rows` ist eine **Funktion** (Getter) — reagiert auf Quelländerungen. `types: { col: 'number'|'date'|'string' }` pro Spalte mit nicht-eindeutiger Auto-Detection. `persistKey` für localStorage-Persist. Ausnahmen ausschliesslich: Server-Pagination/-Sort, Presence-Matrizen, Heatmap-Tabellen — siehe DESIGN.md „Sortierbare Tabelle" → „Wann nicht". Bei Berührung einer bestehenden Tabelle: mitziehen, nicht „später".
- **Combobox statt `<select>`** — alle Auswahlfelder nutzen `Alpine.data('combobox')` aus [public/js/app.js](public/js/app.js). Kein natives `<select>` für neue Features, ausser bei zwingendem Grund (z.B. native Mobile-Picker erwünscht — dann begründen). `init()` rendert Trigger + Dropdown + Search + Liste komplett selbst und überschreibt `innerHTML` des Wrapper-Divs. Wrapper-Div **leer lassen**, nur Attribute setzen. Pflicht-Pattern (3 Attribute):
  ```html
  <div x-data="combobox(placeholder, emptyLabel?)"
       x-modelable="value" x-model="selectedRef"
       x-effect="options = computeOptionsInline()"></div>
  ```
  - `init()` setzt automatisch: `combobox-wrap`-Klasse (+ `--compact` per Default), document-Mousedown (Outside-Close), Element-Keydown (Tastatur-Nav). Kein `@click.outside`, kein `@keydown`, keine `class`-Attribute mehr im Konsumenten-Markup.
  - Object-Form für Variante non-compact (selten, z.B. Buchwahl in Hero-Row): `combobox({ placeholder: t('…'), compact: false })`.
  - `options`: Array `[{ value, label }]`. Inline-Expression im `x-effect` aufbauen (siehe DESIGN.md "Reaktivität bei Datenquelle aus Karten-Scope" — Method-Indirection trackt nicht zuverlässig).
  - `x-modelable="value" x-model="ref"` koppelt internen `value`-State an äusseres Feld. Ohne `x-modelable` greift `@combobox-change` nicht in den Parent-State durch.
  - `emptyLabel` (2. Positional-Arg oder `{emptyLabel}`) erzeugt „Alle"-Option mit Wert `''`. Weglassen für Pflichtauswahl.
  - Optional `@combobox-change="…"` für Side-Effects bei Auswahl.
  - Referenz: [public/index.html](public/index.html) (Buchwahl, non-compact), [public/partials/szenen.html](public/partials/szenen.html) (Filter-Combobox).
- **`numInput` statt `<input type="number">`** — alle Zahlen-Felder nutzen `Alpine.data('numInput')` aus [public/js/num-input.js](public/js/num-input.js). Native `type=number` versteckt Tausender-Separatoren und akzeptiert nur Browser-Locale-Decimal — Swiss-User (de-CH: `.`-Decimal, `’`-Tausender) sehen falsche Anzeige. Pflicht-Pattern (3 Attribute):
  ```html
  <input type="text"
         x-data="numInput({ step: 0.1, min: 0, max: 2 })"
         x-modelable="value" x-model="form['key']">
  ```
  - `init()` setzt `inputmode`/`autocomplete`/`spellcheck` und hängt Event-Handler an — keine `@input/@blur/@focus` im Konsumenten.
  - Config: `step`, `min`, `max`, optional `decimals` (sonst aus `step` abgeleitet), `integer: true` (Shortcut für step=1+inputmode=numeric), `grouping: false` (Tausender unterdrücken).
  - Anzeige nutzt `uiLocale` (de→de-CH, en→en-US). Bei Focus rohe Edit-Form ohne Tausender; bei Blur reformatiert + clamped.
  - Parser akzeptiert sowohl `.` als auch `,` als Decimal — User-Habit-tolerant.
  - **Niemals** `x-model.number` parallel — der Component-State ist bereits Number.
- **LanguageTool auf Prosatextfeldern Pflicht** — jedes `<input type="text">` und `<textarea>`, in das User Prosatext eingibt (Buch-/Seiten-/Kapiteltitel, Notizen, Beschreibungen, Einleitungen, Ideen, Freitext-Kontext, Widmung, Impressum, neuer-Kapitel-/Seiten-Name), bekommt `data-spellcheck="spelling"`. Der globale Dispatcher ([public/js/cards/editor-spellcheck/dispatch.js](public/js/cards/editor-spellcheck/dispatch.js)) hängt sich beim Focus dran, wickelt das Feld in `<span class="lt-field-wrap">` (siehe DESIGN.md „Spellcheck-Badge auf Form-Feldern") und zeigt Tippfehler-Badge + Popover. **Why:** ohne harte Regel driftet das pro Karte auseinander (manche Felder geprüft, andere nicht), und User-sichtbare Inhalte wie Titel/Einleitungen brauchen Spellcheck genauso wie Seiten-Body. **How to apply:** neues Prosa-Feld → Attribut setzen, fertig. **Ausnahmen** (kein Spellcheck): Suchfelder/Filter (`.filter-search-input`, Sidebar-Suche, Palette), `numInput`-Zahlenfelder, Admin-/technische Settings (Modell-IDs, URLs, Tokens, Pfade), Find/Replace-Eingaben (User sucht ggf. nach Fehlern — kein Selbst-Meckern), Readonly-Anzeigen (Share-URLs), `<input type="password">`.
- **File-Limits / Modularität** — JS-Module > 600 LOC, HTML-Partials > 250 LOC, CSS-Files > 600 LOC werden gesplittet in `<name>/`-Subfolder mit thematischen Sub-Files. Pattern: Facade-File `<name>.js` re-exportiert Sub-Module; Sub-Module gruppieren Methoden nach Domäne (z.B. `load/stats/coverage/figuren/orte/kapitel/recent/format`). Beispiele: [public/js/prompts/](public/js/prompts/), [public/js/book-overview/](public/js/book-overview/), [public/css/book-overview/](public/css/book-overview/), [public/css/components/](public/css/components/), [public/partials/bookoverview-*.html](public/partials/bookoverview-snapshot.html). HTML-Partials werden via `_loadPartials` mit `<div id="partial-<name>">`-Placeholdern nested geladen (5-Pässe-Schleife, max 1-2 Verschachtelungstiefen). CSS-Subfolder via einzelne `<link>`-Tags in [public/index.html](public/index.html) (Cascade-Order = Lade-Order, base zuerst). Tile-Compute-Methoden, die mehrfach pro Render gerendert werden, sind Pflicht-memoized.
- **Memo-Pattern: ein Helper pro Modul** — Aggregat-Methoden, die im Template mehrfach pro Render aufgerufen werden, MÜSSEN memoized sein. Genau **ein** `_memo(key, deps[], fn)`-Helper pro Modul mit Array-Deps-Vergleich (shallow `===`). Kein Mix aus `_memo`/`_memoN`/handrolled Cache-Vergleichen. Helper auf `this`, gemeinsamer `this._memos`-Speicher pro Card-Instanz. `loadXxx`/`resetXxx` weisen `this._memos = {}` zu (Cache-Reset bei Daten-Reload). Pure Compute-Body (ohne `this._memo`) als `_computeXxx` extrahieren, vom memoizierten Wrapper aufrufen — testbar ohne Alpine. Referenz: [public/js/book-overview/load.js](public/js/book-overview/load.js)#`_memo`.
- **State explizit deklariert** — fachlicher Karten-State gehört entweder in `app-state.js` (wenn root-relevant) oder als Initial-Feld im `Alpine.data`-Objekt. Lazy `this._privates`, die nur in Methoden auftauchen, sind verboten — nicht inventarisierbar via Lookup. Ausnahme: kurzlebige Re-Entry-Guards in async-Methoden (z.B. `_loadingBookId`, `_staleCheckBookId`), wenn klar als solche dokumentiert.
- **Ein Attribut, eine Deklaration** — kein `:foo` (oder `foo`) doppelt am gleichen HTML-Element. Browser nimmt letzte Version, erste wird stillschweigend verworfen → toter Code mit irreführendem Code-Review-Eindruck. Gilt auch für `:class`/`:style` mit Object-Form. Mehrere Zustände → eine Deklaration mit Ternary/Object.
- **CSS: Selektor unique pro Datei** — keine Doppel-Definition desselben Selektors im selben File. Bewusste Variation läuft über klar abgegrenzte Variant-Klasse, nicht über Re-Definition. Selektor-Duplikate erzeugen toten Code: zweite Deklaration überschreibt nur ihre eigenen Properties, erste bleibt für nicht-überschriebene Properties aktiv — schwer durchschaubar.
- **Mobile-Strategie pro Komponente** — entweder Media-Query (Viewport-bezogen) ODER Container-Query (Tile-bezogen) für dieselbe Regel, nicht beide. Container-Query bevorzugt, wenn Komponente in variablem Layout-Slot lebt (z.B. dichtes Grid mit Tile-Span). Mobile-Regeln stehen im selben File wie die zugehörige Komponente — kein zentrales `mobile.css`.
- **DB-Timestamps: ISO+Z via `NOW_ISO_SQL`** — alle `*_at`-Spalten (`created_at`, `updated_at`, `last_seen_at`, …) speichern ISO-8601 mit Z-Suffix. In Code-Pfaden (INSERT/UPDATE in `db/*.js`, `routes/*.js`, `lib/*.js`): `${NOW_ISO_SQL}` aus [db/now.js](db/now.js) interpolieren, **niemals `datetime('now')` inline**. In neuen Migrationen + CREATE-TABLE-Blöcken: Default `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` statt `(datetime('now'))`. INSERT-Statements liefern Timestamp-Spalten **explizit** (Spalte in Column-List + `${NOW_ISO_SQL}` in VALUES) — Default-Fallback ist drift-anfällig (Frontend kriegt sonst „YYYY-MM-DD HH:MM:SS" UTC-no-Z, JS parsed als lokale Zeit und `toLocaleString({ timeZone: appTimezone })` zeigt UTC-Uhr unter app.timezone-Label). Reine Vergleichs-WHERE-Clauses (`WHERE datetime(col) < datetime('now')`) dürfen `datetime('now')` behalten — beide Seiten via `datetime()` parsen ISO+Z und das alte Format gleich.
- **Frontend-Datums-Display: nur via `tzOpts()`** — `toLocaleString`/`toLocaleDateString`/`toLocaleTimeString`/`Intl.DateTimeFormat`-Calls für Datums-/Uhrzeit-Display (nicht reine Zahlen) IMMER mit `tzOpts(opts)` aus [public/js/utils.js](public/js/utils.js) wrappen — Helper mergt `timeZone: appTimezone`. Tag-Bucketing (heute/gestern, Streak-Buckets, Day-Diff) via `localIsoDate()` (TZ-aware), nicht via `d.getFullYear/Month/Date()` (Browser-TZ). Server-Pendant: [lib/local-date.js](lib/local-date.js) liest dieselbe Setting (`app.timezone`).


## Neues Feature hinzufügen

### Backend (KI-Job)

1. Job-Datei in `routes/jobs/` anlegen (Pattern: siehe `routes/jobs/review.js`)
2. `runXxxJob`-Funktion + `router.post('/xxx', ...)` implementieren
3. Router in `routes/jobs.js` mounten
4. Prompt-Builder im passenden Submodul unter `public/js/prompts/` ergänzen (z.B. `prompts/komplett.js` für Pipeline-Prompts, `prompts/review.js` für Bewertungen) und in der Facade `public/js/prompts.js` re-exportieren — **bei schemarelevanter Änderung `PROMPTS_VERSION` (in `prompts/core.js`) bumpen** (invalidiert `chapter_extract_cache`/`book_extract_cache` (Komplettanalyse), `chapter_review_cache`/`book_review_cache` (Buchbewertung), `chapter_macro_review_cache` (Kapitelbewertung), `synonym_cache`, `lektorat_cache`)
5. Schema-Validierung nach `callAI` nicht vergessen
6. Dedup-Check im POST-Handler: `findActiveJobId(type, entityId, userEmail)` aus `routes/jobs/shared/` (NICHT `runningJobs.get(...) && jobs.has(...)` — matcht sonst auch fertige Jobs)
7. Logging-Context: `setContext({ book: book_id })` (aus [lib/log-context.js](lib/log-context.js)) im POST-Handler nach `toIntId`-Validierung, damit der `book`-Slot im Log-Tag gefüllt ist (siehe Harte Regel „Logging-Context")

### Frontend (neue Karte als `Alpine.data`-Sub-Komponente)

Der Frontend-Scope ist in **Alpine.data-Sub-Komponenten** aufgeteilt:
- **Root** (`x-data="lektorat"` am `<body>`): Navigation (`selectedBookId`, `pages`, `tree`), Session, i18n, `showXxxCard`-Flags (Single Source of Truth für Hash-Router + Exklusivität), Job-Queue-Footer, globale Cross-Cutting-Methoden (`t`, `loadFiguren`, `selectPage`, `gotoStelle` …).
- **Sub-Komponenten** in [public/js/cards/](public/js/cards/) — eine pro UI-Karte. Buchebene: Figuren, Orte, Szenen, Ereignisse, Stil, Fehler-Heatmap, BookStats, BookSettings, UserSettings, Kontinuität, Ideen, Finetune-Export, PDF-Export, Buch-Overview, Buch-Chat, Buch-Review, Kapitel-Review, Palette. Editor-Subs: editor-find, editor-synonyme, editor-figur-lookup, editor-toolbar, editor-focus, lektorat-findings, page-history. Plus Seiten-Chat. Jede besitzt fachlichen State + Lifecycle.
- **Im Root** verbleibt: `page-view`, `editor/edit`, `editor/utils`, Hash-Router, Auto-Save, Selection-Management, Navigation. Editor-UI-Slices laufen als eigene Cards mit Trampoline-Events aus dem Root (z.B. `editor:focus:toggle`).

**Neue Karte anlegen:**
1. Fachmodul in `public/js/` → Methods-Export (`export const xxxMethods = { ... }`), Root-Zugriffe via `window.__app.xxx` (siehe unten).
2. Sub-Komponente in `public/js/cards/xxx-card.js` → `Alpine.data('xxxCard', () => ({ ...state, init(), destroy(), ...xxxMethods }))`, registriert als `registerXxxCard()` und in `app.js` aufgerufen.
3. Partial in `public/partials/xxx.html` mit `x-data="xxxCard"` am Wurzel-`<div class="card">`. Root-Zugriffe im Template via `$app.xxx`.
4. Root-Methode `toggleXxxCard()` in `app-view.js` — reiner Flag-Toggle + `_closeOtherMainCards('xxx')`. Bei Karten, die bei erneutem Klick refreshen sollen (statt schliessen): `window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: 'xxx' } }))`.
5. `showXxxCard`-Flag in `app-state.js` → `cardsState`.
6. **Pflicht: Eintrag in `EXCLUSIVE_CARDS` ([public/js/cards/feature-registry.js](public/js/cards/feature-registry.js))** — `{ key: 'xxx', flag: 'showXxxCard' }`. `_closeOtherMainCards`, `resetView` und `_maybeOpenBookOverview` iterieren darüber; ohne Eintrag bricht Exklusivität + Home-Klick öffnet keine Übersicht.
7. **Eintrag in `FEATURES` ([public/js/cards/feature-registry.js](public/js/cards/feature-registry.js))** (Single Source of Truth für Quick-Pills + Command-Palette + Usage-Tracking) — bei `kind: 'toggle'` zusätzlich Key in `ALLOWED_KEYS` von [routes/usage.js](routes/usage.js) ergänzen, sonst verwirft `/usage/track` lautlos. Karten, die nicht in der Palette erscheinen sollen (`kapitelReview`, `userSettings`), bleiben nur in `EXCLUSIVE_CARDS`.
8. Hash-Router: in `_currentHashView` ([public/js/app/app-hash-router.js](public/js/app/app-hash-router.js)) Parse-/Build-Branch ergänzen + Flag in der Liste am Ende der Datei aufnehmen.

### Root-Zugriff aus Sub-Komponenten (`$app` / `window.__app`)

Alpine's `$root` zeigt auf das **nächste x-data-Element** (bei Sub-Komponenten also die Sub selbst), nicht auf die `lektorat`-Root. Darum gibt es `$app`:
- **In Templates** (Alpine-Expressions): `$app.t('key')`, `$app.selectedBookId`, `$app.figuren`. Funktioniert über die Custom-Magic `Alpine.magic('app', …)` in [app.js](public/js/app.js).
- **In JS-Methoden/Gettern** (Sub-Komponenten): `window.__app.xxx` — der Root cached sich in `init()` in `window.__app` (garantiert reaktiver Alpine-Proxy). Alpine-Magics sind in JS-Getter-Ausführungen **nicht** zuverlässig verfügbar; `window.__app` ist robust.

### Geteilter Fach-State: `Alpine.store('catalog')`

`figuren`, `orte`, `szenen`, `globalZeitstrahl` leben in [public/js/cards/catalog-store.js](public/js/cards/catalog-store.js). Der Root exponiert sie als Getter/Setter-Proxy, sodass `this.figuren = …` und `this.figuren.push(…)` aus Root-Methoden weiter funktionieren. Sub-Komponenten lesen via `$app.figuren` oder direkt `Alpine.store('catalog').figuren`.

### Events zwischen Root und Subs

Root dispatched, Subs hören:
- **`book:changed`** — aus `_resetBookScopedState()`; Subs resetten State + laden bei offener Karte neu.
- **`view:reset`** — aus `resetView()`; Subs nullen lokalen State komplett.
- **`card:refresh` `{ name }`** — erneuter Klick auf offene Karte → Daten neu laden.
- **`job:reconnect` `{ type, jobId, job, extra? }`** — aus `checkPendingJobs()`; Review/Kapitel-Review-Subs übernehmen Loading-State + starten Polling.
- **`chat:reset` / `book-chat:reset`** — Root dispatcht beim Seitenwechsel / User-Settings-Danger-Reset; Chat-Subs leeren Session.
- **`kapitel-review:select` `{ chapterId }`** — aus Sidebar/Hash-Router; Sub setzt ihre `kapitelReviewChapterId`.

### Job-Polling (shared utilities)

Pure Funktionen in [public/js/cards/job-helpers.js](public/js/cards/job-helpers.js):
- `startPoll(ctx, config)` — generischer Job-Poller mit explizitem ctx.
- `runningJobStatus(translate, …)` — Status-HTML mit Token-Info.

Für createJobFeature-ähnliche Karten: [public/js/cards/job-feature-card.js](public/js/cards/job-feature-card.js) exportiert `createCardJobFeature(cfg)` — Sub-Variante der Root-Factory mit Flag am `$app` statt lokal.

### Feature-Toggle (Exklusivität)

Immer nur eine Hauptansicht aktiv. Buchebenen-Features und Seitenebenen-Features (Editor) sind gegenseitig exklusiv.
- Root-Toggle-Methode (`app-view.js`) ruft `_closeOtherMainCards(keep)` auf (schliesst alle anderen Karten + Editor)
- `selectPage()` ruft `_closeOtherMainCards()` (kein keep) — schliesst alle Buchkarten bevor der Editor öffnet. **Niemals Show-Flags in `selectPage` hand-pflegen** — drift-anfällig (neue Karte vergessen → bleibt beim Seitenklick offen). Helper ist SSoT für „alle Buchkarten zu".
- Jede neue Buchkarte braucht einen `EXCLUSIVE_CARDS`-Eintrag in [public/js/cards/feature-registry.js](public/js/cards/feature-registry.js) (`{ key, flag }`). `_closeOtherMainCards`, `resetView` und `_maybeOpenBookOverview` lesen ausschliesslich daraus — keine Hand-Pflege in app-view.js mehr.
- Sub-Komponenten haben **keine** eigenen `showXxxCard`-Flags — der Root ist SSoT. Subs hören auf `$watch(() => window.__app.showXxxCard)`.
- Seiten-Chat ist eine Ausnahme: läuft neben dem Editor, kein `_closeOtherMainCards` beim Öffnen.

### Scroll-to bei Karten-Toggle

SSoT: `_scrollToCardByKey(key)` + `_scrollToCardEl(el)` in [public/js/app/app-view.js](public/js/app/app-view.js). Mobile (<960px): `scrollIntoView({ block: 'start' })` aufs Karten-Element. Desktop (>=960px): `window.scrollTo({ top: 0 })`.

**Pflicht-Aufrufer:**
- `_toggleCardGeneric` ruft `_scrollToCardByKey(entry.key)` nach `_ensurePartial` + Flag-Set. Reihenfolge zwingend — Selector `[x-show="$app.${flag}"]` findet das Element erst nach Partial-Inject.
- Refresh-Pfad (`onReclick: 'refresh'`) scrollt **auch** — Re-Klick auf offene Karte zentriert sie wieder, statt User weggescrollt zu lassen.
- Hash-Apply für bereits offene Karte (`_applyHash`-Branches): explizit `_scrollToCardByKey(key)` ergänzen, sonst landet User nach Deep-Link-Click ins Nichts.

**Anti-Pattern:**
- Eigene `el.scrollIntoView()`-Calls in Sub-Komponenten oder Toggle-Methoden — Mobile/Desktop-Branching dann doppelt + drift-anfällig.
- Scroll **vor** `await _ensurePartial`: Selector findet nichts (Cold-Open hat leeres `partial-<name>`-Div).
- `_closeOtherMainCards` selbst scrollen lassen: Helper schliesst nur, scroll gehört in den Toggle-Pfad.

**`onCardRefresh` ≠ Re-Load vom Server.** Standardfall ist lokaler Re-Render aus bereits geladenem State (z.B. `_rerender()` im Buchorganizer snapshot't aus `root.tree`). Server-Fetch (z.B. `root.loadPages()`) clear't Tree/Listen visible → Sidebar-Flicker bei jedem Re-Klick. Nur dispatchen, wenn Karte wirklich externe Drift hat.

## Command-Palette + Feature-Registry

**SSoT für UI-Features:** [public/js/cards/feature-registry.js](public/js/cards/feature-registry.js) listet alle Karten (`kind: 'toggle'`), globalen Aktionen und Such-Provider. Quick-Pills, Command-Palette und Usage-Tracking lesen ausschliesslich daraus.

**Palette:** [public/js/cards/palette-card.js](public/js/cards/palette-card.js) — Modal mit Such-Input + Sektionen aus Karten + globalen Aktionen + Such-Providern. Trigger: Cmd/Ctrl+K bzw. `/`. Prefix-Modi: `>` Befehle, `#` Seiten, `!` Kapitel, `@` Figuren, `$` Orte, `%` Szenen. Ohne Prefix: alles fuzzy gemixt (Score-Threshold in `FUZZY_THRESHOLD_PER_CHAR`).

**Karten-Keys synchron halten:** Wer eine neue Toggle-Karte hinzufügt, ergänzt sie in `FEATURES` (feature-registry) **und** in `ALLOWED_KEYS` von [routes/usage.js](routes/usage.js). Sonst wird `/usage/track` lautlos verworfen → keine Recency-Position in der Palette.

**Recency:** [public/js/features-usage.js](public/js/features-usage.js) wird in den Root gespreaded; `$watch` auf jeden Show-Flag (rising edge) ruft `/usage/track`. Beim Login lädt `/usage/recent` die letzten Keys; Fallback: `DEFAULT_RECENT_KEYS` aus feature-registry.

## Lazy-Loaded Libs

vis-network (Figuren-Graph) und Chart.js (BookStats) laden ausschliesslich on-demand via [public/js/lazy-libs.js](public/js/lazy-libs.js). Kein neuer `<script>`-Tag im `index.html` für grosse Libs — sie würden den initialen Page-Load mit ~800 KB unbenutztem JS belasten.

## Prompt-System

**Trennung Config vs. Code:**
- `prompt-config.json` (Projektroot, Pflichtdatei) — Rollenformulierungen, Basisregeln, Buchtypen pro Sprache. Fehlt sie → Server-Crash beim Start.
- `public/js/prompts.js` — Facade (Re-Exports + `configurePrompts`-Orchestrator). Externer Einstieg für Server (dynamic `import()`) und Frontend (ESM).
- `public/js/prompts/` — interne Aufteilung nach Job-Typ:
  - `state.js` — `_isLocal`-Flag, `_jsonOnly()`, `JSON_ONLY`-Konstante (geteilter Provider-State)
  - `schema-utils.js` — Schema-Atome (`_obj`, `_str`, `_num`)
  - `blocks.js` — wiederverwendbare Regel-Blöcke (Stil, Wiederholung, Schwache Verben, Show-vs-Tell, Passiv, Perspektivbruch, Tempuswechsel, Erzählform)
  - `core.js` — `configureLocales`, `getLocalePromptsForBook`, alle `SYSTEM_*` Live-Exports, `PROMPTS_VERSION`, Locale-State
  - `lektorat.js` — Seiten-Lektorat (Einzel + Batch) + Stilkorrektur + `SCHEMA_LEKTORAT` (rebuild-pflichtig)
  - `review.js` — Buch-/Kapitel-Bewertung + statische Schemas
  - `komplett.js` — Komplettanalyse-Pipeline (Extraktion, Soziogramm, Orte, Kontinuität, Zeitstrahl) + alle dynamischen Schemas
  - `chat.js` — Seiten-Chat + Buch-Chat (klassisch + Agentic) + `BOOK_CHAT_TOOLS`
  - `synonym.js` — Synonym-Suche
  - `finetune.js` — Finetune-Export-Augmentation
- **Reihenfolge in `configurePrompts`:** `_setIsLocal(provider)` → `_rebuildLektoratSchema()` → `_rebuildKomplettSchemas()` → `configureLocales(cfg)`. Schemas vor `configureLocales`, weil `_buildLocalePrompts` → `buildSystemKomplett*` den `_isLocal`-Flag liest.

**Ladereihenfolge:**
- Server: `routes/jobs.js` und `routes/chat.js` lesen `prompt-config.json` synchron beim Modulstart → `configurePrompts()` einmalig (via `lib/prompts-loader.js`). `routes/proxies.js` liefert die Config lazy beim ersten `/config`-Call ans Frontend.
- Frontend: `app.js` → `init()` → `configurePrompts(cfg.promptConfig)` → setzt `SYSTEM_*`-Variablen via ESM-Live-Binding.

**Buchtypen:** In `prompt-config.json` unter `buchtypen`, aufgeteilt nach Sprachcode (`de`, `en`). Jeder Key hat `label` + `zusatz`. Neuer Typ: in beiden Sprachen ergänzen.

**Per-Buch-Kontext:** `getBookPrompts(bookId)` → `getLocalePromptsForBook()` augmentiert `baseRules` dynamisch mit Buchtyp-Zusatztext (`BUCHTYP-KONTEXT:`) und Freitext des Users (`VORRANGIGE ANGABEN DES AUTORS:` – übersteuert bei Konflikt die Basisregeln, insbesondere Stil/Ton/Format).

## Datenbank

DB-Code lebt in [db/](db/), aufgeteilt auf thematische Files: [connection.js](db/connection.js) (better-sqlite3-Setup, `PRAGMA foreign_keys = ON` global), [migrations.js](db/migrations.js) (Schema + `runMigrations`), [schema.js](db/schema.js), [books.js](db/books.js), [pages.js](db/pages.js), [figures.js](db/figures.js), [tokens.js](db/tokens.js), [token-usage.js](db/token-usage.js), [pdf-export.js](db/pdf-export.js), [fonts.js](db/fonts.js).

**Schema-Übersicht: [docs/erd.md](docs/erd.md)** — Mermaid-ERD mit allen Tabellen, FK-Kanten und thematischen Sub-Diagrammen (Buch-Hierarchie, Figuren, Continuity/Zeitstrahl, Chat/Reviews/Jobs/Caches/User/Export). Vor neuen Tabellen/Beziehungen prüfen, ob bestehende Strukturen (Bridge-Pattern, FK-Konventionen, ON-DELETE-Strategien) wiederverwendbar sind. Enthält ausserdem priorisierte Liste offener Schema-Verbesserungen.

### Relationale Integrität (Pflicht)

- **Jede neue Tabelle integriert sich via FK** ins bestehende Schema. Lose `*_id`-Spalten (`book_id`, `page_id`, `chapter_id`, `figure_id`, `location_id`, …) ohne `REFERENCES` sind verboten.
- Refs auf lokale PKs/UNIQUE-Targets MÜSSEN als FK deklariert werden:
  - `books(book_id)` (PK; INTEGER, global eindeutig — analog `pages.page_id`/`chapters.chapter_id`)
  - `pages(page_id)` (PK)
  - `chapters(chapter_id)` (PK; global eindeutig)
  - `figures(id)` (PK; nicht `figures.fig_id` — TEXT, nicht UNIQUE alleine)
  - `locations(id)`, `figure_scenes(id)`, `chat_sessions(id)`, `continuity_*(id)`
- ON-DELETE-Strategie bewusst wählen:
  - `CASCADE` für reine Caches/Aggregationen (page_stats, chapter_reviews, figure_appearances, location_chapters, lektorat_time, page_figure_mentions, chat_sessions[kind=page], page_checks)
  - `SET NULL` für user-kuratierte Daten (figure_events.page_id/chapter_id, figure_scenes.page_id/chapter_id, locations.erste_erwaehnung_page_id, ideen.page_id, continuity_issue_chapters.chapter_id, page_checks.chapter_id, pages.chapter_id)
- **Snapshot-Spalten verboten** (`chapter_name`, `kapitel`, `seite`, `page_name`, `book_name`) — keine Ausnahmen. Display-Werte zur Lese-Zeit per JOIN auf `chapters`/`pages`/`books`/`figures`. Wahrheit lebt nur in `pages.page_name`, `chapters.chapter_name`, `books.name` und `figures.name` (User-Stamm). Snapshot-Fallback nur bei nullbarem FK, wenn KI-Output keine ID liefern konnte (z. B. `continuity_issue_figures.figur_name` mit nullable `figure_id`).
- Index auf jede neue FK-Spalte Pflicht (`CREATE INDEX idx_xx_yy ON …`).
- `book_id`-Spalten referenzieren `books(book_id)` (PK). Buchanlage ausschliesslich über die Content-Store-Facade.

### Sentinel-freie Modellierung

Vermeide Sentinel-Werte (`page_id=0`, `page_name='__book__'`) als Diskriminator. Stattdessen: explizite Spalte (`kind TEXT NOT NULL CHECK(kind IN ('page','book'))`) + `NULL` für nicht-anwendbare Refs + CHECK-Constraint, der die Kombination erzwingt. Beispiel: `chat_sessions`. Sentinels blockieren FK-Constraints und verstecken Geschäftslogik.

### Migration hinzufügen

Neuen `if (version < N)`-Block in `runMigrations()` ([db/migrations.js](db/migrations.js)) ergänzen (N = nächste fortlaufende Nummer, aktuelle Version siehe `schema_version`-Tabelle) + `UPDATE schema_version SET version = N`. Neue Tabellen als `CREATE TABLE IF NOT EXISTS` mit FKs. **Timestamp-Defaults**: `TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))` — siehe Harte Regel „DB-Timestamps: ISO+Z via `NOW_ISO_SQL`". `datetime('now')` ist verboten in neuen Schema-Defaults und neuen Inline-INSERT/UPDATE-Statements.

**Pflicht: jede Migration endet mit:**
```js
const fkErrors = db.pragma('foreign_key_check');
if (fkErrors.length) throw new Error(`Migration N: foreign_key_check meldet ${fkErrors.length} Verstoesse.`);
db.prepare('UPDATE schema_version SET version = N').run();
```

**FK-Migration via Recreate-Pattern** (SQLite kann FKs nicht via `ALTER TABLE ADD CONSTRAINT`):
1. `db.pragma('foreign_keys = OFF')`
2. Pre-Cleanup: orphans nullen (UPDATE … SET ref = NULL WHERE ref NOT IN parent) bzw. löschen (CASCADE-Targets)
3. `DROP TABLE IF EXISTS xxx_new` (defensiv gegen Crash-Reste)
4. `CREATE TABLE xxx_new` mit finalen FKs + Indexen
5. `INSERT INTO xxx_new SELECT … FROM xxx`
6. `DROP TABLE xxx` → `ALTER TABLE xxx_new RENAME TO xxx`
7. Indexe neu anlegen (Recreate verliert sie)
8. `db.pragma('foreign_keys = ON')` + `foreign_key_check`
9. `UPDATE schema_version`

**Initial-Schema-Block** (oben in `migrations.js`) ist der „Stand vor allen Migrationen" für **Legacy-Installationen**. Nur additive Changes (neue Spalten via ALTER ADD COLUMN, neue Tabellen). FK-Anreicherung gehört in eigene Migrationen via Recreate-Pattern, nicht ins Initial-Schema — sonst brechen Daten-Migrationen, die ihre eigenen Vorbedingungen aus alten Spalten lesen, auf frischen DBs.

**Fresh-DB-Fast-Path:** Brand-neue Installationen (keine `schema_version`-Tabelle) installieren stattdessen [db/squashed-schema.js](db/squashed-schema.js) in einem einzigen `db.exec`-Call (End-Zustand nach allen Migrationen) und überspringen die Legacy-Chain komplett. `runMigrations()` sieht direkt `version === SQUASHED_VERSION` und ist no-op. Drift zwischen Squashed-Snapshot und Legacy-Chain ist durch [tests/unit/squash-drift.test.mjs](tests/unit/squash-drift.test.mjs) gegated.

**Pflicht nach jeder neuen Migration: `npm run squash:regen`** — regeneriert [db/squashed-schema.js](db/squashed-schema.js) aus einem frischen Migration-Run. Wer das vergisst, lässt den Drift-Test in CI rot.

**Pflicht: [docs/erd.md](docs/erd.md) im selben Commit aktualisieren.** Stand-Zeile (Schema-Version + Tabellen-Anzahl) bumpen; betroffene Block-Definitionen (neue Spalten, geänderte Typen) anpassen; bei neuen Tabellen einen Block + die FK-Kanten in Section 1 (Übersicht) und ggf. im passenden thematischen Sub-Diagramm ergänzen; bei neuen FK-Kanten auf bestehende Tabellen die Kante in Section 1 nachziehen. Drift gegated durch [tests/unit/erd-drift.test.mjs](tests/unit/erd-drift.test.mjs): prüft Stand-Zeile (Schema-Version + Tabellen-Anzahl) und Set-Gleichheit der Mermaid-Block-Definitionen (`name {`) gegen `sqlite_master` (ohne `sqlite_*`/`schema_version`/FTS5-Shadow-Tables). Vergessene Tabelle → CI rot.

### Neuer Beziehungstyp

Keine Schemaänderung. `figure_relations.typ` ist Freitext. Neuen Typ in der `BZ`-Konstante (Frontend-Rendering) und im Claude-Prompt (`FIGUREN_BASIS_SCHEMA` in `public/js/prompts/komplett.js`) ergänzen.

`figure_relations.from_fig_id`/`to_fig_id` sind INTEGER-FK auf `figures.id` (nicht TEXT-fig_id). Schreib-/Lesepfade übersetzen via Lookup-Map (TEXT-fig_id ↔ INTEGER-id, siehe [db/figures.js](db/figures.js) `saveFigurenToDb`/`updateFigurenSoziogramm` und JOINs in [routes/figures.js](routes/figures.js), [routes/jobs/shared.js](routes/jobs/shared.js)).

## Architektur-Überblick

```
Browser → NGINX (HTTPS) → Express (Port 3737)
  /auth/*    → Google OIDC (Login/Callback/Logout/Me)
  /config    → Modell-Config + User (keine Credentials)
  /content/*       → Content-Store-Facade (Books/Chapters/Pages, Order, Revisions)
  /book-editor/*   → Page-Save/Apply, Locks, Presence
  /book-access/*   → ACL: User ↔ Book (Owner/Editor/Reader)
  /claude          → api.anthropic.com (ANTHROPIC_API_KEY-Injection, SSE)
  /ollama          → Ollama /api/chat (NDJSON → SSE normalisiert)
  /jobs/*          → Hintergrund-Jobs (Status-Polling, alle KI-Analysen)
  /chat/*          → Seiten-Chat (SSE-Streaming) + Buch-Chat-Sessions
  /history/*       → Job-Verlauf (SQLite)
  /figures/*       → Figuren-CRUD (SQLite)
  /draft-figures/* → Figuren-Drafts (Brainstorming vor Übernahme)
  /locations/*     → Orte-CRUD (SQLite)
  /ideen/*         → Ideen-CRUD (SQLite)
  /songs/*         → Songs-Feature (Buch-Soundtrack)
  /booksettings/*  → Per-Buch-Settings (Buchtyp, Freitext)
  /me/*            → User-Settings (Sprache, Modell-Override)
  /sync/*          → Buchstatistik-Sync (manuell + Cron)
  /export/*        → Buch-Export (PDF/HTML/Markdown/Plaintext/EPUB via App-eigenen Builder)
  /search/*        → FTS5-Volltextsuche
  /categories/*    → Kategorie-Pool (CRUD, Zuordnung pro Buch via ACL)
  /pdf-export/*    → Custom-PDF-Export-Profile (CRUD + Cover-Upload + Font-Liste)
  /jobs/pdf-export → Render-Job (eigene pdfkit-Pipeline mit PDF/A-2B)
  /blog/*          → WordPress-Blog-Connection (Buchtyp 'blog'): Status, Connect, Links, Konflikt-Resolve
  /hubspot/*       → HubSpot-Blog-Connection (Buchtyp 'blog'): Status, Connect, Blogs/Authors-Combo, Links
  /jobs/blog-*     → Blog-Sync-Jobs (initial-import, pull, push)
  /jobs/hubspot-*  → HubSpot-Sync-Jobs (initial-import, push-as-draft)
  /usage/*         → Feature-Usage-Tracking (Recency für Palette/Quick-Pills)
  /telemetry/*     → Block-Level-Merge-Counter (POST /telemetry/merge → merge_telemetry, exponiert via /metrics)
  /admin/books, /admin/logs, /admin/registration-requests, /admin/settings, /admin/usage, /admin/users
  /public/*        → Unauthentifizierte Endpoints (Health, Marketing)
  /                → public/index.html (SPA)

Cron (täglich 02:00) → syncAllBooks() → page_stats + book_stats_history
```

**Auth:** Alle Routen ausser `/auth/*` sind durch Session-Guard geschützt. HTML-Requests → Redirect auf Login. API-Requests → `401 JSON`.

**Credentials:** KI-Aufrufe laufen über Server-Proxies — der Server hält alle API-Keys.

**Content-Store-Facade ([lib/content-store/](lib/content-store/)):** zentrale Storage-Abstraktion über das SQLite-Backend. Bündelt Page-Revisions, Tree-Overlay (book_order) und FTS-Index-Hooks am Schreib-Chokepoint. Konsumenten (Routes, Jobs, Sync) importieren ausschliesslich die Facade.

## KI-Provider

Drei Provider, konfiguriert via `API_PROVIDER` in `.env`:

| Provider | Env-Vars | Besonderheit |
|----------|----------|--------------|
| `claude` | `ANTHROPIC_API_KEY`, `MODEL_NAME` | Prompt-Caching (`cache_control: ephemeral`), grosses Kontextfenster |
| `ollama` | `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_TEMPERATURE` | Mutex-Serialisierung (VRAM-Schutz), dynamische `num_ctx`-Berechnung |
| `llama` | `LLAMA_HOST`, `LLAMA_MODEL`, `LLAMA_TEMPERATURE` | llama.cpp, ebenfalls Mutex-serialisiert |

**`MODEL_TOKEN`** setzt den globalen Output-Token-Cap (`MAX_TOKENS_OUT` in `lib/ai.js`, Default 64 000). Job-spezifische Overrides werden per `Math.min` gedeckelt.

**`MODEL_CONTEXT`** setzt das gesamte Kontextfenster (Input + Output, Default 200 000). Daraus leitet `lib/ai.js` das `INPUT_BUDGET_TOKENS` (= `MODEL_CONTEXT − MODEL_TOKEN − 2000`) ab. Alle kontextabhängigen Grenzen skalieren automatisch: `SINGLE_PASS_LIMIT`/`PER_CHUNK_LIMIT` (Komplettanalyse), `BOOK_CHAT_TOKEN_BUDGET`-Default, Buch-Chat-Tool-Result-Caps und das Classic-Buch-Chat-Text-Budget. Bei lokalen Modellen auf die native Kontextgrösse setzen (Mistral-Small3.2 / Gemma3 / Llama-3.1: 128 000, ältere: 32 000 / 8 000).

**JSON-Parsing:** `lib/ai.js` hat mehrstufigen Fallback: `JSON.parse()` → `extractBalancedJson()` → `jsonrepair()`.

**Per-User-Override:** Admin setzt `app_users.ai_provider_override` pro User; `lib/ai.js#resolveProvider({ userEmail })` löst per Call auf (Override > globaler `ai.provider` > `'claude'`). Job-Pfade resolven am Job-Start einmal in `effectiveProvider`. Cache-Tabellen haben `provider` im PRIMARY KEY (verhindert Cross-Provider-Bleeding). Details: [docs/ai-providers.md](docs/ai-providers.md).

## Two-Tier-Analyse

Jobs in `routes/jobs/` verwenden ein Single-Pass/Multi-Pass-Muster. Limits und Batch-Grössen sind als Konstanten in `routes/jobs/shared/` definiert — `SINGLE_PASS_LIMIT` und `PER_CHUNK_LIMIT` skalieren dynamisch aus `INPUT_BUDGET_CHARS` (70% / 35%).

## Komplettanalyse-Job

**Pipeline-Phasen und Abhängigkeiten:**

```
Phase 1 – Vollextraktion (parallel pro Kapitel oder Single-Pass)
          → figuren, orte, fakten, szenen(Namen), assignments(Namen)
          → Checkpoint 'p1_full_done'
                    ↓
Phase 2 – Figuren konsolidieren + Soziogramm (aus P2-Output, kein Extra-Call)
Phase 3 – Schauplätze konsolidieren
Phase 3b – Kapitelübergreifende Beziehungen (nur Multi-Pass, non-critical)
                    ↓
Block 2 [parallel]:
  Phase 5 – Szenen remappen (kein API-Call, Namen → IDs)
  Phase 6 – Zeitstrahl konsolidieren
  Phase 8 – Kontinuitätscheck (Single-Pass: voller Text, Multi-Pass: Fakten)
```

**Standalone-Kontinuitätscheck:** `POST /jobs/kontinuitaet` — läuft Phase 8 einzeln, ohne die volle Pipeline. Exportiert `runKontinuitaetJob` aus `routes/jobs/komplett/job.js`.

**Wichtige Mechanismen:**
- **Delta-Cache:** Phase 1 (Multi-Pass) prüft `chapter_extract_cache` in der DB. Cache-Key enthält `pages_sig` (sortierte `page_id:updated_at`-Paare). Ändert sich eine Seite → Cache-Miss → Neu-Extraktion. Single-Pass wird nicht gecacht.
- **Prompt-Caching:** System-Prompt mit eingebettetem Schema wird bei parallelen Kapitel-Calls gecacht (~10% des Input-Preises für Folge-Calls).
- **Checkpoint-Wiederaufnahme:** `p1_full_done` speichert alle 5 Arrays.

## Finetune-Export

Ziel: Buch im Modell **internalisieren** (Stil, Welt, Figuren, Fakten, Plot). Darum **maximal grosszügig extrahieren** — lieber zu viele Trainingssamples als zu wenige. Alles, was sich aus Text/Figuren/Szenen/Schauplätzen/Ereignissen/Lektorats-Findings als Q&A, Stil-Fortsetzung, Dialog, Szenen-Generierung, Fakten-Recall etc. ableiten lässt, mitnehmen. Keine künstlichen Sample-Caps, keine vorsichtigen Limits per Sampler — Modell soll Buch nach Finetune möglichst vollständig „kennen". Neue Sampler/Datenquellen tendenziell hinzufügen, nicht filtern. Code: [routes/jobs/finetune-export/](routes/jobs/finetune-export/).

## Custom PDF-Export

**Eigener Renderer** mit druckfertiger PDF/A-2B-Konformität und User-konfigurierbarem Layout, Fonts, Cover, Kapitelgliederung.

**Pipeline:**
```
/jobs/pdf-export (POST, Job-Queue) → loadBookContents → render (pdfkit, subset='PDF/A-2b') → optional veraPDF-Validate
                                                          ↓
                                          /jobs/pdf-export/:id/file (Stream)
```

**Module:**
- `routes/jobs/pdf-export.js` — Job-Wrapper, hält PDF-Buffers in `pdfResults`-Map (TTL 2h).
- `lib/pdf-render.js` — pdfkit-Doc-Lifecycle, Cover, Title-Page, TOC, Kapitel-Loop, Header/Footer-Pass.
- `lib/pdf-render/html-walker.js` — linkedom-basiert. Whitelist: h1-h3, p, ul/ol/li, blockquote, pre, hr, img + inline strong/em/u/a. `<div class="poem">` → eigener `poem`-Block. Tabellen werden als Plain-Text-Fallback durchgereicht (kein Layout). Standard-Editor-Markup wird unterstützt.
- `lib/pdf-export-defaults.js` — `defaultConfig()` + `validateConfig(src)`. Strict: unbekannte Keys werden verworfen, Numerik geclampt, Enums whitelisted.
- PDF/A-2B-Subset macht pdfkit nativ via `subset: 'PDF/A-2b'` im PDFDocument-Constructor: hängt `pdfaid:part`/`conformance` ans XMP, schreibt OutputIntent mit eingebettetem sRGB-ICC-Profil aus pdfkit's eigenem Bundle (`node_modules/pdfkit/js/data/sRGB_IEC61966_2_1.icc`). **Nicht** manuell via `doc._root.data.Metadata = …` patchen — pdfkit's `endMetadata()` läuft danach und überschreibt die Referenz.
- `lib/pdfa-validate.js` — veraPDF-CLI-Wrapper. Schreibt Buffer in Tempdatei mit `.pdf`-Extension (CLI liest nicht von stdin), validiert, löscht. Wenn Binary fehlt → `{ available: false }`, Job liefert PDF mit Warnung. ENV `VERAPDF_BIN`, `VERAPDF_FLAVOUR`, `VERAPDF_DISABLED`.
- `lib/font-fetch.js` — Google-Fonts-Loader. Hardcoded Whitelist (~24 Familien). UA-Trick (`Wget/1.13.4`) zwingt Google-CSS-API zu TTF. 30-Tage-TTL via `font_cache`-Tabelle (Stale-while-revalidate: bei Network-Fail wird stale-Cache geliefert).
- `lib/cover-prepare.js` — sharp: Magic-Bytes-Check → JPEG, sRGB, kein Alpha, max. 2400 px Längsseite. PDF/A-tauglich.
- `db/pdf-export.js` + `db/fonts.js` — Profile-CRUD + Font-Cache. **Multiple Profile pro (book, user)** via `(book_id, user_email, name)`-UNIQUE; `book_id=0` für User-Default-Vorlagen. Cover-Bild als BLOB in `pdf_export_profile.cover_image`.

**Frontend:** `pdfExportCard` ([public/js/cards/pdf-export-card.js](public/js/cards/pdf-export-card.js)) mit Tabs Layout/Schrift/Kapitel/Cover/TOC/Extras/PDF/A. Live-Font-Preview lädt Google-Fonts-CSS lazy in den Browser. Profile-Operationen (CRUD, Default, Cover-Upload) gehen an `/pdf-export/...`. Render-Trigger an `/jobs/pdf-export`, Download-Stream `/jobs/pdf-export/:id/file`.

**Wichtige Invarianten:**
- `font.body` braucht `family` aus der Whitelist (lib/font-fetch.js#FONT_LIST). PUT validiert; bad font → 400 `FONT_NOT_ALLOWED`.
- Cover-Bilder werden bei Upload **und** beim Render durch sharp geschleust (defensiv-doppelt; PDF/A erlaubt kein Alpha/CMYK).
- `pageStructure: 'flatten'` (Default) verkettet alle Seiten eines Kapitels ohne Per-Page-Heading; `'nested'` rendert pro Page einen h2-Sub-Heading.
- Job-Result-JSON enthält Metadaten (Größe, MIME, PDF/A-Status), **nicht** den Buffer — der lebt in `routes/jobs/pdf-export.js#pdfResults` und wird über `/jobs/pdf-export/:id/file` gestreamt.
- veraPDF-Failure ist **non-fatal**: Datei wird trotzdem geliefert, Frontend zeigt Warnung.

**Ops:**
- veraPDF (Java-CLI, ~80 MB inkl. JRE) optional im Container. Fehlt es → Validation skipped, kein Crash.
- sharp ist Pflicht-Dep (Cover + Image-Embeds); libvips wird über das npm-Package mitgeliefert.
- Code: [routes/jobs/pdf-export.js](routes/jobs/pdf-export.js), [routes/pdf-export.js](routes/pdf-export.js), [lib/pdf-render.js](lib/pdf-render.js).

## Chat

- **Seiten-Chat** (`/jobs/chat`): Job-Queue. Antwortformat enthält `vorschlaege` mit zeichengenauem `original` für Textersetzung.
- **Buch-Chat** (`/jobs/book-chat`): Job-Queue, kein Vorschläge-System. Sessions sind durch `chat_sessions.kind = 'book'` (mit `page_id IS NULL`) markiert; CHECK-Constraint erzwingt die Kombination.

## Fehlerbehandlung

- **Jobs:** `try/catch` → `failJob(id, err)` setzt Status auf `'error'` oder `'cancelled'` (bei `AbortError`). Fehler werden in `job.error` gespeichert und geloggt.
- **API-Routen:** Fehlende Parameter → `400 JSON`, unauthentifiziert → `401 JSON`.
- **JSON-Parsing:** Mehrstufiger Fallback in `lib/ai.js` (siehe KI-Provider).
- **DB-Fehler:** Geloggt, blockieren nicht den Request.

## Logging

Winston (`logger.js`): Level `info`, Ausgabe in `schreibwerkstatt.log` (5 MB, 5 Dateien rotiert, `tailable: true` → `schreibwerkstatt.log` ist immer current, ältere Rotationen liegen als `schreibwerkstatt1.log`..`schreibwerkstatt5.log` daneben) + Console. Jobs nutzen Child-Logger mit Kontext: `logger.child({ job, user, book })` → Format: `[INFO][lektorat|user@mail.com|42] Nachricht` (das `lektorat` im Beispiel ist der Job-Typ, nicht die App).

## Projektstruktur (thematische Cluster)

Vollständiges Inventar via `ls`/`find` — hier nur Einstiege und Cluster, damit Drift gegen Datei-Listings nicht jeden Refactor bricht.

- `server.js` — Express-Setup, Auth-Guard, Cron, Route-Mounting.
- `logger.js` — Winston-Config.
- **`lib/`** — Server-Libs. Highlights:
  - `ai.js` (callAI + Provider-Dispatch + JSON-Fallback), `content-store/` (Pages/Chapters/Books-Facade), `html-clean.js` (Page-HTML-Sanitization, **SSoT** vor jedem DB-Write).
  - PDF/Export: `pdf-render.js` + `pdf-render/` (Pipeline), `pdf-export-defaults.js`, `pdfa-validate.js`, `font-fetch.js`, `cover-prepare.js`, `export-builders/` (HTML/MD/EPUB/Plaintext).
  - Cross-cutting: `acl.js`, `admin-mw.js`, `admin-login-ratelimit.js`, `register-ratelimit.js`, `app-settings.js`, `budget.js`, `pricing.js`, `cache-cleanup.js`, `content-mapper.js`, `crypto.js`, `dev-seed.js`, `draft-mindmap-builder.js`, `filenames.js`, `i18n-server.js`, `load-contents.js`, `local-date.js`, `log-context.js`, `mailer.js` + `mailer-templates.js`, `notify.js`, `page-index.js`, `prompts-loader.js`, `search.js`, `slug.js`, `validate.js`.
- **`db/`** — SQLite-Split. Einstieg: `connection.js`, `migrations.js`, `schema.js`, `squashed-schema.js` (Fresh-DB-Fast-Path). Eine Domäne pro File: `books`, `pages`, `page-revisions`, `page-presence`, `figures`, `draft-figures`, `book-access`, `book-categories`, `book-order`, `app-users`, `registration-requests`, `token-usage`, `admin-usage`, `budget-alerts`, `pdf-export`, `fonts`.
- **`routes/`** — Ein Router pro Feature. Namen entsprechen der Routen-Tabelle oben.
  - `jobs.js` mountet alle Job-Sub-Router. Subfolder: `jobs/shared/` (Queue, AI-Helper, Loader, Model, Queries, Router, State) und `jobs/komplett/` (Pipeline: index, job, phases, checkpoint, figuren-merge, remap, utils). Single-File-Job-Router: `lektorat`, `review`, `kapitel`, `chat`, `synonyme`, `figur-werkstatt`, `pdf-export`. Helper-Files (kein Router): `narrative-labels`, `book-chat-tools`, `review-context`. `finetune-export/` als Subfolder mit eigenem Router.
- **`public/`** — SPA.
  - `index.html` Shell; `partials/` werden via `_loadPartials()` nested geladen.
  - `css/` thematisch gesplittet (eine Datei pro Komponente; grosse Cards als Subfolder, z.B. `book-overview/`). `tokens.css` Facade-File (importiert `tokens/`-Module); Cascade via `@layer base, components, utilities`. `tokens.css` selbst unlayered.
  - `js/app.js` Alpine-Root; `js/app/` Root-Slices (`app-state`, `app-view`, `app-ui`, `app-jobs-core`, `app-hash-router`, `app-navigation`, `app-chrome`, `app-komplett`, `app-collab`).
  - `js/cards/` — Alpine-Sub-Komponenten, eine pro Karte. **SSoT-Liste in [feature-registry.js](public/js/cards/feature-registry.js)** — nicht hier pflegen. Shared neben den Karten: `catalog-store.js`, `feature-registry.js`, `job-helpers.js`, `job-feature-card.js`, `card-lifecycle.js`, `palette-card.js`/`palette-fuzzy.js`/`palette-providers.js`.
  - `js/book/` — Buch-/Seiten-Fachmodule (tree, page-view, history, review, kapitel-review, fehler-/stil-heatmap, kontinuitaet, ereignisse, orte, szenen, figuren, ideen, finetune-export, lektorat-time, writing-time, export, songs, book-create, book-settings, bookstats).
  - `js/editor/` — Editor-Fachmodule (`utils`, `edit`, `focus/` + `focus.js`, `find`, `synonyme`, `figur-lookup`, `toolbar`, `lektorat`, `shortcuts`, `draft-storage`). Cards in `cards/editor-*-card.js` importieren von hier.
  - Feature-eigene Submodul-Cluster (Facade-File + gleichnamiger Subfolder): `book-overview.js` + `book-overview/`, `figur-werkstatt.js` + `figur-werkstatt/`, `graph.js` + `graph/`.
  - Weitere Cluster: `js/chat/`, `js/admin/`, `js/api/`, `js/i18n/`, `js/repo/`.
  - `js/prompts.js` Facade; `js/prompts/` Submodule pro Job-Typ (state, schema-utils, blocks, core, lektorat, review, komplett, chat, synonym, finetune, figur-werkstatt).
  - Cross-cutting Top-Level: `utils.js`, `lazy-libs.js` (vis-network/Chart.js on-demand), `features-usage.js`, `user-settings.js`, `num-input.js`, `page-revision-diff.js`, `theme-init.js`, `plausible-init.js`, `tooltip.js`, `fullscreen.js`, `register.js`.

## Tests

`npm test` führt Unit-, Integration- und E2E-Tests nacheinander aus. Einzeln: `npm run test:unit` (Node built-in, parallelisiert, kein Browser), `npm run test:integration` (Node built-in, sequenziell, Job-Pipelines gegen Mock-AI), `npm run test:e2e` (Playwright, Chromium nötig). Setup: [tests/](tests/), [playwright.config.js](playwright.config.js).

**Unit** (`tests/unit/*.test.{js,mjs}`, `node --test`) — decken ab:
- JSON-Fallback-Kette ([ai.test.js](tests/unit/ai.test.js)), Stil-/Figuren-Metriken ([page-index.test.js](tests/unit/page-index.test.js)), Prompts-Build ([prompts.test.mjs](tests/unit/prompts.test.mjs)), XSS-Escape-Invariante ([escape-xss.test.mjs](tests/unit/escape-xss.test.mjs)), Request-Validierung ([validate.test.js](tests/unit/validate.test.js)), Job-Reconnect-Events ([job-reconnect.test.mjs](tests/unit/job-reconnect.test.mjs)), Hash-Router ([hash-router.test.mjs](tests/unit/hash-router.test.mjs)), Card-Exklusivität ([card-exclusivity.test.mjs](tests/unit/card-exclusivity.test.mjs)), Editor-Focus-Granularität ([editor-focus.test.mjs](tests/unit/editor-focus.test.mjs), [focus-granularity.test.mjs](tests/unit/focus-granularity.test.mjs)), Szenen-Filter ([szenen-filter.test.mjs](tests/unit/szenen-filter.test.mjs)), Ideen-Prompt + Schema ([ideen-prompt.test.mjs](tests/unit/ideen-prompt.test.mjs), [ideen-schema.test.js](tests/unit/ideen-schema.test.js)), Shared-Jobs-Helper ([shared-jobs.test.js](tests/unit/shared-jobs.test.js)), HTML-Cleaner ([html-clean.test.js](tests/unit/html-clean.test.js)), Page-Stats-Normalisierung ([page-stats-normalization.test.mjs](tests/unit/page-stats-normalization.test.mjs)), Stale-Write-Schutz ([stale-write.test.mjs](tests/unit/stale-write.test.mjs)), PDF-Export ([pdf-export-db.test.js](tests/unit/pdf-export-db.test.js), [pdf-export-defaults.test.js](tests/unit/pdf-export-defaults.test.js), [pdf-html-walker.test.mjs](tests/unit/pdf-html-walker.test.mjs), [pdf-render.test.mjs](tests/unit/pdf-render.test.mjs)), Palette-Fuzzy ([palette-fuzzy.test.mjs](tests/unit/palette-fuzzy.test.mjs)), Streak-Heatmap ([streak-heatmap.test.mjs](tests/unit/streak-heatmap.test.mjs)), Local-Date ([local-date.test.mjs](tests/unit/local-date.test.mjs), [local-date-server.test.js](tests/unit/local-date-server.test.js)), Book-Overview-Load ([book-overview-load.test.mjs](tests/unit/book-overview-load.test.mjs)).

**Integration** (`tests/integration/*.test.js`, `node --test`, sequenziell mit Mock-AI):
- [tests/integration/komplett.test.js](tests/integration/komplett.test.js) – Komplettanalyse-Pipeline (Vollextraktion, Konsolidierung, Block 2).
- [tests/integration/kontinuitaet.test.js](tests/integration/kontinuitaet.test.js) – Standalone-Kontinuitätscheck.
- [tests/integration/review.test.js](tests/integration/review.test.js) – Buch-Review-Job.
- [tests/integration/regression.test.js](tests/integration/regression.test.js) – Cross-Job-Regressionen.
- Helpers in [tests/integration/_helpers/](tests/integration/_helpers/).

**E2E** (`tests/e2e/*.spec.js`, Playwright):
- [tests/e2e/focus-editor.spec.js](tests/e2e/focus-editor.spec.js) – Fokus-Editor: Toggle, Recenter, Pointer-Schonfrist, Cleanup/Leak-Freiheit.
- [tests/e2e/clean-content.spec.js](tests/e2e/clean-content.spec.js) – `cleanContentArtefacts` aus [public/js/utils.js](public/js/utils.js): Paste-Artefakt-Stripping.
- [tests/e2e/lektorat.spec.js](tests/e2e/lektorat.spec.js) – Lektorat-Flow mit Mock-Server und Harness-Szenarien.
- [tests/e2e/pdf-export.spec.js](tests/e2e/pdf-export.spec.js) – Custom-PDF-Export-Profile (CRUD, Cover, Render-Job).

**Bei grösseren UI-Änderungen** (besonders am Editor, Fokus-Modus, Scroll-/Selection-Verhalten, Lektorat-Flow) vor dem Commit automatisch `npm test` ausführen. Schlägt etwas fehl, Ursache klären statt Tests anpassen. Übrige Bereiche weiterhin manuell validieren.
