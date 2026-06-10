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

- Max. Tool-Iterationen: App-Setting `jobs.book_chat.max_tool_iter` (Default 6). Nach Erreichen ohne `stop_reason='end_turn'` bricht der Loop ab und der letzte Text wird geliefert.
- Aktivierung (`_bookChatUseAgent`): effektiver Provider `claude` und `jobs.book_chat.mode != 'classic'` (`auto`/`agent`). Andere Provider/Modes nutzen den klassischen Single-Pass-Chat ohne Tools (`runBookChatJob`).
- Per-Job-Claude-Override (analog Komplettanalyse): `ai.claude.model.bookchat` / `…context_window.bookchat` / `…max_tokens_out.bookchat` / `…timeout_ms.bookchat` / `…effort.bookchat` (App-Settings, leer/0 = folgt global). Greift nur bei `ai.provider = claude`, für **beide** Buch-Chat-Pfade (klassisch + agentisch). Gebunden via `setContext` in `routes/jobs/chat.js#_applyBookChatClaudeOverrides` **vor** `getContextConfigFor`, damit Token-Budget/Tool-Result-Cap das Override-Kontextfenster reflektieren. Kein eigener Timeout-Default (anders als komplett). So läuft z.B. der Tool-Loop auf Opus, während global Sonnet 4.6 fürs Lektorat bleibt.

## Claude-/Opus-Call (Tool-Use)

Der agentische Loop ruft `callAIWithTools` → `_callClaudeWithToolsAttempt` ([lib/ai.js](../lib/ai.js)) — ein **eigener Pfad** neben dem Nicht-Tool-`_callClaudeAttempt`. Wer den Buch-Chat auf Opus optimiert, fasst diesen Pfad an, nicht den Nicht-Tool-Pfad.

- **Adaptive Thinking:** auf Opus 4.7+ sendet der Tool-Pfad `thinking:{type:'adaptive'}` (Modell-Erkennung `_claudeUsesAdaptiveThinking`, identisch zum temperature-Verbot). **Pflicht-Invariante:** die im Stream erfassten `thinking`/`redacted_thinking`-Blöcke (inkl. `signature`) werden in `rawContentBlocks` in Originalreihenfolge zurückgespielt — der assistant-Turn MUSS mit dem Thinking-Block beginnen, sonst quittiert die Folge-Iteration mit HTTP 400. Sonnet 4.6 / Opus 4.6 / lokale Provider: kein `thinking`-Feld → unverändert. **Folge:** Thinking zählt gegen `max_tokens_out` — Output-Cap (`…max_tokens_out.bookchat`) großzügig halten (≥ 32–64K), sonst Truncation-Wurf.
- **Prompt-Caching (Multi-Turn):** System + Tools tragen einen Cache-Breakpoint (über `_buildClaudeSystemBlocks`); zusätzlich setzt `_withCacheBreakpointOnLastMessage` pro Iteration einen Breakpoint auf den letzten Block der letzten Nachricht. Die wachsende `tool_result`-History wird damit ab Iteration 2 aus dem Cache gelesen statt voll bezahlt (Render-Order tools→system→messages; 2 von max 4 Breakpoints). Nur der Tool-Pfad; das Original-`messages`-Array bleibt unangetastet (geklont).
- **effort:** `ai.claude.effort.bookchat` (`low|medium|high|xhigh|max`) → `output_config.effort`, nur für den Buch-Chat (ALS-Override `claudeEffort`; andere Jobs unberührt). Tier-Mismatch wird geklemmt (`max`→Opus-only, `xhigh`→Opus-4.7+, sonst `high`) statt 400. Leer = API-Default (`high`).

## Tools

31 Tools, gruppiert nach Domäne. Alle Read-Only ausser `final_answer` (Pflicht-Endpunkt, kein DB-Read).

### Buch/Kapitel-Überblick

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `list_chapters` | – | Alle Kapitel + Seiten (`pages[{page_id,page_name,words}]`), `total_pages`/`total_words`. Einstieg für IDs. | `chapters` + `pages` + `page_stats` |
| `list_figures` | `sort?` (`mentions_desc`/`name`/`presence_desc`), `limit?` (default 50, max 200) | Flacher Figurenkatalog: `fig_id`, Name, Kurzname, Typ, Rolle, Präsenz, `mentions` (Summe aus Index). Light-Einstieg vor ID-basierten Folge-Calls. | `figures` + `page_figure_mentions` |
| `get_stil_metrics` | `scope: book/chapter/page`, `chapter_id?`, `include_figures?`, `metric?`, `order?`, `limit?` | Aggregat aus `page_stats`: words/chars/sentences/dialog/filler/passive/adverb/avg_sentence_len/p90/LIX/Flesch. `scope=page` sortiert Top-N. `scope=chapter` + `include_figures=true` hängt Top-5-Figuren-Erwähnungen pro Kapitel an. | `page_stats` (+ `page_figure_mentions` bei `include_figures`) |
| `count_pronouns` | `per_chapter?`, `pronouns?[]` | Pronomen-Zählung (Narrativ vs. Dialog). Pronomen-Gruppen: `ich`, `du`, `er`, `sie_sg`, `wir`, `ihr_pl`, `man`. | `page_stats` (Pronomen-Buckets) |
| `get_book_settings` | – | Sprache, Region, Buchtyp (Label aufgelöst), Erzählperspektive + Erzählzeit (Label via [routes/jobs/narrative-labels.js](../routes/jobs/narrative-labels.js)), `buch_kontext` (User-Vorgaben an die KI), `is_finished`, `daily_goal_chars`. Pflicht vor stil-/sprachbezogenen Antworten. | `book_settings` + `books.name` |

### Seiten-Text

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `get_pages` | `ids: integer[]` (max 20), `max_chars_per_page?` | Volltext bestimmter Seiten + falls vorhanden `latest_check {checked_at, error_count, fazit, stilanalyse}` aus `page_checks`. | Content-Store-Facade `loadPage(id)` (backend-agnostisch) + `page_checks` |
| `get_chapter_text` | `chapter_id`, `max_pages?` (1-20), `max_chars_per_page?` | Volltext aller Seiten eines Kapitels in einem Call. Spart die Sequenz `list_chapters → get_pages`. Liefert `pages[{page_id,page_name,text,truncated}]` + `total_pages`. | `chapters` + `pages` + Content-Store `loadPage` |
| `search_passages` | `pattern`, `regex?`, `chapter_id?`, `page_id?`, `max_results?` (default 10, max 30) | Volltext-Suche via FTS5-Index (Literal-Pfad, bm25-sortiert) → exakte Offsets + Snippet ±120 Zeichen. Mit `regex=true` umgeht FTS5 und scannt alle Seiten direkt. Mit `chapter_id`/`page_id` einschränkbar. Offsets kompatibel mit `quote_passage`. | `search_index` (FTS5) → `pages.body_html` → `htmlToPlainText` |
| `quote_passage` | `page_id`, `offset`, `length` (max 800), `context_chars?` (default 80, max 300) | Zeichen-genaues Zitat aus einer Seite. Liefert `quote`, `before`/`after`, `page_chars`. Pflicht-Werkzeug vor jeder wörtlichen Zitierung in `final_answer` — kein „aus Erinnerung paraphrasieren". | Content-Store `loadPage` → `htmlToPlainText` |
| `quote_match` | `page_id`, `pattern` (max 800), `occurrence?` (default 1), `context_chars?` | Bequemes Pendant zu `quote_passage`: Server sucht den Pattern (case-insensitive Literal) selbst und gibt `offset`/`length`/`quote`/`before`/`after`/`occurrence`/`total_matches` zurück. Spart `search_passages → quote_passage`. | Content-Store `loadPage` → `htmlToPlainText` |
| `find_repetitions` | `n?` (2-5, default 3), `scope?` (book/chapter/page), `chapter_id?`/`page_id?`, `min_count?`, `limit?` (default 30, max 100), `ignore_stopwords?` | N-Gramm-Frequenzanalyse mit Stopwort-Filter (DE+EN). Returns `results[{phrase, count, sample_pages}]`. Sprach-Tics/redundante Phrasen. | `pages.body_html` → `htmlToPlainText` |
| `get_dialogue` | `chapter_id?`, `page_id?`, `figur_id?`/`figur_name?`, `min_length?`, `limit?` (default 30, max 100) | Heuristische Dialog-Extraktion (Anführungszeichen, Speech-Verb+Doppelpunkt, Em-Dash) via `findDialogRanges` aus [lib/page-index.js](../lib/page-index.js). Mit Figur-Filter: ±100-Zeichen-Sprecherheuristik. Offsets kompatibel mit `quote_passage`. | `pages.body_html` → `htmlToPlainText` + `findDialogRanges` |

### Figuren

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `get_figure_mentions` | `figur_id` ∨ `figur_name` | Wo + wie oft eine Figur erwähnt wird, nach Kapitel/Seite. Liefert ausserdem `first_appearance`, `last_appearance`, `total_mentions`, `pages_with_mention` (Arc-Tracking). | `page_figure_mentions` |
| `get_figure_profile` | `figur_id` ∨ `figur_name` | Vollprofil: Stammdaten, Tags, Zitate, Lebensereignisse, Szenen, Kapitelauftritte, alle Beziehungen (beide Richtungen). | `figures` + `figure_events` + `figure_scenes` + `figure_relations` + `figure_appearances` |
| `get_figure_relations` | `figur_id?` ∨ `figur_name?` | Soziogramm: alle Kanten oder nur die einer Figur. Typ, Beschreibung, Machtverhältnis, bis zu 3 Belege. | `figure_relations` |

### Orte / Szenen

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `list_locations` | `chapter_id?` | Alle Schauplätze + Typ, Beschreibung, Stimmung, erste Erwähnung, betroffene Kapitel (mit Häufigkeit), `last_chapter` (Arc-Ende kapitel-genau), assoziierte Figuren. | `locations` + `location_chapters` + `location_figures` |
| `get_location_profile` | `loc_id?` ∨ `name?` | Tiefes Einzel-Ort-Profil (Pendant zu `get_figure_profile`): Stammdaten + alle Kapitel (mit Häufigkeit) + `last_chapter` + assoziierte Figuren + alle Szenen am Ort (Titel, Wertung, Kapitel/Seite) + Counts. | `locations` + `location_chapters` + `location_figures` + `scene_locations` + `figure_scenes` |
| `list_scenes` | `chapter_id?`, `page_id?`, `figur_id?` ∨ `figur_name?`, `loc_id?`, `limit?` (default 50, max 200) | Szenenkatalog mit Titel, Wertung, Kommentar, Kontext, beteiligte Figuren/Orte. | `figure_scenes` + Bridges |
| `list_world_facts` | `kategorie?` (exakt), `subjekt?` (Teilstring) | Etablierte Welt-Fakten/Weltregeln (deklaratives Buch-Wissen aus der Komplettanalyse): Magiesystem-Regeln, Geografie, Daten. Pro Fakt kategorie, subjekt, fakt-Text, betroffene Kapitel. | `world_facts` + `world_fact_chapters` |

### Songs / Soundtrack

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `list_songs` | `chapter_id?`, `figur_id?` ∨ `figur_name?`, `scene_id?`, `limit?` (default 50, max 200) | Soundtrack/Musikbibliothek: Titel, Interpret, Genre, Kontext-Typ, Beschreibung, Stimmung, erste Erwähnung + verknüpfte Kapitel (mit Häufigkeit), Figuren, Szenen. Filterbar nach Kapitel/Figur/Szene. | `songs` + `song_chapters` + `song_figures` + `song_scenes` |

### Reviews / Lektorat

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `get_reviews` | `scope?` (`book`/`chapter`, default `chapter`), `chapter_ids?[]`, `sort?`, `limit?` | `scope=book`: letzte Buchbewertung (gesamtnote, Stärken/Schwächen, Fazit, Zusammenfassung). `scope=chapter`: Kapitelbewertungen + `ohne_bewertung[]`. | `book_reviews` / `chapter_reviews` |
| `get_lektorat_hotspots` | `chapter_id?`, `min_errors?`, `limit?` (default 20, max 100) | Aggregat über `page_checks` (letzter Check pro Seite): pro Kapitel total/avg/max Fehler + Top-N-Seiten mit Fazit-Snippet. | `page_checks` |
| `get_lektorat_findings` | `page_id?`, `chapter_id?`, `typ?`, `limit?` (default 30, max 100) | Einzelbefunde aus `page_checks.errors_json` (letzter Check pro Seite). Liefert `findings[{page_id,page_name,chapter_id,checked_at,typ,original,korrektur,erklaerung,offset?,length?}]` + `by_typ`-Verteilung + `total_findings`. Filterbar nach Typ (`stil`, `grammatik`, …). | `page_checks.errors_json` |

### Kontinuität / Zeitstrahl

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `list_continuity_issues` | `schwere?`, `typ?`, `chapter_id?`, `limit?` (default 30, max 100) | Befunde des letzten Kontinuitätschecks: Typ, Schwere, Beschreibung, `stelle_a`/`stelle_b`, Empfehlung, betroffene Figuren + Kapitel. | `continuity_issues` + Bridges |
| `get_timeline` | `figur_id?` ∨ `figur_name?`, `typ?`, `limit?` (default 60, max 200) | Konsolidierter Zeitstrahl (`zeitstrahl_events`) chronologisch nach `sort_order`. | `zeitstrahl_events` + Bridges |

### Revisionen

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `list_revisions` | `page_id`, `limit?` (default 20, max 100) | Revisionsliste einer Seite: `rev_id`, `created_at`, `source`, `chars`, `words`, `summary`. Plus `total_revisions`. Vorstufe zu `diff_page_revisions` mit gezielten rev_ids. | `page_revisions` |
| `diff_page_revisions` | `page_id`, `from_rev_id?`, `to_rev_id?` | Plain-Text-Word-Diff zweier Revisionen einer Seite (Default: zwei jüngste). Liefert `summary{add,del,change}`, `chars_delta`, `blocks[{kind, text\|from/to}]`. Max 100 Blöcke, je 600 Zeichen geclampt. | `page_revisions` + `jsdiff.diffWordsWithSpace` |

### Ideen / Werkstatt

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `list_ideen` | `erledigt?`, `page_id?`, `chapter_id?`, `limit?` (default 50, max 200) | Seiten-Ideen/Notizen des Users. Offene zuerst. | `ideen` |
| `list_werkstatt_drafts` | — | Liste aller Werkstatt-Drafts (Name, Archetyp, Quell-Figur, notes-Vorschau, Run-Counts, letzter Lauf). | `draft_figures` + `werkstatt_runs` |
| `get_werkstatt_draft` | `draft_id?` ∨ `figur_name?`, `include_runs?` (default true), `run_limit?` (default 5, max 20) | Detail eines Drafts inkl. Mindmap (eingerückter Plaintext, User-Locale aufgelöst) + KI-Läufe (Brainstorm/Consistency) gekürzt. | `draft_figures` + `werkstatt_runs` |
| `find_first_last_mention` | `figur_id?` ∨ `figur_name?` ∨ `loc_id?` | Erste + letzte Erwähnung einer Figur (page-level) bzw. eines Orts (chapter-level). Schmaler als `get_figure_mentions`. | `page_figure_mentions` / `location_chapters` |

### Endpunkt

| Tool | Input | Zweck | Quelle |
|------|-------|-------|--------|
| `final_answer` | `antwort: string`, `zitate?: [{page_id, offset, length, quote}]` | Pflicht-Endpunkt der Loop: Modell ruft das Tool als letzten Schritt mit der finalen Antwort an den User. `runBookChatJobAgent` fängt es vor `executeTool` ab, setzt `finalText = JSON.stringify({antwort})` und bricht den Loop. Ersetzt freies JSON-Output am Ende — Schema des Tools erzwingt die Struktur. Bei mehreren Tool-Uses in einer Iteration terminiert `final_answer` unabhängig von der Position. **Halluzinationsschutz:** Wenn `zitate` mitgeliefert wird, validiert `validateFinalAnswerCitations` (Content-Store-Reload pro Seite) jeden Eintrag — `text.slice(offset, offset+length) === quote`. Ergebnis landet als `citation_validation` + `citations_invalid` in `toolLog`/`context_info`; ungültige Zitate werden geloggt, aber der Loop bricht NICHT ab (Antwort wird trotzdem ausgeliefert — die Validierung dient als Beweisspur). | – (kein DB-Read; Validierung nutzt Content-Store) |

## Neues Tool hinzufügen

1. Implementierung in [book-chat-tools.js](../routes/jobs/book-chat-tools.js): `function tool_<name>(input, ctx) { ... return obj; }`. Read-Only, deterministisch, kein KI-Call.
2. In der `TOOLS`-Map ([book-chat-tools.js#L1472](../routes/jobs/book-chat-tools.js#L1472)) registrieren.
3. Schema in [chat.js#BOOK_CHAT_TOOLS](../public/js/prompts/chat.js#L174) ergänzen: `name`, `description` (kostet Input-Tokens — knapp halten, aber **Beispiele** für „wann nutzt das Modell mich" reinpacken), `input_schema`. Property-Descriptions geben Default-/Max-Werte an, damit das Modell sie nicht aus Resultaten zurückrechnen muss.
4. Result-Shape so wählen, dass `_truncateResult` greift, wenn nötig: `{ results: [...] }` mit `> 5` Items aktiviert den Listen-Kürzungs-Pfad mit `truncated`-Flag.
5. Bei Content-Store-/DB-Reads `userEmail`-Scope nicht vergessen — alle user-scoped Daten (Reviews, Ideen, Werkstatt, Lektorat-Checks) sind pro User isoliert.
6. `jobSignal` ist im Loop bereits überwacht; lange Reads sollten ihn dennoch konsultieren wenn praktikabel.

## Frontend

Im Buch-Chat zeigt jede AI-Nachricht ein `context_info`-Panel mit aufgelisteten Tool-Calls (Name + gekürztes Input, Iteration). Quelle: `toolLog[]` aus [chat.js#L476](../routes/jobs/chat.js#L476), gespeichert in `chat_messages.context_info` (JSON).
