# LanguageTool-Integration (3 Editoren, self-hosted)

**Status:** Ready
**Aufwand:** ~2 Tage
**Severity:** Medium (Ergonomie, kein Daten-Risiko)

## Context

Browser-Rechtschreibung ist inkonsistent (Chrome ≠ Firefox ≠ Safari), kennt Buchsprache nicht und liefert schlechte Vorschläge. LanguageTool (LT) self-hosted via Docker liefert regelbasierte Prüfung lokal, ohne Drittland-Traffic. Integration in alle drei Editoren — Notebook, Focus, Bucheditor — mit gemeinsamer Logik, gemeinsamem CSS und einheitlicher UI ähnlich der LanguageTool-Browser-Extension. Browser-Spellcheck wird deaktiviert, sobald LT aktiv ist.

Nur Self-Hosted-Modus. Kein Premium-/API-Key-Pfad (Datenschutz + Self-Hosting-Charakter der App).

## Scope MVP

- App-Settings für `enabled`, `url`, `picky`.
- Server-Proxy `/languagetool/check` (synchron, kein Job, kein Cache).
- Controller-Factory `createSpellcheckController({ root, scrollContainer, getHtml, onApplyReplacement, editorKind })` — editor-agnostisch.
- Mount in Notebook-, Focus-, Bucheditor-Lifecycle.
- Overlay-Layer mit Wavy-Underline pro Match, Popover mit Top-3-Replacements + Ignore (Session-only) + Regel-Info-Link.
- Browser-Spellcheck per `:spellcheck`-Binding deaktiviert wenn LT enabled.
- Extension-Konflikt-Detection (LT-Browser-Extension) → Banner + App-Overlay pausiert.
- Text-Normalisierung als Shared-Helper (`lib/text-normalize.js`), Server + Frontend nutzen denselben.

## Out-of-Scope (Phase 2)

- Per-Page-Cache (`page_languagetool_cache`).
- Chunking für Texte >50KB.
- Persistente Ignore-Liste pro User/Buch.
- Custom-Dictionary.
- Premium/API-Key-Modus.
- Status-Indikator in Editor-Toolbar.
- Buch-Locale-Override (`books.languagetool_locale`).
- Touch-Popover-Tweaks für Mobile.

## Done when

- [ ] Admin-UI hat Felder `languagetool.enabled`, `languagetool.url`, `languagetool.picky`.
- [ ] `/languagetool/check` proxied an Self-Hosted-LT; disabled-Fall liefert `404 { error: 'languagetool_disabled' }`.
- [ ] Tippen in Notebook → Debounce 1.5s → Squiggle.
- [ ] Tippen in Focus → Squiggle, korrekt repositioniert beim Scrollen.
- [ ] Bucheditor: Squiggle nur im aktiven Block, wechselt beim Block-Aktivieren.
- [ ] Klick auf Squiggle → Popover mit Replacements; Klick auf Replacement ersetzt Text + triggert Save.
- [ ] Browser-Spellcheck aus wenn LT aktiv.
- [ ] LT-Extension detected → Banner sichtbar, App-Overlay paused.
- [ ] Tests grün (Unit Mapping, Integration Proxy, E2E pro Editor).

## Hard-Rule-Audit (CLAUDE.md)

| Regel | Status |
|---|---|
| Editor-Spezifikation | n/a — Plan adressiert explizit alle drei Editoren mit eigenem Mount-Hook |
| UI-Patterns nur aus DESIGN.md | Neues Pattern „Spellcheck-Overlay" + „Spellcheck-Popover" wird in DESIGN.md ergänzt vor Implementierung |
| KI-Calls nur via Job-Queue | n/a — LT ist regelbasiert, kein KI-Call. Sync-Proxy wie OpenThesaurus erlaubt. CLAUDE.md-Hinweis ergänzt |
| Styles nur in `public/css/` | erfüllt: neue Datei `public/css/editor/spellcheck.css` |
| UI-Strings nur in i18n | erfüllt: neue Keys in beiden Locales |
| Content-Store-Facade | n/a — kein Buchinhalt geschrieben |
| HTML→Text-Normalisierung Frontend matched Server | erfüllt: `lib/text-normalize.js` als SSoT, `routes/sync.js` + Frontend-Stats + LT-Pipeline konsumieren denselben Helper |
| `x-html` nur mit escape | erfüllt: Popover-Content wird via `textContent`/`escHtml()` gerendert |
| A11y klickbare Nicht-Buttons | erfüllt: Squiggle bekommt `.internal-link`-Klasse; MutationObserver in `app.js` macht es Tastatur-erreichbar |
| Kein globaler Fokus-Ring | erfüllt: Popover-Fokus via lokales Pattern |
| Combobox statt `<select>` | n/a — keine Auswahlfelder im Popover |
| SHELL_CACHE bumpen | erfüllt |
| File-Limits | erfüllt: Controller-Factory <600 LOC, CSS <600 LOC |
| State explizit deklariert | erfüllt: Controller-State im `Alpine.data`-Objekt der Spellcheck-Card |
| DB-Timestamps ISO+Z | n/a — keine DB-Spalten in MVP |
| Frontend-Datums-Display via tzOpts | n/a — keine Datumsanzeige |
| Lucide-Icon-Sprite | erfüllt: Popover nutzt `check`/`x`/`info`-Lucide-Icons |

## Abhängigkeiten

- LanguageTool-Docker (`erikvl87/languagetool` oder `meyay/languagetool`), Port 8010, ~1 GB RAM.
- Kein neuer NPM-Dep server-seitig (native `fetch` reicht).
- Frontend: keine neue Lib (TreeWalker, ResizeObserver, MutationObserver sind Browser-Builtins).

## Backend

### App-Settings

[lib/app-settings.js](lib/app-settings.js) `DEFAULTS` erweitern:

```js
'languagetool.enabled': false,
'languagetool.url': '',
'languagetool.picky': false,
```

`ENCRYPTED_KEYS` unverändert — keine Credentials.

### Admin-Settings-Route

[routes/admin-settings.js](routes/admin-settings.js) Allowlist um drei Keys erweitern. Pattern identisch zu bestehenden `ai.*`-Einträgen.

### Proxy-Route

Neue Datei [routes/languagetool.js](routes/languagetool.js):

```
POST /languagetool/check
Body: { text, language, picky? }
```

- Session-Guard (Standard).
- Lese `languagetool.enabled` + `languagetool.url` + `languagetool.picky` via `appSettings.get()`.
- `!enabled || !url` → `404 { error: 'languagetool_disabled' }`.
- Build `URLSearchParams`: `text`, `language`, `level=picky?`.
- `fetch(`${url}/v2/check`, { method: 'POST', body, signal: AbortController(10s) })`.
- LT-Response 1:1 weiterreichen (`software`/`warnings`/`language`/`matches`).
- LT-Fehler → `502 { error: 'languagetool_upstream', detail }`.
- Logging-Context: `setContext({ book: bookId })` falls Body `bookId` mitliefert.

Mount in [server.js](server.js): `app.use('/languagetool', require('./routes/languagetool'))`.

### `/config`-Endpoint

[routes/proxies.js](routes/proxies.js): `/config` exposed:

```js
languagetool: {
  enabled: appSettings.get('languagetool.enabled') === true,
}
```

Niemals URL ans Frontend. Frontend braucht Existenz-Flag, nicht Endpoint — Request läuft eh über App-Proxy.

### Text-Normalize Shared Helper

Neue Datei [lib/text-normalize.js](lib/text-normalize.js): exportiert `htmlToText(html)` mit identischer Logik wie aktuell in [routes/sync.js](routes/sync.js) (Tags → Single-Space, `\s+` collapsed, getrimmt).

Konsumenten umstellen:
- [routes/sync.js](routes/sync.js) → Import + Re-Use.
- [public/js/utils.js](public/js/utils.js) `htmlToText` → Import via ESM-Wrapper oder Code-Spiegelung mit Drift-Test.
- [public/js/book/tree.js](public/js/book/tree.js) `_syncPageStatsAfterSave` → konsumiert denselben.
- Neue Spellcheck-Pipeline → konsumiert denselben.

Drift-Test [tests/unit/text-normalize.test.mjs](tests/unit/text-normalize.test.mjs) prüft Frontend/Server-Parität.

## Frontend

### Spellcheck-Controller (editor-agnostisch)

Neue Datei [public/js/cards/editor-spellcheck-card.js](public/js/cards/editor-spellcheck-card.js).

Export:
```js
export function createSpellcheckController({
  root,              // HTMLElement, contenteditable Root
  scrollContainer,   // HTMLElement, das scrollende Eltern-Element
  getHtml,           // () => string, aktueller Editor-HTML-Snapshot
  onApplyReplacement,// (range, text) => void, editor-spezifischer Apply-Pfad
  editorKind,        // 'notebook' | 'focus' | 'book' — nur für CSS-Hooks
})
```

Rückgabe: `{ attach(), detach(), refresh() }`.

State (in Controller-Closure):
- `_matches: Match[]`
- `_overlay: HTMLDivElement`
- `_squiggles: Map<matchId, { range, els: HTMLSpanElement[] }>`
- `_debounceTimer`
- `_seq: number` (Staleness-Counter)
- `_mutationObs`, `_resizeObs`, `_scrollHandler`
- `_extensionDetected: boolean`

### Lifecycle

| Editor | attach | detach |
|---|---|---|
| Notebook | bei Edit-Mode-Enter (in [public/js/editor/notebook/](public/js/editor/notebook/)) | bei Save+Leave |
| Focus | bei Focus-Enter (in [public/js/editor/focus.js](public/js/editor/focus.js)) | bei Focus-Exit |
| Bucheditor | bei Block-Activate (in [public/js/cards/book-editor-card.js](public/js/cards/book-editor-card.js)) | bei Block-Deactivate / Buchschliessung |

Bucheditor: pro Block-Wechsel `detach()` + `attach(newBlock)`. Nur aktiver Block hat Squiggles, nicht ganzes Manuskript.

### Pipeline

1. `attach()`:
   - Overlay `<div class="lt-overlay" data-editor="${editorKind}">` als Geschwister des `root` einhängen.
   - `MutationObserver` + `input`-Listener auf `root` → `_scheduleCheck()`.
   - `ResizeObserver` auf `root`.
   - `scrollContainer.addEventListener('scroll', _reposition, { passive: true })`.
   - `window.addEventListener('resize', _reposition)`.
   - Extension-Detection-Observer (siehe unten).
   - Initial-Check sofort (kein Debounce beim Attach).

2. `_scheduleCheck()`: debounce 1500ms → `_runCheck()`.

3. `_runCheck()`:
   - `requestId = ++_seq`.
   - Plain-Text + Offset-Tabelle aus `root` via TreeWalker (siehe Mapping).
   - `htmlSnapshot = getHtml()`.
   - `fetch('/languagetool/check', { text, language: bookLang, picky })`.
   - `404` → `_disabled = true`, kein Retry, Overlay leeren.
   - `200`:
     - Wenn `requestId !== _seq` → verwerfen (User hat weitergetippt).
     - Wenn `getHtml() !== htmlSnapshot` → verwerfen.
     - Sonst `_matches = json.matches`, `_renderOverlay()`.

4. `_renderOverlay()`:
   - Alte Squiggles aus DOM entfernen, Map leeren.
   - Pro Match: Range via Offset-Tabelle bauen.
   - `range.getClientRects()` → ein `<span class="lt-squiggle lt-squiggle--${cat}" data-match-id="...">` pro Rect, positioniert relativ zu Overlay-Bounds.
   - `_squiggles.set(matchId, { range, els })`.

5. `_reposition()` (Scroll/Resize):
   - Pro `_squiggles`-Entry: `range.getClientRects()` neu auslesen, Span-Positionen updaten.
   - Wenn `range.collapsed` (DOM-Mutation während Pending-State) → Squiggle invalidieren, nächster Check baut neu.

6. `_onSquiggleClick(matchId)`:
   - Popover öffnen mit Replacements + Rule-Info.
   - Replacement-Klick → `onApplyReplacement(range, text)` → editor-spezifisch.
   - Ignore-Klick → Session-only Set `_ignored.add(matchId)`, Squiggle weg.

7. `detach()`:
   - Alle Observer disconnect, Listener removed, Overlay aus DOM, State geleert.

### Offset → Range Mapping

[public/js/cards/editor-spellcheck/mapping.js](public/js/cards/editor-spellcheck/mapping.js) — pure functions, testbar ohne DOM-Browser:

```js
buildOffsetTable(root)
  → { text: string, nodes: Array<{ node: Text, start: number, end: number }> }

rangeFromOffset(table, offset, length)
  → Range
```

TreeWalker `SHOW_TEXT`, kumuliere `textContent.length`. Whitespace-Normalisierung muss **identisch** zu `lib/text-normalize.js#htmlToText` sein. Block-Boundaries (`</p>`/`<br>`) erzeugen Single-Space im Text-Stream.

### Apply-Replacement pro Editor

| Editor | Handler |
|---|---|
| Notebook | `range.deleteContents()` + `range.insertNode(textNode)` + `input`-Event dispatch (Save-Pipeline triggert) |
| Focus | identisch wie Notebook (gleiche Save-Pipeline) |
| Bucheditor | wie oben, zusätzlich Block als `dirty` markieren (`bookEditorCard._markDirty(blockEl)`) |

### Browser-Spellcheck deaktivieren

Pflicht-Edits:
- [public/partials/editor-body-edit.html:48](public/partials/editor-body-edit.html#L48) → `:spellcheck="!$app.config?.languagetool?.enabled"`
- [public/partials/editor-focus.html:43](public/partials/editor-focus.html#L43) → identisch
- [public/partials/book-editor.html:140](public/partials/book-editor.html#L140) → identisch

Wenn `enabled === false` → Browser-Spellcheck bleibt aktiv (Fallback).

### Extension-Konflikt-Detection

LT-Browser-Extension injiziert eigene Squiggles. Doppelter Underline + Replacement-Konflikte.

Detection in Controller:
- MutationObserver auf `document.body`.
- Selektoren: `lt-div`, `lt-highlighter`, `[class*="lt-toolbar"]`, `[class*="languagetool"]`, `body.__lt-installed`.
- Hit → `_extensionDetected = true` → Banner via `$app`-Flag + `_matches = []` + `_renderOverlay()` (leer).
- Marker verschwinden → `_extensionDetected = false`, nächster Check rendert wieder.

Banner-Render: einmaliger Container über Editor, i18n-Keys `spellcheck.extension_conflict.*`, Dismiss-Button (sessionStorage-Flag).

### Sprach-Mapping

Buch hat zwei Spalten: `books.language` (`de`/`en`, [routes/booksettings.js#VALID_LANGUAGES](routes/booksettings.js)) + `books.region` (`CH`/`DE`/`US`/`GB`, [routes/booksettings.js#VALID_REGIONS](routes/booksettings.js)). LT-Locale = `${language}-${region}`.

Erlaubte Kombinationen (von LT supported):
- `de-CH`, `de-DE`, `de-AT` (falls künftig ergänzt)
- `en-US`, `en-GB`

Falls `language` oder `region` null/leer → Fallback `auto` (LT erkennt selbst).

Mapping-Funktion in Controller, liest aus `$app.currentBook` (Alpine-Reactive). Kein User-Override im MVP — wenn künftig nötig: `books.languagetool_locale`-Spalte (out-of-scope).

### Card-Registry

In [public/js/cards/feature-registry.js](public/js/cards/feature-registry.js) **nicht** eintragen — Controller ist keine Toggle-Karte, lebt im Editor-Scope.

Init-Hook in [public/js/app.js](public/js/app.js): `registerEditorSpellcheckCard()` registriert die Alpine.data-Komponente, die den Controller intern verwaltet (analog `editor-find-card`).

## CSS

Neue Datei [public/css/editor/spellcheck.css](public/css/editor/spellcheck.css). Shared für alle drei Editoren.

Klassen:
- `.lt-overlay` — `position: absolute`, `inset: 0`, `pointer-events: none`, `z-index: var(--z-overlay-spellcheck)`.
- `.lt-squiggle` — absolut positioniert, `pointer-events: auto`, `cursor: pointer`. Background = inline-SVG-Wavy-Underline, Farbe via `--lt-color` Custom-Prop.
- `.lt-squiggle--typo` — `--lt-color: var(--color-danger)`.
- `.lt-squiggle--grammar` — `--lt-color: var(--color-info)`.
- `.lt-squiggle--style` — `--lt-color: var(--color-warning)`.
- `.lt-popover` — fixed, max-width 320px, eckige Badges (`border-radius: var(--radius-sm)`), Lucide-Icons.
- `.lt-popover__replacement` — Button-Stil aus DESIGN.md.
- `.lt-extension-conflict-banner` — Banner-Pattern aus DESIGN.md (Session-Banner wiederverwenden falls existent).

Per-Editor-Tweaks via `[data-editor="focus"]`/`[data-editor="book"]`-Attribut-Selektor, falls nötig (z.B. Focus-Editor andere Schriftgrösse → andere Squiggle-Höhe).

Pflicht:
- `<link>` in [public/index.html](public/index.html).
- `SHELL_CACHE` in [public/sw.js](public/sw.js) bumpen.
- Eintrag in [DESIGN.md](DESIGN.md) „CSS-File-Inventar" + neue UI-Patterns „Spellcheck-Overlay" + „Spellcheck-Popover".
- `--z-overlay-spellcheck`-Token in [public/css/tokens/](public/css/tokens/) (z-index-Datei).

## i18n

Neue Keys in [public/js/i18n/de.json](public/js/i18n/de.json) + [public/js/i18n/en.json](public/js/i18n/en.json):

- `spellcheck.popover.replace`
- `spellcheck.popover.ignore`
- `spellcheck.popover.no_suggestions`
- `spellcheck.popover.rule_info`
- `spellcheck.error.server`
- `spellcheck.extension_conflict.title`
- `spellcheck.extension_conflict.body`
- `spellcheck.extension_conflict.dismiss`
- `admin.settings.languagetool.enabled.label`
- `admin.settings.languagetool.url.label`
- `admin.settings.languagetool.url.placeholder` — z.B. `http://localhost:8010`
- `admin.settings.languagetool.picky.label`
- `admin.settings.languagetool.picky.help`

## DB

Keine Schema-Änderung im MVP.

Phase-2-Cache (out-of-scope): `page_languagetool_cache (page_id, content_hash, lang, matches_json, created_at)` mit `CASCADE` auf `pages`.

## Security

- LT-URL niemals ans Frontend leaken (Proxy hält sie).
- Session-Guard auf Proxy-Route (kein anonymer LT-Zugriff).
- Text-Inhalt geht nur an Self-Hosted-LT — kein externer Traffic.
- Popover-Content escaped via `escHtml()` / `textContent` (LT-Response enthält user-injizierten Kontext-String → XSS-Risiko ohne Escape).
- LT-Server-URL: bei `http://`-URLs Warning im Admin-UI (Plain-HTTP, lokales LAN OK).
- Timeout 10s gegen Hänger; kein unbounded `await fetch`.

## Telemetrie

Kein User-Tracking im MVP. Logging:
- LT-Disabled-Hits → `logger.debug` (nicht spammen).
- LT-Upstream-Fehler → `logger.warn` mit URL + Status.
- Timeout → `logger.warn`.
- Extension-Conflict-Detection-Hit → `logger.info` einmalig pro Session.

Kein Recency-Tracking (`/usage/track`) — Spellcheck ist kein Feature-Toggle.

## Reversibilität

- App-Settings `languagetool.enabled=false` → Frontend-Controller attached nicht, Browser-Spellcheck zurück.
- Vollständiger Rollback: Datei-Set löschen + i18n-Keys raus + Template-`:spellcheck`-Bindings auf `true` zurück. Kein DB-Schema-Change.

## Tests

| Layer | Datei | Scope |
|---|---|---|
| Unit | [tests/unit/text-normalize.test.mjs](tests/unit/text-normalize.test.mjs) | Server/Frontend-Parität `htmlToText` |
| Unit | [tests/unit/languagetool-mapping.test.mjs](tests/unit/languagetool-mapping.test.mjs) | `buildOffsetTable`/`rangeFromOffset`: Whitespace-Collapse, Block-Boundaries, Mehrzeilen-Match |
| Integration | [tests/integration/languagetool-proxy.test.js](tests/integration/languagetool-proxy.test.js) | Mock-LT-Server: Forward, Disabled-404, Upstream-502, Timeout |
| E2E | [tests/e2e/spellcheck-notebook.spec.js](tests/e2e/spellcheck-notebook.spec.js) | Tippen → Debounce → Squiggle → Popover → Replace → Save |
| E2E | [tests/e2e/spellcheck-focus.spec.js](tests/e2e/spellcheck-focus.spec.js) | Focus-Enter/Exit-Lifecycle, Scroll-Reposition |
| E2E | [tests/e2e/spellcheck-book.spec.js](tests/e2e/spellcheck-book.spec.js) | Block-Activate-Switch: Squiggle wandert mit aktivem Block |

Mock-LT-Server in `tests/integration/_helpers/mock-languagetool.js`.

## Edge-Cases

- **LT down**: `_runCheck` catched → kein Editor-Bruch, Squiggles aus. Banner optional in Phase 2.
- **>50KB Text**: deferred (Chunking Phase 2). MVP cap auf 100KB im Proxy, sonst `413`.
- **DOM-Mutation während pending Check**: Response verworfen via `_seq`-Counter + `htmlSnapshot`-Check.
- **Lektorat-Marks koexistieren**: LT-Overlay liegt über Editor; Lektorat-Marks sind inline `<mark>`. Visuelle Konkurrenz möglich. MVP: koexistieren. Phase 2 evtl. LT pausieren bei aktivem Lektorat-Mode.
- **Bucheditor-Block-Wechsel mit pending Check**: `detach()` cancelt Debounce-Timer + AbortController.
- **Extension-Toggle zur Laufzeit**: MutationObserver fängt rein/raus, Overlay pausiert/resumed automatisch.
- **`books.language` null**: Mapping fällt auf `auto` zurück.
- **LT-Response leer**: `matches: []` → Overlay leer, kein Fehler.
- **Range invalid nach Mutation**: `range.collapsed` Check, Squiggle invalidieren statt crashen.

## Kritische Dateien

### Modify

| Datei | Änderung |
|---|---|
| [lib/app-settings.js](lib/app-settings.js) | `DEFAULTS`: `languagetool.{enabled,url,picky}` |
| [routes/admin-settings.js](routes/admin-settings.js) | Allowlist um 3 Keys |
| [routes/proxies.js](routes/proxies.js) | `/config` → `languagetool: { enabled }` |
| [routes/sync.js](routes/sync.js) | `htmlToText` Import aus `lib/text-normalize.js` |
| [server.js](server.js) | Router mount `/languagetool` |
| [public/partials/editor-body-edit.html](public/partials/editor-body-edit.html) | `:spellcheck`-Binding |
| [public/partials/editor-focus.html](public/partials/editor-focus.html) | `:spellcheck`-Binding |
| [public/partials/book-editor.html](public/partials/book-editor.html) | `:spellcheck`-Binding |
| [public/js/editor/notebook/](public/js/editor/notebook/) | Controller-attach/detach |
| [public/js/editor/focus.js](public/js/editor/focus.js) | Controller-attach/detach |
| [public/js/cards/book-editor-card.js](public/js/cards/book-editor-card.js) | Controller-attach/detach pro Block |
| [public/js/book/tree.js](public/js/book/tree.js) | `htmlToText` aus Shared-Helper |
| [public/js/utils.js](public/js/utils.js) | `htmlToText` aus Shared-Helper |
| [public/js/app.js](public/js/app.js) | `registerEditorSpellcheckCard()` |
| [public/index.html](public/index.html) | `<link>` spellcheck.css |
| [public/sw.js](public/sw.js) | `SHELL_CACHE` bump |
| [public/css/tokens/](public/css/tokens/) | `--z-overlay-spellcheck` |
| [public/js/i18n/de.json](public/js/i18n/de.json) | neue Keys |
| [public/js/i18n/en.json](public/js/i18n/en.json) | neue Keys |
| [DESIGN.md](DESIGN.md) | CSS-Inventar + Patterns „Spellcheck-Overlay"/„Spellcheck-Popover" |
| [CLAUDE.md](CLAUDE.md) | Hinweis: LT non-KI, sync Proxy OK |

### Create

| Datei | Zweck |
|---|---|
| [lib/text-normalize.js](lib/text-normalize.js) | Shared `htmlToText` (Server + Frontend) |
| [routes/languagetool.js](routes/languagetool.js) | Proxy-Route |
| [public/js/cards/editor-spellcheck-card.js](public/js/cards/editor-spellcheck-card.js) | Controller-Factory + Alpine.data-Wrapper |
| [public/js/cards/editor-spellcheck/mapping.js](public/js/cards/editor-spellcheck/mapping.js) | Offset/Range-Mapping (testbar) |
| [public/css/editor/spellcheck.css](public/css/editor/spellcheck.css) | Squiggle + Popover + Banner |
| [tests/unit/text-normalize.test.mjs](tests/unit/text-normalize.test.mjs) | Parität-Test |
| [tests/unit/languagetool-mapping.test.mjs](tests/unit/languagetool-mapping.test.mjs) | Offset-Mapping |
| [tests/integration/languagetool-proxy.test.js](tests/integration/languagetool-proxy.test.js) | Proxy-Forward |
| [tests/integration/_helpers/mock-languagetool.js](tests/integration/_helpers/mock-languagetool.js) | Mock-LT-Server |
| [tests/e2e/spellcheck-notebook.spec.js](tests/e2e/spellcheck-notebook.spec.js) | Notebook-Flow |
| [tests/e2e/spellcheck-focus.spec.js](tests/e2e/spellcheck-focus.spec.js) | Focus-Lifecycle |
| [tests/e2e/spellcheck-book.spec.js](tests/e2e/spellcheck-book.spec.js) | Bucheditor-Block-Switch |

## Offene Fragen

(leer — Plan ist Ready)
