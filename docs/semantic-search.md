# Semantische Suche (Embeddings)

Bedeutungs-basierte Suche über ein Buch: Seiten, Szenen und Figuren werden in Chunks zerlegt, über einen **self-hosted, OpenAI-kompatiblen `/v1/embeddings`-Endpunkt** (z.B. LocalAI, llama.cpp) in Float32-Vektoren übersetzt und per Cosinus-Ähnlichkeit durchsucht. **Rein rückwärtsgewandt** — liest bestehende Inhalte, schreibt nie in den Buchtext (analog Recherche-/Buch-Chat).

Der Index ist ein **reiner Ableitungs-Index** (wie FTS5): jederzeit aus den Quelltabellen neu berechenbar. Host/Model/Key liegen in `app_settings` (`embed.*`) und verlassen den Server nie.

## Trefferqualität — die drei Stufen des Freitext-Pfads

Der **Freitext**-Query (`?q=…`, Such-Karte + Buch-Chat-Tool `search_similar`) läuft über die zentrale Pipeline [lib/semantic-retrieval.js](../lib/semantic-retrieval.js)#`semanticQuery`; jede Stufe ist optional und gated:

1. **Retrieval + Score-Floor** — Embedding-Cosinus (`searchSimilar`). `embed.min_score` (Default 0.25) ist die Cosinus-Untergrenze: die Ähnlichkeitssuche liefert nie „keine Treffer" (jede Anfrage hat einen nächsten Nachbarn), der Floor schneidet den schwachen Long-Tail ab, damit unter den guten Treffern kein Rauschen steht. **Gilt nur für Freitext**, nicht für „ähnliche Stellen zu Entität" (dort zählt Recall — der gemittelte Entitäts-Vektor rankt niedriger).
2. **Hybrid-Fusion (`embed.hybrid`, Default an)** — die lexikalische FTS5/bm25-Rangliste ([lib/search.js](../lib/search.js)) wird per **Reciprocal Rank Fusion** ([lib/semantic-fusion.js](../lib/semantic-fusion.js), pure, `RRF_K=60`) in die semantische gemischt. RRF fusioniert über die Rang-Position (nicht über inkompatible Score-Skalen) → exakte Begriffe/Eigennamen (die reine Embeddings verlieren) kommen zurück, Paraphrasen (die FTS verliert) bleiben.
3. **Reranking (`rerank.*`, Default aus)** — ein Cross-Encoder ([lib/rerank.js](../lib/rerank.js), self-hosted OpenAI/Jina-`/v1/rerank`, z.B. LocalAI/TEI) ordnet die Top-`rerank.top_n` Fusions-Kandidaten neu, indem er (Anfrage, Textstelle) direkt bewertet — schärfere Relevanz als Vektor-Distanz allein. `rerank.min_score` filtert danach. **Non-fatal:** fällt der Endpunkt aus, greift still die RRF-/Cosinus-Reihenfolge. Setzt aktivierte semantische Suche voraus (`isEnabled()` prüft zusätzlich `embed.isEnabled()`).

**Instruction-Präfixe** (`embed.query_prefix`/`embed.passage_prefix`, Default leer): für asymmetrische Modelle (e5: `query: `/`passage: `). Query-seitig via [lib/embed.js](../lib/embed.js)#`embedQuery` (alle Query-Aufrufer nutzen es), Passage-seitig im Index-Job — der `passage_prefix` fliesst in den Chunk-`content_hash` → Präfixwechsel invalidiert den Delta-Cache und erzwingt Reindex. **bge-m3 braucht die Präfixe NICHT** (leer lassen).

`/config` exponiert die Ableitungs-Flags `semanticSearch.hybrid`/`.rerank` für einen dezenten Hinweis in der Such-Karte (`semanticEnhancedLabel`); Host/Model/Key bleiben serverseitig. Admin-Test: `POST /admin/settings/test-embed` + `POST /admin/settings/test-rerank`.

## Drei Einstiegspunkte

Alle drei sind nur sichtbar/aktiv, wenn das Backend konfiguriert ist (`config.semanticSearchEnabled`, siehe [Freischalten](#freischalten)).

| Einstieg | Ort | Auslöser |
|----------|-----|----------|
| **Modus „Sinngemäss"** | Such-Karte (`searchCard`), Modus-Zeile `.search-mode-row` | User schaltet in [search.html](../public/partials/search.html) von „Volltext" (`fts`) auf „Sinngemäss" (`semantic`) → `setMode('semantic')` |
| **„Ähnliche Stellen"** | Button an Figuren- und Szenen-Karten | [figuren.html:133](../public/partials/figuren.html) / [szenen.html:181](../public/partials/szenen.html) → `$app.findSimilar(kind, id, label)` → öffnet Such-Karte, feuert Event `search:similar` |
| **Buch-Chat-Tool** | Agentischer Buch-Chat | Tool `search_similar` ([book-chat-tools.js:68](../public/js/prompts/book-chat-tools.js)) — Gegenstück zu `search_passages` (Wort-genau vs. sinngemäss) |

Es gibt **keine eigene Karte** und **keinen Paletten-Prefix** — die semantische Suche lebt komplett in der bestehenden Such-Karte (`key: 'search'` in [feature-registry.js](../public/js/cards/feature-registry.js)).

**Interner Konsument (kein UI-Einstieg):** die **Kontinuitäts-Verify-Stufe** (Multi-Pass, [docs/komplett.md](komplett.md#phase-8--kontinuitätsprüfung)) nutzt den Index als **best-effort Beleg-Fallback** — findet die wörtliche Textstellen-Suche das Zitat eines Befunds nicht, lädt sie die semantisch nächste Seiten-Passage nach (`searchSimilar`, `kinds:['page']`). Gilt nur, wenn der Index für das Buch existiert; sonst keyword-Pfad. Rein rückwärtsgewandt.

## Freischalten

Admin → Einstellungen → Tab **„Semantik"** ([admin-settings-embed.html](../public/partials/admin-settings-embed.html)). Settings-Keys (Defaults in [lib/app-settings.js](../lib/app-settings.js)):

| Key | Default | Bedeutung |
|-----|---------|-----------|
| `embed.enabled` | `false` | Kill-Switch |
| `embed.host` | `''` | Basis-URL des Embedding-Endpunkts (ohne `/v1`) |
| `embed.model` | `bge-m3` | Embedding-Modell (steht im Chunk-Key → Modellwechsel = Reindex) |
| `embed.dim` | `1024` | Vektor-Dimension (muss zum Modell passen) |
| `embed.timeout_ms` | `60000` | HTTP-Timeout pro Batch |
| `embed.api_key` | `''` | optionaler Bearer-Token |

**Gate:** `embed.isEnabled()` = `embed.enabled === true` **und** `embed.host` gesetzt ([lib/embed.js:14](../lib/embed.js)). Das `/config` exponiert daraus `semanticSearch.enabled` ([routes/proxies.js:137](../routes/proxies.js)), das Frontend spiegelt es nach `Alpine.store('config').semanticSearchEnabled` ([app-init.js:206](../public/js/app/app-init.js)). Zusätzlich verlangen die UI-Einstiege ein **gewähltes Buch** (`semanticAvailable`-Getter in [search-card.js:81](../public/js/cards/search-card.js)) — Vektoren leben pro Buch.

## Pipeline

```
Admin „Semantik" (embed.*) ──► lib/embed.js  ──POST /v1/embeddings──► self-hosted Endpunkt
                                    │
Such-Karte „Index aufbauen" ──POST /jobs/embed-index──► runEmbedIndexJob ──► semantic_chunks (BLOB)
                                                                                   │
Such-Karte „Sinngemäss" / „Ähnliche Stellen" ──GET /search/semantic──► searchSimilar (Cosinus, Brute-Force)
```

### Index-Job — `POST /jobs/embed-index`

[routes/jobs/embed-index.js](../routes/jobs/embed-index.js), `runEmbedIndexJob`. Rolle **`lektor`**, dedupt via `findActiveJobId`.

1. `_collectEntities` lädt indexierbaren Rohtext je Kind: Seiten (`loadPageContents`), Szenen (`titel`+`kommentar`), Figuren (`name`+`beschreibung`). Leerer Text → übersprungen.
2. `chunkText` ([lib/embed-chunk.js](../lib/embed-chunk.js)): ~1500 Zeichen/Chunk, 200 Overlap, bricht bevorzugt an Satz-/Absatzgrenzen.
3. **Delta-Cache:** pro Chunk `content_hash` (SHA-256, 16 hex). Unveränderter Chunk mit passender `dim` → alter Vektor wird wiederverwendet, kein Embedding-Call. Nur `pending`-Chunks werden in Batches (64) neu embeddet.
4. **Inkrementelle Persistenz:** eine Entität wird via `replaceEntity` atomar geschrieben, sobald ihr letzter pending-Chunk embeddet ist (nicht erst am Ende). Bricht das Backend mitten im Lauf ab, überleben die bereits fertigen Entitäten — der Delta-Cache übernimmt sie beim nächsten Lauf, nur der Rest wird neu embeddet. `pruneMissing` räumt am Ende verwaiste Chunks gelöschter Entitäten.

Erstlauf kann dauern (embeddet alles); Folgeläufe embetten nur Geändertes. Fehlt das Backend → `EMBED_DISABLED` (400) bzw. `job.error.embedDisabled`.

**Batch-Retry gegen transiente Aussetzer:** [lib/embed.js](../lib/embed.js)#`_withRetry` wiederholt jeden HTTP-Batch bis zu 3× mit linearem Backoff (800 ms × Versuch), wenn der Fehler transient ist — Netz-Blip (`fetch failed`), Timeout, HTTP 429/5xx, unvollständige Antwort (`err.retriable`). Nicht-transiente Fehler (HTTP 4xx ausser 429) und echter Job-Cancel (`signal`) werfen sofort. So reisst bei grossen Büchern (viele Batches) nicht mehr ein einzelner Backend-Zucker den ganzen Index-Lauf ab.

### Query — `GET /search/semantic`

[routes/search.js:118](../routes/search.js). Rolle **`viewer`**, immer buch-skopiert. Zwei Modi:

- **Freitext** (`q`, 2–500 Zeichen): `embed.embedOne(q)` → Query-Vektor.
- **„Ähnliche Stellen zu Entität"** (`like_kind`+`like_id`): `getEntityVector` mittelt die vorhandenen Chunk-Vektoren der Entität — **kein** Embedding-Call. Die Quell-Entität wird aus den Treffern ausgeschlossen.

`searchSimilar` ([db/semantic-chunks.js:70](../db/semantic-chunks.js)) scannt alle Chunks des Buches unter dem **aktiven Modell** linear (Buchgröße → Millisekunden, kein sqlite-vec nötig), nimmt pro Entität den besten Chunk, sortiert nach Score, top-K. Backend nicht erreichbar → `EMBED_UNAVAILABLE` (503) → Frontend zeigt `search.semantic.unavailable`.

## Datenmodell — `semantic_chunks`

Migration **240** ([db/migrations.js](../db/migrations.js)). Polymorph nach `kind` (`page`/`scene`/`figure`) → **kein einzelner FK** auf die Quelltabelle möglich; Aufräumung deshalb explizit + Netz:

- `entity_id` (polymorph), `book_id` → `books(book_id)` **ON DELETE CASCADE**, `chunk_ix`, `content_hash`, `model`, `dim`, `vector BLOB` (Float32 LE), `text`.
- `UNIQUE(kind, entity_id, chunk_ix, model)` — Mehr-Modell-Koexistenz, Query filtert aufs aktive Modell.
- Indexe: `idx_semchunk_book(book_id, kind)`, `idx_semchunk_entity(kind, entity_id)`.

**Cleanup-Hooks** (Entity-Delete räumt Chunks proaktiv): [db/pages.js:154](../db/pages.js) (`remove('page', …)`), [routes/figures.js](../routes/figures.js) (`remove('scene'/'figure', …)`). `book_id`-CASCADE ist das Netz beim Buch-Delete.

## Nacht-Cron

`reindexAllBooks()` ([routes/jobs/embed-index.js](../routes/jobs/embed-index.js), eingehängt in [server.js](../server.js)) reiht pro Buch (`contentStore.listBooks`) einen `embed-index`-Job ein (Dedup gegen laufende Jobs). Der Delta-Cache hält den Reindex billig: bereits indizierte Bücher embedden nur seit gestern geänderte Chunks neu, nie-indizierte Bücher bekommen ihren Erst-Index.

## Pflicht-Invarianten

- **Nie generativ** — die semantische Suche findet nur Bestehendes, schreibt nie in den Buchtext.
- **Reiner Ableitungs-Index** — keine Wahrheit in `semantic_chunks`; jederzeit via `embed-index` neu berechenbar.
- **Query filtert aufs aktive Modell** (`embed.model`). Modellwechsel im Admin → alte Modell-Chunks bleiben liegen (koexistieren), bis der nächste Full-Reindex sie über `pruneMissing`/`clearBook` ersetzt. Nach Modellwechsel Reindex anstoßen.
- **Host/Model/Key nie im `/config`** — nur der abgeleitete Bool `semanticSearch.enabled` geht ans Frontend.
- **`embed.dim` muss zum Modell passen** — Vektoren ungleicher Länge ranken via `cosineSim → -Infinity` nie als Treffer.

## Tests

[tests/unit/embed-chunk.test.mjs](../tests/unit/embed-chunk.test.mjs) — Chunking, (De)Serialisierung, Cosinus, Content-Hash (pure Helfer, kein Netz/DB). [tests/unit/embed-retry.test.mjs](../tests/unit/embed-retry.test.mjs) — Batch-Retry (`_withRetry`): transient→Erfolg nach Retries, nicht-transient→sofort, erschöpft→wirft, Job-Cancel→kein Retry.
