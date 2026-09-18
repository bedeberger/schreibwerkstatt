# Recherche-Board

Karte `rechercheCard`, Routen `/research`, Status-SSoT [lib/research-validate.js](../lib/research-validate.js). Der Recherche-Chat daneben: [recherche-chat.md](recherche-chat.md).

- **Das Recherche-Board hat ZWEI Ansichten, EINEN Bestand** (Karte `rechercheCard`, Umschalter `viewMode` = `list`|`status`): die **Liste** zeigt den Bestand (Anriss je Fundstueck), das **Status-Board** den Fortschritt (Kanban ueber `research_items.status`, SSoT der Stufen: [lib/research-validate.js](../lib/research-validate.js)#`RESEARCH_STATUSES` + Frontend-Spiegel [recherche/shared.js](../public/js/book/recherche/shared.js)#`STATUSES`, Drift gegated in [tests/unit/research-status.test.mjs](../tests/unit/research-status.test.mjs)). Pflicht: **beide Ansichten rendern dieselbe `items`-Liste desselben `/research`-Requests** hinter derselben Filterleiste — ein zweiter Lesepfad zeigte bei aktivem Filter zwei verschiedene Bestaende; **`verworfen` ist eine Stufe, nicht `archived`** (archiviert = aus dem Board geraeumt und aus den Seiten-/Kapitel-Indikatoren gefallen, verworfen = geprueft und sichtbar nicht verwendet — als Archiv verschwiege es genau die Information, um derentwillen man es festhaelt); **eine Reihenfolge INNERHALB einer Spalte gibt es nicht** (`research_items` hat keine `sort_order`, die Ordnung kommt aus der gewaehlten Sortierung — darum nimmt [recherche/status.js](../public/js/book/recherche/status.js) den DOM-Move von SortableJS **immer** zurueck und schreibt nur den neuen Status); und **die Stelle im Buch bleibt die bestehende Verknuepfung** (`chapter`/`page` aus `research_item_links`, auf der Karte read-only) — „eingearbeitet" ohne solche Verknuepfung ist ein **Befund** auf der Karte, keine Korrektur (gleiche Bauart wie das Drift-Badge der Beat-Karte). Status setzen: Drag im Board oder der Abschnitt „Status" im geteilten Aktionsmenue ([recherche-item-menu.html](../public/partials/recherche-item-menu.html)) — ein Schreibpfad (`setItemStatus`), drei Oberflaechen.

## Rückrichtung: Pendenzen am Fundstück

Jedes Fundstück zeigt die eigenen Ideen, die darauf zeigen, als
`.idee-backlink-chip` — geladen über `GET /ideen/links?target_kind=research`
(non-fatal, [ideen-backlinks.js](../public/js/book/ideen-backlinks.js)). Read-only:
kuratiert wird die Kante auf der Ideen-Seite, Klick springt an die Stelle im Buch,
an der die Pendenz hängt.

**Der Lesepfad hängt bewusst NICHT am Fundstück-Payload.** `research_items` ist
buchweit geteilt, `ideen` dagegen user-privat — hingen die Anrisse an der Zeile,
müsste jeder ihrer Schreibpfade (`/capture`, Upload, Scrape, Interview, PATCH …)
die Skopierung mitführen, und der erste, der es vergisst, zeigt dem Mitarbeiter
die privaten Pendenzen des Autors. Details: [ideen-board.md](ideen-board.md).
