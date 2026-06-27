# Die drei Chats

Die App hat **drei unabhängige Chats**. Sie teilen sich nur das Storage-Modell (`chat_sessions` + `chat_messages`, diskriminiert über `chat_sessions.kind`) und die geteilte Frontend-Basis [public/js/chat/chat-base.js](../public/js/chat/chat-base.js) (`makeChatMethods`). Charakter, Job-Pfad, Tool-Set und Skopierung sind je Chat verschieden — bei Änderungs-/Bugfix-Wünschen am „Chat" **immer** zuerst klären, welcher gemeint ist (siehe Harte Regel „Chat-Spezifikation Pflicht" in [CLAUDE.md](../CLAUDE.md)).

## Übersicht

| | **Seiten-Chat** | **Buch-Chat** | **Recherche-Chat** |
|---|---|---|---|
| Karte / Frontend | `chatCard` ([chat-card.js](../public/js/cards/chat-card.js)) | `bookChatCard` ([book-chat-card.js](../public/js/cards/book-chat-card.js)) | Panel in `rechercheCard` ([recherche-card.js](../public/js/cards/recherche-card.js)) |
| Methods-Modul | [public/js/chat/chat.js](../public/js/chat/chat.js) | [public/js/chat/book-chat.js](../public/js/chat/book-chat.js) | [public/js/chat/research-chat.js](../public/js/chat/research-chat.js) |
| Job-POST | `/jobs/chat` | `/jobs/book-chat` | `/jobs/research-chat` |
| Job-Runner | `runChatJob` ([routes/jobs/chat.js](../routes/jobs/chat.js)) | `runBookChatJob` / `runBookChatJobAgent` ([routes/jobs/chat.js](../routes/jobs/chat.js)) | `runResearchChatJob` ([routes/jobs/research-chat.js](../routes/jobs/research-chat.js)) |
| Session-`kind` | `'page'` (mit `page_id`) | `'book'` (`page_id IS NULL`) | `'research'` (`page_id IS NULL`, buchweit) |
| Skopierung | pro Seite | pro Buch | pro Buch + User |
| Provider | alle | alle (Tool-Loop nur Claude) | **Claude-only** (mit Anthropic-Web-Suche) |
| Tool-Loop | nein (klassisch) | ja, agentisch (`BOOK_CHAT_TOOLS`) | ja, agentisch (eigenes Tool-Set + Web-Suche) |
| Schreibt? | schlägt `vorschlaege` mit zeichengenauem `original` vor (User wendet an) | nein (read-only; Ausnahme `generate_image`) | schlägt `propose_research_item` vor (User bestätigt → POST `/research`) |

## Seiten-Chat

Läuft **neben dem Editor** (Ausnahme zur Exklusivitäts-Regel: kein `_closeOtherMainCards` beim Öffnen). Klassischer Chat ohne Tool-Loop. Antwortformat enthält `vorschlaege` mit zeichengenauem `original` für Textersetzung; unterliegt dem `updatedAt`-Staleness-Check (Vorschlag wird verworfen, wenn der User während der Analyse gespeichert hat). Session-`kind = 'page'` mit gesetztem `page_id`; Root dispatcht `chat:reset` beim Seitenwechsel.

## Buch-Chat

Buchweiter agentischer Chat **ohne** Vorschläge-System. Sessions: `kind = 'book'` mit `page_id IS NULL` (CHECK-Constraint erzwingt die Kombination). Read-only-Tool-Vertrag mit 33 Tools (Inventar, `ctx`-Vertrag, Truncation, Loop-Constraints, neues Tool anlegen: **[docs/buchchat-tools.md](buchchat-tools.md)**). Einzige bewusste Ausnahme zum Read-Only-Vertrag: `generate_image` (**[docs/image.md](image.md)**) — nie in den Manuskript-Text. Per-Job-Claude-Override möglich (`ai.claude.*.bookchat`). Root dispatcht `book-chat:reset`.

## Recherche-Chat

Agentischer Chat als **Panel in der Recherche-/Wissensboard-Karte**, **Claude-only** mit Anthropics serverseitigem `web_search`-Tool. Aufbau analog `runBookChatJobAgent`, aber eigenes Tool-Set + Web-Suche, ohne Seiten-Vorladen/Zitat-Validierung. Rückwärtsgewandt im Sinne der App-Philosophie: recherchiert + sammelt Material, **schreibt nie in den Buchtext**. Vorschläge (`propose_research_item`) werden **nicht** automatisch gespeichert — sie kommen in `context_info.proposals` zurück, der User bestätigt sie im Frontend (POST `/research`). Session-`kind = 'research'`, pro Buch + User gescoped. Panel nur sichtbar, wenn der effektive Provider Claude ist + Kill-Switch `research_chat.enabled` ≠ false (`/config` → `researchChat.enabled`). Volle Details (Tool-Tabelle, Loop, Bestätigungs-Modell): **[docs/recherche-chat.md](recherche-chat.md)**.

## Geteiltes

- **Storage:** `chat_sessions` (diskriminiert über `kind`) + `chat_messages`. Beim Buch-Migration-Export werden Seiten- und Buch-Chat mitgenommen ([docs/book-migration.md](book-migration.md)).
- **Frontend-Basis:** [chat-base.js](../public/js/chat/chat-base.js) (`makeChatMethods`) — gemeinsames Verhalten, in die jeweilige Card gespreadet. Implementierungs-Detail, keine fachliche Kopplung.
- **Temperatur:** `ai.chat_temperature` (app_settings) überschreibt Provider-Defaults für Seiten- **und** Buch-Chat ([docs/ai-providers.md](ai-providers.md)).
