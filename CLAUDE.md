# schreibwerkstatt

Schreiben, Lektorat und Buchanalyse mit KI. Inhalte (Bücher/Kapitel/Seiten) liegen lokal in SQLite und werden ausschliesslich über die Content-Store-Facade ([lib/content-store/](lib/content-store/)) gelesen und geschrieben. Deployment (LXC + systemd) und Env-Variablen: siehe [README.md](README.md).

**Lokal starten:** `npm install && npm start` (Port 3737). Tests: `npm test` (Playwright, erstmalig `npx playwright install chromium`).

## Vertiefende Dokus

Themen-Spickzettel ausgelagert (Drift-Schutz: CLAUDE.md-Regeln, Details in den Spickzetteln):

- [docs/jobs.md](docs/jobs.md) — Job-Queue: Lifecycle, `createJob`/`updateJob`/`failJob`, Dedup, Polling, Reconnect-Events.
- [docs/i18n.md](docs/i18n.md) — Key-Konvention, `t/tRaw`, Server-Status-Keys, `__i18n:`-Marker für persistierte Nachrichten.
- [docs/ai-providers.md](docs/ai-providers.md) — `callAI`-Vertrag, JSON-Parse-Fallback, Token-Budgets, Caching, Mutex bei Ollama/Llama, Retries.
- [docs/testing.md](docs/testing.md) — Wann Unit/Integration/E2E, Mock-AI-Setup, Harness-Konventionen, häufige Fallen.
- [docs/erd.md](docs/erd.md) — Schema-ERD (Mermaid): alle Tabellen, FK-Kanten, thematische Sub-Diagramme + Pflege-Regeln.
- [docs/komplett.md](docs/komplett.md) — Komplettanalyse (Kern-Pipeline): Phasen P1–P8, Single-/Multi-Pass, Claude-Split (A1/B/C/A2) vs. lokal, Delta-Cache + `book_extract_cache` + Checkpoint, Cache-Versionierung, faktenFailed/relationsFailed-Cache-Skip, Kontinuitäts-Verify-Stufe, Nacht-Cron, Pflicht-Invarianten.
- [docs/figur-werkstatt.md](docs/figur-werkstatt.md) — Figuren-Werkstatt: jsMind-Mindmap, Import aus `figures`, Brainstorm-/Consistency-Jobs, Run-Historie, Hash-Permalinks. Consistency **erdet semantisch** (`_loadFigurTextbelege` via `semanticQuery`) — Mindmap-Plan gegen die tatsächlich geschriebene Prosa der Figur, klickbare Belegstellen im Panel.
- [docs/plot.md](docs/plot.md) — Plot-Werkstatt (Beat-Board): Akte/Beats als Kanban-Spalten/-Karten (`plot_acts`/`plot_beats`/`plot_beat_figures`), optionale Handlungsstränge als Swimlanes (`plot_threads` + `plot_beats.thread_id` → Raster Akte × Stränge; null Stränge = flaches Board, opt-in), CRUD + 2D-DnD-Reordering, zwei planende KI-Jobs (Brainstorm pro Akt/Zelle + Consistency gegen Buchrealität inkl. Strang-Bögen) plus **Beat-Verankerung** (Job `beat-anchor`, kein `callAI` — findet je Beat die Fundstellen im Buchtext über den Embedding-/FTS-Index, Ist-Index `plot_beat_occurrences`, Full-Replace pro Beat + Nacht-Cron; Soll-`status` vs. Ist-Fundstellen → Drift-Badge auf der Beat-Karte, **erdet zusätzlich die Consistency-Prüfung** an echten Textstellen statt am Szenen-Index), pro Buch + User skopiert, nie generativ in den Text.
- [docs/motiv-werkstatt.md](docs/motiv-werkstatt.md) — Motiv-Werkstatt (Themen & Motive als Konstellation): planend **und** überwachend. Themen (`themes`) clustern Motive (`motifs`, die Nabe), Motiv↔Motiv-Kanten (`motif_relations`, Freitext-`typ`). **Soll** = vier M:M-Brücken (`motif_{figures,beats,chapters,pages}`), **Ist** = abgeleiteter Fund-Index `motif_occurrences` (page/scene, CHECK-gated, Full-Replace pro Scan). KI-Motiverkennung Job `motif-scan` (kein `callAI` — hybrid aus Embedding-Semantik + FTS-`trigger_terms`), Nacht-Cron nach `embed-index`. KI-Brainstorm Job `motif-brainstorm` (einziger `callAI`-Pfad — schlägt neue Motive/Themen aus dem Text vor, transient, Draft-Bestätigung). vis-network-Konstellation (Knotengrösse = Ist-Dichte, Geist-Knoten = geplant-aber-fehlt), Karte `motivCard`, Routen `/motifs`. Pro Buch + User, nie generativ in den Text.
- [docs/chats.md](docs/chats.md) — **Die drei Chats** (Seiten- / Buch- / Recherche-Chat) zusammengefasst, aber differenziert: Vergleichstabelle (Karte, Methods-Modul, Job-Pfad, Session-`kind`, Skopierung, Provider, Tool-Loop, Schreibverhalten) + geteiltes Storage-/Frontend-Modell (`chat_sessions.kind`, [chat-base.js](public/js/chat/chat-base.js)). Deep-Docs je Chat: buchchat-tools.md + recherche-chat.md. **Bei Chat-Änderungen zuerst klären, welcher Chat** (Harte Regel „Chat-Spezifikation Pflicht").
- [docs/buchchat-tools.md](docs/buchchat-tools.md) — Agentic Buch-Chat: Tool-Inventar (37 Stück inkl. `final_answer`-Endpunkt + `generate_image`), `ctx`-Vertrag, Truncation, Loop-Constraints, neues Tool anlegen.
- [docs/recherche-chat.md](docs/recherche-chat.md) — Recherche-Chat (Claude-only, Panel in der Recherche-Karte): agentischer Chat mit Anthropics nativem `web_search`-Server-Tool, liest Board + Buch-Entitäten, schlägt Fundstücke via `propose_research_item` vor (User bestätigt → `POST /research`), `chat_sessions.kind='research'`, Job `/jobs/research-chat`, Sichtbarkeit gegated auf effektiven Provider=Claude (`/config` `researchChat.enabled`). Rückwärtsgewandt: nie generativ im Buchtext.
- [docs/fassungen.md](docs/fassungen.md) — Fassungen (Manuskript-Meilensteine): ganze-Buch-Snapshots (`book_snapshots`, `content_json` selbsttragend mit Seiten-HTML inline), Capture/Liste/Diff (`diffSnapshots` + Side-by-Side), **destruktiver Restore** (Auto-Sicherung → Wipe → Buch-Import-Pipeline ins selbe Buch → Settings → Sync), Routen `routes/snapshots.js`, Karte `snapshotsCard`.
- **Drei unabhängige Editoren — bei Änderungen MUSS der User nennen, welcher gemeint ist** (siehe Harte Regel „Editor-Spezifikation" weiter unten):
  - [docs/notebook-editor.md](docs/notebook-editor.md) — Notebook-Editor (Einzelseiten-Edit-Modus): `notebookEditMethods` am Root, Toolbar/Bubble/Slash-Card, Autosave (Idle 60 s / Max 120 s), Draft-Pipeline, Stale-Write-Schutz, Findings-Mark-Watcher, Snapshot, Pflicht-Invarianten.
  - [docs/focus-editor.md](docs/focus-editor.md) — Focus-Editor (Vollbild-Schreibmodus auf einer Seite): State-Machine, Submodule (`focus/`), Trampoline-Pattern, Granularitäten, Recenter-Pipeline, Auto-`<p>`-Slot, Snapshot, Pflicht-Invarianten.
  - [docs/book-editor.md](docs/book-editor.md) — Bucheditor (Manuskript-Stream über das ganze Buch): Block-Liste, Klick-aktiviert-Block, Save-Queue, Pre-Conflict-Check, Find/Replace via CSS Custom Highlight, Outline/TOC, Pflicht-Invarianten.
- [docs/clients.md](docs/clients.md) — **Native Clients** (macOS [schreibwerkstatt-focuseditor], Android [schreibwerkstatt-mobile]): client-seitige Server-Schicht im Überblick — Device-Token-Auth (`swd_…`, [db/device-tokens.js](db/device-tokens.js)/[lib/device-auth.js](lib/device-auth.js), `/me/device-tokens`, Admin-Tab `/admin/devices`), Offline-Sync (`/content/books/:id/sync` Keyset-Delta) + Presence (`device-ping`/`presence`), OTA nur macOS (`/content/editor-bundle.zip` + `/content/macclient-i18n.json`), Release-Discovery beider Apps (`/content/{macclient,android}/release.json`). Editor-Kern + Bridge selbst: [docs/focus-editor.md](docs/focus-editor.md); Block-Merge-Konfliktmodell: [docs/notebook-editor.md](docs/notebook-editor.md).
- [docs/state-modell.md](docs/state-modell.md) — **Verbindliche Referenz für die gesamte Alpine-/Frontend-State-Architektur** (siehe Harte Regel „Frontend-State-Architektur Pflicht"): 3 Ebenen (Root/Sub/Store), Root-State-Slices, Computed-Maps, Lifecycle (`AbortController`-Pattern), `setupCardLifecycle`, `$app`/`window.__app`, Event-Bus, Karten-Inventar (SSoT [register-cards.js](public/js/app/register-cards.js)), Editor-Modi (Notebook/Focus-Flags + Bucheditor-Karte, Invarianten, erlaubte Kombinationen).
- [docs/buchorganizer.md](docs/buchorganizer.md) — Buchorganizer: Slice-Layout, In-Place-Mirror, Undo/Redo-Regeln, DnD-Pitfalls, Pflicht-Mutationssequenz.
- [docs/graph.md](docs/graph.md) — Figuren-Graph: 3 Modi (Swimlane/Familie/Soziogramm), vis-network-Internals, deterministisches Layout, neuen Beziehungstyp einbinden.
- [docs/finetuning.md](docs/finetuning.md) — Finetune-Export.
- [docs/publikation-export.md](docs/publikation-export.md) — Publikations-Metadaten (`book_publication`, 1:1 zu Buch) als SSoT für PDF- **und** EPUB-Export: Datenmodell, Pflege im BookSettings-Publikation-Tab, `/publication`-Route, EPUB-Builder/Job/Sync-Pfad (Cover via `File`, Frontmatter-Pages mit `__toc`-Skip), PDF-Spiegel in `config.extras`, drift-kritische Feld-Aufteilung buch-weit vs. profil-spezifisch.
- [docs/word-export.md](docs/word-export.md) — Custom-Word-Export (DOCX, Manuskript für Lektorat/Verlag): profilbasiert (`docx_export_profile`, user-scoped, Pendant zu PDF), programmatische `docx`-Lib (Shunn-Kopfzeile mit Seitenzahl + echtes Word-TOC-Feld + benannte Heading-Styles), Titelei aus `book_publication`, geteilter HTML-Walker mit dem PDF-Renderer, Job `/jobs/docx-export`, Karte `docxExportCard`. Normseite bleibt Schnellpfad.
- [docs/folder-import.md](docs/folder-import.md) — Folder-Import: ZIP mit YYYY/Monat/Tag-Struktur, Kapitel pro Jahr, Date-Detect mit AI-Fallback.
- [docs/book-migration.md](docs/book-migration.md) — Buch-Migration (`.swbook`): verlustfreier Buch-Round-Trip zwischen Instanzen, ZIP-Bundle (manifest+book.json mit node-Tree), Sync-Export `GET /book-migration/:bookId` + Import-Job `POST /jobs/book-import`, pure Builder/Parser in `lib/book-bundle.js`.
- [docs/geocode.md](docs/geocode.md) — Geocoding & Orte-Karte: `book_settings.orte_real`/`schauplatz_land`, `locations.lat`/`lng`/`land`, Dual-Provider (Nominatim/Photon) in `lib/geocode.js`, `GET /geocode`-Proxy, KI-first-Verortung via Job (`POST /jobs/geocode-resolve`, Label-Normalisierung + Buch-/Figuren-Kontext), Leaflet-View-Mode `map`.
- [docs/chapter-hierarchy.md](docs/chapter-hierarchy.md) — Kapitel-Hierarchie (max 3 Ebenen): Schema (`parent_chapter_id`), SSoT-Tree, Organizer-DnD/Tab-Indent, Sidebar-Indent, Kapitel-Review inkl. Sub-Kapitel, PDF/Export-Builder Depth-Mapping, Pflicht-Invarianten.
- [docs/languagetool.md](docs/languagetool.md) — LanguageTool-Integration (Self-Hosted, regelbasiert, sync Proxy als Ausnahme zur Job-Queue-Regel): Dispatch über 3 Editoren + Form-Felder, CSS-Custom-Highlights für Squiggles, Chunking + Per-Page-Cache, Custom-Dictionary, Extension-Konflikt-Detection, Pflicht-Invarianten.
- [docs/stt.md](docs/stt.md) — STT-Diktat (Speech-to-Text, self-hosted, **zweite** Sync-Proxy-Ausnahme zur Job-Queue-Regel): nur Notebook-Editor, Mic-Button im Root-Scope, browserseitiges WebAudio-RMS-VAD → Segment an `POST /stt/transcribe` → OpenAI-kompatibler Whisper-Endpunkt, Text verbatim am Cursor über den normalen Save-Pfad, Sprache aus Buch-Locale, Host/Key nie im `/config`, Admin-Tab „Diktat", `stt.enabled`-Kill-Switch.
- [docs/tts.md](docs/tts.md) — TTS / Proof-Listening (Text-to-Speech, self-hosted, **dritte** Sync-Proxy-Ausnahme zur Job-Queue-Regel): **zwei Oberflächen** — Notebook-Seitenansicht (Read-Modus, Dock im Root-Scope, `POST /tts/speak` auth) **und** Share-Reader (Vanilla-Dock, selbst-bootstrappend, `POST /share/:token/tts` public+token-skopiert). Synthese-Kern SSoT [lib/tts-synth.js](lib/tts-synth.js), pure Segmentierung SSoT [public/js/tts-segment.js](public/js/tts-segment.js) — beide von beiden Oberflächen geteilt. Text satzweise via `Intl.Segmenter` → OpenAI-kompatibler Speech-Endpunkt, Audio als `blob:`, aktueller Satz via `::highlight(tts-sentence)` (reines Lesen, keine DOM-Mutation), Prefetch-Kette, Voice/Host/Key nie ans Frontend, Admin-Tab „Vorlesen", `tts.enabled`-Kill-Switch (beide Oberflächen), CSP `media-src blob:`. Reader-Modulgraph muss pre-auth erreichbar sein (`PUBLIC_ASSET_PREFIXES`/`PUBLIC_ASSETS` in server.js).
- [docs/image.md](docs/image.md) — Bild-Generierung im **agentischen Buch-Chat** (self-hosted, OpenAI-kompatibler `/v1/images/generations`-Endpunkt, z.B. LocalAI; A1111/ComfyUI brauchen Adapter): Tool `generate_image` (bewusste Ausnahme zum Read-Only-Tool-Vertrag), Bild als BLOB in `chat_images` (FK `chat_sessions` CASCADE), Stream via `GET /chat/image/:id` (Owner-Check, MIME-Allowlist + `nosniff`), Anzeige + Download unter der Chat-Antwort, Admin-Tab „Bilder", `image.enabled`-Kill-Switch, Host/Key nie im `/config`. **Nie in den Manuskript-Text** (Weltaufbau-/Chat-Visualisierung).
- [docs/semantic-search.md](docs/semantic-search.md) — Semantische Suche (Embeddings, self-hosted OpenAI-kompatibler `/v1/embeddings`-Endpunkt, z.B. LocalAI): **zweiter Modus der Such-Karte** („Sinngemäss") + „Ähnliche Stellen"-Buttons an Figuren/Szenen + Buch-Chat-Tool `search_similar`; reiner Ableitungs-Index `semantic_chunks` (Float32-BLOB, polymorph nach `kind` page/scene/figure, book_id-CASCADE), Index-Job `POST /jobs/embed-index` (Delta-Cache via content_hash), Query `GET /search/semantic` (buch-skopiert, Cosinus-Brute-Force), Nacht-Cron reindexiert alle Bücher (Delta-Cache hält es billig; nie-indizierte bekommen Erst-Index). **Freitext-Trefferqualität** über die geteilte Pipeline [lib/semantic-retrieval.js](lib/semantic-retrieval.js): Score-Floor (`embed.min_score`) → Hybrid-RRF-Fusion mit FTS5 (`embed.hybrid`, [lib/semantic-fusion.js](lib/semantic-fusion.js)) → Cross-Encoder-Reranking (`rerank.*`, self-hosted `/v1/rerank`, [lib/rerank.js](lib/rerank.js), non-fatal). Instruction-Präfixe (`embed.query_prefix`/`passage_prefix`) für asymmetrische Modelle (e5), leer für bge-m3; Passage-Präfix im Chunk-Hash. Admin-Tab „Semantik" (`embed.*`+`rerank.*`), `/config semanticSearch.{enabled,hybrid,rerank}`, Host/Model/Key nie im `/config`. Rein rückwärtsgewandt — nie in den Buchtext.
- [docs/share-link.md](docs/share-link.md) — Share-Link (Page/Chapter/Book public via opaken Token): SSR-Reader-View ohne Alpine, Mount **vor** Auth-Guard, In-Memory-Rate-Limit + Honeypot, IP-Hash für GDPR, Owner-Karte listet nur Links (Unread-Tracking via `owner_last_seen_at`), „Kommentare anzeigen" wechselt in die Editor-Ansicht; **drei Kommentar-Oberflächen** (Share-Reader-SSR-View, Notebook-Leseansicht, Bucheditor) zeigen verankerte **und** allgemeine Leser-Kommentare als schwebende Margin-Rail (Google-Docs-Modell). Geteilte SSoT-Module über alle drei: `share-anchor.js` (Re-Anchoring), `comment-card-layout.js` (pure Kollisions-Geometrie), `avatar.js` (Initialen-Pips); die beiden SPA-Leisten teilen zusätzlich `comment-rail-core.js` (Verhalten + Triage-Filter) + `comment-rail-layout.js` (Layout-DOM-Glue). `/share/api/book-comments/:book_id`, Grid-Flag `pageCommentRailOpen`.
- [docs/metrics-api.md](docs/metrics-api.md) — Metrics-API: `GET /metrics` im Prometheus-Text-Format (HA/Grafana/Prometheus), Bearer-Token-Auth mit Scopes, `api_tokens`-Lifecycle, exponierte Kennzahlen-Liste, Pflicht-Invarianten.
- [docs/blog-sync.md](docs/blog-sync.md) — Blog-Sync (Buch ↔ WordPress, Buchtyp `blog`): Initial-Import + Pull + Push, LWW-Konfliktstrategie, Gutenberg-Block-Mapping, Buchorganizer-Status-Badges.
- [docs/hubspot-sync.md](docs/hubspot-sync.md) — HubSpot-Sync (Buch ↔ HubSpot-Blog, Buchtyp `blog`): einmaliger Initial-Import + Create-Draft-Push (kein Update, kein Pull-Back), PAT-Auth, Rate-Limit-Bucket.
- [docs/homeassistant/](docs/homeassistant/) — Home-Assistant-Integration: `rest`-Sensor-Config + Template-Sensoren + fertiges Lovelace-Dashboard, deckt alle Metriken ab. **Pflicht: jede neue `/metrics`-Kennzahl (in [lib/metrics-collector.js](lib/metrics-collector.js)) braucht im selben Commit einen Eintrag in [docs/homeassistant/configuration.yaml](docs/homeassistant/configuration.yaml) (REST-Sensor + ggf. abgeleiteter `template:`-Sensor), [docs/homeassistant/dashboard.yaml](docs/homeassistant/dashboard.yaml) (Dashboard-Kachel) und der Sensor-Übersicht in [docs/homeassistant/README.md](docs/homeassistant/README.md) — sonst erscheint sie nie in HA.**

## Feature-Pläne

Standardmässig **keine** Plan-Dateien anlegen — auch nicht unter [docs/ideen/](docs/ideen/). Grössere Features werden direkt im Chat besprochen und umgesetzt. Eine Plan-Datei (und erst recht ein grosses Mehrseiten-Dokument) entsteht **nur**, wenn der User es ausdrücklich verlangt; Ablageort dann mit dem User klären, nicht automatisch `docs/ideen/`.

## Doku-Stil dieser Datei

CLAUDE.md beschreibt **ausschliesslich den aktuellen Stand**. Keine Historie, keine Migrationsanleitungen, keine „statt X" / „ersetzt Y" / „alte Variante" / „vorher war …" / „Bug-Symptom"-Erzählungen mit konkreten Symptom-Werten. Wer wissen will, was früher anders war, liest `git log`/`git blame`. Beim Refactor: alten Pfad ersatzlos aus der Datei entfernen, nicht als „migriert von" mitschleppen. **Why:**/**Begründungen** für aktuelle Constraints und Invarianten bleiben — sie erklären den aktuellen Code; Bug-Narrative aber nicht.

## Harte Regeln

- **Editor-Spezifikation Pflicht** — die App hat **drei unabhängige Editoren**: **Notebook-Editor** (Einzelseiten-Edit-Modus, [docs/notebook-editor.md](docs/notebook-editor.md), Code `public/js/editor/notebook/`, Klassen `.page-content-view*`), **Focus-Editor** (Vollbild-Schreibmodus auf einer Seite, [docs/focus-editor.md](docs/focus-editor.md), Code `public/js/editor/focus/`, Klassen `.focus-editor*`) und **Bucheditor** (Manuskript-Stream über das ganze Buch, [docs/book-editor.md](docs/book-editor.md), Code [public/js/cards/book-editor-card.js](public/js/cards/book-editor-card.js), Klassen `.book-editor-*`). Bei Änderungs-/Bugfix-/Refactor-Wünschen **immer** zuerst klären, welcher Editor gemeint ist — Begriffe wie „der Editor", „Edit-Modus", „im Editor" sind mehrdeutig. Bei Unklarheit explizit nachfragen, nicht raten. Gilt auch für Cross-Cutting-Änderungen (Save-Pipeline, Toolbar, Find/Replace): wenn eine Änderung nur einen Editor betreffen soll, das im Diff sichtbar machen; wenn sie alle drei betrifft, jeden Editor einzeln auflisten und Pflicht-Invarianten der jeweiligen Doku prüfen. Notebook + Focus teilen `public/js/editor/shared/` (Save-Pipeline, html-clean) — das ist Implementierungs-Detail, nicht „die zwei sind ein Editor".
- **Kommentar-Oberfläche Pflicht** — Share-Link-Leser-Kommentare erscheinen auf **drei unabhängigen Oberflächen** ([docs/share-link.md](docs/share-link.md)): **Share-Reader-View** (öffentliche SSR-Leseansicht ohne Alpine, Code `public/js/share-reader*`, Leser-Sicht), **Notebook-Leseansicht** (Margin-Rail im Read-Modus einer Einzelseite, Code `public/js/editor/comments-rail.js`, Owner-Sicht) und **Bucheditor** (Margin-Rail über den ganzen Manuskript-Stream, Code `public/js/editor/book-editor-comments.js`, Owner-Sicht). Bei Änderungs-/Bugfix-/Refactor-Wünschen am Kommentieren (Anker, Threads, Reply/Resolve/Delete, Triage-Filter, Layout, Highlights) **immer** zuerst klären, **welche** Oberfläche gemeint ist — „die Kommentare", „die Leiste", „im Kommentar-View" sind mehrdeutig. Bei Unklarheit explizit nachfragen, nicht raten. Cross-Cutting: liegt die Logik im geteilten SSoT (`share-anchor.js` Re-Anchoring, `comment-card-layout.js` Geometrie, `avatar.js` Pips, `comment-rail-core.js`/`comment-rail-layout.js` für die zwei SPA-Leisten), betrifft die Änderung **alle** Oberflächen → jede einzeln nennen und Pflicht-Invarianten der Doku prüfen; soll nur eine betroffen sein, das in der Editor-/Reader-Glue lokalisieren, nicht im Kern. Owner editiert verankerte **und** allgemeine Kommentare ausschliesslich in Notebook-Leseansicht (Seiten-Share) bzw. Bucheditor (Buch-/Kapitel-Share), nie in der Owner-Karte; der Share-Reader ist die Leser-Seite.
- **Chat-Spezifikation Pflicht** — die App hat **drei unabhängige Chats** ([docs/chats.md](docs/chats.md)): **Seiten-Chat** (klassisch, neben dem Editor, schlägt `vorschlaege` zur Textersetzung vor; Karte `chatCard` [public/js/cards/chat-card.js](public/js/cards/chat-card.js), Methods [public/js/chat/chat.js](public/js/chat/chat.js), Job `/jobs/chat`, Session-`kind='page'`), **Buch-Chat** (agentisch mit `BOOK_CHAT_TOOLS`, read-only, buchweit; Karte `bookChatCard` [public/js/cards/book-chat-card.js](public/js/cards/book-chat-card.js), Methods [public/js/chat/book-chat.js](public/js/chat/book-chat.js), Job `/jobs/book-chat`, Session-`kind='book'`, Deep-Doc [docs/buchchat-tools.md](docs/buchchat-tools.md)) und **Recherche-Chat** (agentisch, Claude-only mit Web-Suche, Panel in der Recherche-Karte, schlägt `propose_research_item` vor; Methods [public/js/chat/research-chat.js](public/js/chat/research-chat.js) gespreadet in `rechercheCard`, Job `/jobs/research-chat`, Session-`kind='research'`, Deep-Doc [docs/recherche-chat.md](docs/recherche-chat.md)). Bei Änderungs-/Bugfix-/Refactor-Wünschen am „Chat" **immer** zuerst klären, welcher gemeint ist — „der Chat", „im Chat", „die Chat-Antwort" sind mehrdeutig. Bei Unklarheit explizit nachfragen, nicht raten. Cross-Cutting: die drei teilen nur die Frontend-Basis [public/js/chat/chat-base.js](public/js/chat/chat-base.js) (`makeChatMethods`) und das Storage-Modell (`chat_sessions.kind` + `chat_messages`) — Implementierungs-Detail, nicht „die drei sind ein Chat". Betrifft eine Änderung alle drei, jeden einzeln auflisten; soll nur einer betroffen sein, das im jeweiligen Methods-Modul/Job lokalisieren, nicht in der Basis.
- **Frontend-State-Architektur Pflicht: [docs/state-modell.md](docs/state-modell.md)** — die Datei ist die **verbindliche, drift-gepflegte SSoT** für den gesamten Alpine-State-Aufbau. Vor **jeder** Änderung am Frontend-State **zuerst dort die richtige Ebene wählen** — Root (`Alpine.data('lektorat')`) vs. Sub-Karte (`Alpine.data('xxxCard')`) vs. Store (`Alpine.store(...)`) entscheidet über Reaktivität, Lifecycle und Speicherlecks. Gilt für: neues Root-State-Feld (→ passender Slice in [app-state.js](public/js/app/app-state.js)), neue Karte (Lifecycle via `setupCardLifecycle`), geteilten Fach-State (Store statt Root-Proxy als Soll-Endbild), Window-Event-Bus, Root-Zugriff aus Subs (`$app`/`window.__app`, nie `$root`), globale Listener (Pflicht: `{ signal: this._abortCtrl.signal }`), sowie die **vier orthogonalen Editor-Modi des Notebook-Editors** mit ihrer Kombinations-Matrix + 7 Pflicht-Invarianten. **Bei jeder Änderung, die das State-Modell berührt, die Doku im selben Commit aktualisieren** (Slice-Tabelle, Karten-Inventar verweist auf [register-cards.js](public/js/app/register-cards.js) als SSoT, Editor-Modi-Invarianten + Zeilen-Refs) — sonst driftet sie wie zuletzt geschehen. Editor-Modus-Erweiterung folgt zwingend dem Schritt-Rezept am Ende der Doku.
- **UI-Patterns nur aus [DESIGN.md](DESIGN.md)** — vor jeder neuen UI-Komponente (Karte, Toggle, Badge, Liste, Status, …) den Pattern-Katalog prüfen. Wiederverwenden statt parallel neu erfinden. Existiert das Pattern nicht: erst dokumentieren in `DESIGN.md` (Markup-Snippet + CSS-Datei + Use-Case), dann verwenden. Klappbare Sections nutzen ausschliesslich das `.collapsible-toggle` + `.history-chevron`-Pattern (kein `<details>`/`<summary>`, kein neuer Marker). Akzentfarben pro Karte über `--card-accent-xxx` aus `tokens.css`.
- **Prompts nur unter `public/js/prompts/` (Facade `public/js/prompts.js`)** — einzige Quelle für alle Prompt-Schemas und Build-Logik. Externe Imports gehen ausschliesslich über die Facade `prompts.js`; Submodule (`prompts/lektorat.js`, `prompts/komplett.js`, `prompts/chat.js`, …) sind interne Aufteilung. Server importiert die Facade via dynamic `import()`. NIEMALS Prompts in Route-Handlern, Config-Dateien oder anderswo duplizieren.
- **KI-Calls nur via Job-Queue** — neue Features implementieren einen Job-Typ in `routes/jobs/` (Funktion `runXxxJob` + `router.post`). Direkte synchrone KI-Calls aus Route-Handlern sind verboten.
- **`callAI` gibt nur JSON zurück** — jeder Systemprompt muss JSON-Only erzwingen (`JSON_ONLY`-Konstante in `prompts/state.js`). Nach jedem `callAI`-Aufruf Pflichtfeld prüfen (z.B. `fehler`, `gesamtnote`, `figuren`). Fehler werfen statt falsche Daten rendern. **`truncated`-Flag IMMER vor `parseJSON` prüfen und werfen** — `jsonrepair` ist tolerant und liefert sonst Partial-Daten zurück (verhindert „silent partial"-Bug).
- **Styles nur in `public/css/`** — keine Inline-`style`-Attribute, keine `<style>`-Blöcke im HTML. CSS in 8 thematische Subfolder aufgeteilt: [layout/](public/css/layout/), [components/](public/css/components/), [page/](public/css/page/), [editor/](public/css/editor/), [entities/](public/css/entities/), [analysis/](public/css/analysis/), [admin/](public/css/admin/), [book/](public/css/book/). Plus [book-overview/](public/css/book-overview/) (dichtes Tile-Grid) und [tokens/](public/css/tokens/) (Custom-Properties). Root behält nur Facade ([tokens.css](public/css/tokens.css), [card-accents.css](public/css/card-accents.css)) + Solitäre ohne Geschwister ([chat.css](public/css/chat.css), [search.css](public/css/search.css), [tokens-est.css](public/css/tokens-est.css), [landing.css](public/css/landing.css)). Cascade-Reihenfolge via `@layer base, components, utilities;` in [public/css/tokens.css](public/css/tokens.css) (Facade — `@import` der Token-Module aus [public/css/tokens/](public/css/tokens/); tokens unlayered, Custom-Props global). Neue Datei → in passenden Subfolder einsortieren oder neue Datei anlegen + in [public/index.html](public/index.html) als `<link>` ergänzen + Eintrag in [DESIGN.md](DESIGN.md) „CSS-File-Inventar" ergänzen (der Shell-Cache aktualisiert sich automatisch über den Content-Hash, siehe „Shell-Cache: kein manueller Bump"). [tests/fixtures/focus-harness.html](tests/fixtures/focus-harness.html) lädt absichtlich nur Minimal-CSS für Focus-Editor-E2E-Tests (tokens, editor/focus-mode, components/job-toast, page/page-revision-viewer, components/user-chip) — neue Datei dort **nur** ergänzen, wenn der Focus-Editor-DOM-Pfad sie konsumiert; Reihenfolge dann analog index.html. **Neues Token (Farbe, Spacing, Motion, Z-Index, Scale): in passende Datei in `public/css/tokens/` ergänzen — der Facade-`<link>` reicht (kein zusätzlicher Link nötig).** **Karten-Akzentfarbe: Light-Hue als `--card-accent-<key>-base` + Mapping `--card-accent-<key>: var(…-base)` in [public/css/tokens/colors.css](public/css/tokens/colors.css); der Dark-Wert wird dort im Dark-Block per OKLCH Relative Color Syntax abgeleitet (eine `oklch(from …)`-Zeile nach dem Muster der Nachbarzeilen — keine Hand-Hexwerte mehr). Dazu Mapping `.card--<key> { --card-accent: var(--card-accent-<key>); }` in [public/css/card-accents.css](public/css/card-accents.css) (SSoT). Pro-Karten-CSS konsumiert `var(--card-accent)`, deklariert nicht selbst.**
- **UI-Strings nur in `public/js/i18n/{de,en}.json`** — keine hartcodierten deutschen/englischen Texte in HTML-Partials, JS-Modulen oder Alpine-Templates. Immer `t('bereich.feld')` (bzw. `tRaw()` ausserhalb von Alpine) verwenden. Neuer String → Key in **beiden** Locale-Dateien ergänzen (de = Fallback, en = Übersetzung). Key-Konvention: `bereich.feld` (z.B. `profile.title`). Platzhalter via `{name}` + Parameter-Map.
  - **Gilt auch serverseitig:** `updateJob`/`failJob`-`statusText` immer als i18n-Key setzen (z.B. `'job.phase.aiReply'`), dynamische Werte als `statusParams`-Objekt. Job-Labels via `{ key, params }` an `createJob`. Fehler-Messages, die der User sieht, ebenfalls als Key.
  - **Automatisch übersetzen, ungefragt:** jeder neue User-sichtbare String wird beim Hinzufügen sofort in beide Locale-Dateien eingetragen — egal ob Frontend-Label, Server-Status, Fehlertext, Placeholder oder Tooltip. Nie nur DE (oder nur EN) committen und auf „mach ich später" verschieben.
  - **Persistierte User-Nachrichten (z.B. Chat-Fallbacks in DB):** als `__i18n:bereich.feld__`-Marker speichern; Frontend löst beim Rendern via `t()` auf. So bleibt die Locale-Wahl des späteren Betrachters massgeblich.
  - **Ausnahme:** Winston-Logs (`logger.info/warn/error`) bleiben vorläufig deutsch — sie gehen nur in `schreibwerkstatt.log`/Console, nicht an den User.
- **Content-Store-Facade als einziger Eintrittspunkt für Buchinhalte** — Pages/Chapters/Books werden ausschliesslich via `require('lib/content-store')` gelesen und geschrieben. Direkte SQL-Zugriffe auf `pages`/`chapters`/`books` aus Route-/Job-Handlern sind verboten.
- **Block-IDs (`data-bid`) als Write-Path-Invariante** — `lib/html-clean.js#ensureBlockIds` vergibt stabile 8-Byte-Hex-IDs auf allen Block-Tags (`p,h1-h6,ul,ol,blockquote,pre,hr,figure,table,div.poem`). Aufruf **nur** am Page-Write-Chokepoint ([lib/content-store/backends/localdb.js](lib/content-store/backends/localdb.js)#`_cleanHtmlSafe`), **nicht** in `cleanPageHtml` (sonst landen IDs auch in Export/WP-Sync). Idempotent (bestehende IDs bleiben), Duplikate werden neu vergeben. Basis für den Block-Level-Merge ([public/js/editor/shared/block-merge.js](public/js/editor/shared/block-merge.js)) bei Stale-Write in **Notebook + Focus** (Flag `FEATURE_BLOCK_MERGE` in [app-state.js](public/js/app/app-state.js)): `base = originalHtml`, kollisionsfrei → stiller Auto-Merge, echte Block-Kollision → Auflösungs-Modal ([partials/conflict-resolution.html](public/partials/conflict-resolution.html), Previews via `x-text`). `data-bid` nicht strippen; Merge-Engine ist pure + client-seitig. Bucheditor unberührt. Details: [docs/notebook-editor.md](docs/notebook-editor.md#block-level-merge-bei-stale-write). Tests: [tests/unit/block-merge.test.mjs](tests/unit/block-merge.test.mjs), [tests/unit/html-clean-blockids.test.mjs](tests/unit/html-clean-blockids.test.mjs).
- **HTML→Text-Normalisierung für Stats: Frontend MUSS Server matchen** — `page_stats.chars`/`words`/`tok` werden auf zwei Pfaden befüllt: a) Server-Sync ([routes/sync.js](routes/sync.js)#htmlToText: Tags zu Single-Space, `\s+` collapsed, getrimmt) und b) Frontend nach Page-Save ([tree.js](public/js/book/tree.js)#`_syncPageStatsAfterSave`). Beide Pfade MÜSSEN dieselbe Normalisierung verwenden. `DOMParser().body.textContent` behält Whitespace zwischen Block-Tags und bläst `tokEsts.chars` gegenüber dem Cron-Snapshot auf — Frontend-Save-Pfad nutzt deshalb dieselben zwei Regex-Replacements wie Server. `tok = Math.round(chars / CHARS_PER_TOKEN)` (Text-Tokens, gleiche Quelle wie chars; kein Prompt-Overhead). Beide Pfade müssen die Formel synchron halten. `/history/page-stats/batch` persistiert blind, kein Server-Recompute. Test: [tests/unit/page-stats-normalization.test.mjs](tests/unit/page-stats-normalization.test.mjs).
- **Job-Ergebnisse mit `updatedAt`-Staleness-Check** — Server-Jobs, deren Resultate auf einem Snapshot des Seitenstands operieren, liefern `updatedAt: pd.updated_at`. Zwei Guard-Modelle, je nach Persistenz des Resultats:
  - **Transiente, positionsbasierte Resultate (Lektorat-Findings):** Der Client vergleicht im `onDone` mit `currentPage.updated_at`; weicht es ab (User hat während der Analyse gespeichert), wird das Ergebnis **verworfen** statt angewandt — die Positionen zeigen sonst ins Leere.
  - **Persistierte, textbasierte Resultate (Seiten-Chat `vorschlaege.original`, in `chat_messages` gespeichert):** werden **nicht** im `onDone` verworfen (sie leben in der DB und würden bei Session-Reload wiederkehren). Guard liegt stattdessen am **Apply-Zeitpunkt** ([public/js/chat/chat.js](public/js/chat/chat.js)#`applyChatVorschlag`): frischer Reload → `countInHtml` (0 → `originalNotFound`, >1 → `originalAmbiguous`, kein Blind-Ersatz der falschen Fundstelle) → `replaceInHtml`-No-Op-Check (Block-Grenzen-Vorschlag → `crossesBlockBoundary` statt still-falscher Erfolg) → `savePage(..., expectedUpdatedAt)` (409 bei Fremd-Write dazwischen).
- **401-Handling zentral** — ein globaler `window.fetch`-Wrapper in `public/js/app.js` fängt alle 401-Antworten ab und dispatcht `session-expired`; Alpine zeigt daraufhin den Session-Banner. Feature-Module prüfen 401 nicht selbst und dürfen das Event nicht unterdrücken. Kein Auto-Redirect – User soll ungespeicherte Inhalte retten können.
- **Logging-Context: `book` immer mitgeben** — jede neue Route mit Buchscope MUSS den `book`-Slot im Log-Tag `[scope|user|book|jobId]` füllen, damit Buch-scoped Requests filterbar bleiben.
  - **URL-Param-Routes (`:book_id`):** im Router einmalig `router.param('book_id', bookParamHandler)` aus [lib/log-context.js](lib/log-context.js) registrieren — deckt alle `:book_id`-Routes dieses Routers ab.
  - **Body/Query-Routes:** Handler nach `toIntId`-Validierung `setContext({ book: bookId })` (Import aus `lib/log-context`). Bei Routen, die `bookId` indirekt laden (z.B. via `session.book_id`, `draft.book_id`), nach DB-Read setzen.
  - **Job-Worker:** automatisch — `routes/jobs/shared/queue.js#drainQueue` zieht `job.bookId` in den ALS-Context. Pflicht ist nur, dass `createJob(type, bookId, …)` korrekt gefüllt wird.
  - **Why:** Worker-Logs zeigten Buch-ID; HTTP-Routes nicht → inkonsistente Tags. Sucht man Logs zu einem Buch, fehlt sonst die halbe Lifecycle-Spur (POST + Job + Sync).
- **`x-html` nur mit vorab-escaptem Content** — jede Stelle, die ins `x-html` fliesst, muss KI-/User-Felder vor der Interpolation durch `escHtml()` aus `utils.js` geschleust haben. Gilt für Status-Strings (`_runningJobStatus`), Review-Renderer (`_renderReviewHtml`, `_renderKapitelReviewHtml`), Lektorat-Output (`analysisOut`), Chat-Markdown (`renderChatMarkdown` escaped als erstes). Keine neuen `x-html`-Sinks ohne dieses Escape. Keine Runtime-Sanitizer wie DOMPurify – die Escape-Invariante reicht.
- **A11y: klickbare Nicht-Buttons** — Elemente mit Klasse `.internal-link` (spans/divs mit `@click`) werden global in `app.js` via MutationObserver + Event-Delegation tastatur-erreichbar gemacht (`role="button"`, `tabindex="0"`, Enter/Space → click). Nicht pro Element wiederholen. Neue klickbare Nicht-Buttons → einfach `.internal-link` setzen.
- **Kein globaler Fokus-Ring** — Browser-Default-Outline bleibt aktiv; per-Element-Fokus-Styles für Tab-Navigation (Skip-Link, `.page-item`, `.tree-chapter-header`, `.lektorat-split-findings .finding`) leben in [public/css/layout/base.css](public/css/layout/base.css). Komponenten mit eigenem Fokus-Signal (Border-Color, Background-Tönung, Inset-Outline) setzen `outline: none` ohne `!important`. Kein wildcard-`:focus-visible`-Token mehr; kein `!important`-Override für Outline-Disable.
- **Progress-Bars** — `.progress-bar` liest die Breite aus CSS-Custom-Prop `--progress`. Binding: `:style="{ '--progress': xProgress + '%' }"`, nicht `:style="'width:' + ... + '%'"`.
- **Flip-up-Popover messen statt raten** — JS-positionierte, nach `<body>` teleportierte Kebab-/Context-Menüs ([ideen.js](public/js/book/ideen.js)#`openMenu`, [plot/threads.js](public/js/book/plot/threads.js)#`openThreadMenu`) klappen nach oben, wenn unterhalb des Triggers kein Platz ist. Die dafür subtrahierte Höhe **nie** als fixe Konstante (`PH = 240`) raten — sonst löst sich das Menü beim Hochklappen vom Button (Lücke, weil die echte Höhe kleiner ist). Pattern: Trigger-Rect merken, mit Schätzung vorpositionieren, dann in `$nextTick` `el.offsetHeight`/`getBoundingClientRect().height` des gerenderten Popovers messen und via `_computeMenuPos(r, pw, ph)` neu setzen (`x-ref` aufs `.context-menu`). Cursor-verankerte Rechtsklickmenüs, die nur nach unten clampen (`Math.min(innerHeight - H, y)`), sind ausgenommen — sie flippen nicht. Gegated: [tests/unit/popover-flip-measure.test.mjs](tests/unit/popover-flip-measure.test.mjs).
- **Card-Animationen nur via CSS** — `.card` fadet via `cardFadeIn` (in [public/css/components/card-form.css](public/css/components/card-form.css)) ein. Kein `x-transition` zusätzlich auf `.card`-Elementen, sonst doppelt (CSS translateY + Alpine scale konkurrieren, wirkt wabbelig). Neue Karte: nur `x-show="..." x-cloak`, keine Alpine-Transition.
- **Shell-Cache: kein manueller Bump** — `SHELL_CACHE` leitet sich aus dem Content-Hash `__SHELL_BUILD` in [public/sw-manifest.js](public/sw-manifest.js) ab (generiert via `npm run sw:manifest`, läuft automatisch auf `prestart`). Jede Asset-Änderung (JS/Partial/CSS/i18n/Icon-Sprite/index.html) verschiebt den Hash → neue SW-Generation, ohne dass man eine Konstante hochzählt. Der SW precacht den vollständigen kohärenz-kritischen Asset-Satz atomar beim Install und serviert ihn **cache-only** — ein lazy-gefetchtes Partial oder dynamisch importiertes Modul zieht nie eine fremde Generation vom Netz (verhindert „neues Partial trifft altes JS-Modul"-Skew → ReferenceError). Drift zwischen [public/sw-manifest.js](public/sw-manifest.js) und einem frischen Scan ist durch [tests/unit/sw-manifest-drift.test.mjs](tests/unit/sw-manifest-drift.test.mjs) gegated (Teil von `test:unit` → blockiert den Deploy-Job); nach Asset-Änderungen lokal `npm run sw:manifest` laufen lassen und das Ergebnis **mitcommiten**. **Im Entwicklungsprozess passiert das automatisch:** ein PostToolUse-Hook ([.claude/settings.json](.claude/settings.json) → [scripts/hooks/regen-sw-manifest.js](scripts/hooks/regen-sw-manifest.js)) regeneriert das Manifest nach jeder `Edit`/`Write`/`MultiEdit`-Änderung an einem Shell-Asset (partials/*.html, js/**.{js,mjs,json}, css/**.css, icons.svg, index.html); Backend-/Test-/Doku-Edits lösen ihn bewusst nicht aus (kein Hash-Einfluss). Der regenerierte `public/sw-manifest.js` muss dann nur noch mitcommittet werden — manuelles `npm run sw:manifest` bleibt nötig, wenn der Hook deaktiviert ist (`/hooks`) oder ein Asset ausserhalb der Editor-Tools geändert wurde. Prod regeneriert **nicht** beim App-Start (systemd-Unit startet via `node server.js`, das `prestart`-Hook greift nur bei lokalem `npm start`) — stattdessen ruft [deploy/deploy.sh](deploy/deploy.sh) nach `npm install` explizit `node scripts/sw-manifest.js` auf, sodass Prod den Hash aus dem deployten Asset-Stand selbst regeneriert. vendor/* + fonts/* bleiben bewusst aus dem Manifest (self-contained) und liegen im generationsunabhängigen `VENDOR_CACHE` (cache-first), sodass sie nicht bei jedem Deploy mit dem `SHELL_CACHE` weggeworfen und neu geladen werden.
- **`sortableTable` Pflicht für Tabellen** — jede `<table>` mit >3 Datenzeilen nutzt `Alpine.data('sortableTable')` aus [public/js/sortable-table.js](public/js/sortable-table.js). Kein nacktes `<table>` für Listen-/Admin-/Verwaltungs-Views. Pflicht-Pattern: `x-data="sortableTable({ rows: () => …, defaultKey, types, persistKey })"` am `<table>`; jede sortierbare `<th>` bekommt `class="sortable-th"` + `:class="sortClass('key')"` + `:aria-sort="ariaSort('key')"` + `@click="sortBy('key')"`; `<tbody>` rendert `sorted` (nicht die Quell-Liste). `rows` ist eine **Funktion** (Getter) — reagiert auf Quelländerungen. `types: { col: 'number'|'date'|'string' }` pro Spalte mit nicht-eindeutiger Auto-Detection. `persistKey` für localStorage-Persist. Ausnahmen ausschliesslich: Server-Pagination/-Sort, Presence-Matrizen, Heatmap-Tabellen — siehe DESIGN.md „Sortierbare Tabelle" → „Wann nicht". Bei Berührung einer bestehenden Tabelle: mitziehen, nicht „später".
- **Combobox statt `<select>`** — alle Auswahlfelder nutzen `Alpine.data('combobox')` aus [public/js/app.js](public/js/app.js). Kein natives `<select>` für neue Features, ausser bei zwingendem Grund (z.B. native Mobile-Picker erwünscht — dann begründen). `init()` rendert Trigger + Dropdown + Search + Liste komplett selbst und überschreibt `innerHTML` des Wrapper-Divs. Wrapper-Div **leer lassen**, nur Attribute setzen. Pflicht-Pattern (3 Attribute):
  ```html
  <div x-data="combobox(placeholder, emptyLabel?)"
       x-modelable="value" x-model="selectedRef"
       x-effect="options = computeOptionsInline()"></div>
  ```
  - `init()` setzt automatisch: `combobox-wrap`-Klasse (+ `--compact` per Default), document-Mousedown (Outside-Close), Element-Keydown (Tastatur-Nav). Kein `@click.outside`, kein `@keydown`, keine `class`-Attribute mehr im Konsumenten-Markup.
  - Object-Form für Variante non-compact (selten, z.B. Buchwahl in Hero-Row): `combobox({ placeholder: t('…'), compact: false })`.
  - `options`: Array `[{ value, label }]`. Inline-Expression im `x-effect` aufbauen (siehe DESIGN.md "Reaktivität bei Datenquelle aus Karten-Scope" — Method-Indirection trackt nicht zuverlässig).
  - `x-modelable="value" x-model="ref"` koppelt internen `value`-State an äusseres Feld. Ohne `x-modelable` greift `@combobox-change` nicht in den Parent-State durch.
  - `emptyLabel` (2. Positional-Arg oder `{emptyLabel}`) erzeugt „Alle"-Option mit Wert `''`. Weglassen für Pflichtauswahl.
  - Optional `@combobox-change="…"` für Side-Effects bei Auswahl.
  - Referenz: [public/index.html](public/index.html) (Buchwahl, non-compact), [public/partials/szenen.html](public/partials/szenen.html) (Filter-Combobox).
- **`numInput` statt `<input type="number">`** — alle Zahlen-Felder nutzen `Alpine.data('numInput')` aus [public/js/num-input.js](public/js/num-input.js). Native `type=number` versteckt Tausender-Separatoren und akzeptiert nur Browser-Locale-Decimal — Swiss-User (de-CH: `.`-Decimal, `’`-Tausender) sehen falsche Anzeige. Pflicht-Pattern (3 Attribute):
  ```html
  <input type="text"
         x-data="numInput({ step: 0.1, min: 0, max: 2 })"
         x-modelable="value" x-model="form['key']">
  ```
  - `init()` setzt `inputmode`/`autocomplete`/`spellcheck` und hängt Event-Handler an — keine `@input/@blur/@focus` im Konsumenten.
  - Config: `step`, `min`, `max`, optional `decimals` (sonst aus `step` abgeleitet), `integer: true` (Shortcut für step=1+inputmode=numeric), `grouping: false` (Tausender unterdrücken).
  - Anzeige nutzt `uiLocale` (de→de-CH, en→en-US). Bei Focus rohe Edit-Form ohne Tausender; bei Blur reformatiert + clamped.
  - Parser akzeptiert sowohl `.` als auch `,` als Decimal — User-Habit-tolerant.
  - **Niemals** `x-model.number` parallel — der Component-State ist bereits Number.
- **Klappbare Section via `collapsible`** — eine eigenständige, per-Boolean klappbare Sektion (`.collapsible-toggle` + `.history-chevron`) nutzt `Alpine.data('collapsible')` aus [public/js/collapsible.js](public/js/collapsible.js), kein Hand-Wiring von `@click`/`:aria-expanded`/`:class`/`x-show` mehr. Pflicht-Pattern: `x-data="collapsible()"` (bzw. `collapsible(true)` für initial offen) auf ein Element, das Trigger + Panel umschliesst; `x-bind="trigger"` am Button, `x-bind="chevron"` am leeren `<span class="history-chevron" aria-hidden="true">` (CSS-Mask-Icon, **kein** `›`/`<svg>`-Inhalt), `x-bind="panel"` am Inhalt. In `x-for` pro Item eine eigene Instanz (`collapsible(role === 'body')`). Parent-gesteuerter/persistierter State: zusätzlich `x-modelable="open" x-model="parentVar"`. **Nicht** für Listen-/Tree-Row-Chevrons (`selectedXId === item.id`, Per-Item-Map, Tree-`item.open`) — das ist Single-Select/Tree-Expansion, kein eigenständiger Toggle; dort bleibt nur die `.history-chevron`-Rotation. Details + Beispiele in DESIGN.md „Klappbarer Section-Toggle".
- **LanguageTool auf Prosatextfeldern Pflicht** — jedes `<input type="text">` und `<textarea>`, in das User Prosatext eingibt (Buch-/Seiten-/Kapiteltitel, Notizen, Beschreibungen, Einleitungen, Ideen, Freitext-Kontext, Widmung, Impressum, neuer-Kapitel-/Seiten-Name), bekommt `data-spellcheck="spelling"`. Der globale Dispatcher ([public/js/cards/editor-spellcheck/dispatch.js](public/js/cards/editor-spellcheck/dispatch.js)) hängt sich beim Focus dran, wickelt das Feld in `<span class="lt-field-wrap">` (siehe DESIGN.md „Spellcheck-Badge auf Form-Feldern") und zeigt Tippfehler-Badge + Popover. **Why:** ohne harte Regel driftet das pro Karte auseinander (manche Felder geprüft, andere nicht), und User-sichtbare Inhalte wie Titel/Einleitungen brauchen Spellcheck genauso wie Seiten-Body. **How to apply:** neues Prosa-Feld → Attribut setzen, fertig. **Ausnahmen** (kein Spellcheck): Suchfelder/Filter (`.filter-search-input`, Sidebar-Suche, Palette), `numInput`-Zahlenfelder, Admin-/technische Settings (Modell-IDs, URLs, Tokens, Pfade), Find/Replace-Eingaben (User sucht ggf. nach Fehlern — kein Selbst-Meckern), Readonly-Anzeigen (Share-URLs), `<input type="password">`.
- **File-Limits / Modularität** — JS-Module > 600 LOC, HTML-Partials > 250 LOC, CSS-Files > 600 LOC werden gesplittet in `<name>/`-Subfolder mit thematischen Sub-Files. Pattern: Facade-File `<name>.js` re-exportiert Sub-Module; Sub-Module gruppieren Methoden nach Domäne (z.B. `load/stats/coverage/figuren/orte/kapitel/recent/format`). Beispiele: [public/js/prompts/](public/js/prompts/), [public/js/book-overview/](public/js/book-overview/), [public/css/book-overview/](public/css/book-overview/), [public/css/components/](public/css/components/), [public/partials/bookoverview-*.html](public/partials/bookoverview-snapshot.html). HTML-Partials werden via `_loadPartials` mit `<div id="partial-<name>">`-Placeholdern nested geladen (5-Pässe-Schleife, max 1-2 Verschachtelungstiefen). Für **geteiltes Markup innerhalb von `<template>`/`x-for`** (wo der DOM-Placeholder nicht greift — `querySelector` steigt nicht in Template-Content ab) gibt es den **string-seitigen Fragment-Include** `<!-- @include <name> -->` ([app-ui.js](public/js/app/app-ui.js)#`_resolveIncludes`, ersetzt vor `innerHTML`/`Alpine.initTree`): das eingefügte Markup wird Teil des Template-Contents und pro Loop-Iteration normal geklont. SSoT-Beispiel: [public/partials/plot-beat-cell.html](public/partials/plot-beat-cell.html) (Beat-Karte, geteilt zwischen flachem + Grid-Board). CSS-Subfolder via einzelne `<link>`-Tags in [public/index.html](public/index.html) (Cascade-Order = Lade-Order, base zuerst). Tile-Compute-Methoden, die mehrfach pro Render gerendert werden, sind Pflicht-memoized. Maschinell gegated: [tests/unit/loc-limits.test.mjs](tests/unit/loc-limits.test.mjs) — Cap pro Kategorie + Ratschen-Allowlist für bestehende Überschreiter (dürfen nur schrumpfen); neue Datei über dem Cap → CI rot. Beim Split einer allowlisted Datei deren Eintrag im Test streichen.
- **Memo-Pattern: ein Helper pro Modul** — Aggregat-Methoden, die im Template mehrfach pro Render aufgerufen werden, MÜSSEN memoized sein. Genau **ein** `_memo(key, deps[], fn)`-Helper pro Modul mit Array-Deps-Vergleich (shallow `===`). Kein Mix aus `_memo`/`_memoN`/handrolled Cache-Vergleichen. Helper auf `this`, gemeinsamer `this._memos`-Speicher pro Card-Instanz. `loadXxx`/`resetXxx` weisen `this._memos = {}` zu (Cache-Reset bei Daten-Reload). Pure Compute-Body (ohne `this._memo`) als `_computeXxx` extrahieren, vom memoizierten Wrapper aufrufen — testbar ohne Alpine. Referenz: [public/js/book-overview/load.js](public/js/book-overview/load.js)#`_memo`. Gegated: [tests/unit/dedup-tripwire.test.mjs](tests/unit/dedup-tripwire.test.mjs) (bant `_memoN`-Varianten).
- **State explizit deklariert** — fachlicher Karten-State gehört entweder in `app-state.js` (wenn root-relevant) oder als Initial-Feld im `Alpine.data`-Objekt. Lazy `this._privates`, die nur in Methoden auftauchen, sind verboten — nicht inventarisierbar via Lookup. Ausnahme: kurzlebige Re-Entry-Guards in async-Methoden (z.B. `_loadingBookId`, `_staleCheckBookId`), wenn klar als solche dokumentiert.
- **Ein Attribut, eine Deklaration** — kein `:foo` (oder `foo`) doppelt am gleichen HTML-Element. Browser nimmt letzte Version, erste wird stillschweigend verworfen → toter Code mit irreführendem Code-Review-Eindruck. Gilt auch für `:class`/`:style` mit Object-Form. Mehrere Zustände → eine Deklaration mit Ternary/Object. Gegated: [tests/unit/dedup-tripwire.test.mjs](tests/unit/dedup-tripwire.test.mjs).
- **CSS: Selektor unique pro Datei** — keine Doppel-Definition desselben Selektors im selben File. Bewusste Variation läuft über klar abgegrenzte Variant-Klasse, nicht über Re-Definition. Selektor-Duplikate erzeugen toten Code: zweite Deklaration überschreibt nur ihre eigenen Properties, erste bleibt für nicht-überschriebene Properties aktiv — schwer durchschaubar. Gleicher Selektor in unterschiedlichem `@media`/`@layer`-Scope ist erlaubt (bewusste Variation). Gegated: [tests/unit/dedup-tripwire.test.mjs](tests/unit/dedup-tripwire.test.mjs).
- **Mobile-Strategie pro Komponente** — entweder Media-Query (Viewport-bezogen) ODER Container-Query (Tile-bezogen) für dieselbe Regel, nicht beide. Container-Query bevorzugt, wenn Komponente in variablem Layout-Slot lebt (z.B. dichtes Grid mit Tile-Span). Mobile-Regeln stehen im selben File wie die zugehörige Komponente — kein zentrales `mobile.css`.
- **DB-Timestamps: ISO+Z via `NOW_ISO_SQL`** — alle `*_at`-Spalten (`created_at`, `updated_at`, `last_seen_at`, …) speichern ISO-8601 mit Z-Suffix. In Code-Pfaden (INSERT/UPDATE in `db/*.js`, `routes/*.js`, `lib/*.js`): `${NOW_ISO_SQL}` aus [db/now.js](db/now.js) interpolieren, **niemals `datetime('now')` inline**. In neuen Migrationen + CREATE-TABLE-Blöcken: Default `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` statt `(datetime('now'))`. INSERT-Statements liefern Timestamp-Spalten **explizit** (Spalte in Column-List + `${NOW_ISO_SQL}` in VALUES) — Default-Fallback ist drift-anfällig (Frontend kriegt sonst „YYYY-MM-DD HH:MM:SS" UTC-no-Z, JS parsed als lokale Zeit und `toLocaleString({ timeZone: appTimezone })` zeigt UTC-Uhr unter app.timezone-Label). Reine Vergleichs-WHERE-Clauses (`WHERE datetime(col) < datetime('now')`) dürfen `datetime('now')` behalten — beide Seiten via `datetime()` parsen ISO+Z und das alte Format gleich.
- **Frontend-Datums-Display: nur via `tzOpts()`** — `toLocaleString`/`toLocaleDateString`/`toLocaleTimeString`/`Intl.DateTimeFormat`-Calls für Datums-/Uhrzeit-Display (nicht reine Zahlen) IMMER mit `tzOpts(opts)` aus [public/js/utils.js](public/js/utils.js) wrappen — Helper mergt `timeZone: appTimezone`. Tag-Bucketing (heute/gestern, Streak-Buckets, Day-Diff) via `localIsoDate()` (TZ-aware), nicht via `d.getFullYear/Month/Date()` (Browser-TZ). Server-Pendant: [lib/local-date.js](lib/local-date.js) liest dieselbe Setting (`app.timezone`).


## Neues Feature hinzufügen

### Backend (KI-Job)

1. Job-Datei in `routes/jobs/` anlegen (Pattern: siehe `routes/jobs/review.js`)
2. `runXxxJob`-Funktion + `router.post('/xxx', ...)` implementieren
3. Router in `routes/jobs.js` mounten
4. Prompt-Builder im passenden Submodul unter `public/js/prompts/` ergänzen (z.B. `prompts/komplett.js` für Pipeline-Prompts, `prompts/review.js` für Bewertungen) und in der Facade `public/js/prompts.js` re-exportieren — **Cache-Invalidierung passiert automatisch**: `configurePrompts()` hängt an `PROMPTS_VERSION` (Basis `'20'` in `prompts/core.js`) einen Content-Hash über alle gebauten Locale-Prompts (inkl. eingebettetem Komplett-Schema) + die cache-gateten Schemas (Lektorat/Review/Synonym/Komplett, in `prompts.js#_promptsContentHash`). Jede Wortlaut-, Schema- oder `prompt-config.json`-Änderung verschiebt den Hash → alte `chapter_extract_cache`/`book_extract_cache` (Komplettanalyse), `chapter_review_cache`/`book_review_cache` (Buchbewertung), `chapter_macro_review_cache` (Kapitelbewertung), `synonym_cache`, `lektorat_cache` matchen nicht mehr. Den Basis-Prefix nur erhöhen, wenn ein **erzwungener** Flush ohne Inhaltsänderung nötig ist. Neue cache-gatete Schemas in `_promptsContentHash` aufnehmen.
5. Schema-Validierung nach `callAI` nicht vergessen
6. Dedup-Check im POST-Handler: `findActiveJobId(type, entityId, userEmail)` aus `routes/jobs/shared/` (NICHT `runningJobs.get(...) && jobs.has(...)` — matcht sonst auch fertige Jobs)
7. Logging-Context: `setContext({ book: book_id })` (aus [lib/log-context.js](lib/log-context.js)) im POST-Handler nach `toIntId`-Validierung, damit der `book`-Slot im Log-Tag gefüllt ist (siehe Harte Regel „Logging-Context")
8. Stats-Label: neuen Job-Typ in `JOB_TYPE_LABELS` ([routes/jobs/shared/jobs.js](routes/jobs/shared/jobs.js)) auf einen `job.label.xxx`-i18n-Key mappen (Key in **beiden** Locales anlegen) — sonst erscheint der Job in den Job-Statistiken (Bucheinstellungen) nur mit roher Typ-ID. Ausnahme: reiner Sub-Job eines Superjobs (wie die komplett-analyse-Sub-Typen) → stattdessen in `STATS_EXCLUDED_TYPES` aufnehmen, damit er gar nicht als eigene Zeile erscheint.

### Frontend (neue Karte als `Alpine.data`-Sub-Komponente)

Der Frontend-Scope ist in **Alpine.data-Sub-Komponenten** aufgeteilt:
- **Root** (`x-data="lektorat"` am `<body>`): Navigation (`selectedBookId`, `pages`, `tree`), Session, i18n, `showXxxCard`-Flags (Single Source of Truth für Hash-Router + Exklusivität), Job-Queue-Footer, globale Cross-Cutting-Methoden (`t`, `loadFiguren`, `selectPage`, `gotoStelle` …).
- **Sub-Komponenten** in [public/js/cards/](public/js/cards/) — eine pro UI-Karte. Buchebene: Figuren, Orte, Szenen, Ereignisse, Stil, Fehler-Heatmap, BookStats, BookSettings, UserSettings, Kontinuität, Ideen, Finetune-Export, PDF-Export, Buch-Overview, Buch-Chat, Buch-Review, Kapitel-Review, Palette. Editor-Subs: editor-find, editor-synonyme, editor-figur-lookup, editor-toolbar, editor-focus, editor-entities, lektorat-findings, page-history. Plus Seiten-Chat. Jede besitzt fachlichen State + Lifecycle.
- **Im Root** verbleibt: `page-view`, `editor/edit`, `editor/utils`, Hash-Router, Auto-Save, Selection-Management, Navigation. Editor-UI-Slices laufen als eigene Cards mit Trampoline-Events aus dem Root (z.B. `editor:focus:toggle`).

**Neue Karte anlegen:**
1. Fachmodul in `public/js/` → Methods-Export (`export const xxxMethods = { ... }`), Root-Zugriffe via `window.__app.xxx` (siehe unten).
2. Sub-Komponente in `public/js/cards/xxx-card.js` → `Alpine.data('xxxCard', () => ({ ...state, init(), destroy(), ...xxxMethods }))`, registriert als `registerXxxCard()` und in `app.js` aufgerufen.
3. Partial in `public/partials/xxx.html` mit `x-data="xxxCard"` am Wurzel-`<div class="card">`. Root-Zugriffe im Template via `$app.xxx`.
4. Root-Methode `toggleXxxCard()` in `app-view.js` — reiner Flag-Toggle + `_closeOtherMainCards('xxx')`. Bei Karten, die bei erneutem Klick refreshen sollen (statt schliessen): `window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: 'xxx' } }))`.
5. `showXxxCard`-Flag in `app-state.js` → `cardsState`.
6. **Pflicht: Eintrag in `EXCLUSIVE_CARDS` ([public/js/cards/feature-registry.js](public/js/cards/feature-registry.js))** — `{ key: 'xxx', flag: 'showXxxCard' }`. `_closeOtherMainCards`, `resetView` und `_maybeOpenBookOverview` iterieren darüber; ohne Eintrag bricht Exklusivität + Home-Klick öffnet keine Übersicht.
7. **Eintrag in `FEATURES` ([public/js/cards/feature-registry.js](public/js/cards/feature-registry.js))** (Single Source of Truth für Quick-Pills + Command-Palette + Usage-Tracking) — bei `kind: 'toggle'` zusätzlich Key in `ALLOWED_KEYS` von [routes/usage.js](routes/usage.js) ergänzen, sonst verwirft `/usage/track` lautlos. Karten, die nicht in der Palette erscheinen sollen (`kapitelReview`, `userSettings`), bleiben nur in `EXCLUSIVE_CARDS`.
8. Hash-Router: in `_currentHashView` ([public/js/app/app-hash-router.js](public/js/app/app-hash-router.js)) Parse-/Build-Branch ergänzen + Flag in der Liste am Ende der Datei aufnehmen.
9. **Hilfe-Karte + Landing pflegen (bei user-sichtbarem Feature):** Die Hilfe-Karte ([public/js/cards/help-card.js](public/js/cards/help-card.js)) zieht ihren Inhalt aus den Landing-Feature-i18n-Keys `landing.feat<N>Title`/`landing.feat<N>Desc` (de + en) — **SSoT, damit öffentliche Landing-Page und In-App-Hilfe nicht auseinanderdriften**. Neues nennenswertes Feature → in beiden Locale-Dateien einen `landing.feat<N>Title`/`Desc`-Block ergänzen **und** die Zahl `<N>` in `HELP_FEATURES` ([public/js/cards/help-card.js](public/js/cards/help-card.js)) aufnehmen (Reihenfolge = Anzeige-Reihenfolge). Sonst kennt weder Hilfe noch Landing das Feature.

### Root-Zugriff aus Sub-Komponenten (`$app` / `window.__app`)

Alpine's `$root` zeigt auf das **nächste x-data-Element** (bei Sub-Komponenten also die Sub selbst), nicht auf die `lektorat`-Root. Darum gibt es `$app`:
- **In Templates** (Alpine-Expressions): `$app.t('key')`, `$app.selectedBookId`, `$app.figuren`. Funktioniert über die Custom-Magic `Alpine.magic('app', …)` in [app.js](public/js/app.js).
- **In JS-Methoden/Gettern** (Sub-Komponenten): `window.__app.xxx` — der Root cached sich in `init()` in `window.__app` (garantiert reaktiver Alpine-Proxy). Alpine-Magics sind in JS-Getter-Ausführungen **nicht** zuverlässig verfügbar; `window.__app` ist robust.

### Geteilter Fach-State: `Alpine.store('catalog')`

`figuren`, `orte`, `szenen`, `globalZeitstrahl` leben in [public/js/cards/catalog-store.js](public/js/cards/catalog-store.js). Der Root exponiert sie als Getter/Setter-Proxy, sodass `this.figuren = …` und `this.figuren.push(…)` aus Root-Methoden weiter funktionieren. Sub-Komponenten lesen via `$app.figuren` oder direkt `Alpine.store('catalog').figuren`.

### Events zwischen Root und Subs

Root dispatched, Subs hören:
- **`book:changed`** — aus `_resetBookScopedState()`; Subs resetten State + laden bei offener Karte neu.
- **`view:reset`** — aus `resetView()`; Subs nullen lokalen State komplett.
- **`card:refresh` `{ name }`** — erneuter Klick auf offene Karte → Daten neu laden.
- **`job:reconnect` `{ type, jobId, job, extra? }`** — aus `checkPendingJobs()`; Review/Kapitel-Review-Subs übernehmen Loading-State + starten Polling.
- **`chat:reset` / `book-chat:reset`** — Root dispatcht beim Seitenwechsel / User-Settings-Danger-Reset; Chat-Subs leeren Session.
- **`kapitel-review:select` `{ chapterId }`** — aus Sidebar/Hash-Router; Sub setzt ihre `kapitelReviewChapterId`.

### Job-Polling (shared utilities)

Pure Funktionen in [public/js/cards/job-helpers.js](public/js/cards/job-helpers.js):
- `startPoll(ctx, config)` — generischer Job-Poller mit explizitem ctx.
- `runningJobStatus(translate, …)` — Status-HTML mit Token-Info.

Für createJobFeature-ähnliche Karten: [public/js/cards/job-feature-card.js](public/js/cards/job-feature-card.js) exportiert `createCardJobFeature(cfg)` — Sub-Variante der Root-Factory mit Flag am `$app` statt lokal.

### Feature-Toggle (Exklusivität)

Immer nur eine Hauptansicht aktiv. Buchebenen-Features und Seitenebenen-Features (Editor) sind gegenseitig exklusiv.
- Root-Toggle-Methode (`app-view.js`) ruft `_closeOtherMainCards(keep)` auf (schliesst alle anderen Karten + Editor)
- `selectPage()` ruft `_closeOtherMainCards()` (kein keep) — schliesst alle Buchkarten bevor der Editor öffnet. **Niemals Show-Flags in `selectPage` hand-pflegen** — drift-anfällig (neue Karte vergessen → bleibt beim Seitenklick offen). Helper ist SSoT für „alle Buchkarten zu".
- Jede neue Buchkarte braucht einen `EXCLUSIVE_CARDS`-Eintrag in [public/js/cards/feature-registry.js](public/js/cards/feature-registry.js) (`{ key, flag }`). `_closeOtherMainCards`, `resetView` und `_maybeOpenBookOverview` lesen ausschliesslich daraus — keine Hand-Pflege in app-view.js mehr.
- Sub-Komponenten haben **keine** eigenen `showXxxCard`-Flags — der Root ist SSoT. Subs hören auf `$watch(() => window.__app.showXxxCard)`.
- Seiten-Chat ist eine Ausnahme: läuft neben dem Editor, kein `_closeOtherMainCards` beim Öffnen.

### Scroll-to bei Karten-Toggle

SSoT: `_scrollToCardByKey(key)` + `_scrollToCardEl(el)` in [public/js/app/app-view.js](public/js/app/app-view.js). Mobile (<960px): `scrollIntoView({ block: 'start' })` aufs Karten-Element. Desktop (>=960px): `window.scrollTo({ top: 0 })`.

**Pflicht-Aufrufer:**
- `_toggleCardGeneric` ruft `_scrollToCardByKey(entry.key)` nach `_ensurePartial` + Flag-Set. Reihenfolge zwingend — Selector `[x-show="$app.${flag}"]` findet das Element erst nach Partial-Inject.
- Refresh-Pfad (`onReclick: 'refresh'`) scrollt **auch** — Re-Klick auf offene Karte zentriert sie wieder, statt User weggescrollt zu lassen.
- Hash-Apply für bereits offene Karte (`_applyHash`-Branches): explizit `_scrollToCardByKey(key)` ergänzen, sonst landet User nach Deep-Link-Click ins Nichts.

**Anti-Pattern:**
- Eigene `el.scrollIntoView()`-Calls in Sub-Komponenten oder Toggle-Methoden — Mobile/Desktop-Branching dann doppelt + drift-anfällig.
- Scroll **vor** `await _ensurePartial`: Selector findet nichts (Cold-Open hat leeres `partial-<name>`-Div).
- `_closeOtherMainCards` selbst scrollen lassen: Helper schliesst nur, scroll gehört in den Toggle-Pfad.

**`onCardRefresh` ≠ Re-Load vom Server.** Standardfall ist lokaler Re-Render aus bereits geladenem State (z.B. `_rerender()` im Buchorganizer snapshot't aus `root.tree`). Server-Fetch (z.B. `root.loadPages()`) clear't Tree/Listen visible → Sidebar-Flicker bei jedem Re-Klick. Nur dispatchen, wenn Karte wirklich externe Drift hat.

## Command-Palette + Feature-Registry

**SSoT für UI-Features:** [public/js/cards/feature-registry.js](public/js/cards/feature-registry.js) listet alle Karten (`kind: 'toggle'`), globalen Aktionen und Such-Provider. Quick-Pills, Command-Palette und Usage-Tracking lesen ausschliesslich daraus.

**Palette:** [public/js/cards/palette-card.js](public/js/cards/palette-card.js) — Modal mit Such-Input + Sektionen aus Karten + globalen Aktionen + Such-Providern. Trigger: Cmd/Ctrl+K bzw. `/`. Prefix-Modi: `>` Befehle, `#` Seiten, `!` Kapitel, `@` Figuren, `$` Orte, `%` Szenen. Ohne Prefix: alles fuzzy gemixt (Score-Threshold in `FUZZY_THRESHOLD_PER_CHAR`).

**Karten-Keys synchron halten:** Wer eine neue Toggle-Karte hinzufügt, ergänzt sie in `FEATURES` (feature-registry) **und** in `ALLOWED_KEYS` von [routes/usage.js](routes/usage.js). Sonst wird `/usage/track` lautlos verworfen → keine Recency-Position in der Palette.

**Recency:** [public/js/features-usage.js](public/js/features-usage.js) wird in den Root gespreaded; `$watch` auf jeden Show-Flag (rising edge) ruft `/usage/track`. Beim Login lädt `/usage/recent` die letzten Keys; Fallback: `DEFAULT_RECENT_KEYS` aus feature-registry.

## Lazy-Loaded Libs

vis-network (Figuren-Graph) und Chart.js (BookStats) laden ausschliesslich on-demand via [public/js/lazy-libs.js](public/js/lazy-libs.js). Kein neuer `<script>`-Tag im `index.html` für grosse Libs — sie würden den initialen Page-Load mit ~800 KB unbenutztem JS belasten. Der Ereignisse-Jahres-Zeitstrahl ist ein selbstgebautes DOM/CSS-Band (kein Vendor-Lib, siehe DESIGN.md „Jahres-Band").

## Prompt-System

**Trennung Config vs. Code:**
- `prompt-config.json` (Projektroot, Pflichtdatei) — Rollenformulierungen, Basisregeln, Buchtypen pro Sprache. Fehlt sie → Server-Crash beim Start.
- `public/js/prompts.js` — Facade (Re-Exports + `configurePrompts`-Orchestrator). Externer Einstieg für Server (dynamic `import()`) und Frontend (ESM).
- `public/js/prompts/` — interne Aufteilung nach Job-Typ:
  - `state.js` — `_isLocal`-Flag, `_jsonOnly()`, `JSON_ONLY`-Konstante (geteilter Provider-State)
  - `schema-utils.js` — Schema-Atome (`_obj`, `_str`, `_num`)
  - `blocks.js` — wiederverwendbare Regel-Blöcke (Stil, Wiederholung, Schwache Verben, Show-vs-Tell, Passiv, Perspektivbruch, Tempuswechsel, Erzählform)
  - `core.js` — `configureLocales`, `getLocalePromptsForBook`, alle `SYSTEM_*` Live-Exports, `PROMPTS_VERSION`, Locale-State
  - `lektorat.js` — Seiten-Lektorat (Einzel + Batch) + Stilkorrektur + `SCHEMA_LEKTORAT` (rebuild-pflichtig)
  - `review.js` — Buch-/Kapitel-Bewertung + statische Schemas
  - `komplett.js` — Komplettanalyse-Pipeline (Extraktion, Soziogramm, Orte, Kontinuität, Zeitstrahl) + alle dynamischen Schemas
  - `chat.js` — Seiten-Chat + Buch-Chat (klassisch + Agentic) + `BOOK_CHAT_TOOLS`
  - `synonym.js` — Synonym-Suche
  - `finetune.js` — Finetune-Export-Augmentation
- **Reihenfolge in `configurePrompts`:** `_setIsLocal(provider)` → `_rebuildLektoratSchema()` → `_rebuildKomplettSchemas()` → `configureLocales(cfg)`. Schemas vor `configureLocales`, weil `_buildLocalePrompts` → `buildSystemKomplett*` den `_isLocal`-Flag liest.

**Ladereihenfolge:**
- Server: `routes/jobs.js` und `routes/chat.js` lesen `prompt-config.json` synchron beim Modulstart → `configurePrompts()` einmalig (via `lib/prompts-loader.js`). `routes/proxies.js` liefert die Config lazy beim ersten `/config`-Call ans Frontend.
- Frontend: `app.js` → `init()` → `configurePrompts(cfg.promptConfig)` → setzt `SYSTEM_*`-Variablen via ESM-Live-Binding.

**Buchtypen:** In `prompt-config.json` unter `buchtypen`, aufgeteilt nach Sprachcode (`de`, `en`). Jeder Key hat `label` + `zusatz`. Neuer Typ: in beiden Sprachen ergänzen.

**Per-Buch-Kontext:** `getBookPrompts(bookId)` → `getLocalePromptsForBook()` augmentiert `baseRules` dynamisch mit Buchtyp-Zusatztext (`BUCHTYP-KONTEXT:`) und Freitext des Users (`VORRANGIGE ANGABEN DES AUTORS:` – übersteuert bei Konflikt die Basisregeln, insbesondere Stil/Ton/Format).

## Datenbank

DB-Code lebt in [db/](db/), aufgeteilt auf thematische Files: [connection.js](db/connection.js) (better-sqlite3-Setup, `PRAGMA foreign_keys = ON` global), [migrations.js](db/migrations.js) (Schema + `runMigrations`), [schema.js](db/schema.js), [books.js](db/books.js), [pages.js](db/pages.js), [figures.js](db/figures.js), [tokens.js](db/tokens.js), [token-usage.js](db/token-usage.js), [pdf-export.js](db/pdf-export.js), [fonts.js](db/fonts.js).

**Schema-Übersicht: [docs/erd.md](docs/erd.md)** — Mermaid-ERD mit allen Tabellen, FK-Kanten und thematischen Sub-Diagrammen (Buch-Hierarchie, Figuren, Continuity/Zeitstrahl, Chat/Reviews/Jobs/Caches/User/Export). Vor neuen Tabellen/Beziehungen prüfen, ob bestehende Strukturen (Bridge-Pattern, FK-Konventionen, ON-DELETE-Strategien) wiederverwendbar sind.

### Relationale Integrität (Pflicht)

- **Jede neue Tabelle integriert sich via FK** ins bestehende Schema. Lose `*_id`-Spalten (`book_id`, `page_id`, `chapter_id`, `figure_id`, `location_id`, …) ohne `REFERENCES` sind verboten.
- Refs auf lokale PKs/UNIQUE-Targets MÜSSEN als FK deklariert werden:
  - `books(book_id)` (PK; INTEGER, global eindeutig — analog `pages.page_id`/`chapters.chapter_id`)
  - `pages(page_id)` (PK)
  - `chapters(chapter_id)` (PK; global eindeutig)
  - `figures(id)` (PK; nicht `figures.fig_id` — TEXT, nicht UNIQUE alleine)
  - `locations(id)`, `figure_scenes(id)`, `chat_sessions(id)`, `continuity_*(id)`
- ON-DELETE-Strategie bewusst wählen:
  - `CASCADE` für reine Caches/Aggregationen (page_stats, chapter_reviews, figure_appearances, location_chapters, lektorat_time, page_figure_mentions, chat_sessions[kind=page], page_checks)
  - `SET NULL` für user-kuratierte Daten (figure_events.page_id/chapter_id, figure_scenes.page_id/chapter_id, locations.erste_erwaehnung_page_id, ideen.page_id, continuity_issue_chapters.chapter_id, page_checks.chapter_id, pages.chapter_id)
- **Snapshot-Spalten verboten** (`chapter_name`, `kapitel`, `seite`, `page_name`, `book_name`) — keine Ausnahmen. Display-Werte zur Lese-Zeit per JOIN auf `chapters`/`pages`/`books`/`figures`. Wahrheit lebt nur in `pages.page_name`, `chapters.chapter_name`, `books.name` und `figures.name` (User-Stamm). Snapshot-Fallback nur bei nullbarem FK, wenn KI-Output keine ID liefern konnte (z. B. `continuity_issue_figures.figur_name` mit nullable `figure_id`).
- Index auf jede neue FK-Spalte Pflicht (`CREATE INDEX idx_xx_yy ON …`).
- `book_id`-Spalten referenzieren `books(book_id)` (PK). Buchanlage ausschliesslich über die Content-Store-Facade.

### Sentinel-freie Modellierung

Vermeide Sentinel-Werte (`page_id=0`, `page_name='__book__'`) als Diskriminator. Stattdessen: explizite Spalte (`kind TEXT NOT NULL CHECK(kind IN ('page','book'))`) + `NULL` für nicht-anwendbare Refs + CHECK-Constraint, der die Kombination erzwingt. Beispiel: `chat_sessions`. Sentinels blockieren FK-Constraints und verstecken Geschäftslogik.

### Migration hinzufügen

Neuen `if (version < N)`-Block in `runMigrations()` ([db/migrations.js](db/migrations.js)) ergänzen (N = nächste fortlaufende Nummer, aktuelle Version siehe `schema_version`-Tabelle) + `UPDATE schema_version SET version = N`. Neue Tabellen als `CREATE TABLE IF NOT EXISTS` mit FKs. **Timestamp-Defaults**: `TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))` — siehe Harte Regel „DB-Timestamps: ISO+Z via `NOW_ISO_SQL`". `datetime('now')` ist verboten in neuen Schema-Defaults und neuen Inline-INSERT/UPDATE-Statements.

**Pflicht: jede Migration endet mit:**
```js
const fkErrors = db.pragma('foreign_key_check');
if (fkErrors.length) throw new Error(`Migration N: foreign_key_check meldet ${fkErrors.length} Verstoesse.`);
db.prepare('UPDATE schema_version SET version = N').run();
```

**FK-Migration via Recreate-Pattern** (SQLite kann FKs nicht via `ALTER TABLE ADD CONSTRAINT`):
1. `db.pragma('foreign_keys = OFF')`
2. Pre-Cleanup: orphans nullen (UPDATE … SET ref = NULL WHERE ref NOT IN parent) bzw. löschen (CASCADE-Targets)
3. `DROP TABLE IF EXISTS xxx_new` (defensiv gegen Crash-Reste)
4. `CREATE TABLE xxx_new` mit finalen FKs + Indexen
5. `INSERT INTO xxx_new SELECT … FROM xxx`
6. `DROP TABLE xxx` → `ALTER TABLE xxx_new RENAME TO xxx`
7. Indexe neu anlegen (Recreate verliert sie)
8. `db.pragma('foreign_keys = ON')` + `foreign_key_check`
9. `UPDATE schema_version`

**Initial-Schema-Block** (oben in `migrations.js`) ist der „Stand vor allen Migrationen" für **Legacy-Installationen**. Nur additive Changes (neue Spalten via ALTER ADD COLUMN, neue Tabellen). FK-Anreicherung gehört in eigene Migrationen via Recreate-Pattern, nicht ins Initial-Schema — sonst brechen Daten-Migrationen, die ihre eigenen Vorbedingungen aus alten Spalten lesen, auf frischen DBs.

**Fresh-DB-Fast-Path:** Brand-neue Installationen (keine `schema_version`-Tabelle) installieren stattdessen [db/squashed-schema.js](db/squashed-schema.js) in einem einzigen `db.exec`-Call (End-Zustand nach allen Migrationen) und überspringen die Legacy-Chain komplett. `runMigrations()` sieht direkt `version === SQUASHED_VERSION` und ist no-op. Drift zwischen Squashed-Snapshot und Legacy-Chain ist durch [tests/unit/squash-drift.test.mjs](tests/unit/squash-drift.test.mjs) gegated.

**Pflicht nach jeder neuen Migration: `npm run squash:regen`** — regeneriert [db/squashed-schema.js](db/squashed-schema.js) aus einem frischen Migration-Run. Wer das vergisst, lässt den Drift-Test in CI rot.

**Pflicht: [docs/erd.md](docs/erd.md) im selben Commit aktualisieren.** Stand-Zeile (Schema-Version + Tabellen-Anzahl) bumpen; betroffene Block-Definitionen (neue Spalten, geänderte Typen) anpassen; bei neuen Tabellen einen Block + die FK-Kanten in Section 1 (Übersicht) und ggf. im passenden thematischen Sub-Diagramm ergänzen; bei neuen FK-Kanten auf bestehende Tabellen die Kante in Section 1 nachziehen. Drift gegated durch [tests/unit/erd-drift.test.mjs](tests/unit/erd-drift.test.mjs): prüft Stand-Zeile (Schema-Version + Tabellen-Anzahl) und Set-Gleichheit der Mermaid-Block-Definitionen (`name {`) gegen `sqlite_master` (ohne `sqlite_*`/`schema_version`/FTS5-Shadow-Tables). Vergessene Tabelle → CI rot.

### Neuer Beziehungstyp

Keine Schemaänderung. `figure_relations.typ` ist Freitext. Neuen Typ in der `BZ`-Konstante (Frontend-Rendering) und im Claude-Prompt (`FIGUREN_BASIS_SCHEMA` in `public/js/prompts/komplett.js`) ergänzen.

`figure_relations.from_fig_id`/`to_fig_id` sind INTEGER-FK auf `figures.id` (nicht TEXT-fig_id). Schreib-/Lesepfade übersetzen via Lookup-Map (TEXT-fig_id ↔ INTEGER-id, siehe [db/figures.js](db/figures.js) `saveFigurenToDb`/`updateFigurenSoziogramm` und JOINs in [routes/figures.js](routes/figures.js), [routes/jobs/shared.js](routes/jobs/shared.js)).

## Architektur-Überblick

```
Browser → NGINX (HTTPS) → Express (Port 3737)
  /auth/*    → Google OIDC (Login/Callback/Logout/Me)
  /config    → Modell-Config + User (keine Credentials)
  /content/*       → Content-Store-Facade (Books/Chapters/Pages, Order, Revisions)
  /book-editor/*   → Page-Save/Apply, Locks, Presence
  /book-access/*   → ACL: User ↔ Book (Owner/Editor/Reader)
  /claude          → api.anthropic.com (ANTHROPIC_API_KEY-Injection, SSE)
  /ollama          → Ollama /api/chat (NDJSON → SSE normalisiert)
  /jobs/*          → Hintergrund-Jobs (Status-Polling, alle KI-Analysen)
  /chat/*          → Seiten-Chat (SSE-Streaming) + Buch-Chat-Sessions
  /history/*       → Job-Verlauf (SQLite)
  /figures/*       → Figuren-CRUD (SQLite)
  /draft-figures/* → Figuren-Drafts (Brainstorming vor Übernahme)
  /locations/*     → Orte-CRUD (SQLite, inkl. lat/lng/land für Geo-Karte)
  /geocode         → Geocoding-Proxy (Nominatim/Photon) für die Orte-Karte, kein KI-Call
  /ideen/*         → Ideen-CRUD (SQLite)
  /songs/*         → Songs-Feature (Buch-Soundtrack)
  /booksettings/*  → Per-Buch-Settings (Buchtyp, Freitext)
  /me/*            → User-Settings (Sprache, Modell-Override)
  /sync/*          → Buchstatistik-Sync (manuell + Cron)
  /export/*        → Buch-Export (PDF/HTML/Markdown/Plaintext/EPUB via App-eigenen Builder)
  /search/*        → FTS5-Volltextsuche
  /categories/*    → Kategorie-Pool (CRUD, Zuordnung pro Buch via ACL)
  /pdf-export/*    → Custom-PDF-Export-Profile (CRUD + Cover-Upload + Font-Liste)
  /jobs/pdf-export → Render-Job (eigene pdfkit-Pipeline mit PDF/A-2B)
  /docx-export/*   → Custom-Word-Export-Profile (CRUD + Font-Whitelist)
  /jobs/docx-export → Render-Job (programmatische docx-Lib, Manuskript für Lektorat/Verlag)
  /blog/*          → WordPress-Blog-Connection (Buchtyp 'blog'): Status, Connect, Links, Konflikt-Resolve
  /hubspot/*       → HubSpot-Blog-Connection (Buchtyp 'blog'): Status, Connect, Blogs/Authors-Combo, Links
  /jobs/blog-*     → Blog-Sync-Jobs (initial-import, pull, push)
  /jobs/hubspot-*  → HubSpot-Sync-Jobs (initial-import, push-as-draft)
  /usage/*         → Feature-Usage-Tracking (Recency für Palette/Quick-Pills)
  /telemetry/*     → Block-Level-Merge-Counter (POST /telemetry/merge → merge_telemetry, exponiert via /metrics)
  /admin/books, /admin/logs, /admin/registration-requests, /admin/settings, /admin/usage, /admin/users
  /public/*        → Unauthentifizierte Endpoints (Health, Marketing)
  /                → public/index.html (SPA)

Cron (täglich nachts; Uhrzeit in server.js, TZ aus app.timezone) → syncAllBooks() → page_stats + book_stats_history
```

**Auth:** Alle Routen ausser `/auth/*` sind durch Session-Guard geschützt. HTML-Requests → Redirect auf Login. API-Requests → `401 JSON`.

**Credentials:** KI-Aufrufe laufen über Server-Proxies — der Server hält alle API-Keys.

**Content-Store-Facade ([lib/content-store/](lib/content-store/)):** zentrale Storage-Abstraktion über das SQLite-Backend. Bündelt Page-Revisions, Tree-Overlay (book_order) und FTS-Index-Hooks am Schreib-Chokepoint. Konsumenten (Routes, Jobs, Sync) importieren ausschliesslich die Facade.

## KI-Provider

Drei Provider, konfiguriert via `API_PROVIDER` in `.env`:

| Provider | Env-Vars | Besonderheit |
|----------|----------|--------------|
| `claude` | `ANTHROPIC_API_KEY`, `MODEL_NAME` | Prompt-Caching (`cache_control: ephemeral`), grosses Kontextfenster |
| `ollama` | `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_TEMPERATURE` | Mutex-Serialisierung (VRAM-Schutz), dynamische `num_ctx`-Berechnung |
| `openai-compat` | `OPENAI_COMPAT_HOST`, `OPENAI_COMPAT_MODEL`, `OPENAI_COMPAT_TEMPERATURE`, `OPENAI_COMPAT_API_KEY` | OpenAI-kompatibler `/v1/chat/completions`-Endpoint (llama.cpp, vLLM, LiteLLM, OpenAI); optionaler Bearer-Token (`ai.openai-compat.api_key`), Mutex-serialisiert |

**`ai.claude.max_tokens_out`** (App-Setting, Default 64 000) setzt den globalen Output-Token-Cap (`MAX_TOKENS_OUT` in `lib/ai.js`); die Per-Provider-Pendants `ai.ollama.max_tokens_out` / `ai.openai-compat.max_tokens_out` löst `getContextConfigFor(provider)` pro Call auf. Job-spezifische Overrides werden per `Math.min` gegen den Provider-Cap gedeckelt. `.env`-`MODEL_TOKEN` dient nur als einmaliger Bootstrap in die DB (`ENV_MAP` in `lib/app-settings.js`), danach ist der App-Setting-Wert massgeblich.

**`ai.claude.context_window`** (App-Setting, Default 200 000) setzt das gesamte Kontextfenster (Input + Output). Daraus leitet `lib/ai.js` das `INPUT_BUDGET_TOKENS` (= `context_window − max_tokens_out − 2000`) ab. Alle kontextabhängigen Grenzen skalieren automatisch: `SINGLE_PASS_LIMIT`/`PER_CHUNK_LIMIT` (Komplettanalyse), `BOOK_CHAT_TOKEN_BUDGET`-Default, Buch-Chat-Tool-Result-Caps und das Classic-Buch-Chat-Text-Budget. Bei lokalen Modellen auf die native Kontextgrösse setzen (Mistral-Small3.2 / Gemma3 / Llama-3.1: 128 000, ältere: 32 000 / 8 000).

**JSON-Parsing:** `lib/ai.js` hat mehrstufigen Fallback: `JSON.parse()` → `extractBalancedJson()` → `jsonrepair()`.

**Per-User-Override:** Admin setzt `app_users.ai_provider_override` pro User; `lib/ai.js#resolveProvider({ userEmail })` löst per Call auf (Override > globaler `ai.provider` > `'claude'`). Job-Pfade resolven am Job-Start einmal in `effectiveProvider`. Cache-Tabellen haben `provider` im PRIMARY KEY (verhindert Cross-Provider-Bleeding). Details: [docs/ai-providers.md](docs/ai-providers.md).

## Two-Tier-Analyse

Jobs in `routes/jobs/` verwenden ein Single-Pass/Multi-Pass-Muster. Limits und Batch-Grössen sind als Konstanten in `routes/jobs/shared/` definiert — `SINGLE_PASS_LIMIT` und `PER_CHUNK_LIMIT` skalieren dynamisch aus `INPUT_BUDGET_CHARS` (70% / 35%).

## Komplettanalyse-Job

Kern-Pipeline (Figuren/Orte/Songs/Fakten/Szenen/Zeitstrahl/Kontinuität) — Phasen, Single-/Multi-Pass-Entscheidung, Delta-Cache + Checkpoint, Cache-Versionierung, Verify-Stufe, Nacht-Cron und Pflicht-Invarianten: **[docs/komplett.md](docs/komplett.md)**. Standalone-Kontinuitätscheck `POST /jobs/kontinuitaet` (`runKontinuitaetJob`) ebenda.

## Finetune-Export

Ziel: Buch im Modell **internalisieren** (Stil, Welt, Figuren, Fakten, Plot). Darum **maximal grosszügig extrahieren** — lieber zu viele Trainingssamples als zu wenige. Alles, was sich aus Text/Figuren/Szenen/Schauplätzen/Ereignissen/Lektorats-Findings als Q&A, Stil-Fortsetzung, Dialog, Szenen-Generierung, Fakten-Recall etc. ableiten lässt, mitnehmen. Keine künstlichen Sample-Caps, keine vorsichtigen Limits per Sampler — Modell soll Buch nach Finetune möglichst vollständig „kennen". Neue Sampler/Datenquellen tendenziell hinzufügen, nicht filtern. Code: [routes/jobs/finetune-export/](routes/jobs/finetune-export/).

## Custom PDF-Export

**Eigener Renderer** mit druckfertiger PDF/A-2B-Konformität und User-konfigurierbarem Layout, Fonts, Cover, Kapitelgliederung.

**Pipeline:**
```
/jobs/pdf-export (POST, Job-Queue) → loadBookContents → render (pdfkit, subset='PDF/A-2b')
   → Norm-Branch (config.pdfa.standard): 'pdfa' → optional veraPDF-Validate │ 'pdfx' → Ghostscript-Post-Step (PDF/X-3) │ 'none' → durchreichen
                                                          ↓
                                          /jobs/pdf-export/:id/file (Stream)
```

**Module:**
- `routes/jobs/pdf-export.js` — Job-Wrapper, hält PDF-Buffers in `pdfResults`-Map (TTL 2h).
- `lib/pdf-render.js` — pdfkit-Doc-Lifecycle, Cover, Title-Page, TOC, Kapitel-Loop, Header/Footer-Pass.
- `lib/pdf-cover-render.js` — separates Umschlag-PDF (Render-Target `target='cover'` in `routes/jobs/pdf-export.js`): ein Bogen Rückseite|Rücken|Vorderseite, Rückenbreite aus `config.coverSpec` (`paperBulkMmPer1000 × pageCount / 1000`), Front=cover_image, Rückseite optional als `back_cover_image`-BLOB + Klappentext + EAN-13, Bleed/Crop/Falzmarken aus dem `print`-Block.
- `lib/pdf-render/html-walker.js` — linkedom-basiert. Whitelist: h1-h3, p, ul/ol/li, blockquote, pre, hr, img + inline strong/em/u/a. `<div class="poem">` → eigener `poem`-Block. Tabellen werden als Plain-Text-Fallback durchgereicht (kein Layout). Standard-Editor-Markup wird unterstützt.
- `lib/pdf-export-defaults.js` — `defaultConfig()` + `validateConfig(src)`. Strict: unbekannte Keys werden verworfen, Numerik geclampt, Enums whitelisted.
- PDF/A-2B-Subset macht pdfkit nativ via `subset: 'PDF/A-2b'` im PDFDocument-Constructor: hängt `pdfaid:part`/`conformance` ans XMP, schreibt OutputIntent mit eingebettetem sRGB-ICC-Profil aus pdfkit's eigenem Bundle (`node_modules/pdfkit/js/data/sRGB_IEC61966_2_1.icc`). **Nicht** manuell via `doc._root.data.Metadata = …` patchen — pdfkit's `endMetadata()` läuft danach und überschreibt die Referenz.
- `lib/pdfa-validate.js` — veraPDF-CLI-Wrapper. Schreibt Buffer in Tempdatei mit `.pdf`-Extension (CLI liest nicht von stdin), validiert, löscht. Wenn Binary fehlt → `{ available: false }`, Job liefert PDF mit Warnung. ENV `VERAPDF_BIN`, `VERAPDF_FLAVOUR`, `VERAPDF_DISABLED`.
- `lib/pdfx-convert.js` — Ghostscript-Post-Step für PDF/X-3 (Druckvorstufe), greift bei `config.pdfa.standard === 'pdfx'`. `convertToPdfX(buffer, …)` stempelt PDFX-Marker + bettet Output-Intent-ICC ein (Default `assets/icc/PSOuncoated_v3_FOGRA52.icc`); **RGB bleibt** — keine CMYK-Separation, die Druckerei separiert selbst. `execFile` ohne Shell, Buffer in Temp-Datei. ENV `GS_BIN`, `GS_DISABLED`, `PDFX_ICC_PATH`. Fehlt gs-Binary oder ICC → `{ available: false }`, Job liefert das unkonvertierte PDF + Warnung (**non-fatal**, Muster wie veraPDF).
- `lib/font-fetch.js` — Google-Fonts-Loader. Hardcoded Whitelist (~24 Familien). UA-Trick (`Wget/1.13.4`) zwingt Google-CSS-API zu TTF. 30-Tage-TTL via `font_cache`-Tabelle (Stale-while-revalidate: bei Network-Fail wird stale-Cache geliefert).
- `lib/cover-prepare.js` — sharp: Magic-Bytes-Check → JPEG, sRGB, kein Alpha, max. 2400 px Längsseite. PDF/A-tauglich.
- `db/pdf-export.js` + `db/fonts.js` — Profile-CRUD + Font-Cache. **Multiple Profile pro (book, user)** via `(book_id, user_email, name)`-UNIQUE; `book_id=0` für User-Default-Vorlagen. Cover-Bild als BLOB in `pdf_export_profile.cover_image`.

**Frontend:** `pdfExportCard` ([public/js/cards/pdf-export-card.js](public/js/cards/pdf-export-card.js)) mit 7 Tabs im Self-Publishing-Workflow: **Format** (Trim-Preset + Seitenformat + Ränder/Satzspiegel, id `layout`) / **Schrift** / **Kapitel** (Umbruch, Titel-Stil, **Kapitel**-Nummerierung — nicht Seitenzahlen) / **Kopf & Seitenzahlen** (id `pagination`: laufende Kopf-/Fusszeile + komplette Seitennummerierung inkl. Zähler-Skip pro Kapitel/Seite — zentralisiert; alles, was bestimmt welche Zahl eine Seite trägt) / **Titelei & Verzeichnis** (id `frontmatter`: Extras-Platzierung + Inhaltsverzeichnis) / **Cover** / **Druck** (Druckvorstufe + PDF-Norm-Combobox PDF/A · PDF/X · kein, SSoT `config.pdfa.standard`). Tab-Panels sind Partials `public/partials/pdf-export-<id>.html`, via `<!-- @include -->` in `pdf-export.html` gebündelt. Live-Font-Preview lädt Google-Fonts-CSS lazy in den Browser. Profile-Operationen (CRUD, Default, Cover-Upload) gehen an `/pdf-export/...`. Render-Trigger an `/jobs/pdf-export`, Download-Stream `/jobs/pdf-export/:id/file`.

**Wichtige Invarianten:**
- `font.body` braucht `family` aus der Whitelist (lib/font-fetch.js#FONT_LIST). PUT validiert; bad font → 400 `FONT_NOT_ALLOWED`.
- Cover-Bilder werden bei Upload **und** beim Render durch sharp geschleust (defensiv-doppelt; PDF/A erlaubt kein Alpha/CMYK).
- `pageStructure: 'flatten'` (Default) verkettet alle Seiten eines Kapitels ohne Per-Page-Heading; `'nested'` rendert pro Page einen h2-Sub-Heading.
- Job-Result-JSON enthält Metadaten (Größe, MIME, PDF/A-Status), **nicht** den Buffer — der lebt in `routes/jobs/pdf-export.js#pdfResults` und wird über `/jobs/pdf-export/:id/file` gestreamt.
- veraPDF-Failure ist **non-fatal**: Datei wird trotzdem geliefert, Frontend zeigt Warnung.
- `config.pdfa.standard` ist SSoT (`pdfa`/`pdfx`/`none`); Legacy-`pdfa.enabled` leitet sich daraus ab (true nur bei `'pdfa'`). PDF/X-Konvertierung (`'pdfx'`) ist **non-fatal**: fehlt Ghostscript/ICC → unkonvertiertes PDF + Warnung.

**Ops:**
- veraPDF (Java-CLI, ~80 MB inkl. JRE) optional im Container. Fehlt es → Validation skipped, kein Crash.
- sharp ist Pflicht-Dep (Cover + Image-Embeds); libvips wird über das npm-Package mitgeliefert.
- Code: [routes/jobs/pdf-export.js](routes/jobs/pdf-export.js), [routes/pdf-export.js](routes/pdf-export.js), [lib/pdf-render.js](lib/pdf-render.js).

## Chat

Drei unabhängige Chats — Übersicht + Vergleichstabelle in **[docs/chats.md](docs/chats.md)**, Harte Regel „Chat-Spezifikation Pflicht" weiter oben. Alle drei nutzen die Job-Queue und teilen `chat_sessions.kind` + `chat_messages` als Storage.

- **Seiten-Chat** (`/jobs/chat`, `kind='page'`): klassisch, neben dem Editor. Antwortformat enthält `vorschlaege` mit zeichengenauem `original` für Textersetzung (Apply-Zeit-Guard: Ambiguitäts-/Block-Grenzen-/No-Op-Check + `expectedUpdatedAt`-409, siehe Harte Regel „Job-Ergebnisse mit `updatedAt`-Staleness-Check").
- **Buch-Chat** (`/jobs/book-chat`, `kind='book'` mit `page_id IS NULL`, CHECK-Constraint erzwingt die Kombination): agentisch mit `BOOK_CHAT_TOOLS`, kein Vorschläge-System. Tool-Inventar: [docs/buchchat-tools.md](docs/buchchat-tools.md).
- **Recherche-Chat** (`/jobs/research-chat`, `kind='research'`, buchweit + pro User): agentisch, Claude-only mit Web-Suche, Panel in der Recherche-Karte. Schlägt `propose_research_item` vor (User bestätigt → `POST /research`), schreibt nie in den Buchtext. Details: [docs/recherche-chat.md](docs/recherche-chat.md).

## Fehlerbehandlung

- **Jobs:** `try/catch` → `failJob(id, err)` setzt Status auf `'error'` oder `'cancelled'` (bei `AbortError`). Fehler werden in `job.error` gespeichert und geloggt.
- **API-Routen:** Fehlende Parameter → `400 JSON`, unauthentifiziert → `401 JSON`.
- **JSON-Parsing:** Mehrstufiger Fallback in `lib/ai.js` (siehe KI-Provider).
- **DB-Fehler:** Geloggt, blockieren nicht den Request.

## Logging

Winston (`logger.js`): Level `info`, Ausgabe in `schreibwerkstatt.log` (5 MB, 5 Dateien rotiert, `tailable: true` → `schreibwerkstatt.log` ist immer current, ältere Rotationen liegen als `schreibwerkstatt1.log`..`schreibwerkstatt5.log` daneben) + Console. Jobs nutzen Child-Logger mit Kontext: `logger.child({ job, user, book })` → Format: `[INFO][lektorat|user@mail.com|42] Nachricht` (das `lektorat` im Beispiel ist der Job-Typ, nicht die App).

## Projektstruktur (thematische Cluster)

Vollständiges Inventar via `ls`/`find` — hier nur Einstiege und Cluster, damit Drift gegen Datei-Listings nicht jeden Refactor bricht.

- `server.js` — Express-Setup, Auth-Guard, Cron, Route-Mounting.
- `logger.js` — Winston-Config.
- **`lib/`** — Server-Libs. Highlights:
  - `ai.js` (callAI + Provider-Dispatch + JSON-Fallback), `content-store/` (Pages/Chapters/Books-Facade), `html-clean.js` (Page-HTML-Sanitization, **SSoT** vor jedem DB-Write).
  - PDF/Export: `pdf-render.js` + `pdf-render/` (Pipeline), `pdf-export-defaults.js`, `pdfa-validate.js`, `font-fetch.js`, `cover-prepare.js`, `export-builders/` (HTML/MD/EPUB/Plaintext).
  - Cross-cutting: `acl.js`, `admin-mw.js`, `admin-login-ratelimit.js`, `register-ratelimit.js`, `app-settings.js`, `budget.js`, `pricing.js`, `cache-cleanup.js`, `content-mapper.js`, `crypto.js`, `dev-seed.js`, `draft-mindmap-builder.js`, `filenames.js`, `i18n-server.js`, `load-contents.js`, `local-date.js`, `log-context.js`, `mailer.js` + `mailer-templates.js`, `notify.js`, `page-index.js`, `prompts-loader.js`, `search.js`, `slug.js`, `validate.js`.
- **`db/`** — SQLite-Split. Einstieg: `connection.js`, `migrations.js`, `schema.js`, `squashed-schema.js` (Fresh-DB-Fast-Path). Eine Domäne pro File: `books`, `pages`, `page-revisions`, `page-presence`, `figures`, `draft-figures`, `book-access`, `book-categories`, `book-order`, `app-users`, `registration-requests`, `token-usage`, `admin-usage`, `budget-alerts`, `pdf-export`, `fonts`.
- **`routes/`** — Ein Router pro Feature. Namen entsprechen der Routen-Tabelle oben.
  - `jobs.js` mountet alle Job-Sub-Router. Subfolder: `jobs/shared/` (Queue, AI-Helper, Loader, Model, Queries, Router, State) und `jobs/komplett/` (Pipeline: index, job, phases, checkpoint, figuren-merge, remap, utils). Single-File-Job-Router: `lektorat`, `review`, `kapitel`, `chat`, `synonyme`, `figur-werkstatt`, `pdf-export`. Helper-Files (kein Router): `narrative-labels`, `book-chat-tools`, `review-context`. `finetune-export/` als Subfolder mit eigenem Router.
- **`public/`** — SPA.
  - `index.html` Shell; `partials/` werden via `_loadPartials()` nested geladen.
  - `css/` thematisch gesplittet (eine Datei pro Komponente; grosse Cards als Subfolder, z.B. `book-overview/`). `tokens.css` Facade-File (importiert `tokens/`-Module); Cascade via `@layer base, components, utilities`. `tokens.css` selbst unlayered.
  - `js/app.js` Alpine-Root; `js/app/` Root-Slices (`app-state`, `app-view`, `app-ui`, `app-jobs-core`, `app-hash-router`, `app-navigation`, `app-chrome`, `app-komplett`, `app-collab`).
  - `js/cards/` — Alpine-Sub-Komponenten, eine pro Karte. **SSoT-Liste in [feature-registry.js](public/js/cards/feature-registry.js)** — nicht hier pflegen. Shared neben den Karten: `catalog-store.js`, `feature-registry.js`, `job-helpers.js`, `job-feature-card.js`, `card-lifecycle.js`, `palette-card.js`/`palette-fuzzy.js`/`palette-providers.js`.
  - `js/book/` — Buch-/Seiten-Fachmodule (tree, page-view, history, review, kapitel-review, fehler-/stil-heatmap, kontinuitaet, ereignisse, orte, szenen, figuren, ideen, finetune-export, lektorat-time, writing-time, export, songs, book-create, book-settings, bookstats).
  - `js/editor/` — Editor-Fachmodule (`utils`, `edit`, `focus/` + `focus.js`, `find`, `synonyme`, `figur-lookup`, `toolbar`, `lektorat`, `shortcuts`, `draft-storage`). Cards in `cards/editor-*-card.js` importieren von hier.
  - Feature-eigene Submodul-Cluster (Facade-File + gleichnamiger Subfolder): `book-overview.js` + `book-overview/`, `figur-werkstatt.js` + `figur-werkstatt/`, `graph.js` + `graph/`.
  - Weitere Cluster: `js/chat/`, `js/admin/`, `js/api/`, `js/i18n/`, `js/repo/`.
  - `js/prompts.js` Facade; `js/prompts/` Submodule pro Job-Typ (state, schema-utils, blocks, core, lektorat, review, komplett, chat, synonym, finetune, figur-werkstatt).
  - Cross-cutting Top-Level: `utils.js`, `lazy-libs.js` (vis-network/Chart.js on-demand), `features-usage.js`, `user-settings.js`, `num-input.js`, `page-revision-diff.js`, `theme-init.js`, `plausible-init.js`, `tooltip.js`, `fullscreen.js`, `register.js`.

## Tests

`npm test` führt Unit-, Integration-, E2E- und Smoke-Tests nacheinander aus. Einzeln: `npm run test:unit` (Node built-in, parallelisiert, kein Browser), `npm run test:integration` (Node built-in, sequenziell, Job-Pipelines gegen Mock-AI), `npm run test:e2e` (Playwright, Fixture-Harnesses gegen Mock-Server, Chromium nötig), `npm run test:smoke` (Playwright gegen die echte gebootete App). Setup: [tests/](tests/), [playwright.config.js](playwright.config.js), [playwright.app.config.js](playwright.app.config.js).

**Unit** (`tests/unit/*.test.{js,mjs}`, `node --test`) — decken ab:
- JSON-Fallback-Kette ([ai.test.js](tests/unit/ai.test.js)), Stil-/Figuren-Metriken ([page-index.test.js](tests/unit/page-index.test.js)), Prompts-Build ([prompts.test.mjs](tests/unit/prompts.test.mjs)), XSS-Escape-Invariante ([escape-xss.test.mjs](tests/unit/escape-xss.test.mjs)), Request-Validierung ([validate.test.js](tests/unit/validate.test.js)), Job-Reconnect-Events ([job-reconnect.test.mjs](tests/unit/job-reconnect.test.mjs)), Hash-Router ([hash-router.test.mjs](tests/unit/hash-router.test.mjs)), Card-Exklusivität ([card-exclusivity.test.mjs](tests/unit/card-exclusivity.test.mjs)), Editor-Focus-Granularität ([editor-focus.test.mjs](tests/unit/editor-focus.test.mjs), [focus-granularity.test.mjs](tests/unit/focus-granularity.test.mjs)), Szenen-Filter ([szenen-filter.test.mjs](tests/unit/szenen-filter.test.mjs)), Ideen-Prompt + Schema ([ideen-prompt.test.mjs](tests/unit/ideen-prompt.test.mjs), [ideen-schema.test.js](tests/unit/ideen-schema.test.js)), Shared-Jobs-Helper ([shared-jobs.test.js](tests/unit/shared-jobs.test.js)), HTML-Cleaner ([html-clean.test.js](tests/unit/html-clean.test.js)), Page-Stats-Normalisierung ([page-stats-normalization.test.mjs](tests/unit/page-stats-normalization.test.mjs)), Stale-Write-Schutz ([stale-write.test.mjs](tests/unit/stale-write.test.mjs)), PDF-Export ([pdf-export-db.test.js](tests/unit/pdf-export-db.test.js), [pdf-export-defaults.test.js](tests/unit/pdf-export-defaults.test.js), [pdf-html-walker.test.mjs](tests/unit/pdf-html-walker.test.mjs), [pdf-render.test.mjs](tests/unit/pdf-render.test.mjs)), Palette-Fuzzy ([palette-fuzzy.test.mjs](tests/unit/palette-fuzzy.test.mjs)), Streak-Heatmap ([streak-heatmap.test.mjs](tests/unit/streak-heatmap.test.mjs)), Local-Date ([local-date.test.mjs](tests/unit/local-date.test.mjs), [local-date-server.test.js](tests/unit/local-date-server.test.js)), Book-Overview-Load ([book-overview-load.test.mjs](tests/unit/book-overview-load.test.mjs)).

**Integration** (`tests/integration/*.test.js`, `node --test`, sequenziell mit Mock-AI):
- [tests/integration/komplett.test.js](tests/integration/komplett.test.js) – Komplettanalyse-Pipeline (Vollextraktion, Konsolidierung, Block 2).
- [tests/integration/kontinuitaet.test.js](tests/integration/kontinuitaet.test.js) – Standalone-Kontinuitätscheck.
- [tests/integration/review.test.js](tests/integration/review.test.js) – Buch-Review-Job.
- [tests/integration/regression.test.js](tests/integration/regression.test.js) – Cross-Job-Regressionen.
- Helpers in [tests/integration/_helpers/](tests/integration/_helpers/).

**E2E** (`tests/e2e/*.spec.js`, Playwright, [playwright.config.js](playwright.config.js)): isolierte Fixture-Harnesses (mounten je eine Karte mit Mock-Daten gegen [tests/server.js](tests/server.js)), nicht die echte SPA. Specs importieren `test`/`expect` aus [tests/e2e/_helpers/fixtures.js](tests/e2e/_helpers/fixtures.js) (Drop-in für `@playwright/test`) — eine Auto-Fixture hängt den Console-Fehler-Guard ([tests/e2e/_helpers/console-guard.js](tests/e2e/_helpers/console-guard.js)) an und macht den Test rot bei unbehandelten Alpine-/Library-Fehlern. Negativ-Tests, die einen Fehler absichtlich provozieren, rufen `consoleGuard.skip()`; bekannte Meldungen via `consoleGuard.ignore(/…/)`. Specs u.a.: [focus-editor.spec.js](tests/e2e/focus-editor.spec.js) (Fokus-Editor: Toggle, Recenter, Cleanup/Leak), [lektorat.spec.js](tests/e2e/lektorat.spec.js) (Lektorat-Flow), [pdf-export.spec.js](tests/e2e/pdf-export.spec.js) (PDF-Profile), [clean-content.spec.js](tests/e2e/clean-content.spec.js) (Paste-Artefakt-Stripping).

**Smoke** (`tests/e2e-app/*.spec.js`, Playwright, [playwright.app.config.js](playwright.app.config.js)): bootet die **echte** App via `node server.js` mit `LOCAL_DEV_MODE=true` (OAuth gebypasst, Dev-Admin-Session + [lib/dev-seed.js](lib/dev-seed.js)-Kafka-Buch) auf einer Wegwerf-DB (`DB_PATH=tests/.tmp/smoke.db`, Port 8766). [tests/e2e-app/smoke.spec.js](tests/e2e-app/smoke.spec.js) öffnet jede Hauptkarte (Liste aus `EXCLUSIVE_CARDS`, kein Drift) + alle drei Editoren und prüft, dass dabei kein unbehandelter Alpine-/Library-Fehler auftritt. **Warum diese Schicht:** Alpine schluckt Expression-Fehler (loggt + re-throwt async) — nur ein echter Browser über dem kompletten Template-Baum fängt sie. Neue Karte ⇒ automatisch im Smoke (registry-getrieben).

**Bei grösseren UI-Änderungen** (besonders am Editor, Fokus-Modus, Scroll-/Selection-Verhalten, Lektorat-Flow) vor dem Commit automatisch `npm test` ausführen. Schlägt etwas fehl, Ursache klären statt Tests anpassen. Übrige Bereiche weiterhin manuell validieren.
