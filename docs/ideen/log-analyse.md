# Log-Analyse in Admin-Console (neues Tab)

## Context

Winston schreibt nach `schreibwerkstatt.log` (5 MB Rotation, 3 Files). Heute nur per SSH/`tail -f` lesbar — User mit Admin-Rolle sollen Logs direkt in der App durchsuchen, filtern, live mitlesen können. Lebenszyklus + Format: `[INFO][scope|user|book|jobId] msg` (siehe [logger.js](logger.js)). Tab erscheint im Admin-Home-Grid neben Users/Settings/Usage/Categories/Books.

## Scope MVP

- Live-Tail (SSE) der aktiven Log-Datei, letzte N Zeilen on-open.
- Server-seitige Filter: Level (`info`/`warn`/`error`), Scope (Job-Typ wie `lektorat`, `chat`, …), User-Mail, Buch-ID, Volltext.
- Pagination zurück über rotierte Files (`.1`, `.2`, `.3`).
- Download des aktuellen Files als `.log` (begründet via Audit-Log).
- Stack-Traces eingeklappt, expandierbar.

## Out-of-Scope (Phase 2)

- Aggregations-Dashboards (Top-Fehler pro Tag, Job-Failure-Rate).
- Externes Sink (Loki/Grafana, fluentd, Sentry-Forward).
- Server-seitiger Regex statt Substring-Filter.
- Multi-Node — App ist Single-LXC, nur ein Log-File.
- Persistierte Saved-Filter (Bookmark-Style).
- Log-Retention-Konfig in App-Settings (heute hartcodiert in winston).

## Backend

### Neue Route [routes/admin-logs.js](routes/admin-logs.js)

Pflicht-Auth: `requireAdmin`-MW aus [lib/admin-mw.js](lib/admin-mw.js) (existiert). Logging-Context: `setContext({ book: null })` — admin-scoped, kein Buch.

- `GET /admin/logs/tail?lines=500` — letzte N Zeilen aus `schreibwerkstatt.log`, geparst zu `{ ts, level, scope, user, book, jobId, msg, stack? }`. Server-seitiger Parser (regex auf das winston-Format aus [logger.js](logger.js)). Max `lines=2000`.
- `GET /admin/logs/search?level=&scope=&user=&book=&q=&before=&limit=200` — durchsucht aktuelles File + Rotationen rückwärts, bis `limit` erfüllt oder Files erschöpft. `before` = ISO-Timestamp für Pagination (klassische Cursor-Pagination, rückwärts in Zeit).
- `GET /admin/logs/stream` — SSE-Endpoint. Pollt `fs.watch` + `fs.read` ab letzter Inode-Position; Zeilen → `data: <json>\n\n`. Reconnect via `Last-Event-Id`-Header (= Byte-Offset im File).
- `GET /admin/logs/files` — Liste rotierter Files mit `size`/`mtime`/Zeilenanzahl (geschätzt via `wc -l`-Äquivalent in Node-Stream).
- `GET /admin/logs/download?file=current|1|2|3` — `Content-Type: text/plain`, `Content-Disposition: attachment`. Audit-Log-Event `admin.logs.download` mit `file`-Param.

Mount in [server.js](server.js): `app.use('/admin/logs', require('./routes/admin-logs'));` neben den anderen `/admin/*`-Routern.

### Parser-Modul [lib/log-parser.js](lib/log-parser.js)

Regex auf das fixe winston-Format aus [logger.js](logger.js):
```
/^(?<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[(?<level>[A-Z]+)\] \[(?<scope>[^|]+)\|(?<user>[^|]+)\|(?<book>[^|\]]+)(?:\|(?<jobId>[^\]]+))?\] (?<msg>.*)$/
```
- Stack-Traces sind unindented Folgezeilen ohne Timestamp — Parser hängt sie an die letzte Zeile als `stack`-Array.
- Liefert Stream-Parser (Generator), nicht Sync-Read — File kann mehrere MB sein.
- **Tests:** [tests/unit/log-parser.test.mjs](tests/unit/log-parser.test.mjs) — Format-Roundtrip, Stack-Trace-Append, malformed Lines (Skip statt Crash).

### Reverse-Reader [lib/log-reverse-read.js](lib/log-reverse-read.js)

Für Search-Pagination: liest File rückwärts in Chunks (z.B. 64 KB), splittet an `\n`, parsed durch [lib/log-parser.js](lib/log-parser.js). Verhindert Full-File-Read bei `limit=200` auf 5-MB-File. Bei Erschöpfung des aktuellen Files: nächstes Rotations-File (`.1`, `.2`, `.3`) anhängen.

### SSE-Tailer

`fs.watch(LOG_FILE)` + `fs.createReadStream({ start: lastByteOffset })`. Auf File-Rotation (Inode-Wechsel oder `size < lastOffset`) → Offset reset. Wenn Client mit `Last-Event-Id` zurückkommt: aktuelle Datei ab dem Offset weiterstreamen; bei Rotation in der Zwischenzeit Verlust akzeptieren (User wird darauf hingewiesen, Search-Endpoint nutzen für lückenlose Sicht). SSE-Pattern aus [routes/proxies.js](routes/proxies.js) (Claude-Streaming) wiederverwenden — Heartbeat alle 15 s, `res.flushHeaders()`.

## Frontend

### Neue Karte [public/js/cards/admin-logs-card.js](public/js/cards/admin-logs-card.js)

Alpine.data — `adminLogsCard`. Sub-Komponente analog zu [public/js/admin/admin-usage.js](public/js/admin/admin-usage.js).

**State:**
- `lines: []` — geparste Log-Einträge.
- `filter: { level: '', scope: '', user: '', book: '', q: '' }`.
- `liveTail: true` — Toggle SSE on/off.
- `eventSource: null`.
- `loadingMore: false`, `hasMore: true`, `oldestTs: null`.
- `expandedStacks: Set` — `{ts}`-Keys mit aufgeklapptem Stack.

**Methods:**
- `init()` — Tail 500 Zeilen via `/admin/logs/tail?lines=500`, dann `_startStream()` falls `liveTail`.
- `_startStream()` — `new EventSource('/admin/logs/stream')`, onmessage parsed JSON, prepend in `lines`, Cap auf 5000 (FIFO).
- `_stopStream()` — `.close()`, EventSource null.
- `_applyFilter()` — Server-Side: bei Filter-Change SSE pausieren + `/admin/logs/search` mit aktuellen Params, Resume Stream nach Reset-Click.
- `loadMore()` — `/admin/logs/search?before=<oldestTs>&limit=200`, append unten, update `hasMore`.
- `toggleStack(ts)`, `download(file)`, `clearFilters()`.

**Reset:** `destroy()` schliesst EventSource. Sub hört auf `view:reset` → `_stopStream()` + `lines = []`.

### Partial [public/partials/admin-logs.html](public/partials/admin-logs.html)

Card-Layout analog zu [admin-usage.html](public/partials/admin-usage.html):
- Header mit Titel + Live-Tail-Toggle (Lucide-Icon `radio` aus Sprite).
- Filter-Toolbar (Inputs als Combobox für Level/Scope, `numInput` für Buch-ID, Text-Inputs für User/Volltext) — Hard Rule: kein `<select>`, `combobox` aus [public/js/app.js](public/js/app.js).
- Liste der Log-Einträge als virtualisierte/getrimmte Tabelle. Spalten: Zeit (mit `tzOpts()`), Level-Badge (Hard Rule: eckiges Badge via `--card-accent-...`), Scope, User, Buch, Message. Zeilen mit `stack` haben Chevron rechts → Toggle expandiert Stack als `<pre>`.
- Footer: „Mehr laden" (Pagination), „Download aktuelles File" (Lucide `download`).
- Color-Mapping: `level=ERROR` → Karten-Akzent `--card-accent-error`, `WARN` → `--card-accent-warn` (in [public/css/tokens/colors.css](public/css/tokens/colors.css) + [public/css/card-accents.css](public/css/card-accents.css) ergänzen).

### CSS [public/css/admin/logs.css](public/css/admin/logs.css)

Eigene Datei (Hard Rule: kein Inline-Style, keine `<style>`-Blöcke). Subfolder [public/css/admin/](public/css/admin/) existiert bereits.
- `.log-list` — monospace, dichte Zeilen (line-height 1.4).
- `.log-row` — Grid mit fixierten Spaltenbreiten (ts/level/scope) + flex msg.
- `.log-row--error`, `.log-row--warn` — Akzent-Border-Left.
- `.log-stack` — `pre`, eingeklappt via `max-height: 0` + Transition.
- Mobile (Container-Query bevorzugt): Spalten kollabieren zu 2-Zeilen-Layout (ts+level oben, scope+msg unten).

Pflicht: `<link>` in [public/index.html](public/index.html), `SHELL_CACHE` in [public/sw.js](public/sw.js) bumpen, Eintrag in [DESIGN.md](DESIGN.md) „CSS-File-Inventar".

### Registrierung

1. Sub-Komponente in [public/js/app.js](public/js/app.js) registrieren via `registerAdminLogsCard()`.
2. Eintrag in `EXCLUSIVE_CARDS` von [public/js/cards/feature-registry.js](public/js/cards/feature-registry.js):
   ```js
   { key: 'adminLogs', flag: 'showAdminLogsCard', toggle: 'toggleAdminLogsCard', onReclick: 'close', partial: 'admin-logs' },
   ```
3. **Kein** Eintrag in `FEATURES` der Palette (Admin-Tools tauchen heute auch nicht auf — `adminUsers` etc. sind nur in `EXCLUSIVE_CARDS`).
4. `showAdminLogsCard` in `cardsState` von [public/js/app/app-state.js](public/js/app/app-state.js).
5. `toggleAdminLogsCard()` in [public/js/app/app-view.js](public/js/app/app-view.js) — Pattern wie `toggleAdminUsageCard`.
6. Tile in [public/partials/admin-home.html](public/partials/admin-home.html) einfügen + im `x-show`-Expression `&& !showAdminLogsCard` ergänzen (sonst bleibt Admin-Home offen, wenn Logs-Card auf ist).
7. Hash-Router-Branch in [public/js/app/app-hash-router.js](public/js/app/app-hash-router.js) (`adminlogs` als View-Key).
8. **Nicht** in `ALLOWED_KEYS` von [routes/usage.js](routes/usage.js) eintragen — Admin-Karten werden heute auch nicht getrackt.

## i18n

Neue Keys in [public/js/i18n/de.json](public/js/i18n/de.json) + [public/js/i18n/en.json](public/js/i18n/en.json):
- `admin.logs.title` — „Logs" / „Logs"
- `admin.home.logsLabel` — Label im Admin-Home-Tile
- `tile.adminLogs.desc` — Tile-Beschreibung
- `admin.logs.filter.level` / `.scope` / `.user` / `.book` / `.search`
- `admin.logs.filter.allLevels`, `admin.logs.filter.allScopes`
- `admin.logs.liveTail` — Toggle-Label
- `admin.logs.loadMore`
- `admin.logs.download`
- `admin.logs.empty`
- `admin.logs.streamError`
- `admin.logs.rotated` — Hinweis bei SSE-Rotation-Lücke

Hard Rule: gleichzeitig DE + EN committen, nie „mache ich später".

## Security / Auth

- **Pflicht-Guard:** `requireAdmin` aus [lib/admin-mw.js](lib/admin-mw.js). Logs enthalten potentiell sensible Daten (User-Mails, Buch-IDs, Fehler-Inhalte). Nur `global_role='admin'`.
- **Audit:** Jeder Aufruf von `/admin/logs/download` loggt via `logAuditEvent('admin.logs.download', { file, lines })` (Pattern aus [routes/admin-users.js](routes/admin-users.js) — falls Helper noch nicht existiert, neuen ergänzen).
- **Kein KI-Provider-Key-Leak:** Filter-Output sollte API-Keys nicht durchscheinen — heute werden sie nicht ins Log geschrieben (geprüft: `lib/ai.js` loggt nur Model + Token-Counts). Falls künftig versehentlich Key ins Log gerät: Regex-Mask im Parser (`sk-ant-…` → `***`) — out-of-scope für MVP, aber als Phase-2-Item festhalten.
- **Rate-Limit:** `/admin/logs/search` mit `limit=200` und Reverse-Read in Chunks ist schnell genug — kein expliziter Limiter nötig. Falls Admin-Tab via SSE offen bleibt, ist `fs.watch`-Last vernachlässigbar (ein File-Descriptor pro Admin).

## DB

Keine Schema-Änderung. Logs leben im Filesystem (winston-File-Transport bleibt unverändert). Hard Rule „neue Tabelle braucht FK" trifft nicht zu — kein neuer DB-State.

## Tests

**Unit:**
- [tests/unit/log-parser.test.mjs](tests/unit/log-parser.test.mjs) — Format-Roundtrip, Stack-Trace-Append, malformed Skip, alle Level-Varianten.
- [tests/unit/log-reverse-read.test.mjs](tests/unit/log-reverse-read.test.mjs) — Reverse-Read über simulierte Mehrfach-Files, Cursor-Pagination.

**Integration:**
- [tests/integration/admin-logs.test.js](tests/integration/admin-logs.test.js) — `/admin/logs/tail`/`/search`/`/files`/`/download` mit Fixture-Log-File (tmpdir). Admin-Auth-Check (401 für Non-Admin).

**E2E (Playwright):**
- [tests/e2e/admin-logs.spec.js](tests/e2e/admin-logs.spec.js) — Admin-Login → Logs-Tab öffnen → Filter setzen → Download anklicken → File-Header prüfen. SSE-Test deferred (Playwright + SSE flaky).

**Manuell:**
- App starten, Job laufen lassen, gleichzeitig Logs-Tab offen → Live-Tail zeigt Job-Events ohne Reload.
- Log rotieren (App reicht 5 MB → File-Switch durch Stress-Test) → SSE bekommt Hinweis-Event, kein Crash.
- Non-Admin (`viewer`-User) auf `/admin/logs/tail` → 403.

## Kritische Dateien (Modify)

| Datei | Änderung |
|---|---|
| [server.js](server.js) | Router mount `/admin/logs` |
| [public/partials/admin-home.html](public/partials/admin-home.html) | Tile + `x-show`-Erweiterung |
| [public/js/app.js](public/js/app.js) | `registerAdminLogsCard()` aufrufen |
| [public/js/app/app-state.js](public/js/app/app-state.js) | `showAdminLogsCard: false` |
| [public/js/app/app-view.js](public/js/app/app-view.js) | `toggleAdminLogsCard()` |
| [public/js/app/app-hash-router.js](public/js/app/app-hash-router.js) | `adminlogs`-Branch |
| [public/js/cards/feature-registry.js](public/js/cards/feature-registry.js) | `EXCLUSIVE_CARDS`-Eintrag |
| [public/index.html](public/index.html) | `<link>` admin/logs.css |
| [public/sw.js](public/sw.js) | `SHELL_CACHE` bump |
| [public/js/i18n/de.json](public/js/i18n/de.json) / [en.json](public/js/i18n/en.json) | Keys |
| [public/css/tokens/colors.css](public/css/tokens/colors.css) | `--card-accent-error`/`-warn` (falls noch nicht da) |
| [public/css/card-accents.css](public/css/card-accents.css) | `.card--admin-logs` |
| [DESIGN.md](DESIGN.md) | CSS-Inventar + Tile-Pattern + Log-Row-Pattern |

## Kritische Dateien (Create)

| Datei | Zweck |
|---|---|
| [routes/admin-logs.js](routes/admin-logs.js) | Tail/Search/Stream/Files/Download |
| [lib/log-parser.js](lib/log-parser.js) | Stream-Parser für winston-Format |
| [lib/log-reverse-read.js](lib/log-reverse-read.js) | Reverse-Chunk-Reader für Pagination |
| [public/js/cards/admin-logs-card.js](public/js/cards/admin-logs-card.js) | Alpine-Sub, Filter, SSE-Client |
| [public/partials/admin-logs.html](public/partials/admin-logs.html) | UI |
| [public/css/admin/logs.css](public/css/admin/logs.css) | Log-Row + Mobile |
| [tests/unit/log-parser.test.mjs](tests/unit/log-parser.test.mjs) | Parser-Roundtrip |
| [tests/unit/log-reverse-read.test.mjs](tests/unit/log-reverse-read.test.mjs) | Reverse-Pagination |
| [tests/integration/admin-logs.test.js](tests/integration/admin-logs.test.js) | Routes + Auth |
| [tests/e2e/admin-logs.spec.js](tests/e2e/admin-logs.spec.js) | Tab-Flow |

## Aufwand

MVP (Tail + Search + Filter + Download, ohne SSE): **1 Tag**.
- Vormittags: Parser + Reverse-Reader + Routes + Tests.
- Nachmittags: Alpine-Card + Partial + CSS + i18n + Admin-Home-Integration.

Mit SSE-Live-Tail: **+0.5 Tag** für Stream-Handling + Rotation-Edge-Cases.

## Edge-Cases / Risiken

- **File-Rotation während SSE:** winston rotiert at-size, alte Datei wird zu `.1`. SSE-Stream muss Inode-Wechsel erkennen (via `fs.watch` `rename`-Event ODER `fstat` periodisch) und auf neue Datei umschalten. Bei nicht-erkennbarer Lücke: Hinweis-Event an Client.
- **Sehr grosse Log-Files:** Bei 5 MB voll + Filter mit hoher Trefferquote könnten Search-Responses 1–2 MB JSON sein. Mit `limit=200` und Reverse-Read ist die Read-Last gedeckelt; JSON-Cap durch `limit` reicht.
- **Memory-Leak bei Live-Tail:** Frontend cappt `lines` auf 5000 (FIFO-Pop). Server-SSE schickt nur neue Zeilen ab `lastOffset`, kein Backbuffer.
- **Concurrency:** winston schreibt sync (File-Transport). Reader liest async — Tearing möglich (halb geschriebene Zeile). Parser handhabt das per Buffer-Hold der letzten Partial-Zeile bis `\n` kommt.
- **Hard Rule „callAI nur via Job-Queue":** Trifft nicht zu — Log-Reading ist kein KI-Call. Synchrone Routes erlaubt.
- **Hard Rule „Content-Store-Facade":** Trifft nicht zu — keine Buchinhalte, nur File-IO.
- **CLAUDE.md aktualisieren:** Neuer Admin-Tab → kurzen Eintrag im Routen-Tabellen-Block ergänzen (`/admin/logs/*`).
