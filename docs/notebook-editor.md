# Notebook-Editor

Klassischer Bearbeitungsmodus **für eine einzelne Seite**: `contenteditable` mit Toolbar (Bubble + Slash), Inline-Findings, Draft-/Autosave-Pipeline, Stale-Write-Schutz und Snapshot-Wiederaufnahme. Einer von drei unabhängigen Editoren der App — die anderen beiden sind der [Focus-Editor](focus-editor.md) (eigenständiger Vollbild-Schreibmodus, läuft auf demselben Seiten-Container) und der [Bucheditor](book-editor.md) (eigenständige Karte mit Manuskript-Stream über das ganze Buch). Bei Änderungswünschen muss der User immer nennen, welcher Editor gemeint ist (Harte Regel in [CLAUDE.md](../CLAUDE.md)).

Implementations-Detail: Notebook- und Focus-Editor teilen die Save-/HTML-Pipeline aus [public/js/editor/shared/](../public/js/editor/shared/) (`save-pipeline.js`, `html-clean.js`, `active-editor.js`); das macht sie nicht zu einem Editor — es ist eine geteilte Lib. Bucheditor nutzt `shared/` bewusst nicht (eigener Save-Pfad mit Per-Block-Queue). Alle drei Editoren schreiben über die [Content-Store-Facade](../lib/content-store/).

Code: [public/js/editor/notebook/edit.js](../public/js/editor/notebook/edit.js) (Methods-Spread in Root, `notebookEditMethods`), [public/js/editor/notebook/toolbar.js](../public/js/editor/notebook/toolbar.js) (Methods für `editorToolbarCard`), [public/js/editor/notebook/storage.js](../public/js/editor/notebook/storage.js) (Snapshot), [public/js/editor/notebook/history.js](../public/js/editor/notebook/history.js) (Undo/Redo-Stack pro Edit-Session). Card-Wrapper: [public/js/cards/editor-toolbar-card.js](../public/js/cards/editor-toolbar-card.js). Partials: [public/partials/editor-notebook.html](../public/partials/editor-notebook.html), [public/partials/editor-body-edit.html](../public/partials/editor-body-edit.html), [public/partials/editor-toolbar.html](../public/partials/editor-toolbar.html). CSS: [public/css/editor/notebook/](../public/css/editor/notebook/).

Trigger: Edit-Button im Karten-Header (`startEdit`). Snapshot-Restore mountet den Editor automatisch beim Reload, wenn `normal.snapshot` für die aktuell geladene Seite passt.

## Verortung im Frontend

Sub-Karte `editorNotebookCard` ([public/js/cards/editor-notebook-card.js](../public/js/cards/editor-notebook-card.js)) hostet die volle Edit-Pipeline (`startEdit`/`saveEdit`/`cancelEdit`/`quickSave` + Autosave/Draft/Lock/Presence) und die Reload-Snapshot-Restore. Root spreaded nur dünne Trampoline-Forwarder ([editor/notebook/trampoline.js](../public/js/editor/notebook/trampoline.js)) und greift via `window.__notebookCard` durch — Templates und Cross-Card-Aufrufer (chat.js, focus/card.js, synonyme.js, find.js, toolbar.js, app-view.js) treffen damit weiter die Root-API (`app.startEdit()`, `app._markEditDirty()` …). Toolbar (Bubble + Slash) ist Sub-Card `editorToolbarCard`.

| Verantwortlichkeit | Wohnt in |
|---|---|
| `editMode`, `editDirty`, `editSaving`, `saveOffline`, `pendingDraft`, `editConflict`, Auto-Save-Timer | Root (`notebookState` in [app-state.js](../public/js/app/app-state.js)) |
| `currentPage`, `originalHtml`, `renderedPageHtml` (mode-agnostisch — von Notebook/Focus/View geteilt) | Root (`pageState` in [app-state.js](../public/js/app/app-state.js)) |
| `correctedHtml`, `hasErrors` (Lektorat-Overlay, nur im Prüfmodus aktiv — von page-view über `correctedHtml \|\| renderedPageHtml` konsumiert) | Root (`lektoratState` in [app-state.js](../public/js/app/app-state.js)) |
| `startEdit`/`saveEdit`/`cancelEdit`/`quickSave` + Autosave/Draft/Online-Retry + private Helper (`_checkPageConflict`, `_filterFindingsAfterSave`, `_flushDraftSaveNow`, `_markEditDirty`, …) | Sub `editorNotebookCard` ([editor/notebook/edit.js](../public/js/editor/notebook/edit.js)) |
| Root-API (Templates + Cross-Card-Aufrufer) | Trampoline ([editor/notebook/trampoline.js](../public/js/editor/notebook/trampoline.js)) — forwarded auf `window.__notebookCard` |
| Reload-Snapshot-Restore (Pendant zu `_tryRestoreFocus`) | Sub `editorNotebookCard` ([editor/notebook/card.js](../public/js/editor/notebook/card.js)) |
| Bubble + Slash-Menü State (`bubbleShow`, `slashShow`, …) | Sub `editorToolbarCard` |
| Container-Lookup (`page-content-view--editing`) | `shared/active-editor.js` (smart-switch mit Focus) |

**Trampoline-Pattern:** beide Editoren konsequent gleich strukturiert — Root hält nur Forwarder, Sub die Logik. Notebook nutzt direkte Sub-Ref-Calls (`window.__notebookCard?.X(args)`), weil Methoden Args/Returns durchreichen müssen (z. B. `_checkPageConflict(pageId, expectedUpdatedAt)`, `await quickSave()`). Focus-Trampoline ([editor/focus/trampoline.js](../public/js/editor/focus/trampoline.js)) ist CustomEvent-basiert (4 arg-lose Dispatcher) — pragmatischer Stilunterschied bei gleicher Architektur (siehe [focus-editor.md](focus-editor.md#root-vs-sub-trampoline-pattern)).

## Sheet-Optik (Tagebuch/Notebook)

`.page-content-view` ist der **gemeinsame Style-Scope für Read- und Edit-Modus** — kein Layout-Sprung beim Toggle, gleiche Buchsatz-Typografie in beiden Modi. CSS: [public/css/page/page-view.css](../public/css/page/page-view.css).

**Aktive Tagebuch-Hebel:**
- **Paper-Sheet-Shadow** — `box-shadow: var(--shadow-sm)` auf `.page-content-view` (Blatt-auf-Tisch-Lift in beiden Modi).
- **Buchsatz-Erstzeilen-Einzug** — `p + p { text-indent: 1.4em; margin-top: 0; }`. Folge-`<p>`-Selector greift automatisch nicht nach Headings, blockquote, poem, hr (Roman-/Tagebuch-Buchsatz). Mobile (<600 px): Margin auf 0.8em angehoben (Zeilen-Boost), Erstzeilen-Indent bleibt.
- **Vertikaler Atem** — `padding: 36px clamp(18px, 4vw, 40px)`, `line-height: 1.5`, `<p>`-Margin 0.6em (Desktop).

**`--editing`-Modifier** ergänzt nur Edit-Spezifika: linkes Rail (5 px primary), Background-Tint, `hyphens: none`, `text-wrap: wrap` (kein pretty/balance gegen Caret-Wackeln), `cursor: text`. Sheet-Shadow, Padding, Line-height, Erstzeilen-Einzug erbt aus dem Base-Selector — **Read und Edit zeigen identische Typografie**.

**Edit-only-Properties** müssen über `.page-content-view--editing` (oder Kind-Selektoren davon) gehängt werden. Setzt man Edit-Properties direkt auf `.page-content-view`, leaken sie in Read.

**Caption-Slot in Partials:** [editor-body-view.html](../public/partials/editor-body-view.html) (Read), [editor-body-edit.html](../public/partials/editor-body-edit.html) (Edit). Caption lebt **ausserhalb** des contenteditable, sonst landet sie im DB-HTML.

## Container-Lookup (smart-switch)

Beide Modi suchen ihren contenteditable via `getActiveEditorContainer()` aus [editor/shared/active-editor.js](../public/js/editor/shared/active-editor.js). Selektoren:

- Normal: `#editor-card .page-content-view--editing`
- Focus: `.focus-editor.is-active .page-content-view--editing` (nur wenn `app.focusActive` und Container sichtbar)

Damit sind mode-agnostische Subs (Synonyme, Figur-Lookup) ohne `if (app.focusActive)` lauffähig.

## Lifecycle

```
view  ──startEdit──▶ edit  ──saveEdit──▶ view
                       │  ──cancelEdit──▶ view (mit appConfirm bei Dirty)
                       │  ──quickSave──▶ edit (silent, Auto-/Ctrl+S)
                       │  ──Enter focus──▶ focus (focusMode=true, editMode bleibt)
                       └──Reload──▶ Snapshot-Restore (sessionStorage)
```

### startEdit
1. Guards: `currentPage && originalHtml !== null`, kein laufender Check / Save, **nicht im Prüfmodus** (`checkDone === false`), `canEdit()`.
2. `editMode=true`, Reset `editDirty/editSaving/saveOffline/pendingDraft`.
3. `execCommand('defaultParagraphSeparator', false, 'p')` einmalig — sonst erzeugt Chrome/Safari `<div>` statt `<p>` bei Enter und Block-Erkennung greift nicht.
4. Draft aus localStorage lesen ([editor/draft-storage.js](../public/js/editor/draft-storage.js)); wenn vorhanden und ungleich Original → übernehmen + `editDirty=true`.
5. `el.innerHTML` setzen: Roh-HTML oder Platzhalter-`<p><br></p>` bei leerer Seite.
6. `normalizeEditorBlocks(el)` — orphan Text-/Inline-Runs in `<p>` wrappen. Weicht `innerHTML` ab → `editDirty=true` + Draft schreiben (Legacy-Reparatur persistieren).
7. Caret-Slot: leerer letzter `<p>` ohne Kinder bekommt `<br>` — sonst kein Caret + keine `input`-Events.
8. `_startAutosave` + `_installOnlineRetry`.
9. `_startPresenceHeartbeat` + `_acquireEditLock` (Soft-Lock).
10. `installEditCounter` (zählt in beiden Modi, sichtbar nur im Focus).
11. `writeNormalSnapshot(pageId)` — sessionStorage für Reload-Restore.

### saveEdit ([edit.js:202-328](../public/js/editor/notebook/edit.js#L202-L328))
1. `stripLektoratMarks(el.innerHTML)` → kanonisches HTML (entfernt `.lektorat-ins`/`.chat-mark-ins`, unwrappt `.lektorat-mark`/`.chat-mark`, läuft durch Cleaner-Kette).
2. `isNoChange` → kein PUT; Save aus Focus bleibt im Focus, sonst `cancelEdit`-Pfad ohne Dialog.
3. Kürzungs-Safety: neuer Text < 20 % vom alten und Original > 50 Z → `appConfirm` „kürzer speichern?".
4. `_checkPageConflict` — Pre-Check via `contentRepo.loadPage(id, { fresh: true })`; `remote.updated_at !== currentPage.updated_at` → Konflikt-Modal mit Überschreib-/Behalt-Option.
5. `contentRepo.savePage(id, buildSavePayload({ source: focusActive ? 'focus' : 'main', expectedUpdatedAt }))` (siehe [shared/save-pipeline.js](../public/js/editor/shared/save-pipeline.js)).
6. Server-Response: `currentPage.updated_at` übernehmen.
7. `_filterFindingsAfterSave(newHtml)` — Findings, deren `original` nicht mehr matcht, fliegen raus + selectedFindings + appliedOriginals + correctedHtml resetten.
8. `_syncPageStatsAfterSave` + `refreshPageAges` (Lektorat-Status flippt auf `warn`).
9. `clearDraft`, Snapshot weg, Autosave/OnlineRetry/Counter/Presence/Lock-Teardown — **nur wenn nicht im Focus**. Im Focus bleibt `editMode=true`.
10. Fehlerpfade: 409 `PAGE_CONFLICT` (Race nach Pre-Check) → Block-Merge-Versuch (s.u.); kollisionsfrei = stille Re-Save, sonst Auflösungs-Banner; bei Flag-off/Fehlschlag Draft sichern + klassischer Banner. Netzwerkfehler → Draft + `saveOffline=true`, Online-Retry feuert `quickSave`.

### Block-Level-Merge bei Stale-Write ([shared/block-merge.js](../public/js/editor/shared/block-merge.js))
Flag `FEATURE_BLOCK_MERGE` ([app-state.js](../public/js/app/app-state.js)). Greift in `saveEdit`/`quickSave` an beiden Konflikt-Punkten (Pre-Check + 409-Race) — Notebook **und** Focus teilen den Pfad.
- **Block-IDs:** `lib/html-clean.js#ensureBlockIds` vergibt beim Page-Write (`localdb`-Backend, `_cleanHtmlSafe`) stabile `data-bid` auf allen Block-Tags. Nur auf gespeichertem Page-Body, nicht in `cleanPageHtml` (sonst auch Export/WP-Sync). Idempotent, Duplikate werden neu vergeben.
- **3-Way:** `_attemptBlockMerge` lädt frischen Remote-Stand, `base = originalHtml` (common ancestor), `local = Editor-HTML`. `mergeBlocks(base, local, remote)` mergt nicht-kollidierende Block-Edits still.
- **Kollisionsfrei** → `saveHtml = mergedToHtml(merged)`, Save mit `expectedUpdatedAt = remote.updated_at`, Editor-DOM auf merged gespiegelt (`_applyMergedToEditor`), Toast `edit.conflict.merged.silent`. Kein Banner.
- **Echte Block-Kollision** → `conflictResolution`-State + Modal ([partials/conflict-resolution.html](../public/partials/conflict-resolution.html)): pro Block Meine/Andere/Beide + Bulk; `submitConflictResolution` baut finales HTML via `buildResolvedHtml`. Block-Previews via `x-text` (escaped, kein x-html-Sink).
- **Fallback** auf klassisches Überschreib-Modal: Flag off, leere Base (frische Page → 2-Way) oder Merge wirft.

### quickSave ([edit.js:331-421](../public/js/editor/notebook/edit.js#L331-L421))
- Silent-Pfad: kein Modal, kein „bist du sicher". Auslöser: Ctrl+S, Autosave-Timer, Focus-Exit, Online-Retry.
- **Reihenfolge:** Erst Draft schreiben → dann Netzwerk versuchen. Offline-Tab kann jederzeit ohne Datenverlust geschlossen werden.
- `editSaving=true` früh setzen (Race-Schutz vs. Auto-Save-Tick + Ctrl+S + exitFocusMode-Save).
- Konflikt im Pre-Check oder 409 → `saveOffline=true` + `editConflict`-Banner; **keine** Modal-Frage (sonst Modal-Spam im Hintergrund-Save).
- Erfolg → Draft löschen, `editDirty=false`, `lastAutosaveAt` setzen, Statusleiste `editor.savedAt`.

### cancelEdit
- Bei `editDirty` → `appConfirm` „verwerfen?". Klick „nein" → kein Cleanup, Editor bleibt.
- Volles Teardown: Draft + Snapshot + Autosave + OnlineRetry + Counter + Presence + Lock.
- Wenn `focusActive` → zusätzlich `exitFocusMode` (Focus folgt Edit aus dem Notebook-Pfad; gilt nur, solange Invariante `focusMode ⇒ editMode` aktiv ist).

## Undo/Redo (Session-scoped, pro Seite)

Eigener Stack in [editor/notebook/history.js](../public/js/editor/notebook/history.js) — Browser-eigener Undo-Stack kollabiert sobald wir `innerHTML` oder `replaceChild` aufrufen (Slash-Menü, HR, Paste-Cleaner), darum eine eigene Snapshot-Kette.

**Lifecycle:**
- `startEdit` → `_historyReset(initialHtml)` legt Baseline-Snapshot.
- `_markEditDirty` → `_historyPushSoon` (debounced 500 ms) — Tipp-Serien werden zu einem Schritt zusammengefasst. Dedup gegen Top-of-Stack.
- Undo/Redo flush'en pending Debounce, dann `idx--/idx++` und `_historyRestore(snap)` setzt `innerHTML` + Caret.
- `cancelEdit` / `saveEdit` (non-focus) → `_historyClear` — Session-Ende = Stack-Ende.

**State** (Initial-Felder in [cards/editor-notebook-card.js](../public/js/cards/editor-notebook-card.js)): `_undoStack` (Array `{ html, caretOffset }`, Cap 100), `_undoIdx`, `_undoTimer`, `_undoApplying`.

**Caret-Restore**: Text-Offset vom Editor-Root (Tree-Walker, SHOW_TEXT). Robust über strukturelle Mutationen (Slash, HR), bei reinen Text-Edits exakt.

**Restore-Pfad**: setzt `_undoApplying=true`, schreibt `innerHTML`, restored Caret, ruft `_scheduleDraftSave`/`_scheduleAutosave` (Draft + Autosave laufen weiter), dispatcht `input`-Event (LanguageTool re-check). `_markEditDirty` skipt während des Flags den Push — so wird das Restore nicht selbst zum neuen Stack-Eintrag.

**UI**: Buttons in [editor-notebook.html](../public/partials/editor-notebook.html) `.page-editor-toolbar` (icons `#undo`/`#redo`), Disabled via `notebookCanUndo()`/`notebookCanRedo()`. Keybinds in [toolbar.js](../public/js/editor/notebook/toolbar.js) `_onEditKeydown`: Cmd/Ctrl+Z = Undo, Cmd/Ctrl+Shift+Z + Ctrl+Y = Redo. Im Focus-Editor deaktiviert (Gate `!app.focusActive`).

## Autosave + Draft

| Pfad | Wann | Wohin | Debounce | Cap |
|---|---|---|---|---|
| Draft | bei jedem `_markEditDirty` | localStorage (`draft-storage.js`) | 500 ms | — |
| Autosave (silent) | Idle nach letztem Edit | Server (`quickSave`) | 60 s | 120 s ab erstem Dirty |
| Manual Save | Save-Button (`saveEdit`) | Server (mit Dialog bei Konflikt/Kürzung) | — | — |

Konstanten in [edit.js:18-20](../public/js/editor/notebook/edit.js#L18-L20). `_scheduleAutosave` resettet den Idle-Timer; Max-Timer läuft ab erstem Dirty durch und schlägt zu, wenn der User dauerhaft tippt.

`_flushDraftSaveNow` schreibt sofort + bricht Debounce ab. Aufruf vor jedem Übergang, der den Editor-Inhalt nicht mehr einfängt — insbesondere Focus-Mode-Entry ([focus/card.js](../public/js/editor/focus/card.js)).

## Snapshot-Wiederaufnahme

`writeNormalSnapshot(pageId)` ([notebook/storage.js](../public/js/editor/notebook/storage.js)) schreibt `{ pageId, ts }` in sessionStorage. TTL 1 h. Überlebt F5 + OIDC-Redirect, nicht Tab-Close.

Restore-Trigger sitzt im Root und mountet den Editor automatisch, wenn nach Reload die ursprüngliche Seite geladen ist. Pendant zum Focus-Snapshot — nur Mount-Signal, keine Content-Wiederherstellung (Content kommt aus dem localStorage-Draft).

Cleanup bei `cancelEdit` / `saveEdit` (Non-Focus-Pfad).

## Toolbar (Bubble + Slash)

Sub-Karte `editorToolbarCard` ([cards/editor-toolbar-card.js](../public/js/cards/editor-toolbar-card.js)), Methods aus [notebook/toolbar.js](../public/js/editor/notebook/toolbar.js). Beide Layer als teleportierte Templates in [partials/editor-toolbar.html](../public/partials/editor-toolbar.html) → `position:fixed` ist ausserhalb des `.card`-Transform-Kontextes.

| Layer | Trigger | Sichtbar wenn | Funktion |
|---|---|---|---|
| Bubble | non-collapsed Selection im Editor | `editMode && !focusActive && !sel.isCollapsed` | Bold/Italic (Inline) — Single-Word-Flag steuert zusätzliche Aktionen |
| Slash | `/` in leerem Block | `editMode && !focusActive` | Block-Transform: `p`, `h2`, `h3`, `blockquote`, `.poem`, `ul/li`, `hr` |

**Im Focus deaktiviert.** Bubble/Slash gaten via `if (app.focusActive) return;` ([toolbar.js#L56](../public/js/editor/notebook/toolbar.js#L56), [#L148](../public/js/editor/notebook/toolbar.js#L148)). Cmd/Ctrl+B/I und Cmd/Ctrl+Shift+H laufen weiter, weil B/I auch im Focus-Notwendig-Whitelist sind.

### Slash-Items ([toolbar.js#L14-22](../public/js/editor/notebook/toolbar.js#L14-L22))
`paragraph`, `h2`, `h3`, `blockquote` (mit innerem `<p>`), `poem` (`div.poem` + innerem `<p>`), `list` (`ul > li`), `hr` (+ Folge-`<p>`). Tag-Swap am ganzen Block; Caret landet im Replacement (oder im wrapP-`<p>`).

### Shortcuts (notebook + focus, im delegierten Listener)
- `Shift+Enter` → `insertLineBreak` (cross-browser Soft-Break statt Default-Absatzsplit).
- `Cmd/Ctrl+B` / `+I` → `_applyInline('bold'|'italic')` (auch im Focus).
- `Cmd/Ctrl+Shift+H` → `insertHorizontalRule` (auch im Focus).
- `/` in leerem Block → Slash-Menü öffnen.
- Slash-Menü offen: `↑/↓` Navigation, `Enter` Apply, `Esc` Schliessen, jedes Zeichen → Menü zu (Zeichen läuft durch).

## Paste-Handler

`_onEditPaste` ([edit.js#L429-442](../public/js/editor/notebook/edit.js#L429-L442)) verhindert, dass Computed-Styles inline aus anderen BookStack-Seiten / Websites in die DB wandern (sonst überschreiben sie `.poem` & Co.).

1. `e.preventDefault`.
2. Clipboard-HTML lesen → `cleanContentArtefacts(html)` ([public/js/utils.js](../public/js/utils.js)) — Cleaner-Kette zieht Font/Color/Span-Hüllen ab.
3. `execCommand('insertHTML', false, cleaned)`.
4. Fallback Plain-Text wenn kein HTML.
5. `_markEditDirty()`.

## Pflicht-Invarianten

1. **Save-Source explizit:** `buildSavePayload` verlangt `'main'` (Normal-Editor) oder `'focus'` — Aufrufer entscheidet, nicht die Lib. Quelle: `this.focusActive ? 'focus' : 'main'`.
2. **Pre-Save-Conflict-Check via `fresh: true`:** `_checkPageConflict` ruft `contentRepo.loadPage(id, { fresh: true })`. Ohne `fresh` liefert der SW-SWR-Cache stale `updated_at` und der Pre-Check passt fälschlich durch → Overwrite remote save. Siehe [feedback_stale_rmw](../.claude/projects/-Users-bd-ClaudeProjects-schreibwerkstatt/memory/feedback_stale_rmw.md).
3. **`stripLektoratMarks` vor jedem Save + jedem Dirty-Vergleich.** Verbindlich aus [shared/html-clean.js](../public/js/editor/shared/html-clean.js). Lokales Strip wäre Drift vs. Server-Sicht.
4. **`normalizeForCompare` für Dirty-Check.** `editDirty` darf nicht byte-genau vergleichen — Whitespace/Attribut-Ordnung weichen identisch-semantisch ab. Verwendet identische Cleaner-Kette wie Save.
5. **Draft IMMER zuerst.** `quickSave` schreibt erst localStorage, dann Netzwerk. Offline-Tab-Close darf nichts verlieren.
6. **`editSaving` früh setzen.** Race vs. parallelem Autosave-Tick + Ctrl+S + exitFocusMode-quickSave. Pre-saveEdit/quickSave noch vor dem ersten `await`.
7. **`defaultParagraphSeparator='p'` einmal pro Edit-Session.** Sonst erzeugen WebKit/Blink `<div>` und Focus-`BLOCK_TAGS` (ohne DIV) erkennt den Block nicht.
8. **Caret-Slot `<br>` in leerem `<p>`.** Bei frischen Seiten / `cleanPageHtml`-`<p></p>`-Fallback hat eine kindlose `<p>` zero-height; Caret rendert nicht. Pendant: `ensureTrailingParagraph` aus [shared/auto-slot.js](../public/js/editor/shared/auto-slot.js).
9. **Conflict-Modal nur im manuellen `saveEdit`.** `quickSave` zeigt Banner statt Modal — Hintergrund-Save darf den User nicht unterbrechen.
10. **Counter `installEditCounter` läuft ab `startEdit`.** Tagesdelta muss alle Edits zählen, sonst sieht der Focus-Counter beim Wiedereintritt falsche Werte. Anzeige nur im Focus-Header (`x-show=focusActive`).
11. **Cleanup-Reihenfolge bei `cancelEdit`/`saveEdit` (clean):** Draft → Snapshot → Autosave → OnlineRetry → Counter → Presence → Lock → `editMode=false`. Frühes `editMode=false` lässt Teardowns auf bereits genullten Refs laufen.
12. **Edit + Prüfmodus forbidden.** `startEdit` bricht bei `checkDone === true` ab; Edit/Fokus-Buttons sind im Prüfmodus per `x-show="!checkDone"` ausgeblendet. Findings landen damit nie im contenteditable — Korrekturen werden ausschliesslich via `saveCorrections` aus dem Prüfmodus-Header angewandt.
13. **Findings-Filter nach jedem Save** (`_filterFindingsAfterSave`): Defensive Restbereinigung, falls Findings doch existieren — `original`-Text nicht mehr im neuen HTML → raus. Mit Invariante #12 üblicherweise No-Op.

## Shared-Lib `public/js/editor/shared/`

Beide Editoren (Notebook + Focus) konsumieren ausschliesslich aus `shared/`:

| Modul | Was |
|---|---|
| [html-clean.js](../public/js/editor/shared/html-clean.js) | `stripLektoratMarks`, `normalizeEditorBlocks` (orphan-Run-Wrapping), `normalizeForCompare` (Dirty-Vergleichs-Normalform), `ROOT_BLOCK_TAGS` |
| [save-pipeline.js](../public/js/editor/shared/save-pipeline.js) | `buildSavePayload({ html, pageName, source, expectedUpdatedAt })`, `isNoChange` — pure, ohne DOM |
| [page-api.js](../public/js/editor/shared/page-api.js) | `savePage` (PUT-Wrapper über Content-Store), `isPageConflict`, `readConflictBody` (409 PAGE_CONFLICT) |
| [auto-slot.js](../public/js/editor/shared/auto-slot.js) | `ensureTrailingParagraph` + `removeAutoAddedParagraph` — Schreib-Slot bei leerer `<p>` |
| [edit-counter.js](../public/js/editor/shared/edit-counter.js) | `installEditCounter` (Re-Export; Container-Per-Instance) |
| [active-editor.js](../public/js/editor/shared/active-editor.js) | `getActiveEditorContainer`, `getActiveEditorMode` — Smart-Switch zwischen Notebook + Focus |
| [shortcuts.js](../public/js/editor/shared/shortcuts.js) | `matchInlineCommand` (Whitelist-Test), `bindInlineFormattingShortcuts` (Cmd/Ctrl+B/I/U Bindings) |

Kein Cross-Import `notebook/` ↔ `focus/`. Gemeinsames läuft strikt über `shared/`.

## Erweitern (Checkliste)

Neuer Toolbar-Button / Slash-Item / Shortcut:
1. Slash-Item: `SLASH_ITEMS` in [toolbar.js#L14](../public/js/editor/notebook/toolbar.js#L14) ergänzen + i18n-Key `editor.slash.<key>` in beiden Locale-Dateien.
2. Toolbar-Button: in [partials/editor-toolbar.html](../public/partials/editor-toolbar.html) — Bubble-Layer; Handler in [notebook/toolbar.js](../public/js/editor/notebook/toolbar.js) + im Focus `x-show="!focusActive"`-Guard (Bubble selbst schon gated).
3. Shortcut: `_onEditKeydown` in [toolbar.js](../public/js/editor/notebook/toolbar.js) — wenn Focus auch reagieren soll, **vor** dem `if (app.focusActive) return;`-Branch. Sonst danach.
4. Save-Pfad anfassen: jede Mutation läuft durch `stripLektoratMarks` + `buildSavePayload`. Niemals direkt PUT — Content-Store-Facade ist Pflicht.
5. Tests: bei Save-/Dirty-Pfaden → [tests/unit/stale-write.test.mjs](../tests/unit/stale-write.test.mjs) / [tests/unit/html-clean.test.js](../tests/unit/html-clean.test.js) erweitern.

## Tests

| Datei | Deckt ab |
|---|---|
| [tests/unit/html-clean.test.js](../tests/unit/html-clean.test.js) | `stripLektoratMarks`, `normalizeEditorBlocks`, `normalizeForCompare` |
| [tests/unit/stale-write.test.mjs](../tests/unit/stale-write.test.mjs) | Pre-Save-Conflict-Check (`fresh: true`), 409 PAGE_CONFLICT-Handling |
| [tests/unit/page-stats-normalization.test.mjs](../tests/unit/page-stats-normalization.test.mjs) | `_syncPageStatsAfterSave` Frontend/Server-Parität |
| [tests/e2e/lektorat.spec.js](../tests/e2e/lektorat.spec.js) | Edit-Mode-Flow inkl. Findings-Apply, Save-Source `main` |
| [tests/e2e/clean-content.spec.js](../tests/e2e/clean-content.spec.js) | Paste-Pipeline (`cleanContentArtefacts`) |
