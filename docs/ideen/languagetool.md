# LanguageTool-Integration im Editor

## Context

User will Browser-Rechtschreibprüfung ablösen durch selbstgehostetes LanguageTool (Docker). Ziel: konsistente Squiggle-Anzeige unabhängig vom Browser/OS, mit besseren Vorschlägen und Buchsprach-Awareness. Konfiguration der LT-URL erfolgt in **App-Settings** (nicht `.env`), Feature nur global aktivierbar — kein User-Override. Check läuft **live während Tippens** (Debounce 1.5s) via Overlay-Layer, damit Cursor unberührt bleibt.

## Hosting (User-Setup)

Docker: `erikvl87/languagetool` (oder `meyay/languagetool`) auf Port 8010. ~1 GB RAM, kein KI. REST: `POST {URL}/v2/check?text=...&language=de-CH`. Optional `X-API-Key`-Header für Premium-Hosting.

## App-Settings (Pattern via [lib/app-settings.js:26-123](lib/app-settings.js#L26-L123))

Neue Keys in `DEFAULTS`:
- `languagetool.enabled` — bool, default `false` (Master-Switch)
- `languagetool.url` — string, default `""` (leer = aus, auch wenn enabled)
- `languagetool.api_key` — string, default `""`, in `ENCRYPTED_KEYS` aufnehmen
- `languagetool.default_language` — string, default `"auto"` (Override pro Buch via `books.language`)
- `languagetool.picky` — bool, default `false` (LT-`level=picky`)

Admin-UI: bestehende Pattern in [routes/admin-settings.js:37-50](routes/admin-settings.js#L37-L50) reicht. Frontend-Exposure via `/config`-Endpoint ([routes/proxies.js:28-66](routes/proxies.js#L28-L66)) — nur `enabled` + Sprach-Default an Frontend, NICHT URL/API-Key.

## Server-Proxy (synchron, kein Job-Queue)

**Pattern:** OpenThesaurus ([routes/proxies.js:365-387](routes/proxies.js#L365-L387)) — synchroner Fetch mit 10s AbortController, kein Job. LT-Check ist <500ms typisch.

**Neue Datei:** [routes/languagetool.js](routes/languagetool.js)
- `POST /languagetool/check` — Body: `{ text, language, bookId? }`
- Auth via Session-Guard (Standard).
- Liest `languagetool.enabled`/`.url`/`.api_key`/`.picky` via `appSettings.get()`.
- Forward an `{url}/v2/check` mit `text`, `language`, `level=picky?`, `enabledOnly=false`.
- Response 1:1 weiterreichen.
- Bei `!enabled || !url` → `404 { error: 'languagetool_disabled' }` (Frontend behandelt als „Feature aus").
- Mount in [server.js](server.js).

**Caching (optional, später):** `page_languagetool_cache` (page_id, content_hash, lang, matches_json, created_at) mit CASCADE auf `pages`. Cache-Hit spart Round-Trip beim Page-Open. **Out-of-Scope für MVP** — erst messen, ob LT-Server schnell genug ist.

## Frontend: Overlay-Layer (kein Inline-Wrap)

Editor-Root: [public/partials/editor-body-edit.html:44-48](public/partials/editor-body-edit.html#L44-L48) — `<div class="page-content-view page-content-view--editing" contenteditable="true">`.

**Pflicht-Änderung:** `spellcheck="true"` → `spellcheck="false"` wenn `$app.config.languagetool?.enabled`. Per `:spellcheck`-Binding.

### Architektur

Neue Sub-Komponente: [public/js/cards/editor-spellcheck-card.js](public/js/cards/editor-spellcheck-card.js) — Alpine.data, ohne UI-Card (nur Logic + Overlay-Mount). Registriert via `registerEditorSpellcheckCard()`.

**Overlay-Pattern:**
1. Neuer Container `<div class="lt-overlay">` als Geschwister des Editors, `position: absolute`, `pointer-events: none`, gleiche Bounds wie Editor-Root (via `getBoundingClientRect`).
2. Pro Match: `<span class="lt-squiggle lt-squiggle--<category>" data-tip="...">` mit `pointer-events: auto`, absolut positioniert über dem Wort. Position aus `Range.getClientRects()` jedes Match-Bereichs.
3. SVG-Squiggle als Background (`background-image: url("data:image/svg+xml,…wavy underline…")`) — wie Browser-Spellcheck, aber stylebar.

### Text-Mapping (Wiederverwendung)

**Plain-Text-Extraktion:** `htmlToText()` in [public/js/utils.js:308-322](public/js/utils.js#L308-L322) — bereits getrimmt, `\s+` collapsed.

**Match-Offset → DOM-Range:**
- LT liefert `offset`/`length` in Plain-Text (UTF-16 Code Units, matched JS `String.length`).
- Walk per `TreeWalker(NodeFilter.SHOW_TEXT)` über Editor-Root, kumuliere `textContent.length` mit derselben `\s+`-Normalisierung wie [routes/sync.js](routes/sync.js) (siehe CLAUDE.md „HTML→Text-Normalisierung").
- An Match-Boundary `Range.setStart`/`setEnd` auf Text-Node + lokalen Offset.
- `range.getClientRects()` → eine oder mehrere Rects (Zeilenumbruch) → ein `lt-squiggle`-Span pro Rect.

**Wichtig:** Normalisierungs-Helper aus [routes/sync.js#htmlToText](routes/sync.js) als gemeinsamen Helper in `lib/text-normalize.js` ziehen + frontend nutzen — sonst Drift gegen Stats-Pfad (CLAUDE.md-Pflicht: „Frontend MUSS Server matchen"). **Out-of-Scope:** wenn Helper bereits SSoT in `utils.js` ist, dort nachschauen statt neu zu schreiben.

### Live-Pipeline

1. `init()` der Sub-Komponente: `$watch` auf `$app.currentPageId` + `$app.editor.html` (oder Editor-`input`-Event).
2. Debounce 1500ms nach letzter Mutation → `_runCheck()`.
3. `_runCheck()`:
   - Plain-Text aus Editor extrahieren (`htmlToText` auf `editorRoot.innerHTML` ODER direkt aus DOM via TreeWalker).
   - `fetch('/languagetool/check', { text, language: bookLang })`.
   - Bei 404 (disabled) → Feature still off, kein Retry.
   - Bei OK → Matches in `_matches` State, `_renderOverlay()`.
4. `_renderOverlay()`:
   - Bestehende Squiggles entfernen.
   - Pro Match Range bauen → Rects → Spans erzeugen + Position setzen.
   - Klick auf Squiggle → Popover mit `match.replacements[0..2].value` + „Ignorieren" + „Regel deaktivieren" (UI-only, persistiert nicht, da User-Override out-of-scope).

### Re-Position bei Scroll/Resize

- `ResizeObserver` auf Editor-Root.
- `scroll`-Listener auf scrollendem Parent.
- Bei jedem Trigger: alle Squiggle-Positionen via gespeicherter Range neu auslesen + setzen.
- Bei DOM-Mutation im Editor: Squiggles weglassen bis nächster Debounce-Check (Ranges sind invalid).

### Apply-Replacement

- Popover-Klick auf Vorschlag → `Range` aus Match wiederherstellen → `range.deleteContents()` + `range.insertNode(document.createTextNode(replacement))`.
- Editor's `input`-Event triggert Auto-Save + nächsten LT-Check.
- Selection nach Replacement hinter Einfügung setzen.

## CSS

Neue Datei: [public/css/editor/spellcheck.css](public/css/editor/spellcheck.css)
- `.lt-overlay` — Container.
- `.lt-squiggle` — absolut positioniert, wavy SVG-Underline als Background (Farbe pro Kategorie via CSS-Custom-Prop `--lt-color`).
- `.lt-squiggle--typo` (rot, Typo/Spelling).
- `.lt-squiggle--grammar` (blau).
- `.lt-squiggle--style` (orange, „picky"-Regeln).
- `.lt-popover` — bestehendes Popover-Pattern aus Synonym-Card wiederverwenden falls vorhanden, sonst eigenes.

Mobile: identisches Verhalten, evtl. Squiggle-Höhe via Container-Query.

Pflicht: `<link>` in [public/index.html](public/index.html), `SHELL_CACHE` in [public/sw.js](public/sw.js) bumpen, Eintrag in [DESIGN.md](DESIGN.md) „CSS-File-Inventar" + neues UI-Pattern „Spellcheck-Overlay".

## i18n

Neue Keys in [public/js/i18n/de.json](public/js/i18n/de.json) + [public/js/i18n/en.json](public/js/i18n/en.json):
- `spellcheck.popover.replace` — „Ersetzen"
- `spellcheck.popover.ignore` — „Ignorieren"
- `spellcheck.popover.no_suggestions` — „Keine Vorschläge"
- `spellcheck.error.server` — „LanguageTool-Server nicht erreichbar"
- `admin.settings.languagetool.url.label`
- `admin.settings.languagetool.enabled.label`
- `admin.settings.languagetool.picky.label`
- `admin.settings.languagetool.api_key.label`

## Sprache pro Buch

LT-Sprach-Param aus `books.language` (existiert bereits). Mapping:
- `de` → `de-CH` (Swiss-Default, alternativ `de-DE` falls Buch-Setting es vorgibt — out-of-scope für MVP, hartcodiert `de-CH`).
- `en` → `en-GB`.
- Sonst → `auto` (LT erkennt selbst).

Falls künftig Buch-Locale-Override nötig: `books.languagetool_locale` ergänzen — **out-of-scope für MVP**.

## Browser-Extension-Warnung

LanguageTool bietet offizielle Browser-Extensions (Chrome/Firefox/Edge). Wenn aktiv, injiziert sie eigene Squiggles in contentEditable-Elemente → **Doppel-Underline** und Konflikte mit dem App-Overlay (doppelte Popover, fehlerhafte Replacements, da Extension Inline-Wrap macht).

**Detection:** Extension injiziert DOM-Marker — z.B. `<lt-div>` (Custom-Element), `<div class="lt-toolbar">` oder `[data-lt-...]`-Attribute am `<body>` bzw. nahe contentEditable-Elementen. MutationObserver auf `document.body` mit Filter auf bekannte Selektoren.

**Bekannte Marker** (Stand 2026, vor Implementierung verifizieren — Extension-DOM ändert sich):
- `<lt-div>` / `<lt-highlighter>` Custom-Elemente
- `[class*="lt-toolbar"]`, `[class*="languagetool"]`
- `body.__lt-installed` (manche Versionen)

**Handling:**
1. Beim Editor-Open + bei MutationObserver-Hit prüfen.
2. Falls Extension detected + `languagetool.enabled=true` global:
   - Banner über Editor: i18n-Key `spellcheck.extension_conflict` — „LanguageTool-Browser-Extension erkannt. Bitte für diese Seite deaktivieren — die App nutzt eine eigene LanguageTool-Integration. (Extension-Icon klicken → 'Auf dieser Seite deaktivieren'.)"
   - App-Overlay pausiert (`_matches = []`, kein Re-Render), damit kein Doppel-Squiggle.
3. Banner persistiert, bis Extension-Marker verschwinden (MutationObserver re-checkt).
4. Dismiss-Button → User kann Banner für Session ausblenden (sessionStorage-Flag), App-Overlay bleibt aber off solange Marker da sind.

**i18n-Keys ergänzen:**
- `spellcheck.extension_conflict.title`
- `spellcheck.extension_conflict.body`
- `spellcheck.extension_conflict.dismiss`

**CSS:** Banner-Pattern aus DESIGN.md wiederverwenden (existierender Session-Banner oder `.notice`-Komponente, vor Implementierung prüfen).

**Datei:** Detection-Logic in [public/js/cards/editor-spellcheck-card.js](public/js/cards/editor-spellcheck-card.js) — neues Feld `_extensionDetected`, Method `_checkExtensionPresence()`, gerendert via `$app`-Flag.

## Edge-Cases / Risiken

- **LT-Server down:** `_runCheck` fängt, kein Editor-Bruch, Browser-Spellcheck bleibt aus → User merkt's nur am fehlenden Squiggle. Status-Indikator optional (kleines Lucide-Icon `circle-off` in Editor-Toolbar).
- **Lange Texte:** LT-API-Cap typisch 100KB. Bei `text.length > 50000` chunken (per Absatz). MVP: deferred, erst messen.
- **DOM-Mutation während pending Check:** Response-Matches verwerfen, wenn `editor.html` sich seit Request-Start geändert hat (Staleness-Check via `requestId` analog zu `updatedAt`-Pattern in CLAUDE.md „Job-Ergebnisse mit `updatedAt`-Staleness-Check").
- **Konflikt mit Lektorat-Marks:** Lektorat rendert inline `<mark>` ins HTML — überlebt parallel zur Overlay. Falls visuelle Konkurrenz: LT-Squiggle pausieren während Lektorat-Modus aktiv. MVP: erstmal koexistieren lassen, beobachten.
- **CLAUDE.md „KI-Calls nur via Job-Queue":** LanguageTool ist regelbasiert, kein KI-Call → Job-Queue nicht nötig. Synchroner Proxy wie OpenThesaurus ist regelkonform. In CLAUDE.md klarstellen.

## Test-Plan

**Unit:**
- [tests/unit/languagetool-mapping.test.mjs](tests/unit/languagetool-mapping.test.mjs) — Plain-Text-Offset → TreeWalker-Range. Edge: Whitespace-Collapse, Block-Boundaries.

**Integration:**
- [tests/integration/languagetool-proxy.test.js](tests/integration/languagetool-proxy.test.js) — Mock-LT-Server, Proxy-Forwarding, disabled-Fall (404), Timeout.

**E2E (Playwright):**
- [tests/e2e/spellcheck.spec.js](tests/e2e/spellcheck.spec.js) — Tippen → Debounce → Squiggle erscheint → Klick → Replacement angewandt → Squiggle weg. Mock-LT-Server via Test-Harness.

**Manuell:**
- LT-Container starten: `docker run -d -p 8010:8010 erikvl87/languagetool`.
- Admin-Settings: `languagetool.url=http://localhost:8010`, `languagetool.enabled=true`.
- Buch öffnen, Seite editieren, Tippfehler eingeben → Squiggle nach 1.5s erwartet.
- Scroll-Test: Squiggle bleibt am Wort kleben beim Scrollen.
- Resize-Test: Window-Resize → Squiggle reposition.

## Kritische Dateien (Modify)

| Datei | Änderung |
|---|---|
| [lib/app-settings.js](lib/app-settings.js) | DEFAULTS + ENCRYPTED_KEYS erweitern |
| [routes/proxies.js](routes/proxies.js) | `/config` um `languagetool: { enabled, defaultLanguage }` erweitern |
| [server.js](server.js) | Router mount `/languagetool` |
| [public/partials/editor-body-edit.html](public/partials/editor-body-edit.html) | `:spellcheck="!$app.config.languagetool?.enabled"` |
| [public/index.html](public/index.html) | `<link>` für spellcheck.css |
| [public/sw.js](public/sw.js) | `SHELL_CACHE` bump |
| [public/js/app.js](public/js/app.js) | `registerEditorSpellcheckCard()` aufrufen |
| [public/js/i18n/de.json](public/js/i18n/de.json) / [en.json](public/js/i18n/en.json) | Keys |
| [DESIGN.md](DESIGN.md) | CSS-Inventar + Pattern-Eintrag |
| [CLAUDE.md](CLAUDE.md) | Klarstellung „LT ist non-KI, synchroner Proxy erlaubt" |

## Kritische Dateien (Create)

| Datei | Zweck |
|---|---|
| [routes/languagetool.js](routes/languagetool.js) | Proxy-Route |
| [public/js/cards/editor-spellcheck-card.js](public/js/cards/editor-spellcheck-card.js) | Alpine-Sub, Check-Pipeline, Overlay-Render |
| [public/css/editor/spellcheck.css](public/css/editor/spellcheck.css) | Squiggle + Popover |
| [tests/unit/languagetool-mapping.test.mjs](tests/unit/languagetool-mapping.test.mjs) | Offset-Mapping |
| [tests/integration/languagetool-proxy.test.js](tests/integration/languagetool-proxy.test.js) | Proxy-Forward |
| [tests/e2e/spellcheck.spec.js](tests/e2e/spellcheck.spec.js) | Live-Flow |

## Aufwand

MVP ohne Caching, ohne Chunking, ohne Status-Indikator: **1.5–2 Tage**.
- Tag 1: App-Settings + Proxy-Route + i18n + Admin-UI (vormittags), Overlay-Mapping + CSS (nachmittags).
- Tag 2: Live-Pipeline + Popover + Replacement-Apply (vormittags), Tests + Polish (nachmittags).

## Out-of-Scope (Phase 2)

- Per-Page-Caching (`page_languagetool_cache`).
- Chunking für >50KB-Texte.
- User-spezifische Regel-Deaktivierung (persistiert).
- Buch-Locale-Override (`books.languagetool_locale`).
- Custom-Dictionary pro User/Buch.
- Status-Indikator in Editor-Toolbar.
