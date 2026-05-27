# Buchorganizer

Karte zum Reordern/Verschieben/Umbenennen/Anlegen/Löschen von Kapiteln und Seiten. Direkter Storage-Zugriff via `contentRepo` (kein KI, keine Job-Queue). DnD via SortableJS (lazy). Undo/Redo bis 10 Aktionen.

Code: [public/js/cards/book-organizer-card.js](../public/js/cards/book-organizer-card.js) (Card-Definition) + [public/js/book-organizer.js](../public/js/book-organizer.js) (Facade) + [public/js/book-organizer/](../public/js/book-organizer/) (Slices).

## Modul-Layout

| Slice | Verantwortung |
|-------|---------------|
| `book-organizer/dnd.js` | Sortable-Setup, `_onChapterDrop`/`_onPageDrop`, `movePageToChapter` (Combobox-Pfad). |
| `book-organizer/persist.js` | `_rerender`, `_snapshotFromRoot`, `_snapshotWorkstate`, `_runMutation`, `_persistOrder`, `_buildTreeFromWorkstate`. |
| `book-organizer/mirror.js` | In-Place-Spiegelung `workTree`/`soloPages` → `root.tree`/`root.pages` + Order-Maps + Chapter-Stats. |
| `book-organizer/crud.js` | Create/Rename/Delete für Kapitel + Seiten, jeweils Server-Call + Mirror + History-Push. |
| `book-organizer/history.js` | Undo/Redo-Stacks (FIFO max 10), Record-Typen, `_applyInverse`/`_applyForward`. |
| `book-organizer/view.js` | Collapse-State pro Kapitel, Filter-Getter (`filteredWorkTree`/`filteredSoloPages`), Move-Combobox-Optionen, Jump-to-Chapter. |

Spread-Reihenfolge in der Facade: dnd → persist → mirror → crud → history → view. Slices teilen `this`-State, kein Cross-Import zwischen Slices.

## State auf der Card

```js
workTree         // [{ id, name, pages: [{ id, name, chapter_id }] }]  — Kapitel + ihre Seiten
soloPages        // [{ id, name, chapter_id: 0 }]                      — Seiten ohne Kapitel
chapterOpen      // { [chapter_id]: bool }                             — Per-Kapitel-Collapse-State
organizerSearch  // String — Filter (UI-only, kein Server-Call)
jumpToChapterId  // String — Wert der Jump-Combobox
_sortables       // Sortable-Instanzen (DnD-Lebenszyklus)
_undoStack       // Record[]
_redoStack       // Record[]
_inHistoryFlight // Boolean — verhindert Re-Entry während Undo/Redo
_lifecycle       // setupCardLifecycle-Handle (AbortController, $watch-Setup)
organizerSaving  // Boolean — Mutation läuft
organizerStatus  // String — i18n-Label während Persist
organizerProgress// Number — 0/100 für Progress-Bar
```

`workTree`/`soloPages` sind die **Edit-Repräsentation** des Buchorganizers; `root.tree`/`root.pages` ist der App-weite Tree (Sidebar). Mutationen passieren zuerst lokal, dann werden Server + Root in-place gespiegelt.

## Lifecycle

`setupCardLifecycle` mit folgenden Hooks:

- **`onShow`** — `loadSortable()` (lazy), dann `_rerender()` (Snapshot + Sortable-Init).
- **`onBookChanged`** — Sortable destroyen, gesamten Card-State leeren. **Vor `loadPages`** — der nachfolgende `pages:loaded`-Listener triggert dann den neuen Snapshot.
- **`onCardRefresh`** — nur `_rerender()`. **Kein `loadPages`** — Drag/Rename/CRUD mutieren `root.tree` in-place, Server-Stand und Card-State sind synchron. `loadPages` würde Sidebar-Tree clearen und neu fetchen → Flicker.
- **`onViewReset`** — Sortable destroyen + State leeren.
- **`pages:loaded`-Listener** — separat über `extraListeners`. Triggert `_rerender()` nur, wenn die Karte sichtbar ist. **Kein `$watch(root.tree)`** — eigene Reassignments im Tree würden Selbst-Reentry erzeugen.

Tastatur (window-Listener via Lifecycle-Signal): Cmd/Ctrl+Z → `historyUndo`, Cmd/Ctrl+Shift+Z bzw. Cmd/Ctrl+Y → `historyRedo`. **Greift nicht** in INPUT/TEXTAREA (native Edit-Undo der Rename-Felder soll funktionieren) und nur bei sichtbarer Karte.

`$watch('organizerSearch')` → `_refreshSortableDisabled()`: aktive Suche disabled alle Sortable-Instanzen, weil Reorder über gefiltertem DOM die Reihenfolge brechen würde.

## Mutationspfad (Pflicht-Sequenz)

```
User-Action  (Drag, Click, Rename-Blur, Combobox-Pick)
  ↓
_snapshotWorkstate()         — Vor-State für History-Record cloneen (Reorder)
  ↓
Lokal mutieren              — workTree/soloPages in-place
  ↓
_runMutation(async () => {
  contentRepo.saveOrder()    — Single-PUT mit gesamtem Tree (atomic)
       /createChapter/createPage/updateChapter/updatePage/deleteChapter/deletePage
  _mirrorXxxInRoot()         — root.tree + root.pages in-place patchen
})
  ↓
History-Push (nur bei ok)
```

`_runMutation` setzt `organizerSaving=true`, fängt Errors via `setStatus`, ruft bei Fehler **einmal `root.loadPages()`** (defensiver Resync — Server-State könnte partiell mutiert sein), resettet Status-Flags im `finally`.

`_persistOrder` ist Single-Tree-PUT an `/content/books/:id/order`: Server materialisiert `chapters.position`, `pages.position`, `pages.chapter_id` in einer Transaction. Kein Per-Item-Update.

## In-Place-Mirror

Pflichtprinzip: **kein `loadPages()` nach erfolgreicher Mutation**. `loadPages` würde `root.pages`/`root.tree` neu zuweisen → ganze App-UI rendert neu (sichtbarer Flicker, Sidebar-Scroll springt). Stattdessen mutiert die Card `root.tree`/`root.pages` in-place via Mirror-Helper. Alpine-Deep-Reactivity erkennt nur die geänderten Items.

Mirror-Helper:

- **`_mirrorChapterOrderInRoot()`** — Reorder-Pfad. Schreibt neue `priority` in `root.tree`-Chapter-Items, sortiert `root.tree` (`_sortSoloFirst`), rebuildt `_chapterOrderMap`, resort `root.pages`, rebuildt `_pageOrderMap`/`_pageIdOrderMap`, ruft `root._refreshChapterStats()`.
- **`_mirrorPageMembershipInRoot(affectedChapterIds)`** — Page-Move-Pfad. Spiegelt `chapter_id`/`priority`/`name`/`chapterName` aus `workTree`/`soloPages` auf `root.pages`, rebuildt `pages`-Array der betroffenen `treeCh`-Einträge aus gefiltertem `root.pages`, rebuildt Solo-Tree-Entries, resort, Maps, Stats.
- **`_rebuildSoloEntries()`** — Solo-Tree-Items komplett löschen + frisch nach `soloPages`-Reihenfolge anlegen. Items haben `id: 'solo-<pageId>'`, `solo: true`, `pages: [rp]`.
- **`_resortRootPages()`** — `root.pages` nach Chapter-Priority + Page-Priority sortieren. Kapitel-lose Seiten kommen zuerst (Order `-1`).

`_mirrorCreatedChapter`/`_mirrorCreatedPage` (CRUD-Slice) übernehmen die Spiegelung für neu angelegte Items. Bei neu angelegter Seite in frisch erstelltem Kapitel wird `treeCh.pages` **per Reassignment** statt `push` aktualisiert — Alpine-Reaktivität greift bei nested Arrays nicht immer zuverlässig, wenn das Parent-Item kürzlich selbst gepusht wurde.

## DnD (SortableJS)

Zwei Sortable-Gruppen:

- **`chapter-list`** (Kapitel reordern, eine Liste pro Tiefe): `group: { name: 'chapters', pull: true, put: ['chapters'] }`. Erlaubt Kapitel-Wandern zwischen Levels; Ziel-Validierung (max-depth, kein-eigener-Subtree, kein-self) im `onMove`-Hook `_validateChapterMove`.
- **`page-list`** (eine pro Kapitel + eine für Solo-Seiten): `group: { name: 'pages', pull: true, put: ['pages'] }`. Erlaubt Page-Drops aus jeder anderen page-list.

`onChoose`/`onUnchoose`: setzen `x-ignore` auf das Drag-Item. Sortable klont das Item als Fallback-Ghost (`cloneNode(true)`) in `<body>`. Ohne `x-ignore` würde Alpines MutationObserver `:value="page.name"` ausserhalb des `x-for`-Scopes evaluieren und „page is not defined" werfen.

**Revert-vor-Mutation (Pflicht).** SortableJS und Alpine `x-for` besitzen dieselben `<li>`/`<div>`-Nodes. Drop-Handler rufen darum **als Erstes** `_revertSortable(evt)` — der schiebt den von Sortable physisch verschobenen Node zurück an seinen Ursprungsplatz (Quell-Container, `oldIndex`). Erst danach mutieren sie das Modell (`workTree`/`soloPages`); Alpine rendert die finale Position aus dem Modell. Ohne Revert zeigt nach einem Cross-Container-Move Alpines `key→el`-Map einer anderen `x-for`-Scope weiter auf den verschobenen Node → Orphan/Duplikat-Nodes, driftender DOM, kumulativ falsche Positionen.

`_onChapterDrop`: liest `movedId`/`toParentId`/`targetDepth`/`newIndex` aus dem `evt` (nicht aus dem DOM), revertet, entfernt den Node via `_findChapter` aus seiner Quell-Liste, setzt `parent_id` + rekursiv `depth` (`_setSubtreeDepth`) und splice't ihn an `newIndex` in die Ziel-Liste (`workTree` bei Top-Level, sonst `parent.subchapters`). Cross-Level-Moves persisten mit `fullReload` (root.tree ist flach), Top-Level-Reorder mit Chapter-Order-Mirror.

`_onPageDrop` liest `fromChapId`/`toChapId` aus `dataset.chapterId` der `<ul>`-Wrapper und den Ziel-Index aus `evt.newIndex`, revertet, entfernt Page aus Source-Bucket, setzt neue `chapter_id`, fügt am Ziel-Index ein. `affectedChapters: [fromChapId, toChapId]` → Mirror-Pfad spiegelt nur diese beiden Buckets. Bei `fullReload` (Page in Sub-Kapitel `depth > 1` via `loadPages`) folgt `_reattachSortables()`.

**Sortable-Options (Präzisions-Tuning, in `_initSortables`):** `forceFallback: true` (konsistenter Klon-Ghost via `<body>`, umgeht HTML5-DnD-Quirks), `swapThreshold: 0.65` (Swap erst bei 65% Cursor-im-Ziel — Default 1.0 swappt schon bei minimaler Überlappung → Nachbar-Flackern), `invertSwap: true` (stabile Backward-Drops in nested Listen), `fallbackTolerance: 5` (5px-Move bevor Drag startet), `revertOnSpill: true` (Drop ausserhalb gültiger Liste springt zurück), `direction: 'vertical'`. Drag-Visuals via eigene Klassen `organizer-ghost`/`organizer-chosen`/`organizer-drag-active` (CSS in `book/buchorganizer.css`).

`_patchSortableOnce` patcht `Sortable.prototype._onDragOver` (v1.15.6): bei `this.el === null` (destroyte Instanz, Alpine `x-for`-Reconciliation läuft parallel) wird no-op statt zu crashen.

`movePageToChapter` (Combobox-Pfad) nutzt dieselbe Mutations-/Persist-Sequenz wie `_onPageDrop`, inkl. History-Push.

## Undo/Redo

Records (siehe `history.js`):

```
{ kind: 'reorder',         before, after }                  // workstate-Snapshots
{ kind: 'rename-chapter',  id, oldName, newName }
{ kind: 'rename-page',     id, oldName, newName }
{ kind: 'create-chapter',  id, name }
{ kind: 'create-page',     id, chapterId, name }
```

`HISTORY_MAX = 10` pro Stack, FIFO-Drop bei Überlauf.

**Reorder-Undo** rebuildet workstate aus dem `before`-Snapshot, re-rendert (destroy + init Sortable), schickt Single-Tree-PUT, läuft beide Mirror-Pfade nacheinander (Chapter-Prio zuerst, dann Page-Membership mit aktualisierten Prios). Snapshot-Deep-Clone via `JSON.parse(JSON.stringify(…))` — `structuredClone` wirft auf Alpine-Proxys.

**Create-Undo** löscht das frisch erstellte Kapitel/Seite via `_deleteChapterRaw`/`_deletePageRaw`. **Redo-Stack wird komplett invalidiert** — beim erneuten Anlegen würde der Server eine neue ID vergeben, andere Records im Redo-Stack referenzieren aber die alten IDs (z.B. Reorder-Snapshots mit alten `chapter.id`). Saubere Wiederherstellung müsste der User manuell auslösen.

**Delete (Kapitel/Seite) ist nicht reversibel.** Hard-Delete in SQLite, keine Content-Snapshots. `deleteChapter`/`deletePage` rufen `_clearHistory()` und blocken damit Undo komplett, statt einen inkonsistenten Stack zu hinterlassen. `deleteChapter` verweigert ausserdem nicht-leere Kapitel und Kapitel, deren Seite gerade im Editor offen ist.

`_inHistoryFlight` blockt parallele Undo/Redo-Calls. `_pushUndo` während eines Replay-Schritts ist no-op (sonst würde der Replay sich selbst in den Stack pushen).

`_applyForward` für Reorder spielt das `after`-Snapshot ein. Für Rename ruft es `_doRenameChapter/_doRenamePage` mit `newName`. Create-Forward gibt es nicht — `_pushRedo` wird in `historyUndo` für Create-Records explizit übersprungen.

## View-State

`_recomputeInitialOpenState` (in `view.js`): beim allerersten Snapshot wird `COLLAPSE_THRESHOLD = 8` geprüft. Mehr als 8 Kapitel → alles zu, sonst alles auf. Bei späteren `pages:loaded`-Re-Snapshots bleibt der User-Zustand erhalten, nur neue/entfernte Kapitel-IDs werden ergänzt bzw. entfernt.

`toggleChapter`/`expandAll`/`collapseAll` weisen `chapterOpen` jeweils ein **neues Objekt** zu (Alpine-Reaktivität für Object-Props).

`filteredWorkTree`/`filteredSoloPages` sind **Methoden, keine Getter**. Beim `{...viewMethods}`-Spread in der Facade würden Getter-Definitionen aufgerufen (`this` = POJO, `workTree` = undefined) und das Ergebnis als statisches Property eingefroren. Methoden bleiben durch Spread reaktiv.

`chapterMoveOptions(currentChId)` wird im `x-effect` der Combobox aufgerufen — die gelesenen Reactive-Felder (`workTree`, `ch.name`) sind Alpine-getrackt.

## Pflicht-Invarianten

- **Kein `loadPages()` nach erfolgreicher Mutation.** Nur im Error-Path von `_runMutation`.
- **Kein `$watch(root.tree)`.** `pages:loaded`-Event ist die einzige zugelassene Re-Snapshot-Quelle.
- **Drop-Handler revertieren Sortables DOM-Move zuerst** (`_revertSortable(evt)`), dann mutieren sie das Modell. Indizes/Parent/Tiefe kommen aus dem `evt`, nicht aus dem DOM. Alpine bleibt alleiniger DOM-Besitzer.
- **Snapshots via `JSON.parse(JSON.stringify(…))`**, nicht `structuredClone`.
- **Delete clear't History.** Create-Undo invalidiert Redo-Stack.
- **Suche disabled Sortable**, nicht das Suchfeld.
- **`x-ignore` aufs Drag-Item** während des Drags (Alpine-MutationObserver-Schutz).
- **Move-Combobox via `movePageToChapter`** — gleiche Persist-Sequenz wie DnD, kein Direct-Mutate.

## Error-Pfad

`_runMutation`-`catch`:
1. `setStatus` mit i18n-Key (`bookOrganizer.saveFailed` etc.) + `error.message`.
2. `root.loadPages()` — defensiver Resync, weil Server möglicherweise partiell mutiert ist (z.B. Atomic-PUT fehlgeschlagen, aber DB-Trigger lief schon teilweise).
3. `organizerSaving=false`, `organizerStatus=''`, `organizerProgress=0` im `finally`.

Rename-Pfad ist anders: kein `_runMutation`-Wrapper, sondern direkter `try/catch` in `_doRenameChapter`/`_doRenamePage`. Bei Fehler wird das `<input>`-Element auf den alten Namen zurückgesetzt (`inputEl.value = ch.name`).

## Neue Mutation hinzufügen

1. Methode in passenden Slice. Wenn DOM-Drag betroffen → `dnd.js`, sonst `crud.js` oder `persist.js`.
2. `_snapshotWorkstate()` vor lokaler Mutation aufrufen (für History-Record).
3. Lokal mutieren (workTree/soloPages in-place).
4. `_runMutation(async () => { contentRepo.xxx(); _mirrorXxxInRoot(); })`.
5. Bei Erfolg: passenden `_recordXxx`-Helper in `history.js` rufen. Wenn Operation nicht reversibel ist (Delete): `_clearHistory()`.
6. Wenn Operation Page-Membership ändert: `affectedChapters`-Liste mitgeben, sonst läuft der teurere `_mirrorChapterOrderInRoot`-Pfad.
7. Bei UI-Pfaden mit nestedem Reassignment (Page in neues Kapitel pushen): `treeCh.pages = [...treeCh.pages, p]` statt `push` — Alpine-Reaktivität.
