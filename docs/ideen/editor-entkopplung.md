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

### Bekannte Bugs im aktuellen Focus-Editor (müssen mit Refactor behoben sein)

- **Scroll funktioniert nicht** — Typewriter-Scroll/Recenter greift nicht mehr; Caret läuft aus dem Viewport, Wheel-/Touch-Scroll wirkt blockiert. Ursache vermutlich Body-Class-`body.focus-mode`-Scroll-Lock oder Recenter-Pipeline-Generation-Mismatch. Nach Refactor (Cardroot-Scope statt Body-Class) muss Scrollen wieder zuverlässig laufen — inkl. Burst-Input + RAF-Debounce.
- **Highlighting/Hervorhebung funktioniert nicht** — Granularitäten (`paragraph`/`sentence`/`window-3`/`typewriter-only`) rendern keine Hervorhebung mehr; CSS-Selektoren matchen vermutlich nicht den aktuellen DOM (Body-Class vs. Cardroot vs. CSS Custom Highlight API). Nach Refactor müssen alle vier Granularitäten live sichtbar sein und auf Settings-Wechsel reagieren.

Beide Bugs sind primäre Treiber für die Entkopplung — der heutige Body-Class-Scope ist instabil, der Refactor verschiebt alle Focus-Styles auf `.focus-editor`-Cardroot und macht Scroll + Highlight wieder deterministisch testbar.

## Scope MVP

- Eigener Alpine-State-Slice für den Focus-Modus (`focusState`), losgelöst von `editorState`. Kein gemeinsames `editMode`-Flag mehr.
- Focus startet aus dem Page-View ohne Detour über den Normal-Editor. **Entry-Pfade aus Page-View: ausschliesslich Hotkey `Cmd/Ctrl+Shift+E` + Focus-Button im Page-View-Header**. Kein Palette-Eintrag, keine Quick-Pill, kein Sidebar-Trigger. Aus dem Normal-Editor heraus startet Focus per Hotkey, schliesst den Normal-Editor sauber.
- Eigener contenteditable-Container im Focus (gemountet in der Focus-Karte selbst, nicht der Normal-Editor-Container). Snapshot beim Eintritt, Save zurück über die Page-Save-API beim Austritt oder per Quick-Save.
- **Focus-Feature-Set (fix)**: Typewriter-Scroll inkl. Granularitäten (Highlight-Feature aus User-Settings: `paragraph` / `sentence` / `window-3` / `typewriter-only`), Counter (Words/Chars + Tagesdelta), Synonyme, Figuren-Lookup, Save/Quick-Save mit Offline-Fähigkeit, Snapshot-Restore nach Reload, Inline-Formatierung **ausschliesslich Bold/Italic/Unterstrichen** per Shortcut (`Cmd/Ctrl+B/I/U`). Kein Toolbar-UI, kein Bubble-Menü, keine Lektorat-Findings, keine Page-History, keine Find/Replace im Focus.
- **Highlight-Granularität bleibt Focus-only**: in [public/partials/user-settings.html](../../public/partials/user-settings.html#L108-L114) wird `userSettingsFocusGranularity` weiter über die Combobox gesetzt; gespeichert in [public/js/user-settings.js](../../public/js/user-settings.js) als `focus_granularity` und live in `window.__app.focusGranularity` gespiegelt. Nach Entkopplung: Setting wirkt ausschliesslich auf Focus-Karte (Live-`$watch`), keinerlei Effekt auf Normal-Editor.
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
- **Scroll funktioniert im Focus durchgängig**: Wheel, Touch, Arrow-Keys, Page-Up/Down, Caret-getriebenes Recenter laufen ohne Hänger; Typewriter-Scroll hält die Caret-Position deterministisch in der gewählten Mittelband-Zone. Burst-Input (schnelles Tippen) führt zu keinem Scroll-Lock.
- **Highlighting funktioniert im Focus für alle vier Granularitäten**: Sichtprüfung pro Granularität, dass die jeweilige Hervorhebung am Cardroot rendert und beim Caret-/Selection-Wechsel mitwandert. `sentence` via CSS Custom Highlight API, `paragraph`/`window-3` via Klassen am Block-Element, `typewriter-only` ohne Hervorhebung (nur Scroll-Mittelband sichtbar).
- Im Focus lassen sich Synonyme (Trigger wie heute) und Figuren-Lookup (Trigger wie heute) wie gewohnt aufrufen und schliessen — keine Funktionalität gegenüber heute verloren.
- Im Focus funktionieren exakt **Cmd/Ctrl+B**, **Cmd/Ctrl+I** und **Cmd/Ctrl+U** am Selektionsbereich. Weitere Inline-Shortcuts sind blockiert / no-op.
- Quick-Save aus dem Focus erzeugt eine Revision mit `source = 'focus'`; aus dem Normal-Editor `source = 'main'`. Keine `'main+focus'`-Mix-Revisionen mehr.
- Offline-Pfad: Focus und Normal-Editor speichern bei fehlender Verbindung in **dieselbe** Offline-Queue über `shared/page-api.js`. Snapshot-Restore funktioniert nach Reload weiterhin, ohne den Normal-Editor zwischendurch zu mounten.
- Normal-Editor rendert nach Merge **ohne** die heutigen Schreibmodus-Layout-Constraints (Spaltenbreite, Padding, opinionated Zeilenhöhe). Sichtprüfung: Normal-Text wirkt dichter und freier; Tagebuch-/Blog-Optik möglich.
- Änderungen am Normal-Editor-CSS schlagen nicht auf den Focus durch (Sichtprüfung: Toggle Normal-CSS aus → Focus-Layout unverändert).
- Bei aktivem Focus klick auf eine andere Seite → Focus speichert + schliesst sauber, neue Seite öffnet im Page-View.
- **Getrennte Test-Suiten mit hoher Abdeckung**: Schreiben ist Kernfeature → beide Editoren bekommen je eine eigene, **hauptfeature-vollständige** Test-Suite (Unit + E2E). Quality-Gate: jedes im Scope-MVP genannte Feature pro Editor hat mindestens einen positiven Testfall, kritische Pfade (Save, Dirty-Detection, Listener-Cleanup, Offline) zusätzlich einen Negativ-/Edge-Case-Test. Cross-Mode-Verhalten (Hotkey-Wechsel, gegenseitige Exklusivität) hat eigenen Test-File. Alte `tests/unit/editor-modes.test.mjs` ist neu geschrieben und besteht; alte I1-Assertions entfernt.
- **Highlight-Granularität getestet**: Settings-Wechsel `paragraph` → `sentence` → `window-3` → `typewriter-only` während aktivem Focus aktualisiert Focus-Render live. Im Normal-Editor sichtbar: kein Effekt, keine Klasse, kein DOM-Change.
- Bei deaktivierter Focus-Karte (hypothetisch): Normal-Editor läuft komplett ohne Focus-Code-Import, keine ReferenceErrors. Umgekehrt: Bei isoliertem Focus-Mount läuft Focus ohne Normal-Editor-Code, keine ReferenceErrors.

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

- [public/partials/editor.html](../../public/partials/editor.html) → umbenannt nach `editor-notebook.html` (Normal-Editor-Partial = Notebook-Cardroot). Alle Focus-Conditionals entfernt. Bindet weiterhin Synonyme- und Figuren-Lookup-Karten ein. **Focus-Button** (heute in editor.html Z.132) wandert raus.
- [public/partials/editor-body-view.html](../../public/partials/editor-body-view.html) (Update) — Page-View-Anzeige bekommt im Header zwei Buttons: Edit-Button (öffnet Normal-Editor) und **Focus-Button** (öffnet Focus direkt). Hotkey `Cmd/Ctrl+Shift+E` bleibt global im Body und routet via `handleFocusHotkey` zum selben Entry-Pfad wie der Button.
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
- `shared/shortcuts.js` — `bindInlineFormattingShortcuts(container, { allowedCommands })`. Pure Bindings; `allowedCommands`-Whitelist pro Modus. MVP: Focus erlaubt **ausschliesslich** `['bold', 'italic', 'underline']`. Normal-Editor reicht den gleichen Whitelist-Set durch (Toolbar bleibt dort die Primär-Geste); erweiterte Commands erst in Phase 2.

### Notebook-Subfolder `public/js/editor/notebook/` (neu, Pendant zu `focus/`)

Normal-Editor = künftiges „Notizbuch". Bekommt eigenen Subfolder, parallel zu `focus/`. Alles Notebook-Spezifische zieht dort ein; Quer-Subs (Synonyme, Figuren-Lookup) bleiben in `cards/` mode-agnostisch.

- `notebook/card.js` — Sub-Komponente-Methoden des Normal-Editors (Mount, startEdit/saveEdit/cancelEdit, Auto-Save-Timer, Lock-Erwerb, Listener-Cleanup, Generation-Counter `_notebookGen`).
- `notebook/edit.js` — Edit-Methoden (Selection, DOM-Manipulation, Dirty-Check für Normal-Form). Ersatz für heutiges [public/js/editor/edit.js](../../public/js/editor/edit.js).
- `notebook/toolbar.js` — Toolbar-Bindings + Button-Handler (B/I/U + Phase-2-Wachstumsfläche für Link, Heading, List, Quote).
- `notebook/storage.js` — sessionStorage-Snapshot `normal.snapshot` (Pendant zu `focus/storage.js`), TTL 1 h.
- `notebook/trampoline.js` — Root ↔ Notebook-Card-Events (`editor:notebook:{enter,exit}`), falls Trampoline-Pattern hier nötig.
- `notebook/index.js` — Facade, re-exportiert alle Notebook-Methods für die Card-Registrierung in [public/js/cards/editor-notebook-card.js](../../public/js/cards/editor-notebook-card.js) (Rename aus heutigem editor-Code-Pfad).

`public/js/editor/focus/` bleibt strukturell wie heute (state-machine, recenter-pipeline, dom-blocks, sentence, typewriter, storage, card, trampoline) und konsumiert `shared/`. Beide Subfolder ziehen **alle** gemeinsamen Pipeline-Aufrufe ausschliesslich aus `shared/`; kein Cross-Import `notebook/` ↔ `focus/`.

Datei-Limit pro Modul wie üblich (>600 LOC → splitten). `notebook/edit.js` darf nicht zur Sammeldatei werden — bei Wachstum (Phase 2: Link-Dialog, Margin-Notes, Sidebars) sofort thematisch in eigene Files unter `notebook/` ziehen.

## CSS

- **Focus-CSS-Subfolder** [public/css/editor/focus/](../../public/css/editor/) (neu, falls noch nicht existent): `focus-mode.css` zieht hier rein, weitere Focus-spezifische Files (z. B. Granularitäten-Highlight pro File) kommen hinzu. Scope durchgängig `.focus-editor`-Cardroot statt `body.focus-mode`. Body-Class-Schaltung bleibt nur für globale Layout-Effekte (overflow-anchor, scroll-Locks), für reine Editor-Styles entfällt sie.
- **Notebook-CSS-Subfolder** [public/css/editor/notebook/](../../public/css/editor/) (neu): alle Normal-Editor-Styles (Cardroot `.notebook-editor`), inklusive Toolbar-, Findings-, Find-, Page-History-Styles. Heutige opinionated Schreibmodus-Text-Metrik-Regeln (max-width-Spaltenbreite, grosszügiges Padding, hoher Zeilenabstand, serifenbetonte Schrift falls vorhanden) werden im Notebook **entfernt** — Notebook rendert dichter (default Zeilenhöhe, normales Padding, normale Block-Spacings, Tagebuch-/Blog-Optik). Wachstumsfläche für Phase-2-Notebook-Features (Sidebars, Margin-Notes) lebt hier.
- Toolbar/Findings-CSS verlieren ihre `body.focus-mode`-Negierungen (`:not(body.focus-mode) …`) — Notebook-Karte lädt die Files, Focus-Karte lädt sie nicht. Cascade-Konflikte fallen weg.
- Synonyme- und Figuren-Lookup-Karten-CSS (heute Editor-übergreifend) wird Mode-unabhängig — sie reagieren nur auf ihren eigenen Cardroot, nicht auf `body.focus-mode`.
- Keine neuen Tokens zwingend. Falls Phase 2 für den Normal-Editor eigene Spacing-Tokens braucht, in [public/css/tokens/](../../public/css/tokens/) ergänzen.
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

Schreiben ist Kernfeature → Quality-Gate **hohe Testabdeckung** für beide Editoren. Eigene Test-Suiten pro Use-Case, gemeinsame Tests nur für Shared-Lib und Cross-Mode-Verhalten.

### Hauptfeature-Inventar Normal-Editor (alle abgedeckt)

| Feature | Unit | E2E |
|---|---|---|
| Edit-Mode öffnen (startEdit) | ja | ja |
| Save (saveEdit) inkl. Server-Roundtrip | ja | ja |
| Quick-Save (Auto-Save während Edit) | ja | ja |
| Cancel ohne Save (cancelEdit) | ja | ja |
| Dirty-Check + `normalizeForCompare` | ja | — |
| Auto-`<p>`-Slot bei leerer Seite | ja | ja |
| Toolbar-Bindings (alle Toolbar-Buttons) | ja | ja |
| Synonyme-Trigger + Apply | — | ja |
| Figuren-Lookup-Trigger + Apply | — | ja |
| Find/Replace-Karte | — | ja |
| Lektorat-Findings-Anzeige + Apply | — | ja |
| Page-History-Karte | — | ja |
| Offline-Save (Queue-Pfad) | ja | ja |
| Stale-Write-Schutz | ja | — |
| Lock-Erwerb / Release | ja | ja |
| Listener-Cleanup nach Exit | ja | ja |
| Save-Source = `'main'` in Revision | — | ja |
| Sichtprüfung: kein Focus-Layout-Constraint | — | manuell |

### Hauptfeature-Inventar Focus-Editor (alle abgedeckt)

| Feature | Unit | E2E |
|---|---|---|
| Direct-Entry aus Page-View per Hotkey | ja | ja |
| Entry aus Normal-Editor (Normal schliesst sauber) | ja | ja |
| State-Machine (idle/entering/active/exiting + Re-Entry-Guard) | ja | — |
| Typewriter-Scroll | ja | ja |
| Scrollen (Wheel/Touch/Arrow/PageUp-Down) ohne Lock | ja | ja |
| Burst-Input ohne Scroll-Hänger | ja | ja |
| Highlight-Render am `.focus-editor`-Cardroot sichtbar | ja | ja |
| Highlight-Granularität `paragraph` | ja | ja |
| Highlight-Granularität `sentence` (CSS Custom Highlight) | ja | ja |
| Highlight-Granularität `window-3` | ja | ja |
| Highlight-Granularität `typewriter-only` | ja | ja |
| Live-Wechsel der Granularität via User-Settings (`$watch`) | ja | ja |
| Counter Words/Chars (Live + Tagesdelta) | ja | ja |
| Synonyme-Trigger + Apply im Focus | — | ja |
| Figuren-Lookup-Trigger + Apply im Focus | — | ja |
| Inline-Shortcut `bold` (Cmd/Ctrl+B) | ja | ja |
| Inline-Shortcut `italic` (Cmd/Ctrl+I) | ja | ja |
| Inline-Shortcut `underline` (Cmd/Ctrl+U) | ja | ja |
| Andere Shortcuts blockiert (no-op) | ja | — |
| Save + Quick-Save im Focus | ja | ja |
| Offline-Save (gemeinsame Queue) | ja | ja |
| Snapshot-Restore nach Reload | ja | ja |
| Save-Source = `'focus'` in Revision | — | ja |
| Recenter-Pipeline (RAF-Debounce, Burst-Input) | ja | ja |
| Listener-Cleanup nach Exit (Generation-Counter) | ja | ja |
| Auto-`<p>`-Slot via `shared/auto-slot.js` | ja | ja |
| Stale-Write-Schutz | ja | — |
| Mobile-Toggle-Verhalten | — | manuell |

### Test-Dateien

| Stufe | Datei | Was wird abgedeckt |
|---|---|---|
| Unit | `tests/unit/editor-normal.test.mjs` (neu) | Normal-Editor isoliert; alle Normal-Hauptfeatures mit Unit-Marker oben |
| Unit | `tests/unit/editor-focus.test.mjs` (Update) | Focus-Editor isoliert; State-Machine, Listener-Setup im neuen Cardroot, RAF-Recenter, Snapshot-Restore — ohne Normal-Editor-Mount |
| Unit | `tests/unit/focus-granularity.test.mjs` (Update) | Alle vier Granularitäten, Live-Wechsel via `$watch`, Class/Highlight-Switching auf `.focus-editor`-Cardroot |
| Unit | `tests/unit/focus-user-settings.test.mjs` (neu) | User-Settings `focus_granularity` Load/Save, Spiegelung in `window.__app.focusGranularity`, Effekt auf Focus + No-Op im Normal |
| Unit | `tests/unit/editor-modes.test.mjs` (umgeschrieben) | **Cross-Mode**: Invariante I1' (gegenseitige Exklusivität), Hotkey-Wechsel Normal ↔ Focus, Save+Lock-Release-Sequenz beim Wechsel |
| Unit | `tests/unit/editor-shared-save.test.mjs` (neu) | `buildSavePayload`, `normalizeForCompare`, `ensureTrailingParagraph`, Offline-Queue-Hook als pure Funktionen |
| Unit | `tests/unit/editor-shared-shortcuts.test.mjs` (neu) | Whitelist-Verhalten: nur `bold`/`italic`/`underline` durchgelassen, alles andere no-op |
| Unit | `tests/unit/card-exclusivity.test.mjs` (Update) | Focus-Karte im `EXCLUSIVE_CARDS`-Iter mitprüfen |
| E2E | `tests/e2e/editor-normal.spec.js` (neu) | Normal-Editor-Flow vollständig; alle Normal-Hauptfeatures mit E2E-Marker oben |
| E2E | `tests/e2e/focus-editor.spec.js` (Update) | Focus-Flow vollständig; alle Focus-Hauptfeatures mit E2E-Marker oben (Direct-Entry, alle 4 Granularitäten, B/I/U, Synonyme, Figuren-Lookup, Offline, Snapshot-Restore) |
| E2E | `tests/e2e/editor-modes.spec.js` (neu) | **Cross-Mode-E2E**: Hotkey-Wechsel Normal ↔ Focus, mehrere Cycles, keine Listener-Leaks, korrekte Save-Sources, gegenseitige Exklusivität |
| E2E | `tests/e2e/clean-content.spec.js` (Update) | `cleanContentArtefacts` aus `shared/` bedient weiter beide Modi |
| Manuell | — | Sichtprüfung: Normal-Editor-Layout ohne Schreibmodus-Constraints (dichter Tagebuch-/Blog-Look). Sichtprüfung: Focus-Layout unverändert vor/nach Refactor. Mobile-Toggle. |

Quality-Gate vor Merge: alle Unit-/Integration-/E2E-Tests grün; Coverage-Kontrolle visuell anhand der Hauptfeature-Inventare (jede Zeile mit „ja" hat im genannten File einen entsprechenden Test).

## Edge-Cases / Risiken

- **Hotkey aus Normal-Editor**: Normal-Editor muss vor Focus-Entry sauber savennen und Listener teardownen — sonst doppelte `selectionchange`-Handler. Mitigation: Save+Teardown-Helper in `shared/`, einheitlich aufgerufen. Schwere: high.
- **Stale-Snapshot beim Re-Entry**: Wenn der User Page wechselt, während Focus speichert, darf der Save nicht auf der alten Page landen. Mitigation: bestehender Stale-Write-Schutz aus [tests/unit/stale-write.test.mjs](../../tests/unit/stale-write.test.mjs) bleibt und wird auf den Focus-Pfad ausgedehnt. Schwere: high.
- **Listener-Leaks bei schnellem Toggle**: Generation-Counter (`_focusGen`) bleibt im Focus-Modul; analoger Counter im Normal-Editor nötig, falls dort heute keiner existiert. Schwere: med.
- **Scroll-Lock-Regression (aktueller Bug)**: heute hängt der Scroll im Focus. Verdacht: `body.focus-mode` setzt `overflow-anchor`/`overflow:hidden` oder Recenter-Pipeline triggert in altem Generation-Slot. Mitigation: Body-Class entfällt, Scope wandert auf `.focus-editor`-Cardroot; Recenter-Pipeline läuft strikt gegen aktuelle Generation. E2E-Pflicht: Scroll-Smoke (Wheel + Burst-Tippen) im Focus-Spec. Schwere: high (Kernfeature broken).
- **Highlight-Selektor-Mismatch (aktueller Bug)**: heute matchen die Granularitäten-Selektoren teilweise auf Body-Class-Scope, der nach Cardroot-Wechsel nicht mehr greift. Mitigation: alle Granularitäten-Styles in `focus-mode.css` auf `.focus-editor`-Cardroot umstellen; Klassen werden am Block-Element gesetzt, CSS-Custom-Highlight-Register läuft pro Cardroot. E2E-Pflicht: alle vier Granularitäten visuell verifiziert. Schwere: high.
- **Snapshot-Wiederaufnahme nach Reload**: Focus-Snapshot in sessionStorage bleibt. Nach Entkopplung muss er auch wieder Focus restoren, ohne Normal-Editor-Detour. Mitigation: Restore-Pfad in `editor-focus-card.js` direkt aus Page-View aktivieren. Schwere: med.
- **Auto-`<p>`-Slot doppelt**: Heute zwei Implementierungen — wird in `shared/auto-slot.js` zusammengeführt. Test-Case: leere Seite, Focus-Enter, Schreibe, Save → kein Duplikat-`<p>`. Schwere: med.
- **Mobile**: heute kein Mobile-Spezial für Focus; bleibt so. Falls Notebook-Features die Mobile-Layouts ändern, bleibt Focus davon unberührt (anderer Cardroot, andere CSS-Datei). Schwere: low.
- **Source-Tagging-Mix**: heute kann ein Edit, der im Normal beginnt und im Focus beendet wird, beide Tags hinterlassen. Nach Entkopplung sauberer Schnitt: Mode-Wechsel = Save + neuer Edit-Zyklus = neue Revision mit eindeutigem `source`. Schwere: low (eigentlich Verbesserung).

## Kritische Dateien (Modify)

| Datei | Änderung |
|---|---|
| [public/js/app/app-state.js](../../public/js/app/app-state.js) | `focusModeState` → `focusState` mit neuen Feldern (`focusActive`, `focusDirty`, `focusSaving`); Trennung von `editorState` |
| [public/js/app/app-view.js](../../public/js/app/app-view.js) | Hotkey-Routing aus Page-View direkt zu Focus; `_closeOtherMainCards` für Focus-Karte; `selectPage` Mode-agnostisch |
| [public/js/editor/edit.js](../../public/js/editor/edit.js) | Move nach `public/js/editor/notebook/edit.js`; Reduktion auf Notebook-Pfad; alle Focus-Branches entfernen; Imports auf `shared/` umstellen |
| [public/js/editor/focus/card.js](../../public/js/editor/focus/card.js) | Direct-Entry-Pfad aus Page-View; I1-Sequenz entfernt; eigener Container statt Normal-Editor-Container |
| [public/js/editor/focus/trampoline.js](../../public/js/editor/focus/trampoline.js) | Auf `enter`/`exit` reduzieren; `toggle`/`start-edit` entfernen |
| [public/js/cards/editor-focus-card.js](../../public/js/cards/editor-focus-card.js) | Cardroot wird selbst Editor-Container; Counter-Setup intern |
| [public/js/cards/editor-toolbar-card.js](../../public/js/cards/editor-toolbar-card.js) | `if (app.focusMode)`-Guards entfernen; Notebook-only; importiert aus `editor/notebook/toolbar.js` |
| [public/js/cards/editor-figur-lookup-card.js](../../public/js/cards/editor-figur-lookup-card.js) | Mode-agnostisch via `getActiveEditorContainer()` aus `shared/`; bleibt in beiden Modi verfügbar |
| [public/js/cards/editor-synonyme-card.js](../../public/js/cards/editor-synonyme-card.js) | dito; bleibt in beiden Modi verfügbar |
| [public/js/cards/editor-find-card.js](../../public/js/cards/editor-find-card.js) | `if (app.focusMode)`-Guards entfernen; Notebook-only |
| [public/js/cards/feature-registry.js](../../public/js/cards/feature-registry.js) | `EXCLUSIVE_CARDS`-Eintrag für Focus prüfen/ergänzen |
| [public/css/editor/focus-mode.css](../../public/css/editor/focus-mode.css) | Move nach `public/css/editor/focus/focus-mode.css`; `body.focus-mode` → `.focus-editor`-Cardroot; alle `:not(body.focus-mode)`-Negierungen in den Notebook-CSS-Files entfernen |
| `public/css/editor/*.css` (übrige Editor-Files) | Move nach `public/css/editor/notebook/`; Scope auf `.notebook-editor`-Cardroot; Schreibmodus-Text-Metrik-Constraints entfernen |
| [public/index.html](../../public/index.html) | Partial-Placeholder für `editor-focus.html` neu, `editor.html` umbenennen auf `editor-notebook.html`; neue CSS-`<link>`-Liste für `editor/focus/` + `editor/notebook/`-Subfolder; Hotkey-Body-Listener-Routing aktualisieren |
| [public/partials/editor-body-view.html](../../public/partials/editor-body-view.html) | Header bekommt Focus-Button neben Edit-Button (gemeinsamer Entry aus Page-View) |
| [public/sw.js](../../public/sw.js) | `SHELL_CACHE` bump |
| [public/js/i18n/de.json](../../public/js/i18n/de.json) | neue Keys |
| [public/js/i18n/en.json](../../public/js/i18n/en.json) | neue Keys |
| [docs/focus-editor.md](../focus-editor.md) | Invarianten neu fassen; I1 ersetzen; State-Machine-Diagramm anpassen |
| [docs/state-modell.md](../state-modell.md) | Slice-Liste um `focusState` aktualisieren; Editor-Modi-Sektion neu beschreiben |
| [CLAUDE.md](../../CLAUDE.md) | Editor-Abschnitt prüfen (wahrscheinlich keine Änderung nötig; Trampoline-Hinweis evtl. präzisieren) |
| [tests/unit/editor-modes.test.mjs](../../tests/unit/editor-modes.test.mjs) | Komplett neu für I1' + Cross-Mode |
| [tests/unit/editor-focus.test.mjs](../../tests/unit/editor-focus.test.mjs) | Pfad-Updates + Hauptfeature-Inventar vollständig |
| [tests/unit/focus-granularity.test.mjs](../../tests/unit/focus-granularity.test.mjs) | Class-Selector-Updates + alle 4 Granularitäten + Live-Wechsel via `$watch` |
| [tests/e2e/focus-editor.spec.js](../../tests/e2e/focus-editor.spec.js) | Direct-Entry-Pfad + Hauptfeature-Inventar vollständig (alle 4 Granularitäten, B/I/U, Synonyme, Figuren-Lookup, Offline, Snapshot-Restore) |
| [public/js/user-settings.js](../../public/js/user-settings.js) | Verifikation: `focus_granularity` Load/Save bleibt unverändert; Spiegelung in `window.__app.focusGranularity` führt zu Live-`$watch` in der Focus-Karte |
| [public/js/cards/user-settings-card.js](../../public/js/cards/user-settings-card.js) | Verifikation: `userSettingsFocusGranularity` + `userSettingsFocusOptions()` bleiben funktional, Combobox in `user-settings.html` weiter wirksam |

## Kritische Dateien (Create)

| Datei | Zweck |
|---|---|
| `public/js/editor/shared/html-clean.js` | Re-Export/Bündelung der Cleaner-Kette |
| `public/js/editor/shared/save-pipeline.js` | `buildSavePayload` + pure Helpers |
| `public/js/editor/shared/auto-slot.js` | `ensureTrailingParagraph` + Cleanup |
| `public/js/editor/shared/page-api.js` | Page-Save-Wrapper |
| `public/js/editor/shared/edit-counter.js` | Per-Container-Counter |
| `public/js/editor/shared/active-editor.js` | `getActiveEditorContainer()` + `getActiveEditorMode()` für mode-agnostische Subs |
| `public/js/editor/shared/shortcuts.js` | Inline-Formatting-Shortcuts mit `allowedCommands`-Whitelist (`['bold','italic','underline']` im MVP) |
| `public/js/editor/notebook/card.js` | Notebook-Card-Methods (Mount, startEdit/saveEdit/cancelEdit, Auto-Save-Timer, Lock, Listener-Cleanup, `_notebookGen`) |
| `public/js/editor/notebook/edit.js` | Edit-Methoden (Selection, DOM-Manipulation, Dirty-Check). Move-Target aus `public/js/editor/edit.js` |
| `public/js/editor/notebook/toolbar.js` | Toolbar-Bindings, Button-Handler, Wachstumsfläche für Phase-2-Buttons |
| `public/js/editor/notebook/storage.js` | sessionStorage-Snapshot `normal.snapshot`, TTL 1 h |
| `public/js/editor/notebook/trampoline.js` | Root ↔ Notebook-Card-Events `editor:notebook:{enter,exit}` |
| `public/js/editor/notebook/index.js` | Facade, re-exportiert Notebook-Methods für Card-Registrierung |
| `public/js/editor/focus/` (falls Files heute flach unter `editor/` liegen) | Subfolder-Aufbau verifizieren; alle Focus-spezifischen Module hier sammeln |
| `public/css/editor/focus/` | CSS-Subfolder; nimmt `focus-mode.css` + künftige Granularitäten-Splits auf |
| `public/css/editor/notebook/` | CSS-Subfolder; nimmt alle Notebook-Styles auf (Toolbar, Findings, Find, Page-History, Body-Layout dichter) |
| `public/partials/editor-notebook.html` | Rename-Target aus `editor.html`; Notebook-Cardroot |
| `public/partials/editor-focus.html` | Focus-Cardroot mit eigenem contenteditable, eingebundene Synonyme- + Figuren-Lookup-Karten |
| `tests/unit/editor-normal.test.mjs` | Unit-Tests Normal-Editor isoliert; Hauptfeature-Inventar vollständig |
| `tests/unit/editor-shared-save.test.mjs` | Unit-Tests für `shared/save-pipeline.js` + `auto-slot.js` + `html-clean.js` |
| `tests/unit/editor-shared-shortcuts.test.mjs` | Unit-Tests für Whitelist-Verhalten der Shortcut-Bindings |
| `tests/unit/focus-user-settings.test.mjs` | Unit-Tests User-Settings ↔ Focus-Granularität (Load/Save, Spiegelung, Live-Effekt nur im Focus) |
| `tests/e2e/editor-normal.spec.js` | E2E Normal-Editor isoliert; Hauptfeature-Inventar vollständig |
| `tests/e2e/editor-modes.spec.js` | E2E Cross-Mode-Verhalten |

## Entscheidungen (geklärt 2026-05-20)

- **Shortcut-Whitelist Focus**: ausschliesslich `bold`, `italic`, `underline` (Cmd/Ctrl+B/I/U). Andere Shortcuts no-op.
- **Shortcut-Set Normal-Editor**: bleibt wie heute. Toolbar ist Primär-Geste; keine Erweiterung über die Focus-Whitelist hinaus im MVP. Phase 2 kann mehr.
- **Text-Metrik Normal-Editor**: heutige Schreibmodus-Constraints (Spaltenbreite/Padding/grosszügige Zeilenhöhe) werden deaktiviert. Normal-Editor rendert dichter, Tagebuch-/Blog-Optik.
- **Hotkey aus Normal-Editor**: schliesst Normal-Editor (Save + Lock-Release + Teardown), öffnet Focus aus Page-View-Snapshot.
- **Offline-Queue**: gemeinsam über `shared/page-api.js`. Beide Modi nutzen dieselbe Queue.
- **Lock-Modell**: einheitlich **ein Lock pro Page-Session**. Mode-Wechsel Normal ↔ Focus gibt den Lock nicht frei — `shared/page-api.js` führt einen Save aus, der Lock bleibt bestehen, der neue Modus übernimmt ihn. Release erst beim verlassen der Page (Page-Wechsel, View-Reset, Logout).
- **Autosave-Frequenz**: in beiden Editoren identisch — `AUTOSAVE_IDLE_MS = 60000` (60 s nach letztem Tippen). `AUTOSAVE_MAX_MS = 120000` bleibt unverändert, deckelt Dauer-Tipper.
- **Counter**: **rechnet in beiden Modi**, **sichtbar nur im Focus**. `installEditCounter` läuft ab `startEdit` weiter (Tagesdelta muss alle Edits zählen — sonst sieht der Focus-Counter beim Wiedereintritt falsche Werte). UI-Show via `x-show="focusActive"` im Header; Normal-Editor zeigt den Counter nicht an. Teardown bleibt an `cancelEdit`/`saveEdit` (Non-Focus-Pfad) gekoppelt — exitFocusMode räumt den Counter nicht ab.
- **Snapshot-Restore**: **beide Editoren** bekommen einen sessionStorage-Snapshot mit gleicher Mechanik (`focus.snapshot` und `normal.snapshot`, je TTL 1 h). Beim Reload mountet die zuletzt aktive Karte direkt ohne Detour über die andere. Storage-Keys getrennt, Restore-Pfad jeweils Card-eigen.

## Offene Fragen

- **`EXCLUSIVE_CARDS`-Pattern**: reicht das aktuelle Pattern, um Focus und Normal-Editor wirklich gegenseitig exklusiv zu halten, wenn beide Cardroots existieren? Eventuell muss die Exklusivitätslogik um „Editor-Modes" erweitert werden — wird in Phase 4 entschieden, wenn beide Cardroots gleichzeitig im DOM existieren.
