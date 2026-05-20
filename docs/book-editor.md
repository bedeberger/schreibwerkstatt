# Bucheditor

Eigenständiger Editor (kein Modus auf einer Einzelseite): rendert **alle Kapitel + Seiten eines Buchs in Lesereihenfolge** als durchgehenden Manuskript-Stream. Jede Seite ist ein separater `contenteditable`-Block mit eigenem Save-State. Klick aktiviert den Block, Verlassen flusht den Save. Schwesterdokus für die anderen beiden Editoren: [notebook-editor.md](notebook-editor.md) (Einzelseiten-Editor), [focus-editor.md](focus-editor.md) (Vollbild-Schreibmodus). Die drei Editoren sind unabhängige Features — bei Änderungswünschen muss der User immer nennen, welcher Editor gemeint ist (siehe Harte Regel in [CLAUDE.md](../CLAUDE.md)).

Code: [public/js/cards/book-editor-card.js](../public/js/cards/book-editor-card.js) (Alpine.data-Sub), [public/partials/book-editor.html](../public/partials/book-editor.html), [public/css/editor/book/book-editor.css](../public/css/editor/book/book-editor.css). Server: [routes/book-editor.js](../routes/book-editor.js) (`/book-editor/:book_id/contents` — Server-Side-Aggregation, Batch-Loader). Tests: [tests/unit/book-editor-blocks.test.mjs](../tests/unit/book-editor-blocks.test.mjs).

Trigger: Karten-Toggle aus Palette/Quick-Pills (`showBookEditorCard`, Feature-Key `bookEditor` in [feature-registry.js](../public/js/cards/feature-registry.js)). Cmd/Ctrl+F im sichtbaren Bucheditor öffnet die Find-Leiste **innerhalb** der Karte (Routing via `book-editor:open-find`-Event aus `editor-find-card`).

## Abgrenzung gegen Notebook-Editor und Focus-Editor

| Eigenschaft | Bucheditor | Notebook-Editor | Focus-Editor |
|---|---|---|---|
| Scope | ganzes Buch (alle Pages sequenziell) | eine Seite | eine Seite (Modus auf Notebook) |
| State-Slot | Card-lokal (kein `editMode`) | `notebookState` ([app-state.js:113](../public/js/app/app-state.js#L113)) | `focusState` ([app-state.js:129](../public/js/app/app-state.js#L129)) |
| Aktivierung | Karten-Toggle (`showBookEditorCard`) | `startEdit()` (Edit-Button im Karten-Header) | `enterFocusMode()` (Hotkey Cmd+Shift+E) |
| Container | `[data-book-editor-page]` pro Block | `#editor-card .page-content-view--editing` | `.focus-editor.is-active .page-content-view--editing` |
| Body-Klasse | `.book-editor-page-body` | `.page-content-view` | `.focus-editor__content` |
| Paper-Tokens | `--color-book-editor-bg/-text` | `--color-page-view-bg/-text` | (eigene Paper-Tokens) |
| Save-Trigger | Block-Wechsel / Autosave / Cmd+S (Save-All) | Save-Button / Ctrl+S / Autosave | (vererbt Notebook-Save aus `focusMode ⇒ editMode`) |
| Concurrency | Save-Queue, eine Page parallel | eine Page | eine Page |
| Find/Replace | eigene Find-Bar (CSS Custom Highlight, Range-Replace) | — | — |
| Toolbar / Bubble | nein | ja ([editorToolbarCard](../public/js/cards/editor-toolbar-card.js)) | nein (im Fokus deaktiviert) |
| Lektorat-Marks | nein (cleanForSave entfernt sie defensiv) | ja (Findings im View, Apply via `saveCorrections`) | nein (im Fokus deaktiviert) |

**Keine Modus-Invariante** zwischen Bucheditor und den anderen — er kann nicht parallel zu Notebook/Focus offen sein (Exklusivität via `_closeOtherMainCards`, Eintrag in `EXCLUSIVE_CARDS` der feature-registry).

## State (Card-lokal)

| Feld | Bedeutung |
|---|---|
| `blocks: Array` | Render-Liste, gebaut via `buildBlocksFromPages(pages)` aus Server-Response. `kind: 'chapter' \| 'page'`. Page-Block hält `html`/`originalHtml`/`originalUpdatedAt`/`dirty`/`saving`/`saveError`/`conflict`/`savedAt`/`_rev` |
| `activePageId` | Klick-aktivierter Block (nur dieser hat `contenteditable=true`) |
| `saveQueue: number[]` | FIFO, Concurrency 1 |
| `saveProcessing` | Re-Entry-Guard für `_processQueue` |
| `saveAllRunning` / `saveAllTotal` / `saveAllDone` | Save-All-Fortschritt |
| `dirtyCount` / `savingCount` | Aggregate für Header-Badge und `beforeunload`-Schutz |
| `_autosaveTimers` / `_autosaveMaxTimers` | `Map<pageId, timeoutId>` — pro Block Idle (60 s) + Max (120 s) |
| `findOpen/Term/Replace/CaseSensitive/WholeWord/Matches/Index` | Find/Replace-State |
| `visiblePageId` / `collapsedChapters` / `outlineOpen` | Outline / TOC (Sticky-Sidebar) |
| `_outlineObserver` | `IntersectionObserver` für Active-Outline-Item |

Reset-Quelle: `setupCardLifecycle({ resetState, load })` ([card-lifecycle.js](../public/js/cards/card-lifecycle.js)) — `book:changed`/`view:reset` resetten den State und laden neu.

## Lifecycle

```
init ──setupCardLifecycle──▶ idle
       │
       └─ showBookEditorCard=true ──load(bookId)──▶ aktiv
                                                       │
                                                       ├─ activateBlock(p)  ── prev.dirty? → _enqueueSave(prev)
                                                       ├─ _onBlockInput     ── block.html = el.innerHTML; _markBlockDirty
                                                       ├─ Autosave Idle 60 s / Max 120 s ── _enqueueSave
                                                       ├─ Cmd/Ctrl+S        ── saveAllDirty
                                                       └─ Find/Replace       ── recompute → _doReplaceAt → dirty+queue
       book:changed / view:reset ──▶ reset → idle
       destroy ──▶ Timer/IO/Highlight-Cleanup
```

### Laden (`_load`)
1. `fetchJson('/book-editor/:book_id/contents')` — Server liefert alle Pages in Lesereihenfolge (Depth-First durch Kapitel-Hierarchie).
2. `buildBlocksFromPages(pages)` produziert die Block-Liste mit Chapter-Markern an Kapitel-Grenzen.
3. `missing > 0` → Status-Toast (`bookEditor.missingPages`); Bucheditor bleibt lauffähig.
4. `$nextTick(_initOutlineObserver)` — IO an alle `.book-editor-page-card`-Targets.

### Klick-aktiviert-Block
- Default: alle Blöcke `contenteditable=false`. Klick speichert `_pendingMousedown` (Klick-Koordinaten + pageId), `activateBlock` setzt `activePageId` und im `$nextTick` Caret aus `caretRangeFromPoint`. Fallback bei fehlender API: kein Caret-Place, Block fokussiert aber leer.
- Vorheriger aktiver Block wird vor dem Wechsel `_enqueueSave`'d, wenn dirty.

### Render-Sync (`_mountBlockEl` / `_maybeRehydrate`)
- **`_mountBlockEl`** (x-init am Block-Container): einmaliger Initial-Write von `block.html` + `data-rev`.
- **`_maybeRehydrate`** (x-effect): schreibt `block.html` **nur dann** in den DOM, wenn `activePageId !== block.pageId` und sich `_rev` geändert hat. Schützt das Caret im aktiven Block vor externen Mutations-Rewrites (Find/Replace, Reload).
- Alle anderen `block.html`-Mutationen kommen aus `_onBlockInput` oder `_doReplaceAt`; sie inkrementieren `_rev` nicht (DOM ist bereits Quelle).

### Save-Queue (`_enqueueSave` → `_processQueue` → `_saveBlock`)
- Pro Block: dirty/saving-Flags; Queue dedupliziert.
- `_saveBlock`:
  1. Pending Timer für die Page clearen.
  2. `cleanForSave(html)` — `lektorat-mark`/`chat-mark`/`*-ins` defensiv entfernen, falls aus History-/Chat-Apply im rohen HTML stehen geblieben.
  3. No-Change-Short-Circuit (`newHtml === originalHtml`) — dirty-Flag zurück, kein PUT.
  4. **Leer-Block-Schutz**: `htmlToText(newHtml).trim() === '' → bookEditor.emptyAbort`. Verhindert versehentliches Leerspeichern beim Verlassen.
  5. Pre-Conflict-Check: `app._checkPageConflict(pageId, originalUpdatedAt)` — Konflikt → `block.conflict = { remoteUserName, remoteUpdatedAt, remoteHtml }` + Banner; **kein** Modal.
  6. `contentRepo.savePage(pageId, { html, name, expected_updated_at })`. Erfolg: `originalHtml`/`originalUpdatedAt`/`savedAt` aktualisieren, `dirtyCount--`.
  7. 409 PAGE_CONFLICT (Race nach Pre-Check) → identische Conflict-Banner-Branch.
  8. `app._syncPageStatsAfterSave?.(...)` — Page-Stats konsistent zum Notebook-/Focus-Save-Pfad (Frontend/Server-Parität, siehe Harte Regel „HTML→Text-Normalisierung" in CLAUDE.md).
- Konflikt-Resolution: `resolveConflictOverwrite(block)` (Remote-`updated_at` übernehmen, re-queue) / `resolveConflictTakeRemote(block)` (Remote-HTML übernehmen, dirty=false, `_rev++` → Re-Hydrate).

### Save-All (Cmd/Ctrl+S)
- Sammelt alle dirty Pages → in Queue → `_processQueue` → seriell.
- Fortschrittsanzeige: `saveAllDone / saveAllTotal`.
- **Im Bucheditor löst Cmd/Ctrl+S keinen Einzel-Save aus** — Save-Trigger ist Block-Wechsel oder Autosave, Cmd/Ctrl+S ist explizit Save-All.

## Find/Replace (innerhalb der Karte)

- Trigger: Cmd/Ctrl+F → globales `editor-find-card` dispatcht `book-editor:open-find` → `openFind()`.
- Match-Pipeline:
  1. `_allBlockEls()` → alle `[data-book-editor-page]`.
  2. Pro Block: `_matchesIn(el, term, caseSensitive, wholeWord)` — `TreeWalker(SHOW_TEXT)` baut Node-Liste + concat-String, `indexOf`-Schleife sammelt Offsets, `_mapOffset` baut `{ startNode, startOffset, endNode, endOffset }` zurück. Whole-Word via `\p{L}\p{N}_`-Boundary-Check.
  3. `findMatches` aggregiert über alle Blöcke.
- Highlight: **CSS Custom Highlight API** (`book-editor-find-match` + `book-editor-find-current`), kein DOM-Wrap. Browser ohne API → keine Highlights, Navigation bleibt funktional.
- Replace: `Range.deleteContents` + `createTextNode(replace)` + `range.insertNode`. Danach `block.html = container.innerHTML`, dirty + autosave-schedule.
- Replace-All läuft rückwärts über die Match-Liste (sonst verschieben sich nachfolgende Offsets).

## Outline (Sticky-TOC)

- `outlineNodes` (getter) gruppiert Pages nach Kapitel — Pages vor dem ersten Kapitel kommen in einen `solos`-Bucket.
- `IntersectionObserver` mit `rootMargin: '-100px 0px -60% 0px'` + Threshold `[0]` markiert die Topmost-Page als `visiblePageId`. rAF-Throttle bündelt mehrere IO-Entries pro Scroll-Tick zu einem Update.
- `outlinePageStatus(block)` → `'saving' | 'error' | 'dirty' | 'saved' | ''` für Mini-Status-Punkt pro Outline-Item.
- `scrollToBlock(pageId)` — smooth-scroll aus Outline-Klick; setzt `visiblePageId` sofort optimistisch.
- `toggleChapterCollapse(chapterId)` — Map `collapsedChapters` togglet Sichtbarkeit der Pages unter einem Kapitel im Outline (Stream bleibt vollständig).

## Pflicht-Invarianten

1. **Bucheditor ist **kein** Modus auf einer Seite.** `editMode`/`focusActive` werden **nie** vom Bucheditor gesetzt. Wer eine Cross-Editor-Funktion einbaut, prüft das per Feature-Flag explizit, statt am Modus-State zu hängen.
2. **`activeBlock` ist exklusiv.** Nur der Block mit `activePageId` ist `contenteditable=true`. Andere `contenteditable=false` — sonst Caret-Jumps + Multi-Block-Selections beim Drag.
3. **`_maybeRehydrate` darf nicht auf den aktiven Block schreiben.** DOM gehört dort dem User; ein Re-Render mit `block.html` würde Caret + Selektion killen.
4. **`_rev` nur bei externen Mutationen inkrementieren** (Conflict-Take-Remote, künftige Reload-Patches). Eigene Input-Events updaten `block.html`, aber **nicht** `_rev` — sonst Re-Hydrate-Schleife gegen den eigenen Tipp-Stream.
5. **`cleanForSave` Pflicht vor jedem PUT.** Lektorat-/Chat-Marks haben im Bucheditor nichts zu suchen; der Cleaner ist defensiv (sollte normalerweise no-op sein).
6. **Pre-Conflict-Check mit `_checkPageConflict` aus dem Notebook-Card** — keine eigene Conflict-Logik. Stale-Write-Schutz ist app-weit eine Quelle, siehe [feedback_stale_rmw](../.claude/projects/-Users-bd-ClaudeProjects-schreibwerkstatt/memory/feedback_stale_rmw.md).
7. **`htmlToText(...).trim() === ''` blockt den Save.** Leer-Block beim Verlassen darf die Seite nicht löschen; User sieht `bookEditor.emptyAbort`, Dirty-Flag bleibt.
8. **Save-Queue ist sequenziell.** Concurrency > 1 würde gegen das Stale-Schutz-Modell (`_checkPageConflict` pro Save) laufen — der zweite Save weiss nicht, dass der erste das `updated_at` schon bewegt hat.
9. **`beforeunload`-Schutz nur bei `dirtyCount > 0 || savingCount > 0`.** Sonst Browser-Spam.
10. **Eigene Body-Tokens** (`--color-book-editor-bg/-text`) — kein Reuse der Notebook-Tokens (`--color-page-view-bg/-text`). Visuell entkoppelt vom Tagebuch-Sheet, siehe [feedback_book_editor_decoupled](../.claude/projects/-Users-bd-ClaudeProjects-schreibwerkstatt/memory/feedback_book_editor_decoupled.md).
11. **Body-Styling ist eigenständig** — kein `--notebook-line`-Liniengitter, kein `repeating-linear-gradient` mit `--color-notebook-rule`. Bucheditor ist Manuskript-Stream, nicht Notebook-Sheet.
12. **Cross-Karten-Aufrufer respektieren** `window.__app` — der Bucheditor liest `app._checkPageConflict`/`app._syncPageStatsAfterSave`/`app.t`/`app.setStatus`. Diese Methoden gehören dem Root (bzw. dem Notebook-Card via Trampoline). Keine eigene Duplikate.

## Erweitern (Checkliste)

Neue Aktion / neuer Block-Typ / neuer Find-Modus:
1. Aktion am Block-Header (Save/Conflict-Buttons) → in [public/partials/book-editor.html](../public/partials/book-editor.html); Handler in [book-editor-card.js](../public/js/cards/book-editor-card.js). Keine Toolbar-Bubble — die gehört zum Notebook-Editor.
2. Neuer Block-Typ (z.B. Trennlinie zwischen Büchern): `buildBlocksFromPages` ergänzen + Unit-Test in [book-editor-blocks.test.mjs](../tests/unit/book-editor-blocks.test.mjs).
3. Find-Modus (Regex, Case-Insensitive-Akzente): `_matchesIn` erweitern; Highlight bleibt via `_refreshFindHighlights`.
4. Save-Pfad anfassen: Pflicht `cleanForSave` + `_checkPageConflict` + `contentRepo.savePage`. Niemals direkt `fetch('/content/page/...')`.
5. Outline-Item-Status (`outlinePageStatus`) und Block-Status (`blockStatusKey`/`blockStatusLine`) synchron halten — beide lesen denselben Block-State.
6. CSS für neue Marker-Klasse: in [public/css/editor/book/book-editor.css](../public/css/editor/book/book-editor.css), Layer `components`. Karten-Akzent ist Sepia (`--card-accent`), Body-Tokens `--color-book-editor-bg/-text`.
7. CLAUDE.md „Vertiefende Dokus" zeigt auf diese Datei — bei strukturellen Änderungen (neuer Modus, neue Invariante) hier ergänzen.

## Tests

| Datei | Deckt ab |
|---|---|
| [tests/unit/book-editor-blocks.test.mjs](../tests/unit/book-editor-blocks.test.mjs) | `buildBlocksFromPages`: Chapter-Boundary-Marker, Solo-Pages vor erstem Kapitel, `originalHtml`/`originalUpdatedAt`-Initialisierung |
| [tests/unit/stale-write.test.mjs](../tests/unit/stale-write.test.mjs) | Pre-Save-Conflict-Check (geteilt mit Notebook-Card) — Bucheditor ruft denselben Helper |
| [tests/unit/page-stats-normalization.test.mjs](../tests/unit/page-stats-normalization.test.mjs) | `_syncPageStatsAfterSave`-Parität — Bucheditor ruft denselben Helper |
