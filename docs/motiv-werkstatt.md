# Motiv-Werkstatt (Themen & Motive als Konstellation)

Planendes **und** überwachendes Werkzeug für Themen und Motive, visualisiert als kraftgerichtete Konstellation. Wie Figuren- und Plot-Werkstatt rein rückwärtsgewandt/planend — schreibt **nie** in den Buchtext. Pro Buch **und** User skopiert.

## Begriffe

- **Thema** (`themes`) — abstrakter Cluster (Schuld & Vergebung, Preis der Freiheit). Wenige pro Buch.
- **Motiv** (`motifs`) — die konkrete, wiederkehrende Nabe (Wasser, Spiegel, ein Lied). Optional einem Thema zugeordnet (`theme_id` SET NULL — Thema löschen lässt das Motiv stehen).
- **Beziehung** (`motif_relations`) — gerichtete Motiv-↔-Motiv-Kante mit Freitext-`typ` (verstärkt / kontrastiert / spiegelt), analog `figure_relations`.

## Soll vs. Ist

Der Kern ist der Abgleich zwischen **Soll** (Plan) und **Ist** (Textrealität):

- **Soll** — vier M:M-Brücken verknüpfen ein Motiv mit `figures` / `plot_beats` / `chapters` / `pages` (`motif_figures` / `motif_beats` / `motif_chapters` / `motif_pages`), alle CASCADE beidseitig. „Wo soll das Motiv laut Plan tragen?"
- **Ist** — `motif_occurrences` ist der abgeleitete Fund-Index: wo die KI-Motiverkennung das Motiv **real** im Text fand. `kind` ∈ {page, scene} (sentinel-frei via CHECK, genau eine Ref gesetzt), `source` ∈ {semantic, trigger}, Full-Replace pro Motiv je Scan (kein `content_hash` — die Erkennung nutzt den bereits vorhandenen Embedding-/FTS-Index und ist billig).

Ein Motiv gilt als **Geist** („geplant, aber fehlt"), wenn es Soll-Verknüpfungen hat, aber 0 Fundstellen — der Graph rendert es als Umriss-Knoten.

## KI-Motiverkennung (Job `motif-scan`)

[routes/jobs/motif-scan.js](../routes/jobs/motif-scan.js) — **kein `callAI`/Prompt**. Hybrid pro Motiv:

1. **Semantisch** — `beschreibung`+`name` als Query über [lib/semantic-retrieval.js](../lib/semantic-retrieval.js) (`semanticQuery`, kinds page/scene). Braucht das Embedding-Backend + einen frischen `embed-index`.
2. **Wörtlich** — jeder `trigger_terms`-Begriff als FTS5-Query über [lib/search.js](../lib/search.js).

Dedup pro (kind, entity): der semantische Treffer gewinnt (höhere Vertrauensstufe), ein Ort zählt einmal (Ist-Dichte). Fehlt das Embedding-Backend, läuft der Scan rein wörtlich; Motive ohne Trigger bekommen dann 0 Fundstellen (alte werden trotzdem geräumt). Nacht-Cron (`scanAllBooks`, [server.js](../server.js)) zieht den Ist-Index nach dem `embed-index`-Reindex nach — pro (Buch, User) mit katalogisierten Motiven.

## Frontend — Konstellations-Graph

- **Karte** `motivCard` ([public/js/cards/motiv-card.js](../public/js/cards/motiv-card.js)), Partial [public/partials/motiv.html](../public/partials/motiv.html), Fachmethoden-Facade [public/js/book/motiv.js](../public/js/book/motiv.js) → Submodule `motiv/{lifecycle,crud,graph,scan}.js`.
- **Graph** ([book/motiv/graph.js](../public/js/book/motiv/graph.js)) via vis-network (lazy, `loadVis()`), eigene Netzwerk-Instanz — teilt keinen State mit dem Figuren-Graph. Themen = Cluster-Anker (Palette nach Index), Motive = Naben (**Grösse = `occurrenceCount`**, Geist = Umriss + gestrichelt), Kanten: Thema→Motiv (gestrichelt), Motiv↔Motiv (`typ` als Label). Optionale Soll-**Layer** (Figuren/Beats/Kapitel) zuschaltbar. Physik stabilisiert einmal, dann eingefroren. Klick auf Motiv-Knoten → Seitenpanel.
- **Seitenpanel** — Motiv-Editor (Name/Thema/Beschreibung/Trigger), Fundstellen-Liste (Ist, Klick → `gotoPageById`), Soll-Verknüpfungs-Chips (Combobox add / Chip-`×` remove) und Beziehungs-Editor. Ohne Auswahl: Themen-Liste + Hinweis.
- **Datenpfad**: `GET /motifs?book_id` liefert den Graph-Payload (`themes` + `motifs` mit Soll-Links & Ist-Count + `relations`); jede Mutation ruft `loadBoard()` neu (Boards sind klein).

## Routen ([routes/motifs.js](../routes/motifs.js), gemountet `/motifs`)

`GET /` (Graph-Payload) · Themen `POST/PATCH/DELETE /themes[/:id]` + `PUT /themes/order` · Motive `POST /` `PATCH/DELETE /:id` + `PUT /order` · Beziehungen `POST /relations` `DELETE /relations/:id` · Soll-Links `PUT /:id/links` (Full-Replace aller vier Brücken; Figuren als TEXT-`fig_id`) · Fundstellen `GET /:id/occurrences`. ACL: `viewer` für den Graph-Read, `editor` für Mutationen; Owner-Check pro `:id` via `_loadOwned`. Scoping-Validatoren in [db/motifs.js](../db/motifs.js) (`resolveFigureIds`/`validBeatIds`/`validChapterIds`/`validPageIds`) verhindern Cross-Book-Link-Leaks.

## Pflicht-Invarianten

- **Nie generativ in den Text** — reine Planung + Überwachung.
- **`motif_occurrences` ist abgeleitet** — jeder Scan macht Full-Replace pro Motiv; kein Handpflegen. `kind`+Ref via CHECK konsistent halten.
- **Figuren nach aussen als `fig_id`** (TEXT), intern INTEGER-FK `figures.id` — die Route/db-Schicht löst um (`resolveFigureIds`).
- **Buch + User skopiert** — alle Planungs-Tabellen tragen `book_id`+`user_email`; Bridges/Beziehungen/Occurrences erben den Scope über `motif_id`.
- **Graph eigenständig** — eigene vis-Instanz (`_motivNetwork`), im `destroy()` zerstören; nicht den Figuren-Graph wiederverwenden.
