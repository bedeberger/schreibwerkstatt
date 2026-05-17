# State-Modell (Frontend)

Verbindlicher Aufbau des Alpine-State. Vor jeder UI-Änderung die richtige Ebene wählen — Root vs. Sub-Komponente vs. Store entscheidet über Reaktivität, Lifecycle und Speicherlecks.

## Drei Ebenen

1. **Root `Alpine.data('lektorat')`** ([public/js/app.js:430](../public/js/app.js#L430)) — `x-data="lektorat"` am `<body>`. SSoT für: Navigation, Session/Shell, i18n-Locale, **alle `showXxxCard`-Flags** (Hash-Router + Exklusivität), Job-Queue, Editor-Edit-Mode, Auto-Save, Selection. Cross-Cutting-Methoden: `t/tRaw`, `bsGet/bsGetAll`, `loadFiguren/loadOrte/loadSzenen`, `selectPage`, `gotoStelle`, `_closeOtherMainCards`.
2. **Sub-Komponenten `Alpine.data('xxxCard')`** in [public/js/cards/](../public/js/cards/) — eine pro UI-Card. Eigener fachlicher State + `init()`/`destroy()`. Karten haben **keine** eigenen `showXxxCard`-Flags (Root ist SSoT); sie hören via `$watch(() => window.__app.showXxxCard)` auf Öffnen/Schliessen.
3. **`Alpine.store('catalog')`** ([public/js/cards/catalog-store.js](../public/js/cards/catalog-store.js)) — geteilte Fach-Daten `figuren / orte / szenen / globalZeitstrahl`. Root spiegelt sie via Getter/Setter-Proxy ([public/js/app.js:439-446](../public/js/app.js#L439-L446)), damit `this.figuren = …` und `this.figuren.push(…)` weiter funktionieren. Karten lesen via `$store.catalog` oder `$app.figuren`.

## Root-State-Slices ([public/js/app/app-state.js](../public/js/app/app-state.js))

`initialLektoratState()` spreadet **14 Slice-Funktionen** in ein flaches Root-Objekt. Neues Feld → in den passenden Slice:

| Slice | Inhalt |
|-------|--------|
| `shellState` | currentUser, devMode, sessionExpired, themePref, focusGranularity, uiLocale, isMac, currentBackend (`'localdb'`/`'bookstack'`), bookstackUrl (nur im `bookstack`-Mode gesetzt), promptConfig, Token-Setup-Modal, `_abortCtrl` |
| `aiProviderState` | claudeModel, claudeMaxTokens, apiProvider, ollamaModel, llamaModel |
| `navigationState` | books, selectedBookId, pages, tree, Hash-Router-Internals (`_applyingHash`, `_hashInitialized`, …), Order-Maps, pageSearch, bookstack-Search (nur `bookstack`-Mode) |
| `editorState` | currentPage, renderedPageHtml, editMode, editDirty, editSaving, Auto-Save-Timer (`_autosaveIdleTimer`, `_autosaveMaxTimer`, `_draftTimer`), originalHtml/correctedHtml, hasErrors, newPage-Felder |
| `focusModeState` | focusMode, focusCountWords, focusCountChars, focusCountWordsDelta, focusCountCharsDelta (Live-Counter im Fokus-Header) |
| `editorPopupState` | Spiegel-Flags `_figurLookupOpen`, `_synonymMenuOpen`, `_synonymPickerOpen` (für Escape-Routing in `editor-focus-onKey`) + `_figurLookupIndex` (Lookup-Cache) |
| `cardsState` | **Alle `showXxxCard`-Flags** (showBookCard, showFiguresCard, showEditorCard, showChatCard, showAvatarMenu, …) — exklusiv via `_closeOtherMainCards(keep)` |
| `statusState` | status, statusSpinner, `_statusTimer` |
| `confirmDialogState` | Eigener Modal-Ersatz für `window.confirm` (verhindert macOS-Vollbild-Bug) |
| `lektoratState` | analysisOut, lektoratFindings, selectedFindings, appliedOriginals, checkLoading/Progress/Status, Token-Estimates (`tokEsts`, `_tokenEstGen`), pageHistory, ideenCounts, pageLastChecked, `_checkPollTimer` |
| `bookReviewState` | bookReviewHistory (von tree.js geschrieben, von user-settings beim Reset gelesen → Root) |
| `kapitelReviewState` | kapitelReviewChapterId (Hash-Router-SSoT) |
| `figurenState` | figurenLoading/Progress/Status, selectedFigurId, figurenFilters, `_figuresPollTimer` (Reconnect-relevant → Root) |
| `ereignisseState` / `szenenState` / `orteState` | Filter + selectedXxxId (von app-navigation geschrieben) + UpdatedAt |
| `chatsState` | `_checkDoneBeforeChat` |
| `featuresUsageState` | recentFeatureKeys (Top-3 Quick-Pills), recentPageIds (Palette) |
| `jobsState` | jobQueueItems, jobQueueExpanded, alleAktualisierenLoading/Status/Progress/Tps, `_jobQueueTimer` |

**Regel:** Slices sind Funktionen (nicht Konstanten), damit jede Komponenten-Instanz frische Arrays/Objekte erhält. Sonst geteilte Referenzen.

## Computed-Maps am Root (Performance)

`figurenById / orteById / szenenById` ([public/js/app.js:453-473](../public/js/app.js#L453-L473)) sind getter-basierte O(1)-Lookups, die nur bei Referenzwechsel der Quell-Arrays neu gebaut werden. **`loadFiguren` etc. müssen die Arrays reassignen, nie pushen** — sonst rebuildet der Cache nicht. Render-Loops in figuren.html/orte.html/szenen.html nutzen diese Maps statt `.find()`.

Weitere Root-Computeds: `szenenNachKapitel`, `szenenNachSeite`, `orteFiltered`, `szenenFiltered`, `filteredTree`, `selectedBookName`, `selectedBookUrl`, `statusHtml`, `ideenMovePickerOptions()`.

## Lifecycle

- **Root `init()`** ([public/js/app.js:611](../public/js/app.js#L611)): setzt `window.__app = this` (für `$app`-Magic), erzeugt `_abortCtrl = new AbortController()`, registriert globale Listener mit `{ signal }`.
- **Root `destroy()`** ([public/js/app.js:603](../public/js/app.js#L603)): `_abortCtrl.abort()` → alle Listener weg in einem Schlag. Plus `clearInterval(_jobQueueTimer)`, `clearTimeout(_statusTimer)`. **Pflicht für jede neue globale Subscription:** `{ signal: this._abortCtrl.signal }` an `addEventListener` — sonst Leak bei HMR/Re-Init.
- **Sub-`init()`/`destroy()`**: Karten managen ihre Window-Listener selbst — der Soll-Pattern dafür ist [`setupCardLifecycle`](../public/js/cards/card-lifecycle.js) (siehe nächste Section). vis-network/Chart-Instanzen explizit `.destroy()` callen + Refs nullen (sonst halten DataSets das alte Buch im Speicher).

## Soll-Pattern für Buch-scoped Karten: `setupCardLifecycle`

Karten, die auf `book:changed` / `view:reset` / `card:refresh` reagieren und beim Öffnen Daten laden, nutzen [`setupCardLifecycle`](../public/js/cards/card-lifecycle.js). Der Helper kapselt die drei Window-Listener + Timer-Cleanup hinter einem `init()`-Aufruf und einem `destroy()`-Aufruf.

**Default-Soll:**

```js
import { setupCardLifecycle } from './card-lifecycle.js';

window.Alpine.data('orteCard', () => ({
  orteLoading: false,
  orteProgress: 0,
  orteStatus: '',
  _ortePollTimer: null,
  _lifecycle: null,

  init() {
    this._lifecycle = setupCardLifecycle(this, {
      name: 'orte',                                // matcht event.detail.name auf card:refresh
      showFlag: 'showOrteCard',                    // Root-Flag, das per $watch beobachtet wird
      timerKeys: ['_ortePollTimer'],               // Poll-Timer auf ctx, automatisch geclearet
      resetState: { orteLoading: false, orteProgress: 0, orteStatus: '' },
      load: (root) => root.loadOrte(root.selectedBookId),
    });
  },
  destroy() { this._lifecycle?.destroy(); },
}));
```

Der Helper macht:
- `$watch(showFlag)` → bei `true` + `selectedBookId` → `cfg.onShow ?? cfg.load`.
- `book:changed` → Timer clear + `resetState` + (sichtbar + Buch vorhanden) → `cfg.load`.
- `view:reset` → Timer clear + `resetState` (KEIN Reload).
- `card:refresh` → wenn `event.detail.name === cfg.name` und Buch vorhanden → `cfg.load`.
- `destroy()` → `clearTimers` + `AbortController.abort()` (alle internen Listener weg).

**Optional cfg-Felder:**
| Feld | Zweck |
|------|-------|
| `onShow(root)` | Override für `$watch(showFlag)`-Body (z.B. zusätzliche Side-Effects wie Textarea-Fokus, oder Mehrfach-Load). |
| `onBookChanged(e, ctx, root)` | Vollständiger Override; skipt das Default-`reset+load`. Nutzen für Karten mit Coalesce-Logik (Microtask, debounce). |
| `onViewReset(e, ctx, root)` | Vollständiger Override fürs `view:reset`-Verhalten. Nutzen, wenn `view:reset` mehr räumt als `book:changed` (z.B. user-scoped Profile-Liste in PDF-Export). |
| `resetStateView` | Eigenes Reset-Objekt nur fürs `view:reset` (wenn book vs. view unterschiedlich resetten). |
| `refreshNeedsBookId: false` | Default: `card:refresh` ignoriert wenn kein Buch aktiv. False für Karten mit eigener Buch-Prüfung. |
| `showNeedsBookId: false` | Analog für `$watch(showFlag)`. |
| `extraListeners: [{ type, handler }]` | Zusätzliche Window-Events (z.B. `chat:reset`, `book-chat:reset`, `ideen:reset`, `kapitel-review:select`, `book-stats:select`, `job:reconnect`). Werden über denselben AbortController automatisch wieder abgemeldet. |

**Rückgabewert:** `{ signal, destroy }`. `signal` ist der `AbortController.signal` der internen Listener — Karten können eigene `addEventListener(..., { signal })` damit registrieren und sparen sich das `removeEventListener`.

**Wann nicht nutzen:** Karten ohne `book:changed`/`view:reset`/`card:refresh`-Trio (Editor-Slices wie [editor-find-card](../public/js/cards/editor-find-card.js), [editor-figur-lookup-card](../public/js/cards/editor-figur-lookup-card.js)) verwenden direkt `AbortController` ohne Helper. Karten mit komplett-anderer Reset-Semantik (Coalesce + microtask wie [book-overview-card](../public/js/cards/book-overview-card.js); zweistufiger Form-Unmount wie [pdf-export-card](../public/js/cards/pdf-export-card.js)) bleiben manuell — der Helper ist Convenience, nicht Pflicht.

## `$app` / `window.__app` (Root-Zugriff aus Subs)

Alpine's `$root` zeigt auf das nächste `x-data` (= Sub selbst), nicht auf die `lektorat`-Root.
- **In Templates** (Alpine-Expressions): `$app.t('key')`, `$app.selectedBookId`, `$app.figuren` — via `Alpine.magic('app', …)` ([public/js/app.js:202](../public/js/app.js#L202)).
- **In JS-Methoden/Gettern** (Subs): `window.__app.xxx`. Magics sind in JS-Getter-Ausführungen nicht zuverlässig; `window.__app` ist robust und ein reaktiver Alpine-Proxy.

## Event-Bus (Root → Subs)

Custom-Events am `window`. Vollständige Liste:

| Event | Dispatcher | Hörer | Zweck |
|-------|-----------|-------|-------|
| `book:changed` | `_resetBookScopedState()` | alle Subs mit Buchscope | State resetten + bei offener Karte neu laden |
| `view:reset` | `resetView()` | alle Subs | Lokalen State komplett nullen |
| `card:refresh` `{ name }` | erneuter Klick auf offene Karte | passende Sub | Daten neu laden |
| `job:reconnect` `{ type, jobId, job, extra? }` | `checkPendingJobs()` | review/kapitel-review/figuren/komplett | Loading-State übernehmen + Polling starten |
| `job:finished` `{ type, jobId, job, dedupId, bookId }` | `_detectFinishedJobs()` (Diff aus `/jobs/queue`) | Root + Subs | Sidebar/History idempotent updaten, auch wenn kein per-Card-Poller mehr läuft (Reload-Lücke). Konsumenten müssen idempotent sein — fired auch parallel zu per-Card-onDone. |
| `chat:reset` / `book-chat:reset` | Seitenwechsel / User-Settings-Reset | chat-card, book-chat-card | Session leeren |
| `kapitel-review:select` `{ chapterId }` | Sidebar / Hash-Router | kapitel-review-card | Chapter-ID setzen |
| `book-stats:select` | Hash-Router | book-stats-card | Statistik-Tab wählen |
| `palette:open` | global | palette-card | Command-Palette öffnen |
| `app:update-available` | Service-Worker-Listener | Root-Banner | Update-Hinweis |
| `session-expired` / `bookstack-token-invalid` | `fetch`-Wrapper | Root | Banner zeigen (`bookstack-token-invalid` nur im `bookstack`-Mode) |

## Karten-Inventar (Alpine.data-Names)

Buchebene: `bookOverviewCard`, `bookReviewCard`, `kapitelReviewCard`, `figurenCard`, `figurWerkstattCard`, `orteCard`, `szenenCard`, `ereignisseCard`, `kontinuitaetCard`, `bookStatsCard`, `stilCard`, `fehlerHeatmapCard`, `chatCard`, `bookChatCard`, `ideenCard`, `finetuneExportCard`, `bookSettingsCard`, `userSettingsCard`, `paletteCard`, `exportCard`, `pdfExportCard`, `bookOrganizerCard`, `bookEditorCard`.
Editor-Slices: `editorFindCard`, `editorSynonymeCard`, `editorFigurLookupCard`, `editorToolbarCard`, `editorFocusCard`, `lektoratFindingsCard`, `pageHistoryCard`.

Alle in [public/js/app.js:205-234](../public/js/app.js#L205-L234) via `registerXxxCard()` registriert.

## Was bleibt im Root (nicht in Subs auslagern)

- Alle Show-Flags (Exklusivität!), Hash-Router, Auto-Save, Selection-Management, Editor-Edit-Mode, Job-Queue, Cross-Cutting-Loader (`loadFiguren` etc.), `_abortCtrl`-basiertes globales Listener-Setup.
- Editor-Module: `page-view`, `editor/edit`, `editor/utils`, `tree`, `history`, `api-ai`, `api-bookstack` (im `bookstack`-Mode aktiv), `bookstack-search` (im `bookstack`-Mode aktiv), `offline-sync`, `i18n`, `shortcuts` — gespreaded in den Root, nicht in eigene Subs.

## Editor-Modi (4 Stück, **Konsistenz kritisch**)

Vier orthogonale Modi am Editor — kein Single-Enum, sondern Boolean-Flags am Root. Reihenfolge der Mutations und Invarianten sind **harte Regeln**: jede Änderung am Modus-Setup muss diese Tabelle aktuell halten.

| Modus | Flag | Slice / Datei | Enter | Exit |
|-------|------|---------------|-------|------|
| **Viewmodus** (Lesen) | _kein_ (= alle anderen `false`) | — | Default | — |
| **Prüfmodus** | `checkDone: true` | `lektoratState` ([app-state.js:199](../public/js/app/app-state.js#L199)) | `runCheck()` ([editor/lektorat.js:42](../public/js/editor/lektorat.js#L42)) → Polling → Setzen bei Done ([editor/lektorat.js:175](../public/js/editor/lektorat.js#L175)) oder `loadHistoryEntry` ([history.js:142](../public/js/book/history.js#L142)) | `closeFindings()` ([editor/lektorat.js:28](../public/js/editor/lektorat.js#L28)) |
| **Editmodus** | `editMode: true` | `editorState` ([app-state.js:87](../public/js/app/app-state.js#L87)) | `startEdit()` ([editor/edit.js:147](../public/js/editor/edit.js#L147)) | `cancelEdit()` ([editor/edit.js:211](../public/js/editor/edit.js#L211)) / `saveEdit()` ([editor/edit.js:237](../public/js/editor/edit.js#L237)) |
| **Fokusmodus** | `focusMode: true` | `focusModeState` ([app-state.js](../public/js/app/app-state.js)) | `enterFocusMode()` / `startFocusEdit()` / Cmd+Shift+E | `exitFocusMode()` / Esc / Cmd+Shift+E |

**Begleit-State pro Modus:**
- Prüfmodus: `lektoratFindings`, `selectedFindings`, `correctedHtml`, `hasErrors`, `analysisOut`, `appliedOriginals`, `appliedHistoricCorrections`, `lastCheckId`, `activeHistoryEntryId`, `checkProgress`, `checkStatus`, `_checkPollTimer`.
- Editmodus: `editDirty`, `editSaving`, `saveOffline`, `lastAutosaveAt`, `lastDraftSavedAt`, `_autosaveIdleTimer`, `_autosaveMaxTimer`, `_draftTimer`, `_onlineHandler`, `originalHtml`.
- Fokusmodus: `focusCountWords/Chars/*Delta` (`focusModeState`) + `focusGranularity` (`shellState`) + Sub-Maschine `_focusState` (`idle`/`entering`/`active`/`exiting`) + `_focusGen` (Re-Entry-Guard) in [editorFocusCard](../public/js/cards/editor-focus-card.js).

**Erlaubte Kombinationen** (8 Bool-Tripel, 6 erlaubt):

| Edit | Focus | Check | Erlaubt? | Bemerkung |
|------|-------|-------|----------|-----------|
| 0 | 0 | 0 | ✓ | Viewmodus |
| 0 | 0 | 1 | ✓ | View + Findings (Split-View) |
| 1 | 0 | 0 | ✓ | Edit |
| 1 | 0 | 1 | ✓ | Edit + Findings (Marks im Editor) |
| 1 | 1 | 0 | ✓ | Edit + Fokus |
| 1 | 1 | 1 | ✓ | Findings vorhanden, Fokus blendet UI aus |
| 0 | 1 | * | ✗ | **Invariante: `focusMode → editMode`** |

**Invarianten (Pflicht — bei Änderungen prüfen):**

1. `focusMode === true` ⇒ `editMode === true`. Enforced in [editor/focus/card.js:45](../public/js/editor/focus/card.js#L45) (`enterFocusMode` bricht bei `!editMode` ab) und [editor/edit.js:234](../public/js/editor/edit.js#L234) (`cancelEdit` ruft `exitFocusMode` zuerst).
2. `runCheck` darf nicht im Editmodus starten. Template-Guard: Prüfen-Button steht in `<template x-if="!editMode">` ([editor.html:44](../public/partials/editor.html#L44)).
3. `closeFindings`-Button im Editmodus nur sichtbar wenn `!focusMode` ([editor.html:82](../public/partials/editor.html#L82)) — im Fokus sind Findings ohnehin ausgeblendet.
4. **Chat-Modus** (showChatCard) snapshotet `checkDone` in `_checkDoneBeforeChat` und setzt `checkDone=false` ([chat-base.js:129](../public/js/chat/chat-base.js#L129)); beim Schliessen Restore ([app-view.js:310-320](../public/js/app/app-view.js#L310-L320)). Ohne diesen Snapshot würde der Chat Findings doppelt rendern.
5. **Reset-Reihenfolge in `resetPage()`** ([app-view.js:378](../public/js/app/app-view.js#L378)): `exitFocusMode` → `_stopAutosave` → Chat-Reset → Card-Flags → Editor-State (`editMode/editDirty/editSaving`) → Lektorat-State (`checkDone/findings/...`). Diese Reihenfolge ist Pflicht — Fokus zuerst, weil `exitFocusMode` `editMode/editDirty` liest.
6. `saveEdit` im Fokus bleibt im Fokus+Edit ([editor/edit.js:318](../public/js/editor/edit.js#L318)) — User möchte weiter schreiben. Erst sauberer Exit räumt Edit-Mode auf, dann flusht `exitFocusMode` per `quickSave` ([editor/focus/card.js:349-351](../public/js/editor/focus/card.js#L349-L351)).
7. Hotkey Cmd+Shift+E ([editor/focus/trampoline.js:28](../public/js/editor/focus/trampoline.js#L28) → [editor/focus/card.js:245](../public/js/editor/focus/card.js#L245)) wirkt nur bei `showEditorCard` und routet zustandsabhängig: in Fokus → exit, in Edit → enter, sonst → startFocusEdit (Edit + Fokus in einem Schritt).

**Bei Modus-Erweiterung (z.B. „Diff-Modus", „Annotations-Modus")** dieser Section folgen:
1. Flag in passenden Slice von `app-state.js`.
2. Begleit-State + Timer-Refs daneben (gleicher Slice).
3. Invarianten-Tabelle hier ergänzen (Kombinations-Matrix).
4. `resetPage()` und `_resetBookScopedState()` um neuen Reset erweitern (gleiche Reihenfolge: neuer Modus zuerst aussen, sonst nach Lifecycle-Abhängigkeit).
5. Template-Guards setzen (analog `x-show="!editMode"` für Prüfen-Button).
6. Hotkey-Routing in handleFocusHotkey-Stil prüfen.
