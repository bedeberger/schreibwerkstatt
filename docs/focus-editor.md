# Focus-Editor

Vollbild-Schreibmodus mit Absatz-/Satz-Spotlight, Typewriter-Scroll und Live-Word-/Char-Counter. Heilige Kuh: jede Änderung an diesem Modul muss dieses Dokument konsultieren. Drift in den Invarianten = sichtbares „Flattern", verlorene Edits oder Phantom-Revisionen im Storage-Backend.

Code: [public/js/editor/focus.js](../public/js/editor/focus.js) (Facade) → [public/js/editor/focus/](../public/js/editor/focus/) (Submodule), [public/js/cards/editor-focus-card.js](../public/js/cards/editor-focus-card.js) (Alpine.data-Sub), [public/css/editor/focus/focus-mode.css](../public/css/editor/focus/focus-mode.css). Tests: [tests/e2e/focus-editor.spec.js](../tests/e2e/focus-editor.spec.js), [tests/unit/editor-focus.test.mjs](../tests/unit/editor-focus.test.mjs), [tests/unit/focus-granularity.test.mjs](../tests/unit/focus-granularity.test.mjs).

Trigger: Hotkey `Cmd/Ctrl+Shift+E` (überall im Editor; aus Lesemodus → startet Edit + Fokus in einem). Body-Listener in [public/index.html](../public/index.html#L227) routet via `handleFocusHotkey`.

## Root vs. Sub: Trampoline-Pattern

Root hält **sichtbare** Flags + Anzeigewerte, Sub hält **Lifecycle-State**. Trennung, weil Templates/CSS/andere Subs nur die Flag brauchen — Listener-Setup, Generation-Counter und RAF gehören zur Card-Lifecycle.

| Wohnt im Root (`focusModeState` + `shellState`) | Wohnt in Sub (`editorFocusCard`) |
|---|---|
| `focusMode` (bool, Template-Guard, body-class) | `_focusState` (`idle`/`entering`/`active`/`exiting`) |
| `focusGranularity` (`paragraph`/`sentence`/`window-3`/`typewriter-only`) | `_focusGen` (Re-Entry-Guard für async Nachzügler) |
| `focusCountWords` / `focusCountChars` (Live-Anzeige) | `_focusListeners` (ctx mit AbortController, Timer, Pointer-Flag, IO/MO, expectedScroll, …) |
| `focusCountWordsDelta` / `focusCountCharsDelta` (Tages-Delta) | `_focusVisibleBlocks` (IO-getrackte Block-Refs) |
|  | `_focusRaf` (cancellable RAF-Handle für Recenter) |
|  | `_focusAutoAddedP` (Auto-`<p>`-Slot — Referenz auf Exit-Cleanup) |
|  | `_restoreSnapshot` (Reload-Wiederaufnahme) |

Root-Methoden ([editor/focus/trampoline.js](../public/js/editor/focus/trampoline.js)) sind **reine Event-Dispatcher** — sie feuern `editor:focus:{toggle|enter|exit|start-edit}` aufs Window. Sub abonniert in `init()` mit `AbortController`-Signal. Root-Spread (`focusMethods`) bleibt minimal, damit Hot-Reload/HMR keine doppelten Listener anhängt.

## State-Machine

```
idle ──enterFocusMode──▶ entering ──$nextTick──▶ active ──exitFocusMode──▶ exiting ──await save──▶ idle
                            │                       │                          │
                            └───install fails───▶ idle                         └── Re-Entry blockt (Generation-Check)
```

- **Re-Entry-Guard:** Jeder `enter`/`exit`-Aufruf erhöht `_focusGen`. Async-Nachzügler (RAFs, `await quickSave`) prüfen `gen !== this._focusGen` → no-op. Schneller exit→enter→exit-Cycle hinterlässt keinen Geisterstand.
- **Doppel-Trigger im `entering`/`exiting`:** `toggleFocusMode` ignoriert beide Übergänge — kein Double-Enter, kein Halt-im-Halbgang.
- **`enterFocusMode` Pflicht-Sequenz** ([card.js:45-82](../public/js/editor/focus/card.js#L45-L82)): `_flushDraftSaveNow` → `focusMode=true` + body-class → `$nextTick` → `_focusInstall` → `_focusUpdateActive(true)` → `writeFocusSnapshot`. Fehler im Install → `_focusTeardown` + Snapshot-clear + Flag zurück, State zurück auf `idle`.
- **`exitFocusMode` Pflicht-Sequenz** ([card.js:329-402](../public/js/editor/focus/card.js#L329-L402)): Auto-`<p>` abräumen → `await quickSave` (wenn dirty) → `_focusTeardown` → Snapshot-clear → body-classes weg → `--focus-vh*` zurück → restliche `.focus-paragraph-*`-Klassen + Custom-Highlight aufräumen → wenn clean: `editMode=false` + Autosave/Counter/OnlineRetry abreissen → `_syncPageStatsAfterSave` + `updatePageView` (idempotent zu Save-Pfad). Reihenfolge ist Pflicht: Cleanup VOR `editMode=false`, sonst rufen Autosave-Teardown auf bereits genullten Refs.

## Submodul-Karte

Facade re-exportiert; externer Import läuft über [editor/focus.js](../public/js/editor/focus.js). Submodule sind interne Aufteilung.

| Modul | Verantwortlich für |
|---|---|
| [constants.js](../public/js/editor/focus/constants.js) | `BLOCK_TAGS` (P/H1-H6/BLOCKQUOTE/LI/PRE/TD/TH/FIGURE/FIGCAPTION — **DIV bewusst nicht drin**), Timing (`POINTER_GRACE_MS=300`, `VV_DEBOUNCE_MS=100`, `CURSOR_HIDE_MS=2000`, `COUNTER_DEBOUNCE_MS=220`), Feature-Detects (`HAS_IO`/`HAS_MO`), `prefersReducedMotion`, `reportError`-Sink |
| [trampoline.js](../public/js/editor/focus/trampoline.js) | Root-Methoden: 4 Event-Dispatcher + `handleFocusHotkey` (Body-Listener-Routing je nach `focusMode`/`editMode`) |
| [card.js](../public/js/editor/focus/card.js) | Sub-Methoden: `toggleFocusMode`/`enterFocusMode`/`startFocusEdit`/`exitFocusMode`/`_focusInstall`/`_focusTeardown`/`_focusUpdateActive`. **Listener-Setup + RAF-Recenter-Pipeline** |
| [dom-blocks.js](../public/js/editor/focus/dom-blocks.js) | `findBlockFromNode` (outermost-Ancestor!), `findBlockAtViewportCenter`/`pickCenterBlock`, `setActiveBlock`/`setNearBlocks`/`clearAllFocusMarks` (Defense gegen Chromium-Split-Bug + `class=""`-Residual), `isEmptyParagraph`/`jumpToTrailingParagraph`/`getScrollContainer` |
| [sentence.js](../public/js/editor/focus/sentence.js) | `findSentenceRanges` (Intl.Segmenter mit Regex-Fallback), `findSentenceAtCaret`, `applySentenceHighlight` (CSS Custom Highlight API — kein DOM-Diff!) |
| [typewriter.js](../public/js/editor/focus/typewriter.js) | `dynamicTypewriterThreshold` (line-height/2 als Untergrenze), `getCaretRect`, `computeTypewriterDelta` (pure), `typewriterScroll` (mit `expectedScroll`-Counter + `prefers-reduced-motion`-Pfad) |
| [storage.js](../public/js/editor/focus/storage.js) | sessionStorage-Snapshot (`focus.snapshot`, TTL 1h) für Reload-Wiederaufnahme, localStorage-Tagesbaseline (`focus.dailyBaseline`) mit lazy-Prune, `installEditCounter` (Pflicht für Counter-Anzeige; **läuft im Edit-Mode, nicht erst im Fokus**) |

## Granularitäten

`focusGranularity` lebt im Root (`shellState`) und ist **live umschaltbar** — Sub-`init()` setzt `$watch` ([editor-focus-card.js:41-46](../public/js/cards/editor-focus-card.js#L41-L46)) und tauscht body-Class + Re-Render ohne exit/enter.

| Wert | Was passiert |
|---|---|
| `paragraph` (default) | Aktiver Block hell, alle anderen via `:not(.focus-paragraph-active)` opacity 0.5 |
| `sentence` | Plus: aktiver Satz im aktiven Block hell, restliche Sätze via `::highlight(focus-sentence-dim)` (CSS Custom Highlight, kein DOM-Diff). **Teurer Pfad** — Range-Iteration via TreeWalker; nur bei Block/Granularity-Wechsel oder bei `sentence`-Live-Update |
| `window-3` | Aktiver + direkter Vorgänger + direkter Nachfolger (`.focus-paragraph-near`) hell |
| `typewriter-only` | Keine Block-Markierung, alle Blöcke hell. Nur Caret-Scroll bleibt |

`_focusUpdateActive` ([card.js:404-475](../public/js/editor/focus/card.js#L404-L475)) hat einen **Short-Circuit-Cache** (`ctx._lastBlock` / `ctx._lastGranularity`): bleibt der aktive Block beim Tippen gleich, werden `setActiveBlock`/`setNearBlocks`/Sentence-Highlight übersprungen. **Cache-Reset Pflicht** bei `beforeinput insertParagraph/insertLineBreak` ([card.js:195-205](../public/js/editor/focus/card.js#L195-L205)) — sonst hält der Cache den vermeintlich noch aktiven Block fest, neuer Absatz bleibt ungemarkt.

## Recenter-Pipeline

Trigger feuern `_focusUpdateActive(scroll: boolean)`. Recenter passiert in einem **gecancelten RAF** — Burst-Inputs (Paste, Auto-Korrektur, IME) kollabieren auf einen Frame.

```
selectionchange / input / scroll / focus → _focusUpdateActive(…)
                                              │
                                       cancelAnimationFrame(_focusRaf)
                                              │
                                              ▼
                              ┌──── RAF-Body (try/catch) ────┐
                              │ 1. Generation-Check          │
                              │ 2. Block aus Caret-Anchor    │
                              │    (Fallback: Viewport-Center│
                              │    via IO-Set / QSA)         │
                              │ 3. setActiveBlock + nearBlocks│
                              │    (Cache-Short-Circuit)     │
                              │ 4. Sentence-Highlight        │
                              │ 5. Typewriter-Scroll wenn:   │
                              │    scroll && block && !sel   │
                              └──────────────────────────────┘
```

- **Aktive Textmarkierung blockt Recenter** — User zieht Auswahl auf, Viewport darf nicht springen.
- **Klick markiert `pointerIntent`** ([card.js:153-157](../public/js/editor/focus/card.js#L153-L157)) — folgender `selectionchange` recentert NICHT (Klick ist absichtliche Positionsänderung). Flag fällt nach `POINTER_GRACE_MS=300` ms automatisch zurück (Klick in leeren Margin erzeugt keinen selectionchange).
- **Typewriter-Schwelle dynamisch** ([typewriter.js:11-18](../public/js/editor/focus/typewriter.js#L11-L18)): `max(16, line-height * 0.5)`. Statisches 16 px scrollte schon bei subpixel-Jitter — halbe Zeilenhöhe ist die natürliche „echte Zeilenwechsel"-Grenze.
- **`expectedScroll`-Counter** ([typewriter.js:81](../public/js/editor/focus/typewriter.js#L81)): programmatischer Scroll inkrementiert; `onScroll` dekrementiert und feuert kein Recenter. Counter > Zeitfenster, weil ScrollEnd nicht zuverlässig in allen Engines.
- **`getCaretRect`-Dreistufenpfad** ([typewriter.js](../public/js/editor/focus/typewriter.js)):
  1. `range.getClientRects()[0]` — Standardfall, deckt 95 %.
  2. `range.getBoundingClientRect()` — Fallback bei leerer Rect-Liste.
  3. **Probe-Range-Expansion**: Range um 1 Position erweitern (`setEnd(off+1)`, sonst `setStart(off-1)`), Rect lesen, Probe verwerfen. Fängt den collapsed-Range-Bug am Soft-Wrap-Bruch und direkt nach `<br>`, wo Browser sonst Höhe 0 / leere Rects liefern. Non-collapsed Ranges liefern deterministisch das Rect der angrenzenden Glyphe → korrekte visuelle Zeile.
- **Kein Block-BBox-Fallback im Recenter** ([card.js:463-473](../public/js/editor/focus/card.js#L463-L473)): Wenn `getCaretRect` `null` liefert, bleibt der Scroll aus — kein Rückfall auf `block.getBoundingClientRect()`. Begründung: bei langen Absätzen ohne neue Absatzmarken (User schreibt Riesensatz mit Soft-Wraps und shift-enter-Brüchen) bewegt sich die Block-Mitte nicht mit dem Caret. Block-BBox als Ziel hätte den Typewriter stehenbleiben lassen, obwohl der Cursor visuell mehrere Zeilen tiefer sitzt. Wenn das Caret-Rect wirklich nicht ermittelbar ist (leerer Absatz ohne Text-Kind, kein Fokus), liefert der nächste echte Input bereits valides Rect.

## Lifecycle-Sequenzen (Pflichtreihenfolge)

### Enter
1. Guards: nur aus `idle` heraus, nur wenn `showEditorCard && editMode`.
2. `_flushDraftSaveNow` — offene Debounce-Drafts ins Backend, damit kein getippter Inhalt verloren geht, falls späterer Cancel im Fokus.
3. `_focusGen++` → `focusMode=true`, body-class `focus-mode` + `focus-mode--<granularity>` setzen.
4. `$nextTick(_focusInstall)`: erst nach Alpine-Render → `--editing`-Container existiert.
5. `_focusInstall`: Container holen, `AbortController` aufmachen, IO/MO setzen, alle Listener mit `{ signal }` registrieren, `applyViewport` direkt (ohne Debounce), Cursor zeigen, `--editing`-Container fokussieren, `jumpToTrailingParagraph` (legt Auto-`<p>` an oder recycelt leeren letzten Absatz).
6. `_focusState='active'` → erstes `_focusUpdateActive(true)` → `writeFocusSnapshot(pageId)`.

### Exit
1. `_focusState='exiting'`, `_focusGen++` (RAFs werden no-op).
2. Auto-`<p>`-Slot prüfen: wenn unverändert leer → entfernen. Sonst bleibt er stehen (User hat darin getippt).
3. `await quickSave` wenn `editMode && editDirty && !editSaving`. Offline/Fehler → `editDirty` bleibt true, Draft im LocalStorage, User bleibt im Edit-Modus (Banner zeigt Status, kein erzwungener Exit).
4. Race-Check: wer in der Zwischenzeit `enter` gerufen hat → abbrechen, kein Cleanup.
5. `_focusTeardown`: AbortController killt alle Listener auf einen Schlag, IO/MO disconnect, Timer clear, RAF cancel.
6. `clearFocusSnapshot`, body-classes weg, `--focus-vh*` löschen, Restklassen + `::highlight(focus-sentence-dim)` defensiv aufräumen.
7. Wenn `editMode && !editDirty` (sauberer Save): `_stopAutosave` → `_uninstallOnlineRetry` → `_editCounterCtx.teardown` → `editMode=false` + `editSaving=false` + `saveOffline=false`. **Reihenfolge Pflicht.** Synonym-Menü, Synonym-Picker, Figur-Lookup zu.
8. Idempotent: `_syncPageStatsAfterSave` + `updatePageView` — garantiert dass Stats-Badges + View-HTML den aktuellen `originalHtml` reflektieren.
9. `_focusState='idle'`.

## Auto-`<p>`-Slot

Beim Enter springt der Caret an Buchende. `jumpToTrailingParagraph` ([dom-blocks.js:26-55](../public/js/editor/focus/dom-blocks.js#L26-L55)):
- Letzter Block ist leerer `<p>` → recyceln, `added = null`.
- Sonst neuen `<p><br></p>` anhängen, `added = p`.

**Pflicht-Eigenschaften:**
- NICHT als dirty markieren (kein `_markEditDirty`). Der Slot ist nur Schreibanker; tippt der User, greift `@input`-Handler regulär.
- Exit räumt den Slot ab, falls noch leer — sonst Phantom-Revision (Backend-agnostisch via Content-Store) bei jedem Open-Close-Cycle.
- Nur `<p>` recyceln, keine leeren Headings/Listen — sonst zerstört Recycling User-Struktur.

## Snapshot-Wiederaufnahme

`writeFocusSnapshot(pageId)` schreibt `{ pageId, ts }` in sessionStorage. Überlebt F5 + OIDC-Roundtrip, nicht Tab-Close. TTL 1 h. Sub-`init` ([editor-focus-card.js:48-60](../public/js/cards/editor-focus-card.js#L48-L60)) liest und wartet via `$watch` auf `currentPage.id` + `renderedPageHtml` + `showEditorCard` — wenn alle drei matchen → `startFocusEdit`. Snapshot wird **vor** dem Restore-Versuch konsumiert (`_restoreSnapshot=null` + `clearFocusSnapshot`), sonst Loop bei kaputter Seite.

## Counter (Wörter/Zeichen + Tagesdelta)

`installEditCounter` ([storage.js:96-135](../public/js/editor/focus/storage.js#L96-L135)) wird **im Edit-Mode** gestartet, nicht erst beim Focus-Enter. Damit zählen Edits ausserhalb des Fokusmodus zum „heute"-Delta.

- `compute()` liest `container.textContent`, debounced (`COUNTER_DEBOUNCE_MS=220`).
- Tagesbaseline pro `pageId` in localStorage. Erste Messung des Tages = Baseline; spätere Messungen liefern Delta. Stale Einträge (andere Tage) werden lazy bei jedem Read entfernt.
- `fmtSigned`: `+12` / `−5` (Unicode-Minus für Tabulator-Look) / `±0`.
- Idempotent: zweiter Install-Aufruf liefert dieselbe Teardown-Funktion ohne Listener-Doppelung. Teardown nullt `_editCounterCtx`.

## IME / Mobile-Tastatur / Resize

- **IME-Composition** (CJK-Eingabe): `compositionstart` setzt `ctx.composing=true`, blockiert `onSelection` und `onInput`. `compositionend` triggert ein Recenter — sonst sitzt der aktive Block nach finalem Commit nicht mittig.
- **visualViewport** (Mobile-Tastatur): `applyViewport` setzt `--focus-vh` (Höhe) und `--focus-vh-top` (offsetTop — Android Chrome schiebt fixed-Container nach oben). Debounced via `VV_DEBOUNCE_MS=100`. Re-validiert nur den aktiven Block (`_focusUpdateActive(false)`); recentert NICHT, sonst flattert der Editor bei jedem KB-Frame.
- **Resize/Orientation/DevTools-Sidebar**: `window.resize` deckt den Desktop-Fall ab, wenn visualViewport-Event nicht feuert. Beide Pfade abonniert.

## Pflicht-Invarianten (zusätzlich zu CLAUDE.md)

1. **`focusMode → editMode`** (CLAUDE.md schon). Sub-`enterFocusMode` bricht ab, wenn `!app.editMode`. `cancelEdit` ruft `exitFocusMode` zuerst.
2. **Listener nur via `AbortController`-Signal.** Jeder `addEventListener` im `_focusInstall` bekommt `{ signal }`. Kein manueller `removeEventListener`. Teardown ist ein `abort()`.
3. **IO observe nur addedNodes, unobserve removedNodes.** Vollscan bei jeder Mutation = O(n²) bei grossen Pastes. Removed-Nodes müssen aus `visibleBlocks` raus, sonst IO-Refs auf abgehängten Knoten.
4. **`setActiveBlock` querySelectorAll, nicht querySelector.** Chromium kopiert beim Paragraph-Split die `.focus-paragraph-active`-Klasse auf beide `<p>` — Vollscan räumt die Leiche ab.
5. **`classList.remove` + `removeAttribute('class')` wenn leer.** Sonst bleibt `class=""` stehen → unnötige Revision beim nächsten Save (Diff zur ursprünglich attributlosen Fassung).
6. **`findBlockFromNode` liefert outermost-Ancestor.** Innermost-Match würde bei `<blockquote><p>…</p></blockquote>` nur den inneren `<p>` aktiv markieren — der äussere Wrapper bleibt opacity-gedimmt und multipliziert auf das Kind.
7. **DIV NICHT in `BLOCK_TAGS`.** Chromium Default-Paragraph-Separator soll `<p>` erzeugen; DIV-Aufnahme würde Garantie aushebeln und Margin-/Spacing-Annahmen kippen.
8. **`_focusUpdateActive` RAF in try/catch.** Ein DOM-Edge-Case (Shadow-Root-Range, obskurer Range-Fehler) darf den Editor nicht stillstellen. Fehler → `reportError('updateActive', err)`, nächster Tick versucht neu.
9. **`expectedScroll` ist Counter, nicht Zeitfenster.** Mehrere prog-Scrolls in Folge müssen alle vom `onScroll` verschluckt werden.
10. **Sentence-Highlight nur via `CSS.highlights`.** Keine DOM-Span-Wraps — sonst Save-Diff bei jedem Caret-Move. Browser ohne Custom-Highlight-API → Sentence-Mode degradiert lautlos auf Paragraph-Visual.
11. **`overflow-anchor: none`** auf `.page-content-view*` im Fokus. Chrome's Scroll-Anchoring kämpft sonst mit Typewriter-Scroll → sichtbares „Flattern".
12. **`x-show="!focusMode"`-Guards für Findings-Close-Button, Toolbar, Bubble.** Findings sind im Fokus ohnehin via CSS ausgeblendet; Buttons trotzdem mit `x-show` raus, damit Tab-Reihenfolge sauber bleibt.
13. **Typewriter folgt ausschliesslich dem Caret-Rect.** Kein Block-BBox-Fallback im Recenter. `getCaretRect` ist die einzige Ziel-Rect-Quelle; liefert sie `null`, bleibt der Scroll aus. Block-Mitte als Ersatz täuscht Stabilität vor und blockiert Typewriter in langen Absätzen mit Soft-Wraps / `<br>`-Brüchen — `getCaretRect` deckt diese Edge-Cases via Probe-Range-Expansion ab.

## Tests

| Datei | Deckt ab |
|---|---|
| [tests/unit/editor-focus.test.mjs](../tests/unit/editor-focus.test.mjs) | `findBlockFromNode` outermost, `pickCenterBlock` Distanz-Logik, `computeTypewriterDelta` Schwellen-Verhalten, `setActiveBlock` class=""-Cleanup, `findSentenceRanges` Intl.Segmenter + Regex-Fallback, `dailyDelta` Baseline + Prune, `getCaretRect` Probe-Range-Expansion am Soft-Wrap-Bruch |
| [tests/unit/focus-granularity.test.mjs](../tests/unit/focus-granularity.test.mjs) | Body-Class-Wechsel bei `focusGranularity`-Live-Switch, Cache-Invalidation, `dynamicTypewriterThreshold` aus computed line-height |
| [tests/e2e/focus-editor.spec.js](../tests/e2e/focus-editor.spec.js) | Toggle, Recenter beim Tippen, Pointer-Schonfrist (Klick recentert NICHT), Cleanup (keine Listener-Leaks nach Exit), Auto-`<p>`-Slot räumt sich ab |

**Pflicht:** Bei jeder Änderung im Focus-Editor `npm test` laufen lassen. Schlägt etwas fehl, Ursache klären, nicht Tests anpassen.

## Erweitern (Checkliste)

Neuer Granularitätsmodus, neue Hotkey, neuer Listener-Pfad:
1. Konstante in [constants.js](../public/js/editor/focus/constants.js) oder neues Sub-File anlegen — Submodule sind nach Verantwortung geschnitten (dom/sentence/typewriter/storage), nicht nach Reihenfolge.
2. Wenn neuer Body-Class-Marker: in `_focusInstall` add, in `exitFocusMode` remove, in `$watch(focusGranularity)`-Switch berücksichtigen.
3. Wenn neuer Listener: ausschliesslich am `ctx.container` oder `window` registrieren mit `{ signal }` aus `_focusInstall`. KEIN globaler `window.addEventListener` ohne AbortController.
4. State-Machine berühren? Generation-Check im async-Body Pflicht (`if (gen !== this._focusGen) return`).
5. CSS für neue Markierungs-Klasse in [focus-mode.css](../public/css/editor/focus/focus-mode.css) — selber `@layer components`, `body.focus-mode :is(.page-content-view, .page-content-view--editing) …`.
6. Tests in [tests/unit/editor-focus.test.mjs](../tests/unit/editor-focus.test.mjs) ergänzen (pure Helpers) und ggf. E2E-Case in [tests/e2e/focus-editor.spec.js](../tests/e2e/focus-editor.spec.js).
7. CLAUDE.md „Editor-Modi"-Tabelle prüfen — bei strukturellen Änderungen am Modus-Set Invarianten-Liste updaten.
