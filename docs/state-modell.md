# State-Modell (Frontend)

Verbindlicher Aufbau des Alpine-State. Vor jeder UI-Änderung die richtige Ebene wählen — Root vs. Sub-Komponente vs. Store entscheidet über Reaktivität, Lifecycle und Speicherlecks.

## Drei Ebenen

1. **Root `Alpine.data('lektorat')`** ([public/js/app.js:254](../public/js/app.js#L254)) — `x-data="lektorat"` am `<body>`. SSoT für: Navigation, Session/Shell, i18n-Locale, **alle `showXxxCard`-Flags** (Hash-Router + Exklusivität), Job-Queue, Editor-Edit-Mode, Auto-Save, Selection. Cross-Cutting-Methoden: `t/tRaw`, `bsGet/bsGetAll`, `loadFiguren/loadOrte/loadSzenen`, `selectPage`, `gotoStelle`, `_closeOtherMainCards`.
2. **Sub-Komponenten `Alpine.data('xxxCard')`** in [public/js/cards/](../public/js/cards/) — eine pro UI-Card. Eigener fachlicher State + `init()`/`destroy()`. Karten haben **keine** eigenen `showXxxCard`-Flags (Root ist SSoT); sie hören via `$watch(() => window.__app.showXxxCard)` auf Öffnen/Schliessen.
3. **`Alpine.store(...)`** — geteilte, benannte State-Inseln, die der Root jeweils via Getter/Setter-Proxy (in [public/js/app.js](../public/js/app.js)) unter den gewohnten Namen spiegelt, damit `this.x = …` aus Root-Methoden und bare/`$app`-Template-Bindings unverändert funktionieren. Karten greifen direkt via `$store.<name>` zu (sichtbare Abhängigkeit statt ambient `window.__app`):
   - **`catalog`** ([catalog-store.js](../public/js/cards/catalog-store.js)) — Fach-Daten `figuren / orte / songs / szenen / globalZeitstrahl / zeitstrahlChronology`. Proxy behält die Key-Namen.
   - **`nav`** ([nav-store.js](../public/js/cards/nav-store.js)) — Navigations-State `books / selectedBookId / pages / tree` (von ~29 Modulen gelesen). Proxy behält die Key-Namen.
   - **`tts`** ([tts-store.js](../public/js/cards/tts-store.js)) — TTS/Proof-Listening `enabled / pause / playing / paused / loading / index / total`. Store-Name liefert den Namespace → Keys ohne `tts`-Präfix; Root-Proxy mappt auf `ttsEnabled / ttsPlaying / …`.
   - **`stt`** ([stt-store.js](../public/js/cards/stt-store.js)) — STT-Diktat `enabled / vad / recording / pending / transcribing / busy / caretUserSet`. Keys ohne `stt`-Präfix; Root-Proxy mappt auf `sttEnabled / sttRecording / …`. `$watch('sttRecording')` (stt-time.js) funktioniert über den Proxy-Getter (wie `selectedBookId`).

## Root-State-Slices ([public/js/app/app-state.js](../public/js/app/app-state.js))

`initialLektoratState()` spreadet **26 Slice-Funktionen** in ein flaches Root-Objekt. Neues Feld → in den passenden Slice:

| Slice | Inhalt |
|-------|--------|
| `shellState` | currentUser, devMode, appReady, sessionExpired, serverOffline, isOffline, updateAvailable, themePref, focusGranularity, uiLocale, defaultRegion, appTimezone, isMac, promptConfig, `_abortCtrl`, `_usersByEmail`/Loading |
| `aiProviderState` | claudeModel, claudeMaxTokens, apiProvider, ollamaModel, openaiCompatModel |
| `navigationState` | books, bookFilter\*, selectedBookId, bookRoles/currentBookRole/bookSharedFlags (ACL), pages, tree, Hash-Router-Internals (`_applyingHash`, `_hashInitialized`, `_inHashApply`, `_hashUpdatePending`, `_navDepth`), Order-Maps (`_chapterOrderMap`, `_pageOrderMap`, `_pageIdOrderMap`), pageSearch, newChapter-Felder |
| `pageState` | Mode-agnostischer Seiten-Inhalt: currentPage, currentPageEmpty/IdeenOpenCount/ChatSessionCount, renderedPageHtml, originalHtml, chapterFigures/showChapterFigures, newPage-Felder. Notebook, Focus und View lesen alle hier |
| `notebookState` | Notebook-Editor-Lifecycle: editMode, editDirty, editSaving, saveOffline, editConflict, pendingDraft, lastAutosaveAt/lastDraftSavedAt, Auto-Save-Timer (`_autosaveIdleTimer`, `_autosaveMaxTimer`, `_draftTimer`, `_onlineHandler`), pageEditorFullscreen/Zoom/FitWidth |
| `focusState` | Focus-Editor-Lifecycle: focusActive, focusDirty, focusSaving, focusCountWords/Chars + Deltas (Live-Counter im Fokus-Header) |
| `editorPopupState` | Spiegel-Flags `_figurLookupOpen`, `_synonymMenuOpen`, `_synonymPickerOpen` (für Escape-Routing in `editor-focus-onKey`) + `_figurLookupIndex` (Lookup-Cache) |
| `cardsState` | **Alle `showXxxCard`-Flags** inkl. Admin-Karten (showAdminUsers/Settings/Usage/Categories/BooksCard), showSongsCard, showKontinuitaetCard, showSearchCard, showKomplettStatus, showAvatarMenu, adminUsageTab — exklusiv via `_closeOtherMainCards(keep)` |
| `statusState` | status, statusSpinner, `_statusTimer` |
| `confirmDialogState` | Native-`<dialog>`-Modal-Ersatz für `window.confirm`/prompt (verhindert macOS-Vollbild-Bug) inkl. Input-Mode + Resolver |
| `lektoratState` | analysisOut, correctedHtml, hasErrors, lektoratFindings, selectedFindings, appliedOriginals, appliedHistoricCorrections, checkDone/Loading/Progress/Status, saveApplying, batchLoading/Progress/Status, lastCheckId, pageHistory, activeHistoryEntryId, Token-Estimates (`tokEsts`, `_tokenEstGen`), pageLastChecked, ideenCounts/chapterIdeenCounts, ideenScope/ideenChapterId/currentChapterIdeenOpenCount, showTokLegend/tokTooltipData/showPageStatusTip, `_statsObserver*` |
| `bookReviewState` | bookReviewHistory (von tree.js geschrieben, von user-settings beim Reset gelesen → Root) |
| `kapitelReviewState` | kapitelReviewChapterId (Hash-Router-SSoT) |
| `figurWerkstattState` | werkstattDraftId (Hash-Router-SSoT), werkstattDrafts (Spiegel für Command-Palette-Indexer) |
| `figurenState` | figurenLoading/Progress/Status, selectedFigurId, figurenFilters, `_figuresPollTimer` (Reconnect-relevant → Root) |
| `ereignisseState` / `szenenState` / `orteState` / `songsState` | Filter + selectedXxxId (von app-navigation geschrieben) + UpdatedAt |
| `kontinuitaetState` | kontinuitaetFilters (figurId/kapitel/schwere) — Persist/Restore über FILTER_SCOPES |
| `chatsState` | `_checkDoneBeforeChat` |
| `featuresUsageState` | recentFeatureKeys (Top-3 Quick-Pills), recentPageIds (Palette) |
| `bookCreateState` | bookCreateName/Busy/Error (Buch-Erstellung-Modal aus Combobox-Footer) |
| `collabState` | `_collabSince`, `_collabPollTimer`, recentRemoteEdits (Set), collabToast/`_collabToastTimer`, livePresenceByPage, Heartbeat-Timer (`_presencePingTimer`/`_presencePingPageId`), Geraete-Ping (`_bookDevicePingTimer`/`_bookDevicePingBookId`/`_selfPageDeviceCount` — page-scoped Multi-Device-Erkennung), Lock-State (`_currentEditLock`, `_lockHeartbeatTimer`, foreignEditLock) |
| `dailyProgressState` | dailyProgressBookId/Stats/IsFinished, `_dailyProgressLoadingBookId` (Header-Donut neben Avatar) |
| `jobsState` | jobQueueItems, jobQueueExpanded, alleAktualisierenLoading/Status/Progress/Tps/Tok\*/PassMode/LastRun, `_jobQueueTimer`, **jobToast** + `_jobToastTimer` (globaler Job-Done-Toast, Severity ok/err) |

**Regel:** Slices sind Funktionen (nicht Konstanten), damit jede Komponenten-Instanz frische Arrays/Objekte erhält. Sonst geteilte Referenzen.

## Computed-Maps am Root (Performance)

`figurenById / orteById / szenenById` ([public/js/app.js:291-305](../public/js/app.js#L291-L305)) sind getter-basierte O(1)-Lookups, die nur bei Referenzwechsel der Quell-Arrays neu gebaut werden. **`loadFiguren` etc. müssen die Arrays reassignen, nie pushen** — sonst rebuildet der Cache nicht. Render-Loops in figuren.html/orte.html/szenen.html nutzen diese Maps statt `.find()`.

Weitere Root-Computeds: `szenenNachKapitel`, `szenenNachSeite`, `orteFiltered`, `szenenFiltered`, `filteredTree`, `selectedBookName`, `selectedBookUrl`, `statusHtml`, `ideenMovePickerOptions()`.

## Lifecycle

- **Root `init()`** ([public/js/app.js:456](../public/js/app.js#L456)): setzt `window.__app = this` (für `$app`-Magic), erzeugt `_abortCtrl = new AbortController()`, registriert globale Listener mit `{ signal }`.
- **Root `destroy()`** ([public/js/app.js:448](../public/js/app.js#L448)): `_abortCtrl.abort()` → alle Listener weg in einem Schlag. Plus `clearInterval(_jobQueueTimer)`, `clearTimeout(_statusTimer)`, `_teardownStatsObserver()`. **Pflicht für jede neue globale Subscription:** `{ signal: this._abortCtrl.signal }` an `addEventListener` — sonst Leak bei HMR/Re-Init.
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
- **In Templates** (Alpine-Expressions): `$app.t('key')`, `$app.selectedBookId`, `$app.figuren` — via `Alpine.magic('app', …)` ([public/js/app.js:210](../public/js/app.js#L210)).
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
| `session-expired` | `fetch`-Wrapper | Root | Banner zeigen |

## Karten-Inventar (Alpine.data-Names)

Buchebene: `bookOverviewCard`, `bookReviewCard`, `kapitelReviewCard`, `figurenCard`, `figurWerkstattCard`, `orteCard`, `songsCard`, `szenenCard`, `ereignisseCard`, `kontinuitaetCard`, `bookStatsCard`, `stilCard`, `fehlerHeatmapCard`, `chatCard`, `bookChatCard`, `ideenCard`, `finetuneExportCard`, `bookSettingsCard`, `userSettingsCard`, `paletteCard`, `exportCard`, `pdfExportCard`, `bookOrganizerCard`, `bookEditorCard`, `searchCard`.
Admin-Karten: `adminUsersCard`, `adminSettingsCard`, `adminUsageCard`, `adminCategoriesCard`, `adminBooksCard`.
Editor-Slices: `editorFindCard`, `editorSynonymeCard`, `editorFigurLookupCard`, `editorToolbarCard`, `editorFocusCard`, `lektoratFindingsCard`, `pageHistoryCard`, `pageRevisionsCard`.

Alle in [public/js/app.js:212-252](../public/js/app.js#L212-L252) via `registerXxxCard()` registriert.

## Was bleibt im Root (nicht in Subs auslagern)

- Alle Show-Flags (Exklusivität!), Hash-Router, Auto-Save, Selection-Management, Editor-Edit-Mode, Job-Queue, Cross-Cutting-Loader (`loadFiguren` etc.), `_abortCtrl`-basiertes globales Listener-Setup.
- Editor-Module: `page-view`, `editor/edit`, `editor/utils`, `tree`, `history`, `api-ai`, `i18n`, `shortcuts` — gespreaded in den Root, nicht in eigene Subs.

## Drei Editoren

Die App hat **drei unabhängige Editoren**. Bei Änderungen muss der User benennen, welcher gemeint ist — siehe Harte Regel „Editor-Spezifikation" in [CLAUDE.md](../CLAUDE.md).

| Editor | Scope | Aktivierung | State | Doku |
|---|---|---|---|---|
| **Notebook-Editor** | eine Seite (Edit-Modus auf der `editor`-Karte) | `startEdit()` Button | `notebookState` + `editMode`-Flag | [notebook-editor.md](notebook-editor.md) |
| **Focus-Editor** | eine Seite (Vollbild-Schreibmodus, läuft auf Notebook) | `enterFocusMode()` / Cmd+Shift+E | `focusState` + `focusActive`-Flag | [focus-editor.md](focus-editor.md) |
| **Bucheditor** | ganzes Buch (eigene Karte `bookEditor`) | `toggleBookEditorCard()` aus Palette/Quick-Pills | Card-lokal in [`bookEditorCard`](../public/js/cards/book-editor-card.js); Root-Flag `showBookEditorCard` (`cardsState`) | [book-editor.md](book-editor.md) |

Bucheditor ist **kein Modus** auf einer Einzelseite — er ist eine eigenständige Karte mit eigener Save-Pipeline (`saveQueue`, pro Block) und keiner Verbindung zu `editMode`/`focusActive`. Exklusivität zum Notebook/Focus läuft über `_closeOtherMainCards` (`EXCLUSIVE_CARDS`-Eintrag in [feature-registry.js](../public/js/cards/feature-registry.js)), nicht über die Modus-Flags.

## Editor-Modi des Notebook-Editors (4 Stück, **Konsistenz kritisch**)

Vier orthogonale Modi am **Notebook-Editor** (nicht am Bucheditor) — kein Single-Enum, sondern Boolean-Flags am Root. Reihenfolge der Mutations und Invarianten sind **harte Regeln**: jede Änderung am Modus-Setup muss diese Tabelle aktuell halten.

| Modus | Flag | Slice / Datei | Enter | Exit |
|-------|------|---------------|-------|------|
| **Viewmodus** (Lesen) | _kein_ (= alle anderen `false`) | — | Default | — |
| **Prüfmodus** | `checkDone: true` | `lektoratState` ([app-state.js:219](../public/js/app/app-state.js#L219)) | `runCheck()` ([editor/lektorat.js:201](../public/js/editor/lektorat.js#L201)) → Polling → Setzen bei Done ([editor/lektorat.js:334](../public/js/editor/lektorat.js#L334)) oder `loadHistoryEntry` ([history.js:66](../public/js/book/history.js#L66)) | `closeFindings()` ([editor/lektorat.js:187](../public/js/editor/lektorat.js#L187)) |
| **Editmodus** | `editMode: true` | `notebookState` ([app-state.js](../public/js/app/app-state.js)) | `startEdit()` ([editor/notebook/edit.js](../public/js/editor/notebook/edit.js)) | `cancelEdit()` / `saveEdit()` ([editor/notebook/edit.js](../public/js/editor/notebook/edit.js)) |
| **Fokusmodus** | `focusActive: true` | `focusState` ([app-state.js:129](../public/js/app/app-state.js#L129)) | `enterFocusMode()` / `startFocusEdit()` / Cmd+Shift+E | `exitFocusMode()` / Esc / Cmd+Shift+E |

**Begleit-State pro Modus:**
- Prüfmodus: `lektoratFindings`, `selectedFindings`, `correctedHtml`, `hasErrors`, `analysisOut`, `appliedOriginals`, `appliedHistoricCorrections`, `lastCheckId`, `activeHistoryEntryId`, `checkProgress`, `checkStatus`, `_checkPollTimer`.
- Editmodus: `editDirty`, `editSaving`, `saveOffline`, `lastAutosaveAt`, `lastDraftSavedAt`, `_autosaveIdleTimer`, `_autosaveMaxTimer`, `_draftTimer`, `_onlineHandler` (`notebookState`) + `originalHtml` (`pageState`, da Mode-agnostisch).
- Fokusmodus: `focusCountWords/Chars/*Delta` (`focusState`) + `focusGranularity` (`shellState`) + Sub-Maschine `_focusState` (`idle`/`entering`/`active`/`exiting`) + `_focusGen` (Re-Entry-Guard) in [editorFocusCard](../public/js/cards/editor-focus-card.js).

**Erlaubte Kombinationen** (8 Bool-Tripel, 4 erlaubt):

| Edit | Focus | Check | Erlaubt? | Bemerkung |
|------|-------|-------|----------|-----------|
| 0 | 0 | 0 | ✓ | Viewmodus |
| 0 | 0 | 1 | ✓ | View + Findings (Split-View) |
| 1 | 0 | 0 | ✓ | Edit |
| 1 | 1 | 0 | ✓ | Edit + Fokus |
| 1 | * | 1 | ✗ | **Invariante: Edit + Prüfmodus forbidden** — `startEdit` bricht bei `checkDone` ab; Edit/Fokus-Buttons sind im Prüfmodus ausgeblendet. |
| 0 | 1 | * | ✗ | **Invariante: `focusActive → editMode`** |

**Invarianten (Pflicht — bei Änderungen prüfen):**

1. `focusActive === true` ⇒ `editMode === true`. Enforced in [editor/focus/card.js:45](../public/js/editor/focus/card.js#L45) (`enterFocusMode` bricht bei `!editMode` ab) und [editor/edit.js:250](../public/js/editor/edit.js#L250) (`cancelEdit` ruft `exitFocusMode` zuerst).
2. `runCheck` darf nicht im Editmodus starten. Template-Guard: Prüfen-Button steht in `<template x-if="!editMode">` ([editor.html:43](../public/partials/editor.html#L43)).
3. `editMode === true` ⇒ `checkDone === false`. Enforced in [editor/notebook/edit.js#startEdit](../public/js/editor/notebook/edit.js) (Guard `if (this.checkDone) return`) und im Template über `x-show="canEdit() && !checkDone"` auf Edit/Fokus-Buttons ([editor-notebook.html:112](../public/partials/editor-notebook.html#L112)). Findings im Editor sind damit ausgeschlossen — Korrekturen laufen via `saveCorrections` aus dem Prüfmodus, nicht via contenteditable.
4. **Chat-Modus** (showChatCard) snapshotet `checkDone` in `_checkDoneBeforeChat` und setzt `checkDone=false` ([chat-base.js:129](../public/js/chat/chat-base.js#L129)); beim Schliessen Restore ([app-view.js:317-319](../public/js/app/app-view.js#L317-L319)). Ohne diesen Snapshot würde der Chat Findings doppelt rendern.
5. **Reset-Reihenfolge in `resetPage()`** ([app-view.js:391](../public/js/app/app-view.js#L391)): `exitFocusMode` → `_stopAutosave` → Chat-Reset → Card-Flags → Editor-State (`editMode/editDirty/editSaving`) → Lektorat-State (`checkDone/findings/...`). Diese Reihenfolge ist Pflicht — Fokus zuerst, weil `exitFocusMode` `editMode/editDirty` liest.
6. `saveEdit` im Fokus bleibt im Fokus+Edit ([editor/edit.js:337](../public/js/editor/edit.js#L337)) — User möchte weiter schreiben. Erst sauberer Exit räumt Edit-Mode auf, dann flusht `exitFocusMode` per `quickSave` ([editor/focus/card.js:350-351](../public/js/editor/focus/card.js#L350-L351)).
7. Hotkey Cmd+Shift+E ([editor/focus/trampoline.js:28](../public/js/editor/focus/trampoline.js#L28) → [editor/focus/card.js:243-245](../public/js/editor/focus/card.js#L243-L245)) wirkt nur bei `showEditorCard` und routet zustandsabhängig: in Fokus → exit, in Edit → enter, sonst → startFocusEdit (Edit + Fokus in einem Schritt).

**Bei Modus-Erweiterung (z.B. „Diff-Modus", „Annotations-Modus")** dieser Section folgen:
1. Flag in passenden Slice von `app-state.js`.
2. Begleit-State + Timer-Refs daneben (gleicher Slice).
3. Invarianten-Tabelle hier ergänzen (Kombinations-Matrix).
4. `resetPage()` und `_resetBookScopedState()` um neuen Reset erweitern (gleiche Reihenfolge: neuer Modus zuerst aussen, sonst nach Lifecycle-Abhängigkeit).
5. Template-Guards setzen (analog `x-show="!editMode"` für Prüfen-Button).
6. Hotkey-Routing in handleFocusHotkey-Stil prüfen.
