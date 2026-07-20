# Motiv-Werkstatt (Themen & Motive als Konstellation)

Planendes **und** überwachendes Werkzeug für Themen und Motive, visualisiert als kraftgerichtete Konstellation. Wie Figuren- und Plot-Werkstatt rein rückwärtsgewandt/planend — schreibt **nie** in den Buchtext. Pro Buch **und** User skopiert.

## Begriffe

- **Thema** (`themes`) — abstrakter Cluster (Schuld & Vergebung, Preis der Freiheit). Wenige pro Buch.
- **Motiv** (`motifs`) — die konkrete, wiederkehrende Nabe (Wasser, Spiegel, ein Lied). Optional einem Thema zugeordnet (`theme_id` SET NULL — Thema löschen lässt das Motiv stehen).
- **Beziehung** (`motif_relations`) — gerichtete Motiv-↔-Motiv-Kante mit Freitext-`typ` (verstärkt / kontrastiert / spiegelt), analog `figure_relations`.

## Soll vs. Ist

Der Kern ist der Abgleich zwischen **Soll** (Plan) und **Ist** (Textrealität):

- **Soll** — fünf M:M-Brücken verknüpfen ein Motiv mit `figures` / `draft_figures` / `plot_beats` / `chapters` / `pages` (`motif_figures` / `motif_draft_figures` / `motif_beats` / `motif_chapters` / `motif_pages`), alle CASCADE beidseitig. „Wo soll das Motiv laut Plan tragen?" Figuren stammen aus **zwei Quellen**: Komplettanalyse-Katalog (`figures`, TEXT-`fig_id` nach aussen) und Plotwerkstatt-Drafts (`draft_figures`, INTEGER-`id`); das Figuren-Combobox im Seitenpanel bündelt beide gruppiert (Gruppen „Komplettanalyse" / „Plotwerkstatt").
- **Ist** — `motif_occurrences` ist der abgeleitete Fund-Index: wo die KI-Motiverkennung das Motiv **real** im Text fand. `kind` ∈ {page, scene} (sentinel-frei via CHECK, genau eine Ref gesetzt), `source` ∈ {semantic, trigger}, Full-Replace pro Motiv je Scan (kein `content_hash` — die Erkennung nutzt den bereits vorhandenen Embedding-/FTS-Index und ist billig).

Ein Motiv gilt als **Geist** („geplant, aber fehlt"), wenn es Soll-Verknüpfungen hat, aber 0 Fundstellen — der Graph rendert es als Umriss-Knoten.

## KI-Motiverkennung (Job `motif-scan`)

[routes/jobs/motif-scan.js](../routes/jobs/motif-scan.js) — **kein `callAI`/Prompt**. Hybrid pro Motiv:

1. **Semantisch** — `beschreibung`+`name` als Query über [lib/semantic-retrieval.js](../lib/semantic-retrieval.js) (`semanticQuery`, kinds page/scene). Braucht das Embedding-Backend + einen frischen `embed-index`.
2. **Wörtlich** — jeder `trigger_terms`-Begriff als FTS5-Query über [lib/search.js](../lib/search.js).

Dedup pro (kind, entity): der semantische Treffer gewinnt (höhere Vertrauensstufe), ein Ort zählt einmal (Ist-Dichte). Fehlt das Embedding-Backend, läuft der Scan rein wörtlich; Motive ohne Trigger bekommen dann 0 Fundstellen (alte werden trotzdem geräumt). Nacht-Cron (`scanAllBooks`, [server.js](../server.js)) zieht den Ist-Index nach dem `embed-index`-Reindex nach — pro (Buch, User) mit katalogisierten Motiven.

**Scan-Transparenz (Frontend).** Ist die semantische Erkennung aus (`/config semanticSearch.enabled` false → `semanticActive()`), zeigt die Karte einen Hinweis, dass nur wörtliche Trigger gefunden werden. Ist sie an, bietet die Karte einen „Index aktualisieren"-Knopf (`refreshEmbedIndex()` → `POST /jobs/embed-index`, danach automatischer Rescan), damit frisch geschriebener Text vor dem Scan eingebettet wird. So bleibt nicht rätselhaft, warum ein Motiv ohne Trigger 0 Fundstellen hat.

## KI-Brainstorm (Job `motif-brainstorm`)

[routes/jobs/motif-brainstorm.js](../routes/jobs/motif-brainstorm.js) — **einziger `callAI`-Pfad** der Werkstatt. Schlägt 4–8 wiederkehrende Motive/Themen vor, die noch **nicht** katalogisiert sind (`typ` thema/motiv, `name`, `beschreibung`, `trigger_terms`). **Single-/Multi-Pass wie die Komplettanalyse**: passt der Buchtext ins `SINGLE_PASS_LIMIT`, läuft ein Durchlauf; sonst wird kapitelweise in `PER_CHUNK_LIMIT`-Chunks (`groupByChapter`/`splitGroupsIntoChunks`) zerlegt und pro Chunk gebrainstormt — so entgehen auch Motive in späteren Kapiteln nicht (kein Head-Slice). Ein chunk-übergreifendes `seen`-Set (Katalog + bereits Vorgeschlagenes) verhindert Dubletten und wird der KI als „NICHT wiederholen"-Kontext mitgegeben. Prompt/Schema in [public/js/prompts/motiv.js](../public/js/prompts/motiv.js) (Facade-Re-Export in `prompts.js`; nicht cache-gatet). Vorschläge sind **transient** (kein DB-Persist) — das Frontend zeigt sie als Karten, der Autor übernimmt einzeln (→ `POST /motifs` bzw. `/motifs/themes`) oder verwirft. Bei einem **Motiv**-Vorschlag lässt sich vor dem Übernehmen ein bestehendes **Thema** in der Karte zuordnen (Combobox → `theme_id` beim POST). Dubletten zum Katalog werden serverseitig gefiltert. Schreibt **nie** in den Buchtext.

## Frontend — Konstellations-Graph

- **Karte** `motivCard` ([public/js/cards/motiv-card.js](../public/js/cards/motiv-card.js)), Partial [public/partials/motiv.html](../public/partials/motiv.html), Fachmethoden-Facade [public/js/book/motiv.js](../public/js/book/motiv.js) → Submodule `motiv/{lifecycle,crud,graph,scan}.js`.
- **Graph** ([book/motiv/graph.js](../public/js/book/motiv/graph.js)) via vis-network (lazy, `loadVis()`), eigene Netzwerk-Instanz — teilt keinen State mit dem Figuren-Graph. Themen = Cluster-Anker (Farbe: vom Autor gewählter Palette-Schlüssel `themes.farbe` → theme-aware `--palette-*`-Token, wie in der Plot-Werkstatt; ohne Wahl deterministisch nach Index. Motive erben die Farbe ihres Themas), Motive = Naben (**Grösse = `occurrenceCount`**, Geist = Umriss + gestrichelt), Kanten: Thema→Motiv (gestrichelt), Motiv↔Motiv (`typ` als Label). Optionale Soll-**Layer** (Figuren/Beats/Kapitel) zuschaltbar (die Figuren-Ebene zeigt Katalog- **und** Werkstatt-Figuren; Knoten-Namespace `f<figId>` bzw. `df<id>`). Physik stabilisiert einmal, dann eingefroren. Klick auf Motiv-Knoten → Seitenpanel.
- **Seitenpanel** — Motiv-Editor (Name/Thema/Beschreibung/Trigger), Fundstellen-Liste (Ist, Klick → `gotoPageById` + Passage-Highlight via `book/motiv/highlight.js`: sucht den Snippet whitespace-tolerant im `.page-content-view`, markiert ihn per CSS Custom Highlight `::highlight(motiv-hit)` und scrollt zentriert — reines Lesen, kein DOM-Eingriff, Fallback aufs längste Wort), Soll-Verknüpfungs-Chips (Combobox add / Chip-`×` remove) und Beziehungs-Editor. Ohne Auswahl: Themen-Liste — jede Zeile mit Drag-Griff (SortableJS, [book/motiv/dnd.js](../public/js/book/motiv/dnd.js) → `PUT /motifs/themes/order`), Farb-Swatch + Palette-Popover (`setThemeColor` → `themes.farbe`) und Umbenennen/Löschen — plus Hinweis.
  - **Kern-Felder mit explizitem Save/Cancel** (App-Standard, kein Feld-Autosave): Name/Thema/Beschreibung/Trigger bearbeiten lokale Puffer (`editName`/`editThemeId`/`editBeschreibung`/`editTriggers`), bei Auswahl aus dem Motiv gefüllt (`_loadMotifBuffer`). `saveMotifEdit()` schickt alle geänderten Felder in **einem** PATCH, `cancelMotifEdit()` verwirft. Save (`check`/`icon-btn--success`) + Cancel (`x`) sind Action-Icons in der Titelzeile (`.motiv-editor-head`), via `x-show="motifDirty()"` nur bei ungespeicherten Änderungen sichtbar, per `.action-sep` vom Löschen (`trash`) getrennt. Chips (Soll-Links/Beziehungen) und Löschen bleiben Sofort-Aktionen.
- **Datenpfad**: `GET /motifs?book_id` liefert den Graph-Payload (`themes` + `motifs` mit Soll-Links & Ist-Count + `relations`); jede Mutation ruft `loadBoard()` neu (Boards sind klein).

## Routen ([routes/motifs.js](../routes/motifs.js), gemountet `/motifs`)

`GET /` (Graph-Payload) · Themen `POST/PATCH/DELETE /themes[/:id]` + `PUT /themes/order` · Motive `POST /` `PATCH/DELETE /:id` + `PUT /order` · Beziehungen `POST /relations` `DELETE /relations/:id` · Soll-Links `PUT /:id/links` (Full-Replace aller fünf Brücken; `figures` als TEXT-`fig_id`, `draftFigures` als INTEGER `draft_figures.id`) · Fundstellen `GET /:id/occurrences`. ACL: `viewer` für den Graph-Read, `editor` für Mutationen; Owner-Check pro `:id` via `_loadOwned`. Scoping-Validatoren in [db/motifs.js](../db/motifs.js) (`resolveFigureIds`/`validDraftFigureIds`/`validBeatIds`/`validChapterIds`/`validPageIds`) verhindern Cross-Book-Link-Leaks.

## Pflicht-Invarianten

- **Nie generativ in den Text** — reine Planung + Überwachung.
- **`motif_occurrences` ist abgeleitet** — jeder Scan macht Full-Replace pro Motiv; kein Handpflegen. `kind`+Ref via CHECK konsistent halten.
- **Figuren nach aussen als `fig_id`** (TEXT), intern INTEGER-FK `figures.id` — die Route/db-Schicht löst um (`resolveFigureIds`).
- **Buch + User skopiert** — alle Planungs-Tabellen tragen `book_id`+`user_email`; Bridges/Beziehungen/Occurrences erben den Scope über `motif_id`.
- **Graph eigenständig** — eigene vis-Instanz (`_motivNetwork`), im `destroy()` zerstören; nicht den Figuren-Graph wiederverwenden.
