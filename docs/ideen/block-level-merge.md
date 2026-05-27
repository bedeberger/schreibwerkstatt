# Block-Level-Merge für Notebook + Focus-Editor

- **Status:** Umgesetzt (MVP, Flag `FEATURE_BLOCK_MERGE` default on)
- **Aufwand:** L (3–4 PRs; Block-ID-Pipeline + Merge-Engine + UI + Tests)
- **Severity:** Feature (verbessert Konflikt-Auflösung, ersetzt Last-Write-Wins durch granularen Merge bei Same-User-Multi-Device)

> **Umsetzungs-Abweichungen vom Plan:**
> - `ensureBlockIds` läuft **nicht** in `cleanPageHtml`, sondern am Page-Write-Chokepoint [lib/content-store/backends/localdb.js](../../lib/content-store/backends/localdb.js)#`_cleanHtmlSafe`. Grund: `cleanPageHtml` wird auch von Export/WP-Sync genutzt — dort sollen keine `data-bid` leaken. Hält ausserdem die exakten Output-Assertions in [tests/unit/html-clean.test.js](../../tests/unit/html-clean.test.js) intakt.
> - Merge-Engine liegt unter [public/js/editor/shared/block-merge.js](../../public/js/editor/shared/block-merge.js) (Browser-ESM, client-seitig) statt `lib/block-merge.js` — Merge läuft nur im Client. Pure Kern `mergeBlockLists` ist DOM-frei + Node-testbar.
> - Konflikt-UI als globales Modal-Partial [public/partials/conflict-resolution.html](../../public/partials/conflict-resolution.html) (Root-Scope), nicht als eigene Karte.
> - E2E-Test [tests/e2e/block-merge.spec.js](../../tests/e2e/block-merge.spec.js) deckt Engine (stiller Merge) + Auflösungs-UI (Banner, Block-Wahl, Bulk) via Harness ab. Voller Dual-Tab-Save-Roundtrip (Express + BookStack) ist out-of-scope des Harness-Modells.
> - Telemetrie als persistente Counter-Tabelle `merge_telemetry` (Migration 153), gemeldet über `POST /telemetry/merge` ([routes/telemetry.js](../../routes/telemetry.js)), exponiert als `sw_merge_*_total` in [lib/metrics-collector.js](../../lib/metrics-collector.js). Client-Helper [public/js/editor/shared/merge-telemetry.js](../../public/js/editor/shared/merge-telemetry.js) (fire-and-forget) aus notebook/edit.js. `conflict_resolved` mit `choice`-Label (local/remote/both).

## Context

Stand: Bei Stale-Write detektiert der Server `PAGE_CONFLICT` ([lib/content-store/backends/localdb.js:217](../../lib/content-store/backends/localdb.js#L217)), Frontend zeigt Konflikt-Banner mit „Überschreiben / Remote übernehmen" ([public/js/editor/notebook/edit.js:1175](../../public/js/editor/notebook/edit.js#L1175)). Last-Write-Wins; die andere Version landet in der Page-Revision-History, ist aber im Live-Doc weg.

Block-Merge-Vision: Bei Konflikt vergleicht der Client beide Versionen blockweise (`<p>`, `<h1>`-`<h3>`, `<ul>`, `<ol>`, `<blockquote>`, `<pre>`, `<hr>`). Nicht-konfliktende Block-Edits werden silent gemerged; nur bei echtem Block-Overlap (beide Geräte ändern denselben Block) erscheint ein Banner mit Auflösungs-Buttons.

Bewusste Scope-Beschränkung laut User-Entscheid: **Notebook-Editor und Focus-Editor zuerst** (häufigster Konfliktpfad). Bucheditor speichert ohnehin block-granular und hat geringeres Konflikt-Risiko — folgt später.

## Scope MVP

1. **Block-IDs als HTML-Invariante**:
   - Jeder Block-Level-Tag bekommt beim Save ein stabiles `data-bid="..."`-Attribut (8-Byte-Hex; via `crypto.randomBytes(8).toString('hex')` server- oder clientseitig).
   - Vergabe in `lib/html-clean.js`: nach `wrapOrphanBlocks` / `flattenDivBlocks` Pass läuft `ensureBlockIds(doc)` durch alle Block-Elemente; existierende `data-bid`s bleiben, fehlende werden gesetzt.
   - Notebook + Focus + Bucheditor schreiben **alle** über `cleanPageHtml` → konsistente Vergabe ohne Editor-spezifischen Code.
2. **Merge-Engine** (`lib/block-merge.js`, neu):
   - Pure Function `mergeBlocks(base, local, remote) → { merged, conflicts }`.
   - 3-Way auf Block-Ebene: identifiziert pro `data-bid`, ob nur lokal, nur remote, beide gleich, oder beide unterschiedlich geändert haben (echter Block-Konflikt).
   - Auto-Merge non-konfliktende Edits.
   - `conflicts`: Array `[{ bid, local_html, remote_html, base_html? }]`.
   - Block-Reihenfolge: Stabile Sortierung anhand der Reihenfolge in `local`; remote-only-Blöcke werden nach Position in `remote` zwischengeschoben (Longest-Common-Subsequence-Heuristik).
3. **Save-Pipeline-Erweiterung** ([public/js/editor/shared/page-api.js](../../public/js/editor/shared/page-api.js) bzw. notebook/edit.js):
   - Bei `PAGE_CONFLICT`: Client lädt `loadPage({ fresh: true })` → `remote`. Plus aktuelle Base aus dem Editor-State (letzte erfolgreich geladene Version inkl. `data-bid`s).
   - Ruft `mergeBlocks(base, local, remote)`.
   - Wenn `conflicts.length === 0`: Auto-Save mit `merged` und `expected_updated_at = remote.updated_at`. Kein Banner. Status-Toast `merged.silent`.
   - Wenn `conflicts.length > 0`: Konflikt-Banner mit Block-by-Block-Auflösungs-UI.
4. **Konflikt-UI**:
   - Banner: „N Blöcke wurden in beiden Versionen geändert."
   - Pro konflikt-Block: Drei Buttons — „Meine Version", „Andere Version", „Beide untereinander".
   - Inline-Preview beider Blöcke (read-only) plus aktuelle Wahl als hervorgehoben.
   - „Alle übernehmen / Alle ablehnen" als Bulk-Action.
   - Nach Auflösung: `merged` + Auflösungs-Entscheidungen kombinieren → erneuter Save mit `expected_updated_at = remote.updated_at`.
5. **Persistierte Base**: Editor-Modul muss `lastLoadedHtml` als „common ancestor" festhalten. Bereits vorhanden für Stale-Write-Schutz? Falls nicht, neu einführen.
6. **Tests**: Pure-Function-Tests für `mergeBlocks` (Standard-Fälle + Edge-Cases), Integration für Auto-Merge-Pfad und Konflikt-UI.

## Out-of-Scope

- Bucheditor (Phase 2 — Block-IDs sind dort eh implizit über `block.id`, aber `cleanPageHtml`-Pfad muss adaptiert werden).
- Inline-Text-Merge **innerhalb** eines Blocks (zwei Geräte ändern denselben `<p>` an verschiedenen Stellen → Block-Overlap, kein Auto-Merge).
- 3-Way-Merge mit Operational Transform (CRDT-Klasse Lösung).
- Block-Move-Detection (Block A wird auf beiden Seiten verschoben, an verschiedenen Stellen). MVP: zählt als Konflikt.
- Real-Time-Co-Editing.

## Done when

- `data-bid` ist auf allen neu gespeicherten Pages auf allen Block-Level-Elementen vorhanden (verifizierbar via Page-Revision-Inspect).
- Existierende Pages erhalten `data-bid` beim ersten Save nach Deployment (Lazy-Migration via `cleanPageHtml`).
- Same-User-Multi-Device-Szenario: Zwei Tabs editieren verschiedene Absätze → beim zweiten Save: silent Auto-Merge, keine User-Aktion nötig.
- Echte Konflikt (beide Tabs ändern Absatz 3): Banner mit klarer Block-by-Block-Auflösung.
- Notebook + Focus-Editor identische Konflikt-UX (gleicher Save-Pipeline-Pfad).
- Unit-Tests `tests/unit/block-merge.test.mjs` decken: identische Bases, einseitige Add/Remove, einseitige Edit, echte Konflikte, Reihenfolge-Drift, Mixed.
- E2E-Test simuliert Same-User-Dual-Tab-Szenario.

## Hard-Rule-Audit

- **Editor-Spezifikation**: explizit **nur** Notebook und Focus betroffen (laut User-Wahl). Save-Pipeline-Code in `public/js/editor/shared/` — Notebook + Focus teilen sie ohnehin. Bucheditor unverändert. Doku-Updates: `docs/notebook-editor.md`, `docs/focus-editor.md` (Konflikt-Sektion erweitern), `docs/book-editor.md` als Folge-Ausblick markieren.
- **DESIGN.md Patterns**: Konflikt-Banner erweitert. Block-by-Block-Auflösung ist neues Pattern → vor Implementierung Pattern-Snippet in DESIGN.md ergänzen.
- **Prompts**: n/a.
- **KI-Calls via Job-Queue**: n/a.
- **`callAI`-JSON-Only**: n/a.
- **Styles nur in `public/css/`**: ja, neue Datei `public/css/editor/conflict-resolution.css` für Banner + Block-Liste.
- **UI-Strings i18n**: alle Keys DE+EN. `edit.conflict.merged.silent`, `edit.conflict.blocks.count`, `edit.conflict.block.takeLocal`, `edit.conflict.block.takeRemote`, `edit.conflict.block.takeBoth`, `edit.conflict.block.takeAll.*`.
- **Content-Store-Facade**: ja, ausschliesslich `contentStore.savePage` / `loadPage`.
- **HTML→Text-Normalisierung Stats**: Merge produziert finales HTML; Stats-Pfad unverändert (Frontend `_syncPageStatsAfterSave` läuft nach erfolgreichem Save).
- **Job-Ergebnisse Staleness**: n/a (kein Job).
- **401-Handling**: zentral, n/a.
- **Logging-Context `book`**: n/a (kein neuer Server-Endpunkt).
- **`x-html`**: Konflikt-Banner zeigt Block-Previews — **Pflicht escHtml** vor `x-html`. Alternative: `<iframe srcdoc="...">` sandboxed. Entscheidung im Backend-Plan.
- **A11y**: Block-Auflösungs-Buttons regulär `<button>`. Banner-Container `role="alert"`.
- **Card-Animationen nur CSS**: n/a.
- **`SHELL_CACHE` bumpen**: ja.
- **`sortableTable`-Pflicht**: n/a.
- **Combobox statt `<select>`**: n/a.
- **`numInput`**: n/a.
- **File-Limits**: `lib/block-merge.js` voraussichtlich ~250 LOC. Konflikt-UI-Sub-Komponente neu — ggf. `public/js/cards/conflict-resolution-card.js` oder direkt in Editor-State.
- **State explizit**: `conflictResolution` als Initial-Feld in `app-state.js` (`null` oder Objekt mit `{ blocks: [...], decisions: {} }`).
- **DB-Timestamps ISO+Z**: n/a (kein Schema-Change im MVP).
- **Frontend-Datums-Display via `tzOpts()`**: n/a.
- **Keine Plan-Phasen-Kommentare**: Implementierung NICHT mit „Phase 1/Schritt 2"-Markern im Code annotieren.

## Abhängigkeiten

- Existierende Libs: `lib/html-clean.js` (Block-ID-Vergabe), `linkedom` (DOM-Parse im Node-Pfad), `lib/content-store/`.
- Frontend nutzt `DOMParser` (nativ) für Client-seitiges Parse vor Merge.
- Optional `diff-match-patch` o.ä. für Inline-Diff-Anzeige im Konflikt-Banner (read-only Preview). Bewusst klein halten — Block-Vergleich ist Hash-basiert, kein Char-Diff nötig.

## Backend

**`lib/html-clean.js`**:
- Neuer Helper `ensureBlockIds(doc)`:
  - Iteriert über `doc.querySelectorAll('p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,pre,hr,figure,table,div.poem')`.
  - Wenn `data-bid` fehlt: `crypto.randomBytes(8).toString('hex')`.
  - Wenn Duplikate existieren (z.B. Copy-Paste): zweites Vorkommen kriegt neue ID.
- Aufruf am Ende von `cleanPageHtml`, vor finalem Serialize.
- Bestehende Tests `tests/unit/html-clean.test.js` erweitern: assertet `data-bid` auf allen Block-Elementen + Idempotenz (zwei Cleans → gleiche IDs).

**`lib/block-merge.js`** (neu):
- `parseBlocks(html) → Map<bid, { tag, html, index }>` via `linkedom` server-side, `DOMParser` client-side. Gemeinsamer Pure-JS-Code via Wrapper.
- `mergeBlocks(baseHtml, localHtml, remoteHtml)`:
  1. Parse beide Versionen + Base in Block-Maps.
  2. Für jeden `bid` in `local ∪ remote`:
     - `base == local && base != remote` → `remote` gewinnt (silent).
     - `base != local && base == remote` → `local` gewinnt (silent).
     - `base == local == remote` → `local` (no-op).
     - `local == remote` → `local` (gleich geändert, kein Konflikt).
     - alle drei unterschiedlich → **Konflikt** in `conflicts[]`.
     - Block fehlt in `local` aber in `base` und `remote` → von beiden gelöscht → fehlt im merged.
     - Block fehlt in `remote` aber in `local` und `base` → lokal beibehalten? Konflikt? — **Konflikt** (lokal hat editiert, remote hat gelöscht).
  3. Reihenfolge: stabile Sortierung mittels LCS auf Block-Sequenzen.
  4. Return `{ merged: serializedHtml, conflicts }`.
- Tests `tests/unit/block-merge.test.mjs` (Standard + Edge-Cases).

## Frontend

**Save-Pipeline** ([public/js/editor/shared/page-api.js](../../public/js/editor/shared/page-api.js)):
- Bei `409 PAGE_CONFLICT`:
  1. `await contentRepo.loadPage(pageId, { fresh: true })` → `remote`.
  2. `const base = this._lastLoadedHtml || ''` (Editor-State).
  3. `const { merged, conflicts } = mergeBlocks(base, local, remote)`.
  4. `conflicts.length === 0`: retry Save mit `merged` + `expected_updated_at = remote.updated_at`. Status-Toast „Stille Zusammenführung".
  5. `conflicts.length > 0`: `app.conflictResolution = { merged, conflicts, remoteUpdatedAt: remote.updated_at }`. UI öffnet Banner.

**Konflikt-Banner-Komponente** (Sub-Karte oder Editor-State-Slice):
- Liste der konflikt-Blöcke mit Preview (local + remote nebeneinander).
- Pro Block: 3 Buttons (Meine / Andere / Beide).
- Default-Auswahl: „Meine Version" (least-surprise).
- „Alle übernehmen" → bulk-set decisions.
- Submit-Button: produziert finales HTML aus `merged` + `decisions`, ruft Save mit `expected_updated_at = remoteUpdatedAt`.
- Cancel-Button: lädt Page-Stand komplett neu (verwirft lokale Edits — User hat ja noch Page-Revisions als Last-Resort).

**`app-state.js`**:
- `conflictResolution: null` als Initial-Feld.

## CSS

- `public/css/editor/conflict-resolution.css` neu (Block-Liste, Buttons, Preview-Frames).
- `<link>` in `public/index.html`. `SHELL_CACHE` bumpen.

## i18n

- `edit.conflict.merged.silent` = "Änderungen automatisch zusammengeführt" / "Changes auto-merged"
- `edit.conflict.blocks.count` = "{count} Block | {count} Blöcke kollidieren" / "{count} block | {count} blocks in conflict" (pluralisierbar)
- `edit.conflict.block.takeLocal` = "Meine Version" / "My version"
- `edit.conflict.block.takeRemote` = "Andere Version" / "Other version"
- `edit.conflict.block.takeBoth` = "Beide übereinander" / "Both stacked"
- `edit.conflict.bulk.takeAllLocal` = "Alle meine" / "All mine"
- `edit.conflict.bulk.takeAllRemote` = "Alle anderen" / "All theirs"

## DB

Keine Schema-Änderung im MVP. Block-IDs sind Inline-HTML-Attribute.

Optional (Phase 2 / Out-of-Scope): `page_revisions` könnte `block_ids` als Hilfsspalte zwischenspeichern für schnelle Diff-Generierung in der History-UI. Heute nicht nötig.

## Security

- `data-bid` ist nicht-vertraulich (HTML-Inline-Attribut, mit Page-HTML mitgeliefert).
- Konflikt-Banner zeigt **fremden** HTML-Content — Pflicht: durch `escHtml()` oder als sandboxed iFrame. Bei Block-Preview empfehle ich `escHtml(blockHtml)` + Mono-Font, da User-Verständnis des HTML-Strukturierens hilfreich ist (nicht hyper-WYSIWYG).
- Block-Merge-Engine läuft client-seitig — keine Server-Vertrauensgrenze überschritten. Server validiert Endresultat nur durch `expected_updated_at`-Check.

## Telemetrie

- Counter `merge.silent.success` (Auto-Merge ohne User-Aktion).
- Counter `merge.conflict.shown` (User sah Banner).
- Counter `merge.conflict.resolved` aufgeschlüsselt nach Auflösungs-Mix.
- Counter `merge.failed.fallback_overwrite` (Edge-Case: Merge-Engine wirft, Fallback ist Last-Write-Wins-Banner).
- Anbindung über bestehendes `/metrics`-System.

## Reversibilität

- Block-IDs sind additiv und idempotent — kein Rollback nötig auf Daten-Ebene.
- Save-Pipeline-Pfad hinter Feature-Flag `feature.blockMerge` (Default off in PR 1, on in PR 4 nach Test-Reifung).
- Bei Bug: Flag off → klassischer Konflikt-Banner zurück.

## Tests

- **Unit** `tests/unit/block-merge.test.mjs`:
  - Identische Inputs → no-op.
  - Lokal ändert Block A, remote ändert Block B → beide gemerged.
  - Lokal löscht Block A, remote behält → Konflikt.
  - Beide ändern Block A unterschiedlich → Konflikt.
  - Lokal fügt Block X nach A ein, remote fügt Block Y nach A ein → beide eingefügt (Reihenfolge deterministisch).
  - Leere Base (frische Page) → Konflikt-Free Merge.
  - Duplikate `data-bid` (Bug-Reproduktion) → robustes Behavior.
- **Unit** `tests/unit/html-clean-blockids.test.mjs`:
  - `cleanPageHtml` vergibt IDs auf allen Block-Tags.
  - Idempotenz: zweimaliger Run → identisches Output.
  - Bestehende IDs bleiben unverändert.
- **Integration**: Notebook + Focus simulate `PAGE_CONFLICT`, prüfen Auto-Merge vs. Banner-Pfad.
- **E2E** `tests/e2e/block-merge.spec.js`:
  - Zwei Browser-Contexte, gleicher User, gleiche Page.
  - Context A editiert Block 1, speichert. Context B editiert Block 2, speichert → silent merge erwartet.
  - Beide editieren Block 1 → Banner mit Auflösung erwartet.

## Edge-Cases

- **Leere `base`** (User hat Page noch nie geladen): Merge gegen leeren String → alle Local-Blöcke gewinnen, alle Remote-Blöcke landen als Konflikt? — **Spezialfall**: bei leerer Base ist `local` neu, `remote` ebenfalls neu → 2-Way-Merge fallback (Klassisch: Banner mit Überschreiben/Übernehmen).
- **Block-Move**: Block A war an Position 3, lokal verschiebt nach 5, remote verschiebt nach 1 → Move-Detection schwer. MVP: Position aus `local` gewinnt, kein Konflikt-Marker. Verbesserung später.
- **Block-Split**: Lokal teilt `<p>` in zwei. Neue Blöcke kriegen neue IDs. Original-ID verschwindet. Wenn remote auch denselben Block teilt: zwei Sets neuer IDs → Konflikt am Original-bid (gelöscht in beiden), Auto-Resolve durch Local-Wins für neue IDs.
- **`<table>`/`<figure>` ohne `data-bid`**: Block-Tags-Whitelist klar definieren. Tabellen werden bei MVP als Single-Block behandelt (innere Zellen nicht mergebar).
- **Performance**: Pages mit >500 Blöcken? Profiling vor Release.
- **`data-bid` durch Paste verloren**: User kopiert HTML von extern → kein `data-bid` → `ensureBlockIds` vergibt neu beim nächsten Save. Akzeptabel — Block ist „neu" aus Merge-Sicht.
- **Race im Auto-Merge**: User tippt weiter während Auto-Merge läuft → vor Save lokalen Stand nochmal lesen, gegen `merged` mergen. Implementierung: `editor.content = mergedHtml` direkt nach Auto-Merge, lokale Edits weiter darüber (Browser kümmert sich um Cursor-Restore? — VOR Implementierung verifizieren).

## Kritische Dateien

**Modify:**
- [lib/html-clean.js](../../lib/html-clean.js) (`ensureBlockIds`)
- [public/js/editor/shared/page-api.js](../../public/js/editor/shared/page-api.js) (Conflict-Pfad)
- [public/js/editor/notebook/edit.js](../../public/js/editor/notebook/edit.js) (Banner-Integration)
- [public/js/editor/focus/](../../public/js/editor/focus/) (Banner-Integration analog)
- [public/js/app/app-state.js](../../public/js/app/app-state.js) (`conflictResolution`-Slot)
- [public/js/i18n/de.json](../../public/js/i18n/de.json), [en.json](../../public/js/i18n/en.json)
- [public/sw.js](../../public/sw.js) (`SHELL_CACHE` bump)
- [public/index.html](../../public/index.html) (neuer CSS-Link)
- [docs/notebook-editor.md](../../docs/notebook-editor.md) (Konflikt-Sektion)
- [docs/focus-editor.md](../../docs/focus-editor.md) (Konflikt-Sektion)
- [DESIGN.md](../../DESIGN.md) (Konflikt-Banner-Pattern)
- [CLAUDE.md](../../CLAUDE.md) (Stale-Write-Schutz-Regel um Merge-Pfad ergänzen)

**Create:**
- `lib/block-merge.js`
- `public/css/editor/conflict-resolution.css`
- `tests/unit/block-merge.test.mjs`
- `tests/unit/html-clean-blockids.test.mjs`
- `tests/e2e/block-merge.spec.js`

## Offene Fragen

1. **Banner-UX bei vielen Konflikten (>10 Blöcken)**: Liste + Bulk-Actions reichen, oder „Diff-View" als Modal sinnvoll? — Vorschlag: erst messen (E2E-Stichproben), Bulk-Actions reichen für MVP.
2. **`feature.blockMerge`-Flag-Ort**: Server-Setting (`app_settings`) oder Client-Constant? — Vorschlag: Client-Constant in `app-state.js`, da kein Per-User-Differenzierung nötig.
3. **Bucheditor-Anschluss**: Block-IDs landen über `cleanPageHtml` auch im Bucheditor-Save-Pfad. Aktiviert ihn das Block-Merge automatisch, oder soll der Konflikt-Pfad dort explizit anders bleiben (Bucheditor speichert pro Block, kennt Block-Konflikte schon per Save-Status)? — **Phase 2** klären, MVP nicht touchet.
