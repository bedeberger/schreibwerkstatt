# Editor-Entkopplung: Normal-Editor („Schreibnotizbuch") vs. Focus-Editor (pur)

> **Status:** Draft
> **Autor:** David Berger
> **Letztes Update:** 2026-05-20
> **Aufwand:** 4–6 Tage (Confidence: med)
> **Severity bei Bug:** high — Editor ist Daten-Eingangspfad; Save-/Dirty-Bugs gehen direkt in `page_revisions`.

## Context

Schreiben ist das Kernfeature der Schreibwerkstatt — Editor-Architektur ist deshalb load-bearing. Heute behandelt der Editor den Focus-Modus als Sub-State des Normal-Editors. Invariante I1 aus [docs/focus-editor.md](../focus-editor.md) verlangt `focusMode ⇒ editMode`, und alle Quer-Features (Toolbar, Figur-Lookup, Synonyme, Lektorat-Findings, Counter, Auto-`<p>`-Slot) müssen entweder `if (app.focusMode)` gaten oder doppelt implementieren. Das blockiert die saubere Trennung der beiden Use-Cases.

Zwei klar getrennte Use-Cases:

- **Focus-Editor — fokussiertes Schreiben**. Pur, ablenkungsfrei, Typewriter-Scroll, Granularitäten, Live-Counter. Inline-Formatierung ausschliesslich Bold/Italic/Unterstrichen per Shortcut. Synonyme und Figuren-Lookup verfügbar. Kein Toolbar-UI, kein Bubble-Menü, keine Findings, kein Find/Replace, keine Page-History.
- **Normal-Editor — Notizbuch / Tagebuch / Blog**. Reichhaltige Formatierung, Toolbar als Primär-Geste, Links setzen, dichtere Text-Metrik (heutige Schreibmodus-Constraints fallen). Wachstumsfläche für künftige Notizbuch-Features (Sidebars, Notizen, weitere Inline-Tools).

Ziel: beide als **gleichrangige** Editier-Modi der Seite — eigene Karten, eigener State, eigenes Frontend-DOM, eigene CSS-Files, eigener Trigger-Pfad, eigene Test-Suiten. Code-Sharing ausdrücklich erwünscht und genutzt: gemeinsame Schreib-Pipeline (HTML-Cleaner, Page-Save-API mit Offline-Queue, Lock/Presence, Revisionen, Snapshot-Restore-Infrastruktur). Daten-Schicht eine, UI-Schicht zwei, Tests pro Use-Case eigene Files.

## Scope MVP

- Eigener Alpine-State-Slice für den Focus-Modus (`focusState`), losgelöst von `editorState`. Kein gemeinsames `editMode`-Flag mehr.
- Focus startet aus dem Page-View ohne Detour über den Normal-Editor. Aus dem Normal-Editor heraus startet er per Hotkey, ohne den Normal-Save-Pfad mitzunehmen.
- Eigener contenteditable-Container im Focus (gemountet in der Focus-Karte selbst, nicht der Normal-Editor-Container). Snapshot beim Eintritt, Save zurück über die Page-Save-API beim Austritt oder per Quick-Save.
- **Focus-Feature-Set (fix)**: Typewriter-Scroll inkl. Granularitäten, Counter (Words/Chars + Tagesdelta), Synonyme, Figuren-Lookup, Save/Quick-Save mit Offline-Fähigkeit, Snapshot-Restore nach Reload, Inline-Formatierung **ausschliesslich Bold/Italic/Unterstrichen** per Shortcut (`Cmd/Ctrl+B/I/U`). Kein Toolbar-UI, kein Bubble-Menü, keine Lektorat-Findings, keine Page-History, keine Find/Replace im Focus.
- **Normal-Editor — Notizbuch-Use-Case**: Toolbar bleibt Primär-Geste (keine erweiterte Shortcut-Liste über die Focus-Whitelist hinaus). Heutige Schreibmodus-Text-Metrik wird **deaktiviert** — Spaltenbreite/Padding/Zeilenhöhe-Constraints aus dem Schreibmodus-Layout fallen, Normal-Editor rendert dichter und freier (Tagebuch-/Blog-Optik). Toolbar wächst künftig um weitere Buttons (Phase 2: Link-Setzen, dann weitere Formatierungen).
- Geteilte Lib `public/js/editor/shared/`: HTML-Cleaner-Kette (`stripLektoratMarks`, `cleanContentArtefacts`, `collapseEmptyBlocks`), `normalizeForCompare`, Auto-`<p>`-Slot, Page-Save-Aufruf (inkl. Offline-Queue-Hook), Lock-Release-Helper, Shortcut-Bindings für die in beiden Modi erlaubte Inline-Formatierung. Beide Modi rufen dieselben Funktionen, kein gemeinsamer Zustand.
- `if (app.focusMode)`-Guards in Normal-Editor-Sub-Komponenten (Toolbar, Bubble-Menüs, Lektorat-Findings, Find/Replace, Page-History) entfernen — Focus-Karte mountet diese gar nicht. Sub-Komponenten, die beide Modi brauchen (Synonyme, Figuren-Lookup), werden parametrisiert: sie kennen einen Mode-agnostischen Editor-Container, kein hartes `app.focusMode` mehr.
- Invariante I1 (`focusMode ⇒ editMode`) aus [docs/focus-editor.md](../focus-editor.md) gestrichen und durch I1' ersetzt: „Focus und Normal-Edit sind gegenseitig exklusiv; Focus kann ohne Normal-Edit aktiv sein."
- `EXCLUSIVE_CARDS`-Eintrag für die Focus-Karte; `selectPage` + Hotkey-Routing entsprechend angepasst.
- Tests: bestehende `tests/unit/editor-modes.test.mjs` umschreiben, neue Unit-Tests für die geteilte Save-Lib und für die Shortcut-Bindings, E2E aktualisieren (inkl. Offline-Save-Pfad und Synonyme-/Figuren-Lookup im Focus).

## Out-of-Scope (Phase 2)

- **Link-Setzen im Normal-Editor** (Toolbar-Button, Link-Dialog, URL-Validierung). Erster Notebook-Use-Case-Ausbau, eigener Plan nach Merge dieser Entkopplung. Nicht im MVP, sonst wächst der Refactor.
- **Weitere Notizbuch-Features im Normal-Editor** (Margin-Notes, Sidebar-Panels, Notizen, neue Inline-Tools, erweiterte Toolbar-Gruppen für Tagebuch-/Blog-Optik). Eigene Pläne pro Feature.
- **Reine UX-Änderungen am Focus-Modus** (z. B. neue Granularität, andere Typewriter-Logik). Nicht Teil dieses Refactors.
- **Mobile-Spezifikum** für den Focus-Modus über die heutigen Breakpoints hinaus.
- **Multi-Page-Editor** (Long-Form-Scroll über mehrere Seiten) — bewusst nicht im Scope, würde Save-Modell wesentlich verändern.
- **Server-Seitiges Source-Tagging in `page_revisions`** über das bestehende `source: 'main'|'focus'` hinaus. Bleibt unverändert.

## Done when (Akzeptanzkriterien)

- User öffnet eine Seite im Page-View, drückt `Cmd/Ctrl+Shift+E` → Focus-Modus startet direkt, ohne dass der Normal-Editor-Container je gemountet wurde (Smoke-Check via DOM-Inspector: kein Normal-Editor-Container im DOM, nur der Focus-Cardroot).
- User ist im Normal-Editor, drückt `Cmd/Ctrl+Shift+E` → Normal-Editor schliesst sauber (Save, Lock-Release, Listener-Teardown), Focus-Editor öffnet aus Page-View-Snapshot. Beim Beenden des Focus-Editors landet User wieder im Page-View, nicht im Normal-Editor.
- User editiert im Focus: kein Toolbar-Element, keine Bubble-Menüs, keine Lektorat-Findings, keine Find/Replace-UI, keine Page-History im DOM. Sichtbar sind ausschliesslich Editor-Fläche, Counter, Granularity-Steuerung.
- Im Focus lassen sich Synonyme (Trigger wie heute) und Figuren-Lookup (Trigger wie heute) wie gewohnt aufrufen und schliessen — keine Funktionalität gegenüber heute verloren.
- Im Focus funktionieren die definierten Inline-Formatierungs-Shortcuts (siehe „Open Questions" für finale Liste) — Bold/Italic/Unterstrichen (Default: Cmd/Ctrl+B/I/U) wirken am Selektionsbereich. Kein Toolbar-Pendant.
- Quick-Save aus dem Focus erzeugt eine Revision mit `source = 'focus'`; aus dem Normal-Editor `source = 'main'`. Keine `'main+focus'`-Mix-Revisionen mehr.
- Offline-Pfad: Focus speichert bei fehlender Verbindung in die lokale Offline-Queue (gleicher Mechanismus wie Normal-Editor), Snapshot-Restore funktioniert nach Reload weiterhin.
- Normal-Editor kann seine Text-Metrik (Zeilenabstand, Block-Spacings) unabhängig vom Focus ändern — Änderungen in Normal-CSS dürfen nie auf den Focus durchschlagen (Sichtprüfung: Toggle Normal-CSS aus → Focus-Layout unverändert).
- Bei aktivem Focus klick auf eine andere Seite → Focus speichert + schliesst sauber, neue Seite öffnet im Page-View.
- `tests/unit/editor-modes.test.mjs` ist neu geschrieben und besteht; alte I1-Assertions entfernt. E2E `tests/e2e/focus-editor.spec.js` deckt den neuen Direct-Entry-Pfad, die Synonyme-/Figuren-Lookup-Trigger im Focus und den Offline-Save ab.
- Bei deaktivierter Focus-Karte (hypothetisch): Normal-Editor läuft komplett ohne Focus-Code-Import, keine ReferenceErrors.

## Hard-Rule-Audit

| CLAUDE.md-Regel | Anwendbar? | Notiz |
|---|---|---|
| KI-Calls nur via Job-Queue | n/a | reine UI/State-Trennung |
| Content-Store-Facade einziger Eintrittspunkt | ja | Save-Lib ruft Facade, nicht direkt SQL |
| Prompts nur unter `public/js/prompts/` | n/a | |
| UI-Strings nur in i18n-Files | ja | neue Status-Strings („Focus speichert …", Save-Source-Hinweise) DE+EN gleichzeitig |
| Styles nur in `public/css/` | ja | siehe CSS-Sektion |
| Combobox statt `<select>` | n/a | |
| numInput statt `<input type=number>` | n/a | |
| `SHELL_CACHE` bump | ja | grosse JS/CSS-Umstellung |
| DESIGN.md-Eintrag (neues UI-Pattern) | n/a | gleiche Patterns, keine neuen |
| FK-Integration bei neuer Tabelle | n/a | kein Schema-Change |
| ISO+Z-Timestamps (NOW_ISO_SQL) | n/a | |
| Logging-Context book-slot | n/a | bestehender Save-Pfad |
| Job-Ergebnisse mit updatedAt-Staleness-Check | n/a | kein Job |
| x-html nur escaped | ja | bestehende Sinks bleiben, neue Status-Strings müssen escaped sein |
| EXCLUSIVE_CARDS + FEATURES + ALLOWED_KEYS | ja | Focus-Karte braucht eigenen Eintrag in `EXCLUSIVE_CARDS`; Hotkey-Trigger ohne Palette-Pill möglich, dann `FEATURES`-Eintrag optional |
| File-Limits / Modularität | ja | `editor/edit.js`-Reste prüfen, ggf. splitten; `editor/shared/`-Subfolder pflegen |
| Memo-Pattern | n/a | |
| State explizit deklariert | ja | `focusState`-Slice in `app-state.js` getrennt von `editorState` |
| Card-Animationen nur via CSS | ja | |

## Abhängigkeiten

- **Andere Pläne:** keiner blockierend. Spätere Notebook-Feature-Pläne hängen an diesem hier (sind aber Phase 2).
- **Externe Services:** keine.
- **DB-Schema-Version:** kein Change. `page_revisions.source` bleibt `'main' | 'focus'`.
- **Tests:** `tests/unit/editor-modes.test.mjs` muss vor Merge umgeschrieben sein.
- **Docs:** [docs/focus-editor.md](../focus-editor.md) und [docs/state-modell.md](../state-modell.md) im selben Commit aktualisieren; [CLAUDE.md](../../CLAUDE.md)-Hinweise auf den Editor-Aufbau prüfen.

## Backend

### Routen

Keine neuen Routen. Bestehende `PUT /content/pages/:id` und Lock/Presence-Endpoints bleiben unverändert. Beide Modi schicken dieselben Bodies.

### Module / Libs

Keine neuen Server-Module. Optional: Validierung des `source`-Felds (`main` | `focus`) in der Page-Save-Route explizit dokumentieren (heute implizit).

### Jobs (falls KI)

n/a.

## Frontend

### State / Karte

Zwei strikt getrennte Slices in [public/js/app/app-state.js](../../public/js/app/app-state.js):

- `editorState` (bestehend, gekürzt): `editMode`, `editDirty`, `editSaving`, `originalHtml`, `saveOffline`. Kennt **nichts** vom Focus.
- `focusState` (neu, ersetzt `focusModeState`): `focusActive` (statt `focusMode`), `focusDirty`, `focusSaving`, `focusGranularity`, `focusCountWords`, `focusCountChars`, `focusCountWordsDelta`, `focusCountCharsDelta`. Live-Zähler hängen am Focus-Container, nicht am Normal-Editor-Container.

Karten:

- Normal-Editor bleibt im Root angesiedelt (siehe heutiger Editor-Flow); die Normal-only-Subs in [public/js/cards/editor-*-card.js](../../public/js/cards/) (toolbar, find, lektorat-findings, page-history) bleiben ihm exklusiv zugeordnet.
- Focus-Karte in [public/js/cards/editor-focus-card.js](../../public/js/cards/editor-focus-card.js) übernimmt vollständig den Focus-DOM: contenteditable, Counter-UI, Granularity-Steuerung, Snapshot-Restore, Shortcut-Bindings. Sie mountet ihren eigenen Editor-Container in einem dedizierten Partial.
- **Beidseitige Subs** (Synonyme, Figuren-Lookup): die Karten `editor-synonyme-card.js` und `editor-figur-lookup-card.js` werden mode-agnostisch. Sie kennen den aktuell aktiven Editor-Container über einen schmalen Selektor-/Ref-Kontrakt (z. B. globalen Helper `getActiveEditorContainer()` aus `shared/`), statt `app.focusMode` zu prüfen. Sowohl Normal-Editor-Partial als auch Focus-Partial referenzieren sie.
- Toolbar/Find/Lektorat-Findings/Page-History/Bubble-Menüs werden **nicht** in die Focus-Karte gespreaded. Damit fallen die bestehenden `if (app.focusMode)`-Guards in diesen Subs ersatzlos weg.

### Partials

- [public/partials/editor.html](../../public/partials/editor.html) (bestehend) — bleibt Normal-Editor-Partial; alle Focus-Conditionals entfernt. Bindet weiterhin Synonyme- und Figuren-Lookup-Karten ein.
- [public/partials/editor-focus.html](../../public/partials/editor-focus.html) (neu) — eigener Partial mit eigenem `<div contenteditable>`, Counter-Anzeige, Granularity-Combobox, **Synonyme- und Figuren-Lookup-Karten** (eingebunden, aber ohne Toolbar/Findings/Find). Mountet bei `focusActive`. Lädt **keine** Toolbar, **keine** Findings, **keine** Find/Replace, **keine** Page-History.

### Lifecycle / Events

- `view:reset` schliesst beide Modi; Save jeweils im eigenen Pfad.
- `book:changed` und `page:changed` triggern auf beiden Karten den Cleanup.
- Neuer Event `editor:focus:enter-from-pageview` (Quelle: Hotkey-Handler aus Page-View) → Focus-Karte mountet ohne Normal-Editor-Detour.
- Bestehende Trampoline-Events `editor:focus:{toggle,enter,exit,start-edit}` aus [public/js/editor/focus/trampoline.js](../../public/js/editor/focus/trampoline.js) werden reduziert: `toggle` und `start-edit` entfallen, `enter`/`exit` bleiben. Root behält nur einen schmalen Hotkey-Router (`handleFocusHotkey`), der je nach aktuellem View den richtigen Entry-Pfad wählt.
- Lock/Presence: beide Modi acquiren den Page-Lock beim Eintritt, releasen beim Austritt. Wechsel Normal → Focus geht über den gemeinsamen Save+Release-Helper.

### Geteilte Lib `public/js/editor/shared/`

Neu, Subfolder mit thematischer Aufteilung:

- `shared/html-clean.js` (Re-Export aus `public/js/utils.js` falls vorhanden; sonst neu) — `stripLektoratMarks`, `cleanContentArtefacts`, `collapseEmptyBlocks`, `normalizeForCompare`.
- `shared/save-pipeline.js` — pure Funktion `buildSavePayload({ html, originalHtml, source })`, kein DOM-Zugriff, testbar isoliert.
- `shared/auto-slot.js` — `ensureTrailingParagraph(container)` + Cleanup-Helper; ersetzt die zwei heutigen Pfade in `startEdit` und `jumpToTrailingParagraph`.
- `shared/page-api.js` — dünner Wrapper über `PUT /content/pages/:id` mit konsistenter Fehlerbehandlung (401, Lock-Konflikt, Stale-Write) und Offline-Queue-Anbindung (`saveOffline`-Pfad gleichwertig für beide Modi).
- `shared/edit-counter.js` — `installEditCounter(container, onCount)`; beide Modi instanziieren ihn jeweils gegen den eigenen Container. Keine globale Single-Instance mehr.
- `shared/active-editor.js` — `getActiveEditorContainer()` + `getActiveEditorMode()`. Sub-Komponenten (Synonyme, Figuren-Lookup), die in beiden Modi laufen, fragen hier nach dem Ziel-Container, statt `app.focusMode` zu prüfen.
- `shared/shortcuts.js` — `bindInlineFormattingShortcuts(container, { allowedCommands })`. Pure Bindings für Bold/Italic/Unterstrichen (Default), mit `allowedCommands`-Whitelist pro Modus. Normal-Editor kann zusätzliche Commands freischalten; Focus bleibt minimal.

`public/js/editor/edit.js` wird auf den Normal-Editor-Pfad reduziert (Toolbar-Methoden, Selection, Dirty-Check für Normal-Form) und konsumiert ausschliesslich `shared/`. `public/js/editor/focus/` konsumiert ebenfalls `shared/` und behält Focus-spezifische Module (state-machine, recenter-pipeline, dom-blocks, sentence, typewriter, storage).

## CSS

- [public/css/editor/focus-mode.css](../../public/css/editor/focus-mode.css) bleibt, wird aber von `body.focus-mode`-Overrides auf eigenen Scope-Selektor `.focus-editor` umgestellt (Cardroot der Focus-Karte). Body-Class-Schaltung bleibt für globale Layout-Effekte (overflow-anchor, scroll-Locks), für reine Editor-Styles aber unnötig.
- Normal-Editor-CSS (heutige `editor/`-Files ausser `focus-mode.css`) wird auf den Cardroot `.normal-editor` gescoped. Damit kann die Normal-Text-Metrik (Zeilenabstand, Block-Spacings, Toolbars) frei wachsen, ohne Focus zu treffen. Konkrete Zeilenabstands-/Spacing-Tokens leben weiterhin in [public/css/tokens/](../../public/css/tokens/) — Werte für Normal können tendenziell dichter werden, Werte für Focus bleiben grosszügig.
- Toolbar/Findings-CSS verlieren ihre `body.focus-mode`-Negierungen (`:not(body.focus-mode) …`) — Normal-Editor lädt die Files, Focus-Karte lädt sie nicht. Cascade-Konflikte fallen weg.
- Synonyme- und Figuren-Lookup-Karten-CSS (heute Editor-übergreifend) wird Mode-unabhängig — sie reagieren nur auf ihren eigenen Cardroot, nicht auf `body.focus-mode`.
- Keine neuen Tokens, kein neuer Card-Akzent, kein neuer Subfolder zwingend nötig. Falls Normal-Editor eigene Spacing-Tokens braucht (z. B. `--editor-normal-line-height`, `--editor-normal-block-gap`), in [public/css/tokens/](../../public/css/tokens/) ergänzen, Focus-Pendant nicht ändern.
- `SHELL_CACHE` in [public/sw.js](../../public/sw.js) bumpen.
- DESIGN.md: kein neuer Pattern-Eintrag; ggf. eine kurze Notiz im Editor-Abschnitt, dass Focus und Normal getrennte Cardroots haben.

## i18n

| Key | DE | EN |
|---|---|---|
| `editor.focus.openedFromPageView` | Fokusmodus | Focus mode |
| `editor.focus.savingOnExit` | Speichere und schliesse Fokus … | Saving and closing focus … |
| `editor.focus.exitConflict` | Fokus konnte nicht sauber gespeichert werden | Focus could not be saved cleanly |
| `editor.notebook.label` *(Platzhalter für künftige Notebook-Features)* | Schreibnotizbuch | Writing notebook |

Genaue Liste während Implementierung; in [public/js/i18n/de.json](../../public/js/i18n/de.json) und `en.json` parallel pflegen.

## DB

n/a — kein Schema-Change.

## Security / Auth

- Page-Save bleibt durch Session-Guard + `requireBookRole` (Editor) abgesichert. Unverändert.
- Lock-Erwerb beider Modi gegen denselben Endpoint; bei Mode-Wechsel kein Lock-Verlust. Edge-Case in „Edge-Cases" dokumentiert.
- Kein neuer `x-html`-Sink. Status-Strings aus i18n in escape-konformer Form (Helper `escHtml` falls dynamisch).
- Kein Rate-Limit nötig (UI-only).

## Telemetrie / Observability

- Bestehender Logger-Tag `[edit|user|book]` bleibt für den Save-Pfad. Save-Event-Log könnte um `source`-Marker erweitert werden, ist aber schon vorhanden (`source: 'main'|'focus'`).
- Plausible-Event: optionaler `focus_enter` aus Page-View vs. aus Normal-Edit unterscheidbar (Property `from`). Nice-to-have, kein MVP.
- Frontend-Usage: Focus-Toggle weiterhin via `/usage/track` mit existierendem Key.

## Tests

| Stufe | Datei | Was wird abgedeckt |
|---|---|---|
| Unit | `tests/unit/editor-modes.test.mjs` (umgeschrieben) | Neue Invariante I1': Focus und Normal gegenseitig exklusiv, Focus kann ohne Normal-Edit aktiv sein |
| Unit | `tests/unit/editor-shared-save.test.mjs` (neu) | `buildSavePayload`, `normalizeForCompare`, `ensureTrailingParagraph` als pure Funktionen |
| Unit | `tests/unit/editor-focus.test.mjs` (Update) | Anpassung der Listener-Setup-Erwartungen an den neuen Cardroot |
| Unit | `tests/unit/focus-granularity.test.mjs` (Update) | Body-Class-Wechsel ggf. → `.focus-editor`-Class-Wechsel |
| Unit | `tests/unit/card-exclusivity.test.mjs` (Update) | Focus-Karte im `EXCLUSIVE_CARDS`-Iter mitprüfen |
| E2E | `tests/e2e/focus-editor.spec.js` (Update) | Direct-Entry aus Page-View, Listener-Cleanup, Save-Source `'focus'`, kein Normal-Editor-DOM während Focus |
| E2E | `tests/e2e/clean-content.spec.js` (Update) | Sicherstellen, dass `cleanContentArtefacts` aus `shared/` weiter beide Modi bedient |
| Manuell | — | Hotkey aus Page-View, aus Normal-Editor, aus anderer Karte (sollte nicht greifen). Mobile-Toggle-Verhalten. Schnelle Wechsel-Cycles. |

## Edge-Cases / Risiken

- **Hotkey aus Normal-Editor**: Normal-Editor muss vor Focus-Entry sauber savennen und Listener teardownen — sonst doppelte `selectionchange`-Handler. Mitigation: Save+Teardown-Helper in `shared/`, einheitlich aufgerufen. Schwere: high.
- **Stale-Snapshot beim Re-Entry**: Wenn der User Page wechselt, während Focus speichert, darf der Save nicht auf der alten Page landen. Mitigation: bestehender Stale-Write-Schutz aus [tests/unit/stale-write.test.mjs](../../tests/unit/stale-write.test.mjs) bleibt und wird auf den Focus-Pfad ausgedehnt. Schwere: high.
- **Listener-Leaks bei schnellem Toggle**: Generation-Counter (`_focusGen`) bleibt im Focus-Modul; analoger Counter im Normal-Editor nötig, falls dort heute keiner existiert. Schwere: med.
- **Snapshot-Wiederaufnahme nach Reload**: Focus-Snapshot in sessionStorage bleibt. Nach Entkopplung muss er auch wieder Focus restoren, ohne Normal-Editor-Detour. Mitigation: Restore-Pfad in `editor-focus-card.js` direkt aus Page-View aktivieren. Schwere: med.
- **Auto-`<p>`-Slot doppelt**: Heute zwei Implementierungen — wird in `shared/auto-slot.js` zusammengeführt. Test-Case: leere Seite, Focus-Enter, Schreibe, Save → kein Duplikat-`<p>`. Schwere: med.
- **Mobile**: heute kein Mobile-Spezial für Focus; bleibt so. Falls Notebook-Features die Mobile-Layouts ändern, bleibt Focus davon unberührt (anderer Cardroot, andere CSS-Datei). Schwere: low.
- **Source-Tagging-Mix**: heute kann ein Edit, der im Normal beginnt und im Focus beendet wird, beide Tags hinterlassen. Nach Entkopplung sauberer Schnitt: Mode-Wechsel = Save + neuer Edit-Zyklus = neue Revision mit eindeutigem `source`. Schwere: low (eigentlich Verbesserung).

## Kritische Dateien (Modify)

| Datei | Änderung |
|---|---|
| [public/js/app/app-state.js](../../public/js/app/app-state.js) | `focusModeState` → `focusState` mit neuen Feldern (`focusActive`, `focusDirty`, `focusSaving`); Trennung von `editorState` |
| [public/js/app/app-view.js](../../public/js/app/app-view.js) | Hotkey-Routing aus Page-View direkt zu Focus; `_closeOtherMainCards` für Focus-Karte; `selectPage` Mode-agnostisch |
| [public/js/editor/edit.js](../../public/js/editor/edit.js) | Reduktion auf Normal-Pfad; alle Focus-Branches entfernen; Imports auf `shared/` umstellen |
| [public/js/editor/focus/card.js](../../public/js/editor/focus/card.js) | Direct-Entry-Pfad aus Page-View; I1-Sequenz entfernt; eigener Container statt Normal-Editor-Container |
| [public/js/editor/focus/trampoline.js](../../public/js/editor/focus/trampoline.js) | Auf `enter`/`exit` reduzieren; `toggle`/`start-edit` entfernen |
| [public/js/cards/editor-focus-card.js](../../public/js/cards/editor-focus-card.js) | Cardroot wird selbst Editor-Container; Counter-Setup intern |
| [public/js/cards/editor-toolbar-card.js](../../public/js/cards/editor-toolbar-card.js) | `if (app.focusMode)`-Guards entfernen; Normal-only |
| [public/js/cards/editor-figur-lookup-card.js](../../public/js/cards/editor-figur-lookup-card.js) | Mode-agnostisch via `getActiveEditorContainer()` aus `shared/`; bleibt in beiden Modi verfügbar |
| [public/js/cards/editor-synonyme-card.js](../../public/js/cards/editor-synonyme-card.js) | dito; bleibt in beiden Modi verfügbar |
| [public/js/cards/editor-find-card.js](../../public/js/cards/editor-find-card.js) | `if (app.focusMode)`-Guards entfernen; Normal-only |
| [public/js/cards/feature-registry.js](../../public/js/cards/feature-registry.js) | `EXCLUSIVE_CARDS`-Eintrag für Focus prüfen/ergänzen |
| [public/css/editor/focus-mode.css](../../public/css/editor/focus-mode.css) | `body.focus-mode` → `.focus-editor`-Cardroot; alle `:not(body.focus-mode)`-Negierungen in den Normal-Editor-CSS-Files entfernen |
| [public/index.html](../../public/index.html) | neuer Partial-Placeholder für `editor-focus.html`; Hotkey-Body-Listener-Routing aktualisieren |
| [public/sw.js](../../public/sw.js) | `SHELL_CACHE` bump |
| [public/js/i18n/de.json](../../public/js/i18n/de.json) | neue Keys |
| [public/js/i18n/en.json](../../public/js/i18n/en.json) | neue Keys |
| [docs/focus-editor.md](../focus-editor.md) | Invarianten neu fassen; I1 ersetzen; State-Machine-Diagramm anpassen |
| [docs/state-modell.md](../state-modell.md) | Slice-Liste um `focusState` aktualisieren; Editor-Modi-Sektion neu beschreiben |
| [CLAUDE.md](../../CLAUDE.md) | Editor-Abschnitt prüfen (wahrscheinlich keine Änderung nötig; Trampoline-Hinweis evtl. präzisieren) |
| [tests/unit/editor-modes.test.mjs](../../tests/unit/editor-modes.test.mjs) | Komplett neu für I1' |
| [tests/unit/editor-focus.test.mjs](../../tests/unit/editor-focus.test.mjs) | Pfad-Updates |
| [tests/unit/focus-granularity.test.mjs](../../tests/unit/focus-granularity.test.mjs) | Class-Selector-Updates |
| [tests/e2e/focus-editor.spec.js](../../tests/e2e/focus-editor.spec.js) | Direct-Entry-Pfad |

## Kritische Dateien (Create)

| Datei | Zweck |
|---|---|
| `public/js/editor/shared/html-clean.js` | Re-Export/Bündelung der Cleaner-Kette |
| `public/js/editor/shared/save-pipeline.js` | `buildSavePayload` + pure Helpers |
| `public/js/editor/shared/auto-slot.js` | `ensureTrailingParagraph` + Cleanup |
| `public/js/editor/shared/page-api.js` | Page-Save-Wrapper |
| `public/js/editor/shared/edit-counter.js` | Per-Container-Counter |
| `public/js/editor/shared/active-editor.js` | `getActiveEditorContainer()` + `getActiveEditorMode()` für mode-agnostische Subs |
| `public/js/editor/shared/shortcuts.js` | Inline-Formatting-Shortcuts mit `allowedCommands`-Whitelist |
| `public/partials/editor-focus.html` | Focus-Cardroot mit eigenem contenteditable, eingebundene Synonyme- + Figuren-Lookup-Karten |
| `tests/unit/editor-shared-save.test.mjs` | Unit-Tests für `shared/` |
| `tests/unit/editor-shared-shortcuts.test.mjs` | Unit-Tests für Whitelist-Verhalten der Shortcut-Bindings |

## Offene Fragen

- **Shortcut-Whitelist im Focus**: User möchte „minimale Formatierung mit Shortcuts". Vorschlag MVP: Cmd/Ctrl+B (Bold), Cmd/Ctrl+I (Italic), Cmd/Ctrl+U (Unterstrichen). Sollen zusätzlich H1/H2/H3 (Cmd+Alt+1/2/3), Listen (Cmd+Shift+7/8), Blockquote, Code-Inline mit rein? Was ist ausdrücklich verboten?
- **Shortcut-Set im Normal-Editor**: bekommt der Normal-Editor künftig dieselben Shortcuts plus weitere (z. B. Listen-Toggles, Heading-Cycle), oder bleibt Toolbar dort die Primär-Geste?
- **Text-Metrik im Normal-Editor**: konkrete Ziel-Zeilenhöhe und Block-Spacings? Soll der Normal-Editor weiterhin im selben Lesemodus-Layout (Spaltenbreite, Padding) sein wie heute, nur dichter, oder grundsätzlich anders strukturiert?
- **Lock-Modell beim Mode-Wechsel**: ein Lock pro Page-Session über beide Modi hinweg, oder pro Edit-Zyklus neu? Heutige Implementierung in [routes/book-editor.js](../../routes/book-editor.js) und Lock-Logik prüfen, bevor die Save+Release-Sequenz im `shared/page-api.js` final wird.
- **Hotkey aus dem Normal-Editor**: schliesst Normal-Editor oder lässt ihn stehen (zweiter Tab-/Pane-Style)? Dieser Plan unterstellt „schliessen". Bestätigen.
- **Quick-Save-Frequenz**: bleibt Focus-Autosave (heute über `_scheduleDraftSave`/`_flushDraftSaveNow`) im selben Intervall wie Normal-Editor, oder konservativer (weniger Revisionen pro Session)?
- **Counter-Anzeige**: nur im Focus, oder auch im Normal-Editor als Notebook-Feature? Falls auch im Normal: `installEditCounter` aus `shared/` muss zwei parallele Anzeigen unterstützen können.
- **Snapshot-Restore** (`focus.snapshot` in sessionStorage): Mechanismus bleibt erhalten — Restore aus Page-View triggern, ohne dass der Normal-Editor je gemountet wird. Spec/Test-Pfad festlegen.
- **Offline-Save im Focus**: heute existiert `saveOffline` im Normal-Editor — wird der Focus an dieselbe Offline-Queue angeschlossen, oder bekommt er eine eigene? MVP: gemeinsame Queue über `shared/page-api.js`. Bestätigen.
- **`EXCLUSIVE_CARDS`-Pattern**: reicht das aktuelle Pattern, um Focus und Normal-Editor wirklich gegenseitig exklusiv zu halten, wenn beide Cardroots existieren (Editor lebt heute teilweise im Root, nicht als Karte)? Eventuell muss die Exklusivitätslogik um „Editor-Modes" erweitert werden.
- **DESIGN.md**: kommt der Notebook-Charakter des Normal-Editors als eigener Pattern-Eintrag rein, sobald Phase 2 startet?
