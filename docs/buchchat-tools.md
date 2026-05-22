# Buch-Chat Tools (Agentic Mode)

Tool-Inventar für den Agentic Buch-Chat. Claude ruft pro Iteration Tools auf, deren Resultate als neue `user`-Turns im Loop landen. Schema-Definitionen (Anthropic-Tool-Format) für das Modell: [public/js/prompts/chat.js#BOOK_CHAT_TOOLS](../public/js/prompts/chat.js#L174). Implementierungen: [routes/jobs/book-chat-tools.js](../routes/jobs/book-chat-tools.js). Dispatcher: [routes/jobs/chat.js#runBookChatJobAgent](../routes/jobs/chat.js#L439).

## Vertrag

Jede Tool-Funktion: `(input, ctx) → JSON-serialisierbares Objekt` (sync oder async). Dispatcher: `executeTool(name, input, ctx)` aus `book-chat-tools.js`.

`ctx` (gebaut in [chat.js#L460](../routes/jobs/chat.js#L460)):
- `bookId` — aus `chat_sessions.book_id` der aktiven Session.
- `userEmail` — Owner-Scope für alle Reads (Reviews, Ideen, Werkstatt sind user-scoped).
- `jobSignal` — `AbortController.signal`, wird vor jedem Tool-Call und im Loop geprüft.
- `logger` — Job-Child-Logger.

## Truncation (zwei Stufen)

1. `_truncateResult(obj)` in [book-chat-tools.js#L27](../routes/jobs/book-chat-tools.js#L27): `JSON.stringify(obj).length > MAX_RESULT_CHARS` → falls `obj.results[]` vorhanden, auf 10 Einträge kürzen + `truncated: true` + `total_results`; sonst hart auf `MAX_RESULT_CHARS − 100` Zeichen.
2. `TOOL_RESULT_CAP_CHARS` in [chat.js#L429](../routes/jobs/chat.js#L429): zweiter Schnitt direkt vor Übergabe an das Modell.

`MAX_RESULT_CHARS = max(4000, INPUT_BUDGET_CHARS / 36)` — skaliert mit `MODEL_CONTEXT`. Listen-Limits (`MAX_SEARCH_RESULTS = 30`, `MAX_PAGES_PER_FETCH = 20`) bleiben fix (UI-Ergonomie).

## Loop-Constraints

- `BOOK_CHAT_MAX_TOOL_ITER = 6` (env `BOOK_CHAT_MAX_TOOL_ITER`). Nach 6 Iterationen ohne `stop_reason='end_turn'` bricht der Loop ab und der letzte Text wird geliefert.
- Aktivierung: `API_PROVIDER=claude` und `BOOK_CHAT_MODE != 'classic'`. Andere Provider/Modes nutzen den klassischen Single-Pass-Chat ohne Tools.

## Tools

26 Tools, gruppiert nach Domäne. Alle Read-Only ausser `final_answer` (Pflicht-Endpunkt, kein DB-Read).

### Buch/Kapitel-Überblick

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `list_chapters` | – | Alle Kapitel + Seiten (`pages[{page_id,page_name,words}]`), `total_pages`/`total_words`. Einstieg für IDs. | `chapters` + `pages` + `page_stats` |
| `get_chapter_stats` | `chapter_id` | Wortzahl, Sätze, Dialoganteil, Top-Figuren-Erwähnungen eines Kapitels. | `page_stats` + `page_figure_mentions` |
| `get_stil_metrics` | `scope: book/chapter/page`, `chapter_id?`, `metric?`, `order?`, `limit?` | Aggregat aus `page_stats`: words/chars/sentences/dialog/filler/passive/adverb/avg_sentence_len/p90/LIX/Flesch. `scope=page` sortiert Top-N. | `page_stats` |
| `count_pronouns` | `per_chapter?`, `pronouns?[]` | Pronomen-Zählung (Narrativ vs. Dialog). Pronomen-Gruppen: `ich`, `du`, `er`, `sie_sg`, `wir`, `ihr_pl`, `man`. | `page_stats` (Pronomen-Buckets) |
| `get_book_settings` | – | Sprache, Region, Buchtyp (Label aufgelöst), Erzählperspektive + Erzählzeit (Label via [routes/jobs/narrative-labels.js](../routes/jobs/narrative-labels.js)), `buch_kontext` (User-Vorgaben an die KI), `is_finished`, `daily_goal_chars`. Pflicht vor stil-/sprachbezogenen Antworten. | `book_settings` + `books.name` |

### Seiten-Text

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `get_pages` | `ids: integer[]` (max 20), `max_chars_per_page?` | Volltext bestimmter Seiten + falls vorhanden `latest_check {checked_at, error_count, fazit, stilanalyse}` aus `page_checks`. | Content-Store-Facade `loadPage(id)` (backend-agnostisch) + `page_checks` |
| `search_passages` | `pattern`, `regex?`, `max_results?` (default 10, max 30) | Volltext-Suche; liefert Treffer mit Snippet ±120 Zeichen. Offsets kompatibel mit `quote_passage`. | `pages.preview_text` → `htmlToText` |
| `quote_passage` | `page_id`, `offset`, `length` (max 800), `context_chars?` (default 80, max 300) | Zeichen-genaues Zitat aus einer Seite. Liefert `quote`, `before`/`after`, `page_chars`. Pflicht-Werkzeug vor jeder wörtlichen Zitierung in `final_answer` — kein „aus Erinnerung paraphrasieren". | Content-Store `loadPage` → `htmlToPlainText` |
| `find_repetitions` | `n?` (2-5, default 3), `scope?` (book/chapter/page), `chapter_id?`/`page_id?`, `min_count?`, `limit?` (default 30, max 100), `ignore_stopwords?` | N-Gramm-Frequenzanalyse mit Stopwort-Filter (DE+EN). Returns `results[{phrase, count, sample_pages}]`. Sprach-Tics/redundante Phrasen. | `pages.body_html` → `htmlToPlainText` |
| `get_dialogue` | `chapter_id?`, `page_id?`, `figur_id?`/`figur_name?`, `min_length?`, `limit?` (default 30, max 100) | Heuristische Dialog-Extraktion (Anführungszeichen, Speech-Verb+Doppelpunkt, Em-Dash) via `findDialogRanges` aus [lib/page-index.js](../lib/page-index.js). Mit Figur-Filter: ±100-Zeichen-Sprecherheuristik. Offsets kompatibel mit `quote_passage`. | `pages.body_html` → `htmlToPlainText` + `findDialogRanges` |

### Figuren

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `get_figure_mentions` | `figur_id` ∨ `figur_name` | Wo + wie oft eine Figur erwähnt wird, nach Kapitel/Seite. | `page_figure_mentions` |
| `get_figure_profile` | `figur_id` ∨ `figur_name` | Vollprofil: Stammdaten, Tags, Zitate, Lebensereignisse, Szenen, Kapitelauftritte, alle Beziehungen (beide Richtungen). | `figures` + `figure_events` + `figure_scenes` + `figure_relations` + `figure_appearances` |
| `get_figure_relations` | `figur_id?` ∨ `figur_name?` | Soziogramm: alle Kanten oder nur die einer Figur. Typ, Beschreibung, Machtverhältnis, bis zu 3 Belege. | `figure_relations` |
| `find_first_last_mention` | `figur_id?` ∨ `figur_name?` ∨ `loc_id?` | Erste + letzte Erwähnung. Figuren seiten-genau aus `page_figure_mentions`, Orte kapitel-genau aus `location_chapters` (+ `locations.erste_erwaehnung_page_id`). Arc-Tracking. | `page_figure_mentions` / `location_chapters` |

### Orte / Szenen

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `list_locations` | `chapter_id?` | Alle Schauplätze + Typ, Beschreibung, Stimmung, erste Erwähnung, betroffene Kapitel (mit Häufigkeit), assoziierte Figuren. | `locations` + `location_chapters` + `location_figures` |
| `list_scenes` | `chapter_id?`, `page_id?`, `figur_id?` ∨ `figur_name?`, `loc_id?`, `limit?` (default 50, max 200) | Szenenkatalog mit Titel, Wertung, Kommentar, Kontext, beteiligte Figuren/Orte. | `figure_scenes` + Bridges |

### Reviews / Lektorat

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `get_book_review` | – | Letzte Buchbewertung des Users (gesamtnote, Stärken/Schwächen, Fazit, Zusammenfassung). | `book_reviews` |
| `list_chapter_reviews` | `chapter_ids?[]`, `sort?` (`note_desc`/`note_asc`/`chapter`), `limit?` (default 30, max 100) | Kapitelbewertungen + `ohne_bewertung[]`. | `chapter_reviews` |
| `get_lektorat_hotspots` | `chapter_id?`, `min_errors?`, `limit?` (default 20, max 100) | Aggregat über `page_checks` (letzter Check pro Seite): pro Kapitel total/avg/max Fehler + Top-N-Seiten mit Fazit-Snippet. | `page_checks` |

### Kontinuität / Zeitstrahl

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `list_continuity_issues` | `schwere?`, `typ?`, `chapter_id?`, `limit?` (default 30, max 100) | Befunde des letzten Kontinuitätschecks: Typ, Schwere, Beschreibung, `stelle_a`/`stelle_b`, Empfehlung, betroffene Figuren + Kapitel. | `continuity_issues` + Bridges |
| `get_timeline` | `figur_id?` ∨ `figur_name?`, `typ?`, `limit?` (default 60, max 200) | Konsolidierter Zeitstrahl (`zeitstrahl_events`) chronologisch nach `sort_order`. | `zeitstrahl_events` + Bridges |

### Revisionen

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `diff_page_revisions` | `page_id`, `from_rev_id?`, `to_rev_id?` | Plain-Text-Word-Diff zweier Revisionen einer Seite (Default: zwei jüngste). Liefert `summary{add,del,change}`, `chars_delta`, `blocks[{kind, text\|from/to}]`. Max 100 Blöcke, je 600 Zeichen geclampt. | `page_revisions` + `jsdiff.diffWordsWithSpace` |

### Ideen / Werkstatt

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `list_ideen` | `erledigt?`, `page_id?`, `chapter_id?`, `limit?` (default 50, max 200) | Seiten-Ideen/Notizen des Users. Offene zuerst. | `ideen` |
| `list_werkstatt_drafts` | – | Figuren-Werkstatt-Drafts des Users für das Buch: Name, Archetyp, Quell-Figur, notes-Vorschau, Run-Counts. | `draft_figures` + `werkstatt_runs` |
| `get_werkstatt_draft` | `draft_id` ∨ `figur_name`, `include_runs?` (default true), `run_limit?` (default 5, max 20) | Werkstatt-Draft inkl. Mindmap (eingerückter Plaintext, User-Locale aufgelöst) + KI-Läufe (Brainstorm/Consistency) gekürzt. | `draft_figures` + `werkstatt_runs` |

### Endpunkt

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `final_answer` | `antwort: string` | Pflicht-Endpunkt der Loop: Modell ruft das Tool als letzten Schritt mit der finalen Antwort an den User. `runBookChatJobAgent` fängt es vor `executeTool` ab, setzt `finalText = JSON.stringify({antwort})` und bricht den Loop. Ersetzt freies JSON-Output am Ende — Schema des Tools erzwingt die Struktur. Bei mehreren Tool-Uses in einer Iteration terminiert `final_answer` unabhängig von der Position. | – (kein DB-Read) |

## Neues Tool hinzufügen

1. Implementierung in [book-chat-tools.js](../routes/jobs/book-chat-tools.js): `function tool_<name>(input, ctx) { ... return obj; }`. Read-Only, deterministisch, kein KI-Call.
2. In der `TOOLS`-Map ([book-chat-tools.js#L1472](../routes/jobs/book-chat-tools.js#L1472)) registrieren.
3. Schema in [chat.js#BOOK_CHAT_TOOLS](../public/js/prompts/chat.js#L174) ergänzen: `name`, `description` (kostet Input-Tokens — knapp halten, aber **Beispiele** für „wann nutzt das Modell mich" reinpacken), `input_schema`. Property-Descriptions geben Default-/Max-Werte an, damit das Modell sie nicht aus Resultaten zurückrechnen muss.
4. Result-Shape so wählen, dass `_truncateResult` greift, wenn nötig: `{ results: [...] }` mit `> 5` Items aktiviert den Listen-Kürzungs-Pfad mit `truncated`-Flag.
5. Bei Content-Store-/DB-Reads `userEmail`-Scope nicht vergessen — alle user-scoped Daten (Reviews, Ideen, Werkstatt, Lektorat-Checks) sind pro User isoliert.
6. `jobSignal` ist im Loop bereits überwacht; lange Reads sollten ihn dennoch konsultieren wenn praktikabel.

## Frontend

Im Buch-Chat zeigt jede AI-Nachricht ein `context_info`-Panel mit aufgelisteten Tool-Calls (Name + gekürztes Input, Iteration). Quelle: `toolLog[]` aus [chat.js#L476](../routes/jobs/chat.js#L476), gespeichert in `chat_messages.context_info` (JSON).
