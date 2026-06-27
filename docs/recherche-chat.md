# Recherche-Chat

Agentischer Chat als **Panel in der Recherche-Karte** ([public/partials/recherche.html](../public/partials/recherche.html)). Recherchiert im offenen Web **und** im vorhandenen Recherche-Material, kennt die Buch-Entitäten als Kontext und schlägt Fundstücke als neue Recherche-Items vor. **Rückwärtsgewandt**: schreibt nie in den Buchtext ([user_app_philosophy]).

## Claude-only — warum

Die einzige Echtzeit-Websuche läuft über Anthropics serverseitiges `web_search`-Tool (kein eigener Google-Key, Anthropic führt die Suche selbst aus). Ollama/OpenAI-compat können das nicht. Darum ist der Chat Claude-only und das Panel wird **nur sichtbar, wenn der effektive Provider dieses Users Claude ist** (`/config` → `researchChat.enabled`, gesetzt in [routes/proxies.js](../routes/proxies.js): `resolveProvider({userEmail}) === 'claude'` + `ai.claude.api_key` gesetzt + Kill-Switch `research_chat.enabled` ≠ false). Der Job ([routes/jobs/research-chat.js](../routes/jobs/research-chat.js)) erzwingt zusätzlich `provider='claude'`.

## Datenmodell

Keine neue Tabelle — die Sessions leben in `chat_sessions` mit **`kind='research'`** (Migration 220; `page_id IS NULL`, buchweit, analog `kind='book'`). Nachrichten in `chat_messages`; `context_info` (JSON) trägt `tool_calls`, `web_searches` und die **`proposals`** (Speicher-Vorschläge).

## Tools ([routes/jobs/research-chat-tools.js](../routes/jobs/research-chat-tools.js) + [public/js/prompts/recherche.js](../public/js/prompts/recherche.js))

| Tool | Handler? | Zweck |
|------|----------|-------|
| `web_search` | nein (Anthropic-Server-Tool, Typ `web_search_20250305`) | Echtzeit-Websuche; Ergebnis + Citations kommen in derselben Runde zurück |
| `list_research_items` | ja | vorhandenes Board durchsuchen (FTS bei `q`) |
| `read_research_item` | ja | Volltext eines Eintrags inkl. PDF-`doc_text` |
| `list_book_entities` | ja | Figuren/Orte/Szenen/Beats/Stränge als Recherche-Kontext |
| `propose_research_item` | ja | sammelt EINEN Vorschlag in `ctx.proposals` — **persistiert nichts** |
| `final_answer` | terminal | Pflicht-Endpunkt der Antwort |

`web_search` wird vom Loop **nicht** ausgeführt: in [lib/ai.js](../lib/ai.js) landen `server_tool_use`-Blöcke nicht in `result.toolUses` (nur `tool_use`), bleiben aber samt `web_search_tool_result` verbatim in `rawContentBlocks` (Re-Send-Pflicht, falls daneben ein Custom-Tool lief).

## Speicher-Vorschläge (Bestätigungs-Modell)

`propose_research_item` schreibt **nichts** — der Vorschlag landet in `context_info.proposals`. Das Frontend ([public/js/chat/research-chat.js](../public/js/chat/research-chat.js) `saveResearchProposal`) rendert pro Vorschlag einen „Speichern"-Button; **erst der Klick** ruft `POST /research` und fügt das Item ins Board ein (analog zu den KI-Verknüpfungsvorschlägen). Spiegelt das `generate_image`→`ctx.images`-Sammelmuster des Buch-Chats.

## Loop ([routes/jobs/research-chat.js](../routes/jobs/research-chat.js))

Klon des agentischen Buch-Chat-Loops (`runBookChatJobAgent`), aber ohne Seiten-Vorladen und ohne Zitat-Validierung: `callAIWithTools` → Custom-Tools ausführen → `final_answer`/Prosa terminiert; bei erschöpften Iterationen erzwungener Synthese-Turn mit nur `final_answer`. Cap `jobs.research_chat.max_tool_iter` (Default 6).

## Frontend

Kein eigenes Card — Sub-State + Methoden sind in `rechercheCard` gespreadet ([public/js/cards/recherche-card.js](../public/js/cards/recherche-card.js)), Chat-Logik aus der geteilten `makeChatMethods`-Factory ([public/js/chat/chat-base.js](../public/js/chat/chat-base.js), Label `ResearchChat`). Toggle-Button im Karten-Header (nur bei `$app.researchChatEnabled`). Markup reused die `chat.css`-Klassen.

## Routen

- `POST /chat/session/research` / `GET /chat/sessions/research/:book_id` ([routes/chat.js](../routes/chat.js)) — editor-scoped, buchweit.
- `POST /jobs/research-chat` ([routes/jobs/chat.js](../routes/jobs/chat.js), via `_handleChatPost`) — Job-Queue, ACL `editor`.

## Pflicht-Invarianten

- Nie generativ in den Buchtext (nur Recherche/Weltaufbau). Der System-Prompt verbietet Manuskript-Generierung explizit.
- `propose_research_item` persistiert nie selbst — Speichern ist immer User-bestätigt.
- Claude-only: Sichtbarkeit gegated + Job erzwingt `provider='claude'`.
