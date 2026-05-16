# Storage-Backend-Pluralisierung

Storage-Backend wird Admin-konfigurierbar. Zwei gleichwertige First-Class-Backends:

- **`localdb`** (Default für Neu-Installationen): Pages/Chapters/Order/Body leben in lokaler SQLite-DB. Eigene Persistenz, eigene Revisionen, eigene Suche. Keine BookStack-Dependency mehr nötig.
- **`bookstack`** (für bestehende Deployments + alle, die BookStack-UI parallel weiter nutzen wollen): Pages/Chapters/Body leben in BookStack. App-DB bleibt Cache (page_stats, FTS-Index, App-Domain-Daten).

Admin wählt global via `app.backend` in `app_settings` (Phase 4c). Wechsel ist Bulk-Copy-Job (Phase 8), nicht Runtime-Hot-Swap. Kein Dual-Write — ein Backend zur Zeit. Inhaltliche Features (eigene User-Mgmt, ACL, Reader-View, Revisions, Tags, FTS) gelten für beide Backends, sind Backend-agnostisch durch die Content-Store-Abstraktion (Vor-Phase).

Editor + WYSIWYG ändern sich nicht: App nutzt eigenen CodeMirror-basierten Editor, Body bleibt HTML. BookStack-TinyMCE-Iframe wird von der App nie eingebunden — historisch nicht, auch nicht im `bookstack`-Modus.

**Diese Datei beschreibt die Multi-Backend-Architektur als Plan** — bewusste Ausnahme zur CLAUDE.md-Doku-Stil-Regel. Sobald eine Phase live ist, gehört der dauerhafte Teil davon in CLAUDE.md / passende `docs/`-Spickzettel. Diese Datei bleibt liegen, solange offene Phasen existieren; vollständig erledigte Phasen werden gestrichen, der Rest bleibt als Architekturbeschreibung für künftige Code-Sessions.

---

## Vor-Phase — Repo-Indirektion (Architektur-Abstraktion ohne Storage-Swap)

Ziel: Editor/Lektorat/Chat/History sprechen nur noch mit einer Domain-Repository-API (`contentRepo` Frontend, `content-store` Server). BookStack-URL-Form, BookStack-JSON-Shape und Token-Hantierung bleiben auf wenige Dateien begrenzt. Phase 1 (Read-Replica) tauscht dann nur Implementierungen, keine Call-Sites.

**Status:**

- [x] **Schritt 1 — Server: Normalisierte Endpunkte.** [lib/content-mapper.js](../lib/content-mapper.js) (mapBook/mapChapter/mapPage/mapPageMeta) + [routes/content.js](../routes/content.js) gemountet unter `/content`. Endpunkte: `GET /content/books`, `GET /content/books/:id`, `GET /content/books/:id/tree`, `GET /content/chapters/:id`, `GET /content/pages/:id`, `PUT /content/pages/:id` (mit `cleanPageHtml`), `POST /content/books` (upserted lokale books-Row). Intern weiter `bsGet`/`bsGetAll`/`bsPut`/`bsPost` aus [lib/bookstack.js](../lib/bookstack.js) — `bsPut` neu für symmetrischen Write-Chokepoint. Unit-Test: [tests/unit/content-mapper.test.mjs](../tests/unit/content-mapper.test.mjs).
- [x] **Schritt 2 — Frontend: Repository-Modul.** [public/js/repo/content.js](../public/js/repo/content.js) mit `listBooks/loadBook/bookTree/loadChapter/loadPage/savePage/createBook`. SW erweitert ([public/sw.js](../public/sw.js)): neuer `CONTENT_CACHE`-Namespace via gemeinsame `_handleSwr`-Helper, `invalidate-content`-Postmessage parallel zu `invalidate-api`, `SHELL_CACHE` v508→v509 gebumpt, Logout-Cleanup um `CONTENT_CACHE` ergaenzt. Caller-Migration kommt in Schritt 3. Unit-Test: [tests/unit/content-repo.test.mjs](../tests/unit/content-repo.test.mjs).
- [x] **Schritt 3 — Call-Sites umstellen (Editor/Lektorat-Pfade).** Frontend-Tree-Reads: [public/js/tree.js](../public/js/tree.js) konsumiert `contentRepo.listBooks` + `contentRepo.bookTree`. Page-Reads: [public/js/app-view.js](../public/js/app-view.js) (selectPage + refetch), [public/js/chat.js](../public/js/chat.js) (Pre-Send-Refresh + Chat-Apply), [public/js/history.js](../public/js/history.js), [public/js/api-bookstack.js](../public/js/api-bookstack.js) (`_checkPageConflict`, `_loadApplyAndSave`). Page-Writes: [public/js/editor/edit.js](../public/js/editor/edit.js) (saveEdit + quickSave), [public/js/api-bookstack.js](../public/js/api-bookstack.js) (Lektorat-Save), [public/js/offline-sync.js](../public/js/offline-sync.js) (Draft-Push), [public/js/cards/book-editor-card.js](../public/js/cards/book-editor-card.js). Buch-Create: [public/js/book-create.js](../public/js/book-create.js) → `contentRepo.createBook`. Mapper-Erweiterung: `mapPage` exportiert `updated_by_name` + `revision_count`; `mapChapter`/`mapPageMeta` zusätzlich `book_slug` (UI-Deeplink in Tree). Tests angepasst: [tests/unit/pre-save-conflict.test.mjs](../tests/unit/pre-save-conflict.test.mjs) + [tests/unit/stale-write.test.mjs](../tests/unit/stale-write.test.mjs) stubben jetzt `fetch` statt `bsGet`. Tripwire-Test: [tests/unit/content-repo-tripwire.test.mjs](../tests/unit/content-repo-tripwire.test.mjs) — fail-fast bei jedem neuen `/api/` oder `bs*` ausserhalb der Allowlist.
- [x] **Schritt 3b — Strukturoperationen migriert.** Server-Routen ergänzt in [routes/content.js](../routes/content.js): `POST /content/pages`, `DELETE /content/pages/:id`, `POST /content/chapters`, `PUT /content/chapters/:id`, `DELETE /content/chapters/:id`, `DELETE /content/books/:id`. `PUT /content/pages/:id` akzeptiert zusätzlich `position` (→ BookStack-`priority`) und `chapter_id` (Drag/Drop). `bsDelete` neu in [lib/bookstack.js](../lib/bookstack.js). Repo erweitert: `createPage/updatePage/deletePage/createChapter/updateChapter/deleteChapter/deleteBook`. Call-Sites migriert: [public/js/cards/book-organizer-card.js](../public/js/cards/book-organizer-card.js) (8 Operationen), [public/js/tree.js](../public/js/tree.js) (createChapter), [public/js/cards/kapitel-review-card.js](../public/js/cards/kapitel-review-card.js) (createPage), [public/js/book-settings.js](../public/js/book-settings.js) (deleteBook). [public/js/api-bookstack.js](../public/js/api-bookstack.js) ist auf reine Lektorat-Domain-Logik (`_loadApplyAndSave`, `_applyStilkorrektur`, `_checkPageConflict`) + Local-Cache-Helper (`bsRegisterPageLocally`/`bsRegisterChapterLocally`) reduziert — alle `bs*`/`_invalidateApiCache` entfernt.
- [x] **Schritt 3c — Search migriert.** Route `GET /content/search?query=…&book_id=…&count=…` in [routes/content.js](../routes/content.js); augmentiert Query mit `{type:page} {in_book:N}` server-seitig, filtert Page-Hits, gibt `{ hits: [PageMeta] }` zurück. Frontend: [public/js/bookstack-search.js](../public/js/bookstack-search.js) → `contentRepo.search`. AbortController fuer in-flight-Cancellation via seq-Guard (Repo-Search akzeptiert noch kein Signal; folgt mit Schritt 4).
- [x] **Schritt 4 — Server-Loader-Abstraktion.** [lib/content-store.js](../lib/content-store.js) ist die serverseitige SSoT (`listBooks/loadBook/bookTree/listChapters/loadChapter/createChapter/updateChapter/deleteChapter/listPages/loadPage/savePage/createPage/deletePage/createBook/deleteBook/searchPages/loadPagesBatch`). Token-Resolution intern via `_resolveToken(ctx)` — akzeptiert Express-`req` (zieht via `getTokenForRequest` aus DB+Session) oder direkt ein Token-Object (fuer Cron/Jobs). Konsumenten: [routes/content.js](../routes/content.js) (duenne HTTP-Schicht), [routes/book-editor.js](../routes/book-editor.js) (bookTree + loadPagesBatch), [routes/jobs/shared/loader.js](../routes/jobs/shared/loader.js) (Job-Loader nutzt `loadPagesBatch`), [routes/export.js](../routes/export.js) (`loadBook`). [routes/books.js](../routes/books.js) wurde geloescht (dead nach Schritt 3) + aus [server.js](../server.js) demontiert + `/books/` aus `API_PREFIXES` entfernt.
- [ ] **Schritt 4b — Job-Handler migrieren (deferred):** [routes/jobs/lektorat.js](../routes/jobs/lektorat.js), [routes/jobs/kapitel.js](../routes/jobs/kapitel.js), [routes/jobs/review.js](../routes/jobs/review.js), [routes/jobs/komplett/job.js](../routes/jobs/komplett/job.js), [routes/jobs/finetune-export/index.js](../routes/jobs/finetune-export/index.js), [routes/jobs/book-chat-tools.js](../routes/jobs/book-chat-tools.js), [routes/jobs/pdf-export.js](../routes/jobs/pdf-export.js) und [routes/sync.js](../routes/sync.js) rufen weiter direkt `bsGet`/`bsGetAll` mit Token aus Job-Context. Server-Tripwire ([tests/unit/content-store-tripwire.test.mjs](../tests/unit/content-store-tripwire.test.mjs)) erlaubt das via `ALLOW_PREFIXES = ['routes/jobs/']` und [routes/sync.js](../routes/sync.js)-Eintrag. Migration analog zu Schritt 3: `bsGetAll('pages?filter[book_id]=N', userToken)` → `contentStore.listPages(bookId, userToken)`, `bsGet('pages/'+id, userToken)` → `contentStore.loadPage(id, userToken)`.
- [ ] **Schritt 5 — Token-Leak schliessen:** `req.session.bookstackToken` nur noch in [lib/bookstack.js](../lib/bookstack.js) + `lib/content-store.js`. Nach Schritt 4b auch `bookstackPageCleaner`-Middleware in [routes/proxies.js](../routes/proxies.js) ueberfluessig (kein Direkt-Schreiben an `/api/pages` mehr), entfernen.
- [x] **Schritt 6 — Tripwire (Frontend + Server).** [tests/unit/content-repo-tripwire.test.mjs](../tests/unit/content-repo-tripwire.test.mjs) fail-fast bei jedem `bs*`-Call oder direktem `/api/`-Fetch in `public/js/**` — Allowlist ist seit Schritt 3c **leer**. [tests/unit/content-store-tripwire.test.mjs](../tests/unit/content-store-tripwire.test.mjs) fail-fast bei `bs*`-Calls in `routes/`/`lib/` ausserhalb `lib/bookstack.js`, `lib/content-store.js`, `lib/load-book-contents.js`, `routes/sync.js` und `routes/jobs/**`. Nach Schritt 4b sind nur noch `lib/bookstack.js` + `lib/content-store.js` legitim.

**Folge für Phase 1+:** Replica-Sync füllt lokale Tabellen; `content-store`-Implementierung bekommt einen `USE_LOCAL_READS`-Branch. Caller-Code in Editor/Lektorat/Chat ändert sich nicht.

---

## Leitplanken

### Privacy-Boundary (kritisch)

- **Admin sieht keine Bücher.** Admin-Rolle ist auf User-Verwaltung + globale App-Konfiguration (Claude/KI-Provider, Modell, Token-Limits, etc.) beschränkt.
- **Buch-Zugriff nur via `book_access`-Row.** Admin bekommt *keine* Auto-Rows. Will Admin Bücher sehen, braucht es einen zweiten User-Account mit `global_role='user'` und expliziten Share.
- **`global_role` und `book_access` sind orthogonal.** Globale Rolle (admin/user) regelt App-weite Funktionen. Buch-Rolle (owner/editor/reader) regelt einzelnen Buchzugriff. Kein Cross-Effekt.
- **Buchliste-Endpoints filtern strikt** über `book_access`. Admin-Aufrufe sehen leere Liste, wenn keine Share-Row existiert. Kein Admin-Bypass.
- **Begründung:** Self-Hosted-Setup mit mehreren Schreibenden — Admin-Rolle ist Betriebsrolle (Useronboarding, Claude-Config), nicht inhaltliche Rolle. App-UI-Trennung. Shell/DB-Zugang hat Admin sowieso; das ist out-of-scope für UI-Privacy.

### Was BookStack heute liefert (Inventar)

- Storage: `Book → Chapter → Page`-Hierarchie + Sortierung + Body-HTML.
- Page-Revisions (BookStack speichert pro Save eine Version).
- Drafts (Autosave pro User/Page).
- Tags (Page-Ebene, Key/Value).
- Auth/User-Liste/Rollen/Permissions.
- WYSIWYG-Editor (TinyMCE).
- Volltextsuche.
- Export (`/export/{fmt}`).
- Templates, Shelves.

App verwendet schon eigenständig: Google-OIDC-Login, Custom-PDF-Export, Focus-Editor, alle KI-Jobs, Page-Stats, Job-Queue. BookStack bleibt für Persistenz + WYSIWYG + User-DB.

Bewusst out-of-scope (User-Wunsch): Attachments (werden nicht genutzt → kein Mirror).

---

## Phasen-Übersicht

| # | Phase | Reversibel? | User-Impact | Abhängigkeiten |
|---|---|---|---|---|
| 0 | Schema-Skelett | ja | keiner | — |
| 0b | Initial Backfill (BookStack → DB) | ja | keiner | 0 |
| 0c | PRAGMA-Tuning | ja | schnellere Reads | — |
| 0d | Cache-TTL-Cleanup | ja | keiner | — |
| 1 | `localdb`-Backend implementieren (Content-Store-Variante) | ja (Flag) | keiner solange `app.backend='bookstack'` | 0, 0b, Vor-Phase |
| 2 | Eigene Page-Revisions | ja | feinere History (beide Backends) | 0 |
| 3 | Eigene Sortierung | ja | `localdb`-only nativ; `bookstack` weiter via BS-`priority` | 0, 1 |
| 4a | App-User-Verwaltung | mittel (FK-Recreate) | Admin-Karte; restriktive Logins; User-Invite-Flag | 0 |
| 4b | Book-ACL + Sharing (owner/editor/lektor/viewer) | ja | Buchliste filtert auf Shares; Rollen-Matrix | 0, 4a |
| 4b1 | Lese-Modus (Print-CSS + readOnly) | ja | Druckansicht + readOnly für viewer | 4b |
| 4c | Admin-Settings (alle Runtime-Configs aus `.env` → DB) | ja | Admin-UI für Provider/Modell/Auth/Cron/Tuning + Backend-Auswahl | 4a |
| 4c1 | First-Run-Setup-Wizard (`/setup`) | ja | Admin loggt sich via `ADMIN_PASSWORD` ein und konfiguriert OAuth/KI/Backend Schritt für Schritt; auch später wieder aufrufbar | 4c |
| 4d | Token-Budget + Cost-Tracking (Admin) | ja (additiv) | Admin-Karte Usage; pro-User-Monats-Budget hard/soft; 429 bei Hard-Cap | 4a |
| 6 | Tags/Kategorien | ja | Filter-UI (beide Backends) | 0, 4a |
| 7 | Volltextsuche (FTS5) | ja | App-eigene Suche (beide Backends) | 1, 2, 4b |
| 8 | Backend-Migration-Tool (Bulk-Copy) | one-way pro Direction | Admin-UI „Backend wechseln" | 1–7 |
| 9 | Doku-Update (Multi-Backend-Sweep) | ja | keiner (Doku) | 8 |
| 10 | Schema-Squash | ja | keiner | 9 |

**Start-Reihenfolge:** Vor-Phase Schritt 5 → 0c → 0d → Vor-Phase Schritt 4 → 0 → 0b → 4a → 4c → 4c1 → 4d → 4b → 4b1 → 2 → 6 → 1 → 3 → 7 → 8 → 9 → 10.
Vor-Phase Schritt 5 als Easy-Win sofort ([routes/books.js](../routes/books.js) toter Mount entfernen). 0c/0d vorab, da unabhängig von Backend-Pluralisierung und sofort gewinnbringend. Schritt 4 (`lib/content-store.js`) Pflicht-Voraussetzung für Phase 1 (Backend-Dispatch). 10 (Squash) zuletzt — Squash vorher wäre Wegwerfarbeit, weil bis dahin viele Migrationen dazukommen.
4a/4c/4b zuerst, weil User-Identität, `app.backend`-Schalter und ACL die SSoT für alle folgenden Phasen sind. Lese-Modus (4b1, Print-CSS + readOnly) direkt nach 4b, weil viewer-Rolle erst dann existiert. Phase 7 (Suche) **vor** Phase 8, damit FTS schon steht, wenn Admin Backend wechselt — Index wird beim Bulk-Copy mitgefüllt.

4d (Token-Budget + Cost) folgt 4a (braucht `app_users.global_role='admin'`). Vor 4b einsortiert, weil Kostenkontrolle vor Sharing-Welle (mehr Co-Editoren = mehr KI-Calls) bestehen muss; rein additiv (neue Spalten/Tabelle/Routen, kein Refactor) und kann bei Bedarf vorgezogen werden.

**Phase 5 (Dual-Write) entfällt.** Im Multi-Backend-Modell schreibt jeder Backend in seine eigene Wahrheit; ein gleichzeitiges Schreiben in BookStack **und** localdb wäre nur sinnvoll bei „Migration mit Rollback-Schutz" — und das deckt Phase 8 als One-Shot-Bulk-Copy mit veraltetem Quell-Backend-Read-Only-Marker während des Runs ab.

---

## Phase 0 — Schema-Skelett

Heute schon vorhanden: `books`, `pages`, `chapters` mit PKs = BookStack-IDs. Body, Order und Owner fehlen.

**Migration N+1** (additiv, keine FK-Brüche):

```sql
ALTER TABLE pages ADD COLUMN body_html TEXT;
ALTER TABLE pages ADD COLUMN body_markdown TEXT;
ALTER TABLE pages ADD COLUMN position INTEGER;
ALTER TABLE pages ADD COLUMN priority INTEGER;
ALTER TABLE pages ADD COLUMN slug TEXT;
ALTER TABLE pages ADD COLUMN local_updated_at TEXT;
ALTER TABLE pages ADD COLUMN remote_updated_at TEXT;
ALTER TABLE pages ADD COLUMN dirty INTEGER DEFAULT 0;

ALTER TABLE chapters ADD COLUMN position INTEGER;
ALTER TABLE chapters ADD COLUMN priority INTEGER;
ALTER TABLE chapters ADD COLUMN slug TEXT;
ALTER TABLE chapters ADD COLUMN description TEXT;

ALTER TABLE books ADD COLUMN description TEXT;
ALTER TABLE books ADD COLUMN cover_image BLOB;
ALTER TABLE books ADD COLUMN owner_email TEXT;
ALTER TABLE books ADD COLUMN created_at TEXT;
```

`dirty` + `remote_updated_at` = Konflikterkennung in Phase 5. `owner_email` wird bei Buch-Discovery (`upsertBook` in [routes/sync.js](../routes/sync.js)) mit Session-User befüllt, sofern leer.

---

## Phase 0b — Initial Backfill (Bulk-Copy BookStack → DB)

Ziel: Vollabzug aller BookStack-Bücher/Kapitel/Seiten in lokale Tabellen nach Migration N+1, **pro User mit dessen eigenem Session-Token**. Phase 1 (Sync-Worker) übernimmt danach inkrementelle Updates; ohne Backfill liesse Phase 1 die DB für einen Neu-User leer.

**Per-User-Backfill** — kein Admin-Token, kein globaler Run. Jeder User backfilled mit seinem eigenen Session-`bookstackToken` exakt jene Bücher, die BookStack ihm zeigt. Konsistent mit Privacy-Boundary (Phase 4b): Buch-Sichtbarkeit bleibt durch BookStack-Permissions definiert, kein Admin-Bypass.

**Endpoint** `POST /sync/backfill` (neu, in [routes/sync.js](../routes/sync.js)):

- Auth via Session-Guard, User-Email + Token aus `req.session`.
- Iteriert `bsGetAll('/api/books')` mit User-Token → pro Buch:
  - `upsertBook({ book_id, name, description, owner_email = req.session.email, created_at })` ([db/schema.js](../db/schema.js)) — `owner_email` nur setzen, wenn leer (erster User „erbt" das Buch; spätere Sharing-Regelung kommt mit Phase 4b).
  - `bsGetAll('/api/books/:id/chapters')` → `upsertChapter({ chapter_id, book_id, chapter_name, position, priority, slug, description })`.
  - `bsGetAll('/api/books/:id/pages')` für Metadaten + Hierarchie. Body pro Seite via `bsGet('/api/pages/:id')` (Detail-Endpoint liefert `html` + `markdown`).
  - `upsertPage({ page_id, book_id, chapter_id, page_name, body_html, body_markdown, position, priority, slug, remote_updated_at })`. `local_updated_at = remote_updated_at`, `dirty = 0`.
- Optional Body `{ bookId }` für Einzel-Buch-Backfill (Smoke-Test, partielle Recovery, gezielter Restore).
- Idempotent: alle Upserts `INSERT … ON CONFLICT DO UPDATE`. Re-Run aktualisiert bestehende Rows, fügt fehlende hinzu.
- Logging via Winston mit `setContext({ book })` pro Buch-Iteration: `[backfill|user@mail|42] chapters=8 pages=120`.
- Job-Queue: lange Laufzeit → als `'backfill'`-Job-Typ in [routes/jobs/](../routes/jobs/) implementieren (Standard-Pattern: `runBackfillJob` + Status-Polling), nicht synchron im Request.

**Trigger-Punkte:**
- **Manuell** über Karte „Buch-Einstellungen" oder „User-Einstellungen": Button „BookStack synchronisieren". Reicht für initialen Roll-Out.
- **Auto bei erstem Login pro User** (optional): wenn `pages.body_html` für keines der User-sichtbaren Bücher gefüllt ist, Backfill-Job starten und Toast anzeigen. Verhindert „leerer Editor"-Effekt nach Deploy von Phase 1.
- **Pro Buch on-demand:** beim ersten Page-Open eines Buchs ohne lokale Bodies → Lazy-Backfill nur für dieses Buch.

**`upsertPage`/`upsertChapter`** neue Helfer in [db/pages.js](../db/pages.js) bzw. [db/schema.js](../db/schema.js). Beide nehmen das vom BookStack-Mapper gelieferte Shape, kein Snapshot-Smell (`page_name`/`chapter_name` sind weiterhin Sync-Caches der BookStack-Wahrheit, nicht Denormalisierung).

**ID-Invariante (kritisch für FK-Integrität):** BookStack-IDs werden **1:1 als lokale Primary Keys** übernommen — `pages.page_id`, `chapters.chapter_id`, `books.book_id` (alle bereits `INTEGER PRIMARY KEY` **ohne** `AUTOINCREMENT`, siehe [db/migrations.js](../db/migrations.js)). Kein Remapping, keine separate `local_id`/`remote_id`-Spalte, keine Surrogate-IDs.

- Upserts setzen die ID **explizit** aus dem BookStack-Response (`INSERT INTO pages (page_id, …) VALUES (?, …) ON CONFLICT(page_id) DO UPDATE …`).
- `figures.book_id`, `page_stats.page_id`, `chapter_reviews.chapter_id`, `figure_events.page_id`, `figure_scenes.chapter_id`, `locations.erste_erwaehnung_page_id`, `continuity_issue_chapters.chapter_id`, `ideen.page_id`, `lektorat_cache.page_id`, `page_revisions.page_id`/`book_id`, `chat_sessions.page_id`, `chapter_extract_cache.chapter_id` etc. — alle ~40 FK-Spalten in [docs/erd.md](erd.md) — referenzieren weiter dieselben BookStack-IDs. Nichts muss umgeschrieben werden.
- Backfill-Reihenfolge erzwingt FK-Validität: **erst** `books`, **dann** `chapters` (FK → books), **dann** `pages` (FK → books, optional → chapters). Innerhalb eines Buchs in einer Transaktion, damit `foreign_key_check` am Ende grün ist.
- Phase 8 (Kill BookStack) ändert daran nichts: dieselben Integer-IDs bleiben PKs, sind dann aber app-vergeben statt BookStack-vergeben (z.B. via `INTEGER PRIMARY KEY AUTOINCREMENT` ab Phase 8 für neu erstellte Rows). Existierende Rows behalten ihre BookStack-IDs für immer → alle historischen FKs (Reviews, Caches, Findings, Revisions, Lektorat-Time, etc.) bleiben gültig.
- `figure_id`, `location_id`, `scene_id` etc. sind app-interne Surrogate (kein BookStack-Pendant) — unverändert, kein Konflikt.
- Test-Pflicht: Backfill-Unit-Test validiert nach jedem Buch `db.pragma('foreign_key_check')` → muss leer sein. Sonst Abbruch + Rollback.

**Sequenz:** Migration N+1 läuft beim nächsten App-Start automatisch (additiv, schnell). Backfill stösst jeder User für sich an — nach Login einmalig oder via Sync-Button. Phase 1 (Sync-Worker) übernimmt dann inkrementell.

**Idempotenz-Garantie:** Endpoint darf jederzeit re-getriggert werden — z.B. wenn neue Bücher in BookStack auftauchen oder lokale Bodies nach Schema-Bumps neu gefüllt werden müssen. Phase 1 macht denselben Diff-Check (`updated_at`); Backfill ist „kalter Sync-Worker-Lauf für genau einen User".

**Wichtig — keine fremden Bücher mirrorbar:** Was User A backfilled, ist exakt das, was BookStack User A zeigt. User B sieht im Backfill seine eigene Buch-Auswahl. In `books` landen ggf. dieselben `book_id`s aus mehreren User-Backfills (idempotenter Upsert), aber Sichtbarkeit regelt sich später über `book_access` (Phase 4b) — bis dahin spiegelt `owner_email` den Erst-Backfiller.

**Tests:** Unit-Test mit Mock-BookStack-Client (Books-Liste → Chapter-Liste → Page-Detail) gegen In-Memory-DB. Verifiziert: Re-Run ist idempotent, FK-Constraints halten, `body_html` landet pro Seite, `remote_updated_at` gesetzt, zwei User-Backfills mit überlappenden Büchern erzeugen keine Duplikate.

---

## Phase 0c — PRAGMA-Tuning

Ziel: SQLite-Tuning für wachsende DB (Replica-Bodies + FTS5-Index ab Phase 7 = mehr Volumen). Unabhängig vom BookStack-Exit, sofort lohnend. Reversibel — alle PRAGMAs sind Runtime-Settings, kein DB-Format-Wechsel.

**Anpassung in [db/connection.js](../db/connection.js):**

```js
db.pragma('journal_mode = WAL');                  // bleibt
db.pragma('synchronous = NORMAL');                // bleibt
db.pragma('foreign_keys = ON');                   // bleibt
db.pragma('cache_size = -65536');                 // 64 MB Page-Cache (neg = KiB)
db.pragma('mmap_size = 268435456');               // 256 MB memory-mapped I/O
db.pragma('temp_store = MEMORY');                 // Temp-Tables/Indexe in RAM
db.pragma('busy_timeout = 5000');                 // 5 s Lock-Wait statt SQLITE_BUSY
db.pragma('wal_autocheckpoint = 1000');           // Checkpoint alle ~4 MB WAL (Default, explizit dokumentiert)
```

**Begründungen:**
- `cache_size = -65536` — 64 MB Hot-Pages im Prozess-Cache. Default ≈ 2 MB. Reduziert Page-Reads für `figures`/`pages`/`chat_messages`-Scans drastisch.
- `mmap_size = 256 MB` — DB-File in den Adressraum gemappt, Linux-Kernel paged on-demand. Schub für die kommenden Body-HTML-Reads (Phase 1).
- `temp_store = MEMORY` — Sortierungen + temp-Indizes (Komplettanalyse-JOINs, Palette-Provider) ohne Temp-Files auf Disk.
- `busy_timeout = 5000` — Cron-Sync + interaktiver Schreiber überschneiden sich gelegentlich. 5 s Wait > sofortiger Fehler.

**Optional `PRAGMA optimize` beim Shutdown** (in `server.js`-SIGTERM-Handler): SQLite analysiert Query-Statistiken, baut bessere Indexpläne. Cheap, max. einmal pro Sitzung.

**Tests:** Smoke-Test in [tests/unit/](../tests/unit/) — Open-DB, prüfe `PRAGMA cache_size`/`mmap_size`/`temp_store`/`busy_timeout` Returns. Verhindert Regression bei künftigem Connection-Refactor.

**Aufwand:** ~1 h. Risiko: niedrig. Rollback: PRAGMA-Block entfernen.

---

## Phase 0d — Cache-TTL-Cleanup

Ziel: Cache-Tabellen wachsen heute unbegrenzt. Nach Komplettanalyse-Reruns, Lektorat-Sessions, Buch-Bewertungen sammelt sich Müll, der nicht mehr matcht (Prompt-Version gebumpt, Page-Signatur veraltet). Periodischer Cleanup-Cron hält die DB schlank, beschleunigt Sequential-Scans, reduziert Backup-Grösse.

**Betroffene Tabellen** (gemäss CLAUDE.md-Cache-Liste):
- `chapter_extract_cache`, `book_extract_cache` — Komplettanalyse
- `chapter_review_cache`, `book_review_cache`, `chapter_macro_review_cache` — Bewertungen
- `synonym_cache` — Editor-Synonyme
- `lektorat_cache` — Seiten-Lektorat
- `finetune_ai_cache` — Finetune-Augmentation
- `font_cache` — bereits 30-Tage-TTL beim Stale-Read, aber kein Purge
- `job_runs` (`status IN ('done','error','cancelled')` älter als N Tage)
- `page_checks` (alte Snapshots, sobald Page neu gesynct wurde)
- `book_stats_history` — historische Snapshots > 365 Tage purgen oder downsamplen
- `page_revisions` (Phase 2) — kein TTL, sondern Max-Limit pro `page_id` (siehe Phase 2)

**Migration N+m** (additiv) — fehlende `created_at`-Spalten ergänzen:

```sql
ALTER TABLE chapter_extract_cache       ADD COLUMN created_at TEXT;
ALTER TABLE book_extract_cache          ADD COLUMN created_at TEXT;
ALTER TABLE chapter_review_cache        ADD COLUMN created_at TEXT;
ALTER TABLE book_review_cache           ADD COLUMN created_at TEXT;
ALTER TABLE chapter_macro_review_cache  ADD COLUMN created_at TEXT;
ALTER TABLE synonym_cache               ADD COLUMN created_at TEXT;
ALTER TABLE lektorat_cache              ADD COLUMN created_at TEXT;
ALTER TABLE finetune_ai_cache           ADD COLUMN created_at TEXT;
-- Backfill bestehende Rows: created_at = COALESCE(updated_at, datetime('now'))
```

Tabellen mit bereits vorhandenem `created_at`/`updated_at` (`font_cache`, `job_runs`, `page_checks`, `book_stats_history`) übersprungen.

**Modul `lib/cache-cleanup.js`** (neu):

```js
const POLICIES = [
  { table: 'chapter_extract_cache',       ttlDays: 90 },
  { table: 'book_extract_cache',          ttlDays: 90 },
  { table: 'chapter_review_cache',        ttlDays: 90 },
  { table: 'book_review_cache',           ttlDays: 90 },
  { table: 'chapter_macro_review_cache',  ttlDays: 90 },
  { table: 'synonym_cache',               ttlDays: 30 },
  { table: 'lektorat_cache',              ttlDays: 60 },
  { table: 'finetune_ai_cache',           ttlDays: 60 },
  { table: 'font_cache',                  ttlDays: 90 },
  { table: 'job_runs',                    ttlDays: 30, where: `status IN ('done','error','cancelled')` },
  { table: 'page_checks',                 ttlDays: 90 },
  { table: 'book_stats_history',          ttlDays: 365 },
];
function runCacheCleanup() { /* DELETE pro Policy mit datetime('now', '-N days') */ }
```

**Scheduler:** Im selben Cron-Tick wie [routes/sync.js](../routes/sync.js)#`syncAllBooks` (täglich 02:00) zusätzlich `runCacheCleanup()`. Logs pro Tabelle: `[cache-cleanup] table=synonym_cache removed=247`.

**Manuelles Tool:** `npm run cache:cleanup` (script in `package.json`) für Ad-hoc-Trigger nach Prompt-Schema-Änderung. Optional `--vacuum`-Flag ruft am Ende `VACUUM;` (Rebuild ohne Lücken, Disk-Space-Reclaim).

**Why TTL statt Cache-Invalidation nach Inhaltsänderung:** `PROMPTS_VERSION`-Bumps und `pages_sig`-Mismatches sortieren stale Rows lautlos aus (Cache-Miss → Neu-Extraktion). Die alten Rows bleiben aber liegen. TTL ist die einfachste Garbage-Collection — Hit-Rate auf alte Rows ist nach 30/60/90 Tagen praktisch null.

**Tests:** Unit-Test in [tests/unit/cache-cleanup.test.mjs](../tests/unit/cache-cleanup.test.mjs) — seedet In-Memory-DB mit alten + frischen Rows, ruft `runCacheCleanup`, verifiziert: alte raus, frische bleiben, Policies einzeln testbar.

**Aufwand:** ~0.5 Tag. Risiko: niedrig (DELETE per TTL, kein FK-Bruch). Rollback: Cron-Hook auskommentieren.

---

## Phase 1 — `localdb`-Backend implementieren (Content-Store-Variante)

Ziel: `lib/content-store.js` (aus Vor-Phase Schritt 4) bekommt eine zweite Implementierung, die ausschliesslich auf lokale Tabellen geht. Backend-Dispatch via `app.backend`-Setting (Phase 4c). Solange `app.backend='bookstack'`, ändert sich das Verhalten nicht.

**Architektur**:

```
content-store.js  (Facade, dispatcht auf gewählten Backend)
  ├─ backends/bookstack.js  (heute: bsGet/bsPut/bsGetAll, unverändert gekapselt)
  └─ backends/localdb.js    (NEU: SQLite-Reads/Writes auf pages/chapters/books)
```

`content-store.js` liest `app.backend` aus `app_settings`. Default `localdb` für Neu-Installationen; `bookstack` als Migrations-Default für Deployments, die heute `BOOKSTACK_BASE_URL` in ENV gesetzt haben (einmaliger Bootstrap-Default beim ersten Start nach Phase 4c-Migration). Cache pro Server-Boot; Setting-Änderung erfordert App-Restart (oder Hot-Reload via `/admin/settings`, siehe Phase 4c).

**Localdb-Backend** `lib/content-store/backends/localdb.js`:
- `loadBook(book_id)` → `SELECT … FROM books WHERE book_id = ?`.
- `bookTree(book_id)` → `chapters` + `pages` JOIN, sortiert nach `book_order.order_json` (Phase 3) oder Fallback `position`.
- `loadPage(page_id)` → `SELECT page_id, book_id, chapter_id, page_name, body_html, body_markdown, updated_at FROM pages …`.
- `savePage(page_id, { body_html, body_markdown, page_name? })` → Transaction: `page_revisions`-Row (Phase 2) → `UPDATE pages SET body_html=?, local_updated_at=datetime('now'), dirty=0 …` → FTS-Reindex (Phase 7).
- `createBook(name, owner_email)` / `createChapter` / `createPage` → INSERT mit lokal generierter PK (eigener Sequence-Counter ab `1_000_000` zur Abgrenzung vom BookStack-ID-Range).
- Kein HTTP, kein Token, keine BookStack-Berührung.

**ID-Strategie**: BookStack-IDs sind positive Integer aus BS-DB (typisch < 100k). Im `localdb`-Mode neu angelegte Entitäten kriegen IDs aus separater Sequence — klare Trennung, kein Kollisionsrisiko bei späterer Backend-Migration. FK-Constraints bleiben intakt, weil `books`/`chapters`/`pages` ihre PKs unverändert führen.

**Bookstack-Backend** `lib/content-store/backends/bookstack.js`:
- Aktueller Code aus [routes/content.js](../routes/content.js) und [lib/bookstack.js](../lib/bookstack.js) bleibt funktional — wird nur hinter der Facade gekapselt.
- Sync-Worker (siehe unten) füllt lokale Cache-Tabellen (`page_stats`, `chapter_extract_cache`, FTS-Index) — diese Cache-Pfade laufen **nur** im `bookstack`-Mode. Im `localdb`-Mode triggert jeder Save direkt die Cache-Aktualisierung im selben Pfad.

**Sync-Worker** `lib/replica-sync.js` (neu, nur aktiv bei `app.backend='bookstack'`):
- Pro Buch: `GET /api/books/:id` + `GET /api/books/:id/chapters` + Pages-Paginierung via `bsGetAll`.
- Body via Page-Detail (`GET /api/pages/:id`).
- Diff via `updated_at`: stale → Refetch + Update lokaler Cache-Spalten + FTS-Reindex.
- Hierarchie/Order: BookStack-`priority` → lokales `position` (lockstep, Cache).
- Trigger: `POST /sync/book/:id` manuell + Cron 02:00 (existiert in [routes/sync.js](../routes/sync.js)) + bei jedem Page-Open Lazy-Refresh-Check.
- Im `localdb`-Mode: Sync-Cron deregistriert oder no-op.

**Routen**: Frontend spricht unverändert `/content/...` (aus Vor-Phase Schritt 1). Kein neuer `/local/...`-Pfad — die Backend-Wahl ist serverintern.

**Frontend**: bleibt unverändert. `public/js/repo/content.js` (Vor-Phase Schritt 2) spricht nur die Facade-URL. Kein Feature-Flag im Frontend, kein Shadow-Mode.

**Tests**:
- Unit (Backend-Disjunktion): beide Backends erfüllen denselben `content-store`-Vertrag (`loadPage`/`savePage`/`bookTree`), gegen Mock-DB bzw. Mock-BookStack.
- Integration: `/content/pages/:id` PUT im `localdb`-Mode persistiert in `pages.body_html`, schreibt `page_revisions`-Row, refresht FTS.
- Integration: `/content/pages/:id` PUT im `bookstack`-Mode ruft `bsPut`, schreibt zusätzlich `page_revisions` lokal (Phase 2).

Bestehende Caches (`page_stats`, `chapter_extract_cache`) bleiben unverändert — sie sind backend-agnostisch (gefüttert von Sync im BS-Mode, von Save-Hooks im localdb-Mode).

---

## Phase 2 — Eigene Page-Revisions

**Migration N+2**:

```sql
CREATE TABLE page_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
  body_html TEXT NOT NULL,
  body_markdown TEXT,
  chars INTEGER, words INTEGER, tok INTEGER,
  source TEXT NOT NULL CHECK(source IN
    ('focus','main','chat-apply','lektorat-apply','bookstack-sync','import','conflict')),
  user_email TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  summary TEXT
);
CREATE INDEX idx_page_revisions_page ON page_revisions(page_id, created_at DESC);
```

Jeder erfolgreiche `bsPut`-Pfad (Editor-Save, Focus-Save, Chat-Apply, Lektorat-Apply, History-Restore) schreibt Revision **vor** PUT mit `source`-Tag. Sync-Pull schreibt Revision `source='bookstack-sync'`, wenn Body sich änderte.

**Frontend**: `page-history-card` umstellen auf `GET /local/pages/:id/revisions`. Restore = neue Revision + PUT.

**Retention via Max-Limit pro Seite** (BookStack-Stil, kein TTL):
- Setting `app.page_revision_limit` in `app_settings` (Default `50`, Range `10..500`). Analog BookStack-Config `revision-limit`.
- Cleanup-Job purged pro `page_id` alle Revisions ausserhalb der jüngsten N:
  ```sql
  DELETE FROM page_revisions
  WHERE id IN (
    SELECT id FROM page_revisions pr
    WHERE pr.page_id = page_revisions.page_id
    ORDER BY created_at DESC
    LIMIT -1 OFFSET ?  -- ? = limit
  );
  ```
  Effizient via Window-Function (`ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY created_at DESC)`) — alle Pages in einem Pass.
- Hook in `lib/cache-cleanup.js` (Phase 0d): zusätzliche Policy `{ table: 'page_revisions', kind: 'per-page-limit', setting: 'page_revision_limit' }`. Cron-Tick 02:00 ruft mit auf.
- Kein TTL — User-Wert (eigene Edit-History) verfällt nicht nach Datum, nur nach Anzahl. Konsistent mit BookStack-Verhalten, Migration `bookstack`→`localdb` ist erwartungstreu.

Vorteil sofort verfügbar, auch ohne Phase 1.

---

## Phase 3 — Eigene Sortierung (Kapitel + Seiten)

Deckt **alle** Strukturoperationen ab: Kapitel-Reihenfolge, Seiten-Reihenfolge innerhalb eines Kapitels, Seiten direkt unter Buch (ohne Kapitel), Seiten zwischen Kapitel umhängen, Seiten zwischen Top-Level und Kapitel umhängen.

**Migration N+3**:

```sql
CREATE TABLE book_order (
  book_id INTEGER PRIMARY KEY REFERENCES books(book_id) ON DELETE CASCADE,
  order_json TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by TEXT
);
```

**Tree-Format** (`order_json`):

```json
[
  { "type": "chapter", "id": 42, "children": [
      { "type": "page", "id": 101 },
      { "type": "page", "id": 102 }
  ]},
  { "type": "page", "id": 103 },
  { "type": "chapter", "id": 43, "children": [] }
]
```

**Hierarchie-Invarianten** (Server-Validierung in `PUT /local/books/:id/order`):
- Genau zwei Ebenen: Buch → (Kapitel ODER Seite) → Seite. Kein Kapitel-in-Kapitel, keine tiefere Verschachtelung.
- Jeder Eintrag hat `type` (`'chapter'|'page'`) und numerische `id`.
- Alle referenzierten IDs gehören zum betreffenden `book_id` — Lookup in `pages` und `chapters`.
- Keine doppelten IDs im Tree (jede Page/jedes Kapitel kommt genau einmal vor).
- Alle Pages/Kapitel des Buches müssen im Tree vorkommen (Vollständigkeit) — verhindert „verlorene" Pages bei Buggy-Frontend-Diffs. Server lehnt Save mit unvollständigem Tree ab.
- `children` nur bei `type='chapter'` erlaubt; ein Top-Level-`type='page'` darf keine Kinder haben.

**Materialisierte Spalten** (`pages.position`, `chapters.position`, `pages.chapter_id`):
- Server-Hook beim `PUT /local/books/:id/order`: Tree traversieren, Positionen vergeben (0-basiert, lückenlos), `pages.chapter_id` setzen (NULL für Top-Level), `pages.position` und `chapters.position` updaten.
- `pages.chapter_id`-Spalte existiert bereits (BookStack-Sync-Cache), bekommt damit lokale Wahrheit. FK auf `chapters(chapter_id) ON DELETE SET NULL` ist schon vorhanden.
- `pages.position` (aus Phase 0) zählt **innerhalb des Kapitels**; Top-Level-Pages haben eigenen Zählbereich (zusammen mit Kapiteln im Tree). Single-Stream-Position über alle Top-Level-Items via separater Spalte `pages.book_position` + `chapters.book_position` — oder simpler: Frontend liest direkt aus `order_json` und ignoriert materialisierte Spalten für Render. Materialisierung dient nur Querys/JOINs (z.B. „nächste Page", Sync).

**Routen**:
- `GET /local/books/:id/order` → `{ order_json, updated_at, updated_by }`.
- `PUT /local/books/:id/order` `{ order_json }` → Validierung + Materialisierung + Save. Atomar in Transaction. Setzt `book_order.updated_at` und alle `pages.chapter_id`/`*.position`-Felder in einer Transaction.
- Keine Per-Item-Move-Routen — Frontend sendet immer den vollständigen Tree. Hält Server-Logik einfach, eliminiert Race-Conditions.

**Frontend** (Tree-Card, [public/js/tree.js](../public/js/tree.js)):
- Drag-Reorder berechnet neuen Tree clientseitig, sendet komplettes Snapshot. Optimistic-Update + Rollback bei 4xx.
- Granularitäten der UI-Operationen, die alle dasselbe Endpoint verwenden:
  - Kapitel innerhalb der Top-Level-Sequenz verschieben.
  - Seite innerhalb eines Kapitels verschieben.
  - Seite zwischen zwei Kapiteln verschieben.
  - Seite aus Kapitel auf Top-Level holen.
  - Seite von Top-Level in ein Kapitel hängen.
- Tree-Render liest direkt aus `order_json` (SSoT), nicht aus `pages.position`. Materialisierte Spalten sind nur für Server-JOINs.

**Initial-Fill** beim Aktivieren der Phase: Migration baut `order_json` aus den vorhandenen `pages.priority`/`chapters.priority` (BookStack-Sync-Snapshot). Danach übernimmt `book_order` die Wahrheit; Sync-Pull aus Phase 1 schreibt **nicht** mehr in `priority`-basierte Render-Pfade.

**Konflikt mit Replica-Pull** (Phase 1): wenn BookStack-Side jemand Pages umhängt (sollte in BookStack-frei-Zukunft nicht passieren, ist aber in Replica-Zwischenphase möglich): Sync-Pull erkennt Diff (`pages.chapter_id` remote ≠ lokal, oder neue Page nicht im Tree). Strategie:
- **Während Phase 3 alleine** (vor Phase 5): Lokal gewinnt. Sync-Pull synct nur Body + Metadaten, nie Order. Auf BookStack-UI vorgenommene Reorder werden ignoriert. Hint im Admin-Log.
- **Mit Phase 5 (Dual-Write)**: Order-Push zu BookStack erfolgt nach jedem `PUT /local/books/:id/order`. Konflikterkennung via `chapters.updated_at`/`pages.updated_at` aus letztem Pull. Differiert → Konflikt-Marker im Tree, Frontend fragt User.

**BookStack-Übersetzung (Phase 5 Push-Worker)**:
- BookStack-Modell: Pages haben `chapter_id` (oder `0` für Top-Level) + `priority`. Kapitel haben `priority`.
- Push-Worker iteriert Tree:
  - Pro Kapitel: `PUT /api/chapters/:id { priority: N }`.
  - Pro Page: wenn `chapter_id` lokal differiert, `PUT /api/pages/:id { chapter_id, priority }`; sonst nur `priority`.
  - Top-Level-Pages: `chapter_id = 0` in BookStack-API.
- Reihenfolge: erst Kapitel, dann Pages (BookStack braucht Chapter-Updates konsistent vor Page-Move).
- Batch-Window: kurz throtteln, BookStack-API-Rate-Limit beachten.

**Tests**:
- Unit: Tree-Validator (Schema, Vollständigkeit, Doppel-IDs, Verschachtelungsgrenze).
- Unit: Materialisierung (Tree → `pages.chapter_id`/`*.position`).
- E2E: Drag-Reorder über alle 5 Granularitäten oben.
- Integration (Phase 5): Push-Worker übersetzt Tree → BookStack-API-Calls korrekt.

---

## Phase 4a — App-User-Verwaltung

Eigene User-DB. BookStack-User-Liste wird ignoriert. OIDC-Login bleibt Identitätsquelle.

**Migration N+4a**:

```sql
CREATE TABLE app_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  global_role TEXT NOT NULL DEFAULT 'user'
    CHECK(global_role IN ('admin','user')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('invited','active','suspended','deleted')),
  language TEXT DEFAULT 'de',
  model_override TEXT,
  can_invite_users INTEGER NOT NULL DEFAULT 1,  -- darf User-Invites (Phase 4a) erstellen. Default an: Standard-User soll Kollegen als viewer/lektor onboarden können. Admin kann pro User entziehen.
  first_seen_at TEXT,
  last_seen_at TEXT,
  invited_by TEXT,
  invited_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_app_users_status ON app_users(status);

CREATE TABLE user_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  global_role TEXT NOT NULL DEFAULT 'user'
    CHECK(global_role IN ('admin','user')),
  invite_token TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  invited_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  UNIQUE(email)
);
CREATE INDEX idx_user_invites_token ON user_invites(invite_token);

CREATE TABLE user_sessions_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN
    ('login','logout','login-denied','suspended','reactivated','role-changed','deleted')),
  ip TEXT,
  user_agent TEXT,
  meta_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_user_audit_user ON user_sessions_audit(user_email, created_at DESC);
```

**Bestehende User-bezogene Tabellen** (FK-Recreate-Pattern):
- `user_settings` → FK `user_email REFERENCES app_users(email) ON DELETE CASCADE`.
- Token-Tabellen (`tokens`, `token_usage`, falls user-scoped).
- `jobs`, `chat_sessions`, `page_revisions` → bewusst **keine** harte FK. User-Löschung würde Historie kaskadieren. Stattdessen Soft-Delete (`status='deleted'`), Email bleibt blockiert.

**Rollen**:
- `admin`: User-Verwaltung + globale Settings + Claude-Config. **Keine** Buchsicht (Privacy-Boundary, siehe oben). Implizit `can_invite_users=1`.
- `user`: Standard. Eigene Bücher anlegen, teilen, sehen. `can_invite_users=1` per Default — Use-Case: User lädt Kollegen als `lektor`/`viewer` ein, ohne dass Admin eingreift. Invite erzwingt `global_role='user'`. Admin kann Flag pro User entziehen (z.B. bei Missbrauch). Admin-Hochstufung bleibt Admin-only.

**Status-Werte**:
- `invited`: Invite ausgestellt, noch nie eingeloggt.
- `active`: aktiv, darf einloggen.
- `suspended`: vorübergehend gesperrt.
- `deleted`: Soft-Delete, Email permanent blockiert.

**Zwei parallele Login-Pfade** (Umbau in [routes/auth.js](../routes/auth.js)):

*A) Google-OIDC (Standard-User + Admin alternativ):*
1. OIDC-Callback liefert verifizierte Email.
2. Lookup in `app_users`.
3. `status='active'` → Session anlegen (`global_role` aus DB), `last_seen_at` updaten, Audit `login` mit `method='oidc'`.
4. `status='suspended'` oder `'deleted'` → 403, Audit `login-denied`.
5. Kein Treffer, aber gültiger Invite-Token (Query-Param `?invite=…`) → User aus Invite anlegen, `status='active'`, Invite `accepted_at` setzen.
6. Kein Treffer, kein Invite → 403, Hinweis „Zugang nicht freigeschaltet".

*B) Admin-Passwort-Login (persistent, kein Bootstrap-Only):*
1. `GET /login` zeigt zwei Buttons: „Mit Google anmelden" + „Admin-Login".
2. `POST /auth/admin-login` `{ email, password }` → vergleicht gegen `process.env.ADMIN_EMAIL` + `process.env.ADMIN_PASSWORD` via `crypto.timingSafeEqual`.
3. Match → Session mit `global_role='admin'`, Audit `login` mit `method='env'`.
4. Mismatch → 401 + Rate-Limit-Zähler hochzählen, Audit `login-denied`.
5. `ADMIN_PASSWORD` leer/unset → Pfad B komplett deaktiviert (Button ausgeblendet, Route liefert 404).

**`ADMIN_EMAIL`/`ADMIN_PASSWORD` Semantik:**
- Klartext in `.env` (Self-Hosted-Pattern, [[project_self_hosted_oss]]). Dateirechte `chmod 600`. Nie in Git.
- Wahrheit lebt in ENV — kein Passwort-Hash in DB. `.env` ändern → sofort wirksam beim nächsten Login (keine Restart-Pflicht, `process.env` wird zur Login-Zeit gelesen).
- `app_users`-Row für `ADMIN_EMAIL` wird beim Server-Start angelegt, falls fehlend: `global_role='admin'`, `status='active'`. Diese Row trägt Audit, `display_name`, `language` etc. — Passwort selbst aber nicht.
- Email-Wechsel in `.env`: alte Admin-Row bleibt liegen (Soft-Delete/Cleanup durch Admin selbst); neue Email legt zweite Admin-Row beim ersten Login an.
- OIDC-Login mit derselben Email funktioniert parallel (gleiche Row, beide Methoden lösen die Session aus).

**Rate-Limit** (`express-rate-limit`, neue Dep): 5 Versuche pro IP pro 15 min auf `POST /auth/admin-login`. Nach Limit 429 + 15-min-Sperre. OIDC-Pfad nicht limitiert (Google macht das vor).

**Open-Signup-Schalter**: Env `ALLOW_OPEN_SIGNUP=false` (Default). Wenn `true`: OIDC-Schritt 6 legt User automatisch als `status='active', global_role='user'` an. Passwort-Pfad ignoriert das Flag (Admin-only).

**Routen**:
- `GET /admin/users` (Admin) — Liste + Filter + Suche.
- `POST /admin/users/invite` `{ email, role }` → `user_invites`-Row + Token. Optional Email via `SMTP_*`-ENV, sonst Token in UI anzeigen. **Guard**: `global_role='admin' OR app_users.can_invite_users=1`. Wer kein Admin ist, darf nur Invites mit `role='user'` ausstellen (kein Admin-Hochstufen).
- `PUT /admin/users/:email` `{ global_role?, status?, can_invite_users? }` (Admin only — `can_invite_users` ist Admin-vergebenes Flag).
- `DELETE /admin/users/:email` → Soft-Delete (`status='deleted'`), `display_name` anonymisieren, Audit behalten.
- `GET /me` (bestehend, anpassen): liefert `{ email, displayName, role, can_invite_users, language, model_override }` aus `app_users`.
- `PUT /me` (bestehende [routes/usersettings.js](../routes/usersettings.js)): nur Selbst-Felder (kein `can_invite_users`, das setzt Admin).
- `POST /me/invite` `{ email }` → User-Invite-Variante für Nicht-Admins mit `can_invite_users=1`. Erzwingt `role='user'`, sonst identisch zu `/admin/users/invite`. UI-Einstiegspunkt aus Buch-Sharing-Dialog: „User existiert noch nicht — jetzt einladen".

**Frontend — neue Karte `AdminUsersCard`**:
- `FEATURES`-Eintrag + `EXCLUSIVE_CARDS` + `ALLOWED_KEYS` in [routes/usage.js](../routes/usage.js).
- Sichtbarkeit: nur wenn `$app.currentUser.role === 'admin'`. Pill und Card-Toggle ansonsten ausgeblendet.
- Tabelle: User, Rolle (Combobox), Status (Combobox), letzter Login, Aktionen (Suspend, Delete).
- Invite-Sektion: Email-Input + Role-Combobox + „Invite erstellen" → Token-Anzeige + Copy + Invite-URL.
- Audit-Drawer pro User (letzte 50 Events).

**i18n** (beide Locales pflegen):
- `admin.users.title`, `admin.users.invite`, `admin.users.role`, `admin.users.status`
- `admin.users.role.admin|user`, `admin.users.status.active|suspended|invited|deleted`
- `admin.users.confirmDelete`, `admin.users.lastLogin`
- `auth.denied.notInvited`, `auth.denied.suspended`
- `me.language`, `me.modelOverride`

**Migration des Bestands**:
- Scan `book_access`-Vorgänger / `chat_sessions` / `jobs` / etc. nach distinct `user_email`.
- Für jeden Eintrag `app_users`-Row anlegen mit `status='active'`, `global_role='user'`.
- `ADMIN_EMAIL` → wenn matched, `global_role='admin'`. Sonst neue Row anlegen.

---

## Phase 4b — Book-ACL + Sharing

```sql
CREATE TABLE book_access (
  book_id INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
  user_email TEXT NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','editor','lektor','viewer')),
  granted_at TEXT DEFAULT (datetime('now')),
  granted_by TEXT,
  PRIMARY KEY (book_id, user_email)
);
CREATE INDEX idx_book_access_user ON book_access(user_email);

CREATE TABLE book_share_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
  invitee_email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('editor','lektor','viewer')),
  invited_by TEXT NOT NULL,
  invited_at TEXT DEFAULT (datetime('now')),
  accepted_at TEXT,
  revoked_at TEXT,
  UNIQUE(book_id, invitee_email)
);

CREATE TABLE page_locks (
  page_id INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
  locked_by_email TEXT NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK(reason IN ('lektorat')),
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_page_locks_book ON page_locks(book_id);
CREATE INDEX idx_page_locks_user ON page_locks(locked_by_email);
CREATE INDEX idx_page_locks_expires ON page_locks(expires_at);
```

**Rollen pro Buch** (Hierarchie absteigend, jede höhere Stufe hat alle Rechte der niedrigeren):

- `owner`: alles, inklusive Sharing-Verwaltung. Genau einer pro Buch. Transferierbar.
- `editor`: lesen + freies Schreiben (Pages, Order, Tags, BookSettings). Trigger aller KI-Jobs. Kein Löschen, kein Sharing-Ändern.
- `lektor`: lesen + **nur vorgeschlagene Korrekturen anwenden**. Keine freien Edits, kein Strukturumbau, kein Page-Anlegen, kein Tag/Setting-Ändern. Darf Lektorat-Job triggern (um Findings zu erzeugen) und Findings via `lektorat-findings-card` anwenden; darf Chat-Vorschläge (`chat-card.vorschlaege`) anwenden. Free-Text-Edits im Editor blockiert (CodeMirror `readOnly` plus selektive Mutations-Pfade für Apply-Operationen). Wechselt Granularität nicht — selbst Whitespace-Edits ausserhalb der Vorschlag-Range sind 403.
- `viewer`: nur lesen, plus Export. **Buch-Editor im View-Mode** (kein Schreiben, keine Toolbar-Buttons für Mutationen, keine Findings/Lektorat-Karten). Sichtbar nur: Page-Inhalt, Page-Liste/Kapitel-Tree, Export-Karten (`export`, `pdfExport`). Versteckt: Stats-/Review-/Analyse-/World-Karten + alle Job-Trigger ausser Export. Domain-Daten (Figuren/Orte/Szenen) sind aus Viewer-Sicht nicht relevant — Cards versteckt; Server liefert sie trotzdem read-only an Viewer, falls Verlinkung nötig.

**Permissions-Matrix** (Server-Guards):

| Operation                                         | owner | editor | lektor | viewer |
|---------------------------------------------------|-------|--------|--------|--------|
| Buch lesen (Pages, Tree, Body)                    | ja    | ja     | ja     | ja     |
| Export (BookStack-Export, Custom-PDF)             | ja    | ja     | ja     | ja     |
| Free-Text-Edit (Page-Body, Page-Name)             | ja    | ja     | nein   | nein   |
| Order ändern (Phase 3)                            | ja    | ja     | nein   | nein   |
| Lektorat-Job triggern                             | ja    | ja     | ja     | nein   |
| Lektorat-Finding anwenden (`/lektorat/apply`)     | ja    | ja     | ja     | nein   |
| Chat-Vorschlag anwenden                           | ja    | ja     | ja     | nein   |
| Page-Chat senden                                  | ja    | ja     | ja     | nein   |
| Buch-Chat senden                                  | ja    | ja     | nein   | nein   |
| Analyse-Jobs (Komplett, Review, Kontinuität, …)   | ja    | ja     | nein   | nein   |
| Figuren/Orte/Szenen/Ideen CRUD                    | ja    | ja     | nein   | nein   |
| BookSettings ändern (Buchtyp, Freitext, Tags)     | ja    | ja     | nein   | nein   |
| Sharing-Verwaltung                                | ja    | nein   | nein   | nein   |
| Buch löschen / Ownership-Transfer                 | ja    | nein   | nein   | nein   |

**Apply-only-Mutations für `lektor`**: Server muss differenzieren zwischen „freiem Save" und „Apply-Operation". Konkret separate Routen:
- `POST /local/pages/:id/apply-lektorat-finding` `{ finding_id }` — Server lädt Finding, ersetzt Range im Body, schreibt Revision (`source='lektorat-apply'`), PUT.
- `POST /local/pages/:id/apply-chat-vorschlag` `{ vorschlag_id }` — analog, `source='chat-apply'`.
- `PUT /local/pages/:id { body_html }` (Free-Edit-Pfad) bleibt `editor`+.
- Lektor-Guard auf Apply-Routen prüft zusätzlich, dass der Vorschlag/das Finding zu derselben Page gehört. Kein Pfad, mit dem Lektor beliebigen HTML einschleusen könnte.

**Page-Lock während Lektorat-Session** (`page_locks`-Tabelle, siehe Schema oben): Seite, an der gerade lektoriert wird, ist für Free-Text-Edits gesperrt. Verhindert, dass der Autor parallel im Editor weiterschreibt, während der Lektor Findings ansieht/anwendet — sonst driften Range-Positionen weg und der `updatedAt`-Staleness-Check (siehe Risiko unten) verwirft die ganze Lektorat-Session.

- **Acquire**: Wer den Lektorat-Job triggert (`POST /jobs/lektorat`) oder eine bestehende Findings-Liste öffnet (`POST /local/pages/:id/lock` mit `reason='lektorat'`), erhält einen Lock auf die Page. `expires_at = now + 30 min`. Ein bereits bestehender Lock desselben Users wird verlängert (Idempotenz); Lock eines fremden Users → `423 Locked` mit `{ locked_by_email, expires_at }` für UI-Anzeige.
- **Heartbeat**: Frontend (Lektorat-Findings-Card) postet alle 60 s `POST /local/pages/:id/lock/heartbeat`, solange die Karte offen ist. Heartbeat verlängert `expires_at` um weitere 30 min und setzt `last_heartbeat_at`.
- **Release**: Explizit via `DELETE /local/pages/:id/lock` beim Schliessen der Findings-Card oder „Lektorat abschliessen"-Button. Implizit beim ersten erfolgreichen Apply-Pfad-Call, der den Findings-Stack leert (Server löscht Lock-Row im selben Transaktions-Schritt). Implizit beim `beforeunload` (best-effort `navigator.sendBeacon`).
- **Server-seitiges Cleanup**: Jeder Lock-Check filtert `WHERE expires_at > datetime('now')`. Cron-Cleanup (im 0d-Cron mit drin) löscht abgelaufene Rows einmal pro Tag — Funktionalität hängt nicht davon ab, nur DB-Hygiene.
- **Guard auf Free-Edit-Routen** (`PUT /local/pages/:id`, `PUT /local/pages/:id/order`, `POST /local/pages/:id/apply-chat-vorschlag` aus dem Page-Chat des Editors): Server prüft `page_locks`. Existiert ein Lock und `locked_by_email !== currentUser.email` und `expires_at > now` → `423 Locked` mit `{ locked_by_email }`. Apply-Routen des **Lock-Holders selbst** sind erlaubt (Lektor braucht sie ja).
- **Frontend-UX im Editor** (für den Autor, der gesperrt ist): Statt 423-Fehler-Toast eine Editor-Banner-Komponente analog zum Session-Banner: „Diese Seite wird gerade von `<email>` lektoriert (bis `<expires_at>`). Bearbeitung pausiert." CodeMirror auf `readOnly: true` setzen, Toolbar-Mutations-Buttons hidden, Auto-Save-Pfad früh aussteigen. Banner refresht via Polling (`GET /local/pages/:id/lock` alle 30 s) und blendet sich aus, sobald der Lock weg ist; danach wieder normales Editier-Verhalten.
- **Frontend-UX im Lektorat** (für den Lektor): Findings-Card zeigt am Header „Du lektorierst — andere können diese Seite gerade nicht bearbeiten". Beim Schliessen der Card explizit Release. Bei Hard-Tab-Close greift Heartbeat-Timeout (max 30 min Stau).
- **Owner/Editor-Override**: Owner darf einen fremden Lock brechen (`DELETE /local/pages/:id/lock?force=true` → 403 für Editor, 200 für Owner). Use-Case: Lektor lässt Browser offen, Urlaub, Owner muss weiter. Audit-Log-Event `lock-broken` mit `meta_json = { broken_by, original_holder }`.

**Lock-Granularität**: Lock ist **pro Page**, nicht pro Kapitel/Buch. Lektor kann mehrere Pages gleichzeitig halten (eine Findings-Card pro Page); Autor kann an anderen Pages desselben Buches frei weiterarbeiten.

**Viewer im Editor**: Frontend öffnet Page im Editor mit `readOnly: true` (CodeMirror-Option) + Toolbar-Buttons hidden via `$app.canEdit`-Getter. Auto-Save-Pfad früh aussteigen. Selection/Find/Synonyme-Lookup bleibt erlaubt (kein Mutationsweg). Findings-Card + Page-Chat-Card komplett ausgeblendet.

**Guard-Middleware** `lib/acl.js` (neu):
- `requireBookAccess(minRole)` liest `book_access`. Hierarchie `owner > editor > lektor > viewer`.
- URL-Param-Routes via `router.param('book_id', aclParamGuard)` analog zu [lib/log-context.js](../lib/log-context.js).
- Body/Query-Routes lösen Guard manuell nach `toIntId`.
- Server-Guards setzen Mindest-Rolle pro Route gemäss Matrix oben. Apply-Routen: `lektor`. Free-Edit-/Order-/Analyse-Routen: `editor`. Sharing/Delete: `owner`. Export + Read: `viewer`.
- 403 bei fehlendem Recht.

**Buchliste-Endpoints filtern strikt** über `book_access`. Admin ohne Share-Row sieht **leeres Array** — keine Ausnahme.

**Sharing-Regel**:
- Sharing-Ziel muss `app_users`-Eintrag haben (`status='active'` oder `'invited'`).
- Frontend-Autocomplete liest `app_users`.
- Nicht-User → Frontend bietet „User zuerst einladen" an. Funktioniert für `global_role='admin'` (Pfad `/admin/users/invite`) und für jeden User mit `can_invite_users=1` (Pfad `/me/invite`, erzwingt `global_role='user'`). Sonst Hinweis „Bitte Admin kontaktieren".
- Wer eingeladen werden darf, ist von der Buch-Rolle entkoppelt: auch ein Viewer/Lektor kann ein noch-nicht-User einladen, sofern `can_invite_users=1`. Owner/Editor des aktuellen Buches darf danach diesen frischen User mit Buch-Rolle teilen.

**Routen**:
- `GET /books` → JOIN `book_access` (User-scoped).
- `POST /books` → Anleger wird Owner (Row in `book_access` + `books.owner_email`).
- `GET /books/:id/access` → Liste der Berechtigten.
- `POST /books/:id/share` `{ email, role }` → Invite + sofortige Auto-Accept-Row (Solo-Tenant).
- `DELETE /books/:id/access/:email` → Widerruf.
- `PUT /books/:id/access/:email` `{ role }` → Rollenwechsel (nicht für Owner).
- `POST /books/:id/transfer-ownership` `{ email }` → neuer Owner muss bereits in `book_access` sein.

**Frontend — `BookAccessCard`**:
- Sichtbar für alle, die `owner`, `editor`, `lektor` oder `viewer` auf dem aktuellen Buch sind (Lese-Modus für Nicht-Owner → können Liste sehen, nicht ändern).
- Owner darf zusätzlich Rolle pro Eintrag in der Tabelle ändern (Combobox `editor|lektor|viewer`); Owner-Zeile read-only (Transfer separat).
- Sub-Karte unter BookSettings oder eigene Karte.
- Buchliste zeigt Badge „geteilt" + Owner-Mail + eigene Rolle (eckig, `--radius-sm`).
- Filter „Meine" / „Mit mir geteilt" / „Alle".
- Invite-Sektion in der Share-Combobox: Wenn eingegebene Email kein User → Button „Einladen" sichtbar wenn `currentUser.global_role='admin' OR currentUser.can_invite_users=1`. Sonst Hinweis.

**Karten-Sichtbarkeit pro Buch-Rolle** (Frontend filtert `FEATURES` aus [public/js/cards/feature-registry.js](../public/js/cards/feature-registry.js) zusätzlich zu den heutigen `requiresBook`/`requiresPages`-Flags):

- `viewer`: nur `bookOverview` (read-only), `export`, `pdfExport`. Quick-Pills + Command-Palette + Sidebar-Tiles versteckt für alles andere. `bookEditor` öffnet im View-Mode.
- `lektor`: zusätzlich Lektorat-Findings-Card sichtbar, Page-Chat sichtbar (für Vorschlag-Apply), `bookEditor` im „Apply-only"-Mode. Versteckt bleiben: Analyse-Cards (`review`, `kapitelReview`, `stil`, `fehlerHeatmap`, `kontinuitaet`, `bookChat`, `bookStats`, Komplett-Action), World-Cards (`figuren`, `werkstatt`, `szenen`, `orte`, `ereignisse`, `ideen`), Settings-/Export-Schreibpfade (`bookSettings`, `finetuneExport`, `bookOrganizer`).
- `editor`/`owner`: heutiger Vollumfang.

Realisierung: neues Feld `minRole: 'viewer'|'lektor'|'editor'|'owner'` pro `FEATURES`-Eintrag in `feature-registry.js`. Default `editor`. Beispiele: `export` und `pdfExport` → `minRole: 'viewer'`. `bookOverview` → `minRole: 'viewer'` (Stats-Felder werden vom Server für Viewer leer geliefert oder gar nicht in Tile-Compute geladen — separate API-Variante `/local/books/:id/overview?lean=true` für Viewer). `lektorat`-Apply-Pfad → `minRole: 'lektor'`. Alle anderen `editor`. Quick-Pills, Command-Palette und `_closeOtherMainCards` lesen `minRole` und blenden aus, was unter aktueller Buch-Rolle liegt.

**Karten-Sichtbarkeit global** (App-Ebene): `AdminUsersCard` + `AdminSettingsCard` weiterhin nur `global_role='admin'`. `UserSettingsCard` (Self-Profile) für alle.

**Backfill**: Migration scannt `books.owner_email`, schreibt Owner-Row in `book_access`. Bücher ohne `owner_email`: erste Person, die nach 4b zugreift, wird Owner — aber nur, wenn `ADMIN_EMAIL` nicht greift (Admin darf gerade kein Buch-Owner werden, sonst Privacy-Bruch). Konkret: Backfill fragt manuell pro Legacy-Buch oder lässt es im „herrenlos"-Zustand mit Admin-Hint.

---

## Phase 4b1 — Lese-Modus (Print-CSS + readOnly-Editor)

Ablenkungsfreier Lese-Pfad für `viewer` (und alle, die „nur lesen" wollen). **Bewusst minimal**: kein eigener Render-Stack, kein E-Reader-Klon — der existierende Editor im readOnly-Mode + Print-CSS reichen für Solo/Multi-User-Self-Host.

**Komponenten:**

1. **Editor-readOnly für viewer-Rolle** ([public/js/cards/book-editor-card.js](../public/js/cards/book-editor-card.js)):
   - CodeMirror-Option `readOnly: true`, wenn `$app.bookRole === 'viewer'`.
   - Toolbar-Buttons hidden via `$app.canEdit`-Getter (existiert bereits als Pattern; siehe Phase 4b „Viewer im Editor").
   - Findings-/Page-Chat-Card komplett ausgeblendet (minRole-Filter Phase 4b).
   - Selection/Find/Synonyme-Lookup bleibt erlaubt — kein Mutationsweg.
   - Auto-Save-Pfad früh aussteigen (`if (!canEdit) return`).

2. **Print-CSS** (`public/css/print.css`, neu):
   - `@media print { … }`: Topbar, Sidebar, Toolbar, Karten-Chrome, Findings-Margins, Job-Footer, Buttons → `display: none`.
   - Editor-Container auf volle Breite, max-width ~680px, serif-Schrift (`var(--font-serif)`).
   - Kapitel-Titel als grosses H1, Page-Headings als H2.
   - Page-Break-Hints (`page-break-before: always` für Kapitel-Wechsel).
   - Link aus `<link>` in [public/index.html](../public/index.html) + [tests/fixtures/focus-harness.html](../tests/fixtures/focus-harness.html), `SHELL_CACHE` bumpen.
   - User öffnet Browser-Print-Dialog (Cmd/Ctrl+P) → kriegt Buch als lineares Druckbild bzw. PDF-Export via Browser.

3. **„Lesen"-Button in Buchliste/Topbar** (optional, leichtgewichtig):
   - Schaltet Editor in readOnly + ruft `window.print()` direkt auf. Oder: dezenter Hint-Tooltip „Cmd/Ctrl+P für Druck/PDF".

**Explizit weggelassen (gegenüber ursprünglichem Plan):**
- Keine `reader_progress`/`reader_bookmarks`-Tabellen.
- Keine `user_settings.reader_theme`/`reader_typo_json`-Spalten.
- Keine `ReaderCard` Sub-Komponente.
- Keine eigene Render-Pipeline (`reader-render.js` etc.).
- Keine Theme-Toggles (hell/sepia/dunkel), keine Typo-Settings, keine TOC-Drawer, keine Highlights/Notizen.
- Keine `/reader/*`-Routen.

**Begründung:** Custom-PDF-Export ([routes/jobs/pdf-export.js](../routes/jobs/pdf-export.js)) existiert bereits als „Buch sauber konsumieren"-Pfad mit Profilen/Cover/Schrift. Print-CSS deckt den Browser-Pfad ab. Eigenes E-Reader-UI ist Aufwand ohne klaren Mehrwert für Self-Host.

**i18n:** keine neuen Keys (oder maximal `reader.printHint`).

**Aufwand:** 0.5-1 Tag (Print-CSS + readOnly-Guard + minRole-Filter-Wiring aus Phase 4b).

**Falls später echter E-Reader gewünscht:** Plan-Stand vor diesem Cut steht in git-History dieser Datei (`git log -p docs/bookstack-exit.md`).

---

## Phase 4c — Admin-Settings (alle Runtime-Configs aus `.env` → DB)

Ziel: `.env` schrumpft auf **reines Boot-/Infra-Layer**. Alles, was zur Laufzeit konfigurierbar sein soll (Auth-Provider, KI-Provider, Storage-Backend, Job-Tuning, Cron, PDF/A), wandert in `app_settings` und ist über die Admin-Konsole editierbar.

### `.env`-Endzustand

**Bleibt in `.env`** (nur Werte, die *vor* der DB lesbar sein müssen oder Crypto-Root sind):

| Variable | Grund |
|---|---|
| `PORT` | Express bindet vor DB-Open. |
| `DB_PATH` | Wir öffnen erst die DB damit. |
| `APP_URL` | OAuth-Callback-URL muss vor Auth-Init feststehen. |
| `SESSION_SECRET` | Express-Session-Middleware initialisiert vor DB-Read. |
| `MASTER_KEY` | AES-256-GCM-Root, verschlüsselt selbst die DB-Settings (Henne/Ei — kann nicht in der DB liegen). Existiert bereits für BookStack-Tokens, [lib/crypto.js](../lib/crypto.js). |
| `ADMIN_EMAIL` | Identität des Bootstrap-/Persistent-Admins. Wird beim Server-Start als `app_users`-Row angelegt mit `global_role='admin'`, `status='active'`. |
| `ADMIN_PASSWORD` | Klartext-Passwort für `POST /auth/admin-login`. Wahrheit lebt in ENV — kein Hash in DB. Leer/unset → Passwort-Login-Pfad deaktiviert (nur OIDC). |
| `TZ` | Process-Level (Node liest beim Start). |
| `LOG_LEVEL` | Winston-Init vor DB-Open; späterer Override via `app.log_level` möglich, wirkt nach Restart. |
| `LOCAL_DEV_MODE` | Dev-Bypass — bewusst nicht in DB (sonst Prod-Risiko via Migration-Copy). |
| `VERAPDF_BIN` | Pfad zu System-Binary; Container-Konfiguration, keine User-Entscheidung. |

Alles andere — **gelöscht aus `.env.example`** und aus DB gelesen.

### Migration N+4c

```sql
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by TEXT
);
```

`encrypted=1` markiert Felder, deren `value_json` AES-GCM-encrypted ist (`enc:v1:`-Prefix). [lib/app-settings.js](../lib/app-settings.js) liest sie transparent.

### Verwaltete Keys

**Auth** (`auth.*`):
- `auth.google.client_id`, `auth.google.client_secret` (encrypted).
- `auth.allowed_emails` (CSV → Array beim Lesen).
- `auth.allow_open_signup` (bool).
- `auth.admin_email` (read-only Spiegel der ENV `ADMIN_EMAIL` für UI-Anzeige; Wahrheit bleibt ENV — Wizard schreibt diesen Key beim Abschluss zur Information, ändert aber nicht die ENV).

**KI-Provider** (`ai.*`):
- `ai.provider` → `'claude'|'ollama'|'llama'`.
- `ai.claude.api_key` (encrypted), `ai.claude.model`, `ai.claude.max_tokens_out`, `ai.claude.context_window`, `ai.claude.retry_max`, `ai.claude.timeout_ms`, `ai.claude.phase1_concurrency`.
- `ai.ollama.host`, `ai.ollama.model`, `ai.ollama.temperature`.
- `ai.llama.host`, `ai.llama.model`, `ai.llama.temperature`.
- `ai.chat_temperature` (Override für Seiten-/Buch-Chat bei Ollama/Llama).
- `ai.chars_per_token` (Heuristik).
- `ai.lektorat_batch_concurrency`.

**Jobs / Buch-Chat** (`jobs.*`):
- `jobs.max_concurrent`.
- `jobs.book_chat.mode` → `'auto'|'agent'|'classic'`.
- `jobs.book_chat.max_tool_iter`.
- `jobs.book_chat.token_budget` (0 = vom Input-Budget ableiten).

**Cron / Sync** (`cron.*`):
- `cron.timezone`, `cron.stale_days`.

**PDF/A** (`pdfa.*`):
- `pdfa.flavour`, `pdfa.disabled`.

**Storage-Backend** (`app.*`):
- `app.backend` → `'localdb'|'bookstack'`. **Default `localdb`** für Neu-Installationen.
- `app.bookstack.base_url`, `app.bookstack.token_id` (encrypted), `app.bookstack.token_secret` (encrypted) — nur relevant bei `app.backend='bookstack'`.
- `app.setup_completed` (bool, gesetzt durch Wizard 4c1).

### Auflösungs-Reihenfolge

Neues SSoT-Modul [lib/app-settings.js](../lib/app-settings.js) ersetzt direkte `process.env.*`-Reads in [lib/ai.js](../lib/ai.js), [routes/jobs/shared.js](../routes/jobs/shared.js), [routes/jobs/book-chat-*.js](../routes/jobs/), [routes/sync.js](../routes/sync.js), [lib/pdfa-validate.js](../lib/pdfa-validate.js), [routes/auth.js](../routes/auth.js).

1. DB-Setting (`app_settings`).
2. Hardcoded Default in [lib/app-settings.js](../lib/app-settings.js).

**Kein ENV-Fallback** für migrierte Keys. ENV-Reads für diese Keys werden in den Modulen entfernt — `.env` ist für diese Keys tot. Wer Werte ändern will, nutzt Admin-UI oder direktes SQL-Update auf `app_settings`.

**Reload-Verhalten**: `app-settings`-Modul cached pro Server-Boot in Memory. `PUT /admin/settings/:key` invalidiert Cache + emittiert In-Process-Event `app-settings:changed`. Module mit teurem Re-Init (KI-Client-Instanzen, OAuth-Strategy, Cron-Jobs) reagieren auf das Event und bauen ihre Singletons neu. Provider-/OAuth-Wechsel ohne Server-Restart.

### Backend-Switch-Verhalten

- `PUT /admin/settings/app.backend` ändert den Key. **Inhalte werden nicht automatisch migriert** — Admin muss zuerst Phase-8-Bulk-Copy-Job ausführen.
- Frontend-Warn-Modal beim Wechsel: „Pages aus dem aktuellen Backend werden nicht mehr sichtbar sein, bis Sie eine Migration durchführen."
- `content-store`-Modul hört auf `app-settings:changed` und liest Backend-Pointer neu. Aktive Jobs im alten Backend laufen zu Ende.

### Admin-Routen

- `GET /admin/settings` → alle Keys, Secrets maskiert (letzte 4 Zeichen sichtbar).
- `PUT /admin/settings/:key` → Single-Key-Update. Encrypted-Felder akzeptieren Sentinel `"__unchanged__"` für „nicht angefasst".
- `POST /admin/settings/test-provider` → 1-Token-Probecall gegen aktuellen KI-Provider, gibt Latenz + Erfolg.
- `POST /admin/settings/test-backend` → bei `bookstack` `GET /api/books?count=1`, bei `localdb` `SELECT 1`. Latenz + Erfolg.
- `POST /admin/settings/test-oauth` → validiert Google-Client-ID via Discovery-Doc-Fetch (Format-Check, kein voller OAuth-Roundtrip).

Alle Admin-Routen guarded via `global_role='admin'` aus Phase 4a.

### Frontend — Karte `AdminSettingsCard`

Zweite Admin-Karte neben `AdminUsersCard`. Tabs:

1. **Auth**: Google-Client-ID/-Secret, Allowed-Emails, Open-Signup-Toggle.
2. **Provider**: Auswahl Claude/Ollama/Llama + Per-Provider-Inputs (API-Key, Host, Modell, Temperature).
3. **Modell**: Modell-ID, `max_tokens_out`, `context_window`, `chars_per_token`.
4. **Storage-Backend**: Combobox `localdb|bookstack`, bei `bookstack` zusätzliche Felder (Base-URL, Token-ID, Token-Secret). Test-Backend-Button. Warnhinweis beim Wechsel.
5. **Jobs**: `max_concurrent`, Book-Chat-Modus + Iter-Limit + Token-Budget.
6. **Cron**: Timezone, Stale-Days.
7. **PDF/A**: Flavour, Disabled-Toggle.
8. **Erweitert** (Disclosure, default eingeklappt): `claude.retry_max`, `claude.timeout_ms`, `claude.phase1_concurrency`, `lektorat_batch_concurrency`, `chat_temperature`. Hinweis-Box: „Werte ohne starken Grund unverändert lassen — Defaults sind aus Praxis kalibriert."

„Verbindung testen"-Buttons pro Tab (Provider, Backend, OAuth). Save-Button persistent unten, Dirty-Indikator pro Feld. Secret-Inputs mit Masking + Sentinel-Pattern für „unchanged".

### i18n

`admin.settings.title`, `admin.settings.tab.{auth,provider,model,backend,jobs,cron,pdfa,advanced}`, `admin.settings.backend.{localdb,bookstack,switchWarning}`, `admin.settings.test.{connection,backend,oauth}`, `admin.settings.test.{ok,fail}`, `admin.settings.secret.masked`, `admin.settings.secret.unchanged`, `admin.settings.advanced.disclaimer`.

### Sicherheit

- API-Keys + Tokens nie im Klartext über die Wire (auch nicht Admin → Frontend). Lesen → Masking; Schreiben → Sentinel `"__unchanged__"` für nicht angefasste Felder.
- Alle `encrypted=1`-Spalten via [lib/crypto.js](../lib/crypto.js) (AES-256-GCM mit `MASTER_KEY`).
- Audit-Log: `app_settings.updated_by` + `updated_at` gesetzt; optional Migration für `app_settings_audit`-Tabelle mit Vor-/Nachwert-Hashes (nicht Klartext-Secrets).

---

## Phase 4c1 — First-Run-Setup-Wizard (`/setup`)

Ziel: Frische Installation, leere DB, keine Google-Credentials → Admin loggt sich via `ADMIN_PASSWORD` ein und wird durch initiales Setup geführt (Google-OAuth-Config, KI-Provider, Storage-Backend). Wizard ist auch nach Abschluss erneut aufrufbar (= „Settings neu durchgehen"-Pfad), Trigger-Logik ist nur die initiale Pflicht-Weiterleitung.

### Voraussetzung

`ADMIN_EMAIL` + `ADMIN_PASSWORD` sind in `.env` gesetzt (siehe Phase 4c `.env`-Endzustand). Ohne `ADMIN_PASSWORD` ist kein First-Run möglich — App startet, weist beim Aufruf auf fehlende ENV hin.

### Trigger-Bedingung

Bei jedem Request einer eingeloggten Admin-Session: solange `app_settings.app.setup_completed` nicht `true` ist → `/admin/*`-Karten redirecten auf `/setup`. Andere App-Bereiche sind verfügbar, zeigen aber Banner „Setup unvollständig — KI-Features deaktiviert" wenn entsprechende Settings fehlen. `/setup` bleibt nach `setup_completed=true` erreichbar (Admin kann jederzeit Schritte erneut durchgehen), wird aber nicht mehr aktiv redirected.

### Zugriffsschutz

`/setup/*` Routen sind **Admin-only** — Guard via Session (`global_role='admin'`). Erreichbar nach `POST /auth/admin-login` (Phase 4a, Pfad B). Kein localhost-Only-Trick, kein ENV-Override nötig — Passwort-Login ist der Schutzmechanismus.

### Wizard-Schritte

1. **Begrüssung**: Anzeige der erkannten `ADMIN_EMAIL` (read-only). Hinweis: „Diese Email ist als Admin via `.env` konfiguriert. Du kannst dich zusätzlich via Google-OAuth mit derselben Email einloggen, sobald OAuth eingerichtet ist."
2. **Google-OAuth** (optional, überspringbar): `client_id` + `client_secret`. Anzeige der zu hinterlegenden Redirect-URI (`${APP_URL}/auth/callback`). Test-Button → Discovery-Doc-Fetch. Skip → reine Passwort-Auth, weitere User können nur via Invite + Passwort-fähiger zweiter Mechanismus (späterer Ausbau, vorerst nicht in Scope).
3. **Allowed-Emails** (optional, nur relevant bei OAuth aktiv): kommaseparierte Liste oder leer (= alle Google-Konten, die in `app_users` als `status='active'` existieren, dürfen rein).
4. **KI-Provider** (optional, kann später): Provider-Wahl + minimaler Setup (Claude-Key oder Ollama-Host). Test-Button. Überspringen → App ohne KI-Features bis Admin-Konsole-Nachzug.
5. **Storage-Backend**: `localdb` (Default) oder `bookstack` (Base-URL + Token-ID/-Secret + Test-Button).
6. **Fertig**: Wizard setzt `app.setup_completed=true` und `auth.admin_email` (Spiegel von ENV) für UI-Anzeige. Redirect zur Hauptansicht.

Jeder Schritt schreibt sofort in `app_settings` (kein Bulk-Commit am Ende). Bei Abbruch springt Wizard beim nächsten Aufruf zum ersten unbefüllten Schritt; nach `setup_completed=true` startet er auf Schritt 1 und lässt durch alle Schritte navigieren.

### Routen

- `GET /setup` → Wizard-Page (Admin-Session erforderlich). [public/setup.html](../public/setup.html) + [public/css/setup.css](../public/css/setup.css) + [public/js/setup.js](../public/js/setup.js).
- `GET /setup/state` → welche Schritte abgeschlossen sind, plus `admin_email` (read-only).
- `POST /setup/:step` → speichert Werte des Schritts. Guard: `global_role='admin'` (kein „setup_completed"-Bypass mehr nötig, weil Admin-Login als Gate dient).
- `POST /setup/test/{provider,backend,oauth}` → Test-Probes.
- `POST /setup/complete` → setzt `app.setup_completed=true`.

### i18n

`setup.welcome.title`, `setup.welcome.adminEmailHint`, `setup.step.{oauth,emails,ai,backend,done}.{title,description,hint}`, `setup.button.{next,back,test,skip,finish}`, `setup.error.{required,invalidEmail,oauthFail,backendFail}`, `setup.banner.incomplete`.

### Sicherheit

- Setup-Routen no-cache (`Cache-Control: no-store`).
- Test-Probes loggen ohne Klartext-Secrets (Masking im Logger-Layer).
- Wizard arbeitet ausschliesslich mit Admin-Session — kein Pre-Auth-Pfad, der versehentlich öffentlich exponiert wird.

---

## Phase 4d — Token-Budget + Cost-Tracking (Admin)

Ziel: Admin sieht USD-Kosten pro User/Job/Monat und konfiguriert pro User ein Monats-Budget. Bei Überschreitung wahlweise hart blocken (HTTP 429) oder weich warnen. Voraussetzung für Multi-User-Self-Host: ein einzelner User darf das Anthropic-Budget des Betreibers nicht leersaugen.

**Abhängigkeit auf 4a**: Admin-Rolle = `app_users.global_role='admin'`. Vor 4a kein Admin → keine sinnvolle Budget-Konfiguration. Soll 4d **vor** 4a anlaufen (Bootstrapping), fällt die Karte zurück auf einen schmaleren Pfad mit `ADMIN_EMAIL`-ENV-Match + `requireAdmin`-Middleware in [lib/admin.js](../lib/admin.js); beim Migrieren auf 4a wird die ENV-Match-Middleware durch das DB-Flag abgelöst (ENV bleibt der persistente Identifier für den Bootstrap-Admin).

**Token-Erfassung steht bereits**: `job_runs` und `chat_messages` persistieren `tokens_in`, `tokens_out`, `cache_read_in`, `cache_creation_in`, `provider`, `model`, `user_email`, `book_id`, Zeitstempel (siehe [db/token-usage.js](../db/token-usage.js)). 4d ergänzt nur Cost-Berechnung + Budget-Spalten + Admin-UI.

### Pricing-Modul

Hardcoded Konstanten in [lib/pricing.js](../lib/pricing.js) (neu). $/Mtoken pro Modell, getrennt nach `input` / `output` / `cache_write` / `cache_read`:

```js
export const PRICING = {
  'claude-opus-4-7':   { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  'claude-sonnet-4-6': { input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  'claude-haiku-4-5':  { input:  1.00, output:  5.00, cache_write:  1.25, cache_read: 0.10 },
  // ältere weiter unterstützen, solange sie in MODEL_NAME-Defaults oder model_override auftauchen
};

export function costUsd({ provider, model, tokensIn, tokensOut, cacheReadIn, cacheCreationIn }) {
  if (provider !== 'claude') return 0; // Ollama/Llama lokal → 0
  const p = PRICING[model] || PRICING[fallbackFamily(model)] || null;
  if (!p) return 0; // unbekanntes Modell → 0 + Winston-Warning
  return ((tokensIn || 0)        * p.input        +
          (tokensOut || 0)       * p.output       +
          (cacheCreationIn || 0) * p.cache_write  +
          (cacheReadIn || 0)     * p.cache_read) / 1_000_000;
}
```

**Update-Disziplin**: Bei Anthropic-Preisänderung → PR auf `PRICING`. Logger warnt bei unbekanntem Modell („Pricing fehlt für `claude-…`"), damit kein stiller Drift entsteht. Lokale Provider (`ollama`/`llama`) kosten 0 — bewusste Entscheidung (Strom/Compute-Eigenaufwand des Betreibers, nicht App-Sache).

### Migration N+4d

```sql
ALTER TABLE app_users ADD COLUMN monthly_budget_usd REAL;            -- NULL = kein Limit
ALTER TABLE app_users ADD COLUMN budget_mode TEXT NOT NULL DEFAULT 'none'
  CHECK(budget_mode IN ('none','soft','hard'));
```

**Semantik**:
- `budget_mode='none'`: keine Prüfung, `monthly_budget_usd` ignoriert.
- `budget_mode='soft'`: Jobs laufen weiter, aber `/config` liefert `user.budgetOverrun=true`; Frontend zeigt Warn-Banner an User + Admin-Dashboard markiert User rot.
- `budget_mode='hard'`: POST auf Job/Chat-Routen → 429 JSON `{ code: 'BUDGET_EXCEEDED', usd, budget, mode: 'hard' }`, wenn aktueller Monat ≥ Budget.

**Zeitraum**: Kalendermonat (`from = first-of-current-month UTC`). Kein expliziter Reset — Query filtert `started_at >= monthStart`. Admin-UI erlaubt Drill-Down auf vergangene Monate.

**Bestehende Spalten reichen sonst aus** — kein neues `cost_usd` in `job_runs`/`chat_messages` materialisieren. Cost wird zur Lese-Zeit aus `(provider, model, tokens_*)` via `costUsd()` berechnet. Vorteil: Preis-Update via PR wirkt rückwirkend auf alte Daten (Admin sieht „so viel hätte das zu heutigen Preisen gekostet"). Nachteil: minimale Re-Compute-Last pro Read — vernachlässigbar bei den Volumen (< 10k Jobs/Monat).

### Budget-Enforcement

Neues Modul [lib/budget.js](../lib/budget.js):

```js
export function checkBudget(email) {
  const user = getAppUser(email);                               // app_users-Row
  if (!user || user.budget_mode === 'none') return { allowed: true, mode: 'none' };
  const monthStart = firstOfCurrentMonthUtc();
  const usd = sumMonthlyCostUsd(email, monthStart);             // JOIN job_runs + chat_messages, costUsd() pro Row
  const over = usd >= (user.monthly_budget_usd || 0);
  if (!over) return { allowed: true, usd, budget: user.monthly_budget_usd, mode: user.budget_mode };
  return { allowed: user.budget_mode !== 'hard', usd, budget: user.monthly_budget_usd, mode: user.budget_mode, overrun: true };
}
```

**Express-Middleware** `enforceBudget`: an alle Job-POST-Routen ([routes/jobs.js](../routes/jobs.js)) + `/chat/send` ([routes/chat.js](../routes/chat.js)) montiert. Skip wenn `API_PROVIDER !== 'claude'` (lokale Provider). Liest `checkBudget(req.session.email)`; `allowed=false` → 429 mit JSON-Body. Frontend zeigt aus dem Job-Error eine spezifische Toast-Message + Modal-Hinweis „Budget aufgebraucht — Admin kontaktieren".

**Wichtige Invariante**: Enforcement nur auf **POST**-Routen, nicht auf `/jobs/:id`-Status-Polls. Sonst kann ein laufender Job nicht mehr abgefragt werden, sobald sein eigener Token-Verbrauch das Budget reisst. Laufende Jobs laufen zu Ende; nächster Start ist blockiert (oder warnt bei soft).

### DB-Queries

Neues Modul [db/admin-usage.js](../db/admin-usage.js):
- `sumMonthlyCostUsd(email, monthStart)` — JOIN `job_runs` UNION `chat_messages`, pro Row `costUsd()`, sum. Cached pro Request (Re-Compute zwischen Routen aber günstig).
- `listUsersWithUsage({ monthStart })` — alle `app_users` + monatliche USD-Summe + Token-Summe + Budget + Mode. JOIN-Variante mit Aggregat in SQL (Cost-Mapping in JS, da `costUsd` JS-seitig lebt — alternativ via SQL-View, wenn Pricing in DB wandert).
- `getJobRunsForUser(email, { from, to, limit, offset })` — paginiert. Liefert `{ id, type, provider, model, tokensIn, tokensOut, cacheReadIn, cacheCreationIn, costUsd, queuedAt, endedAt, status }`.
- `getChatMessagesForUser(email, { from, to, limit, offset })` — analog für Chat-Messages.
- `monthlyTotals({ from, to })` — globale Aggregation: Gesamt-USD, Top-N-User, Per-Modell-Breakdown, Per-Job-Typ-Breakdown.

### Admin-Routen

Neues Router-Modul [routes/admin-usage.js](../routes/admin-usage.js), gemountet auf `/admin/usage` (alle hinter `requireAdmin`-Middleware aus [lib/admin.js](../lib/admin.js)):

- `GET /admin/usage/users?month=YYYY-MM` → `listUsersWithUsage` + Budget + Mode pro User.
- `PUT /admin/users/:email/budget` Body `{ usd: number|null, mode: 'none'|'soft'|'hard' }` → Update auf `app_users`. **Hinweis**: lebt unter `/admin/users` (Phase 4a-Router) und ergänzt dessen `PUT /admin/users/:email`-Endpoint um Budget-Felder; Single-Source-of-Truth-User-Edit bleibt 4a.
- `GET /admin/usage/users/:email/jobs?from&to&limit&offset` → Job-Run-Liste mit USD.
- `GET /admin/usage/users/:email/chat?from&to&limit&offset` → Chat-Message-Liste mit USD.
- `GET /admin/usage/summary?from&to` → Top-User + Pro-Modell + Pro-Job-Typ + Gesamt.

**Privacy-Boundary** (analog zu [Leitplanken](#privacy-boundary-kritisch)): Admin sieht **Job-Typen, Modelle, Token-Counts, Kosten, Zeitstempel** — aber **keine Prompt-Inhalte, keine Chat-Texte, keine Buchtitel**. Konkret: `book_id` ist in den Queries vorhanden (für Filter-UX wäre der Buchtitel praktisch), wird aber in der Admin-Response **nicht** auf `books.name` gejoined. Anzeige als anonyme „Buch #42"-ID. Wer das Buch öffnen will, braucht ACL-Zugriff via Phase 4b. Audit-Log-Event `admin-usage-viewed` bei jedem Read.

**Session-Augmentation**: [routes/auth.js](../routes/auth.js) setzt nach Login `req.session.isAdmin = (user.global_role === 'admin')`. [routes/proxies.js](../routes/proxies.js)#`/config` exposed `user.isAdmin` + `user.monthlyUsage = { usd, tokensIn, tokensOut, budget, mode, overrun }` zur Frontend-Kontrolle.

### Frontend — `AdminUsageCard` (dritte Admin-Karte neben `AdminUsersCard` + `AdminSettingsCard`)

Modul [public/js/cards/admin-usage-card.js](../public/js/cards/admin-usage-card.js) + Partial [public/partials/admin-usage.html](../public/partials/admin-usage.html). Sichtbarkeit: nur bei `$app.user.isAdmin`. Eintrag in `FEATURES` + `EXCLUSIVE_CARDS` ([feature-registry.js](../public/js/cards/feature-registry.js)) und `ALLOWED_KEYS` in [routes/usage.js](../routes/usage.js).

**Tabs**:
- **Users**: Tabelle Email | Name | Monat-USD | Budget (Input USD, NULL-Toggle) | Mode (Combobox `none/soft/hard`) | Aktion (speichern). Inline-Edit; Save via `PUT /admin/users/:email/budget`. Rote Markierung bei Overrun (`usd >= budget && mode !== 'none'`).
- **Jobs**: User-Combobox + Datumsbereich → Tabelle Job-Typ | Modell | Tokens-in/out/cache | USD | Datum. Pagination 50/page.
- **Chat**: analog Tab Jobs für `chat_messages`.
- **Summary**: aktueller Monat — Gesamt-USD, Top-10-User-Bar (Chart.js, lazy via [lazy-libs.js](../public/js/lazy-libs.js)), Pro-Modell-Pie, Pro-Job-Typ-Bar. Trend-Linie letzte 6 Monate.

**User-seitige Banner**: Wenn `user.monthlyUsage.budget` gesetzt → kleine Anzeige in User-Settings-Card („Verbraucht 12.34 / 50.00 USD"). Wenn `user.monthlyUsage.overrun` und `mode='soft'` → globaler Banner (Root-Topbar, analog zum Session-Banner). Wenn `mode='hard'` und Job-POST 429 → Modal mit Hinweis + Admin-Kontakt-Mailto.

**i18n** (de+en in [public/js/i18n/](../public/js/i18n/)):
- `admin.usage.title`, `admin.usage.tab.users`, `admin.usage.tab.jobs`, `admin.usage.tab.chat`, `admin.usage.tab.summary`
- `admin.usage.user.budget`, `admin.usage.user.mode`, `admin.usage.user.mode.none|soft|hard`
- `admin.usage.column.tokensIn`, `admin.usage.column.tokensOut`, `admin.usage.column.cacheRead`, `admin.usage.column.cacheWrite`, `admin.usage.column.cost`
- `admin.usage.overrun`, `admin.usage.banner.soft`, `admin.usage.modal.hard`
- `me.usage.consumed`, `me.usage.budget`

**Locale-Konvention**: USD-Beträge im `de-CH`/`en-US`-Locale rendern, je nach `currentUser.language`. Dezimaltrenner Punkt (DE-CH-Standard), Tausender-Apostroph, z.B. `1’234.56 USD`.

### Sicherheit / Missbrauchsschutz

- Ein im Soft-Mode laufender User kann theoretisch das Anthropic-Budget des Betreibers leersaugen, bevor Admin reagiert → Empfehlung im README, Default-Mode für neu angelegte User auf `hard` mit konservativem Limit (z.B. `monthly_budget_usd=20`) zu setzen. Env `DEFAULT_USER_BUDGET_USD` + `DEFAULT_USER_BUDGET_MODE` für Auto-Provisioning via Phase 4a-Invites.
- Cache-Read ist günstig (10 % vom Input bei Claude); Cache-Write teuer (125 %). Prompt-Caching-Logik in [lib/ai.js](../lib/ai.js) bleibt unverändert, aber Admin-Dashboard zeigt Cache-Hit-Rate pro User (Indikator für „dieser User triggert ständig kalte Pipelines = teurer").
- Budget-Bypass für Admin selbst: optional `app_users.budget_mode='none'` für Admin als Default. Aber: Admin kann auch im UI seinem eigenen Account ein Budget geben, wenn er sich selbst disziplinieren will.

### Tests

- `tests/unit/pricing.test.mjs` — `costUsd` pro Modell + alle Token-Arten + Cache-Pricing; `provider!=='claude'` → 0; unbekanntes Modell → 0 + Warn-Log.
- `tests/unit/budget.test.mjs` — `checkBudget` Matrix (none/soft/hard × under/over); Monatsgrenzen (UTC-Boundary); skip bei lokalem Provider.
- `tests/unit/admin-auth.test.mjs` — `requireAdmin` 403/200, Session-Flag, `ADMIN_EMAIL`-ENV-Match-Fallback (pre-4a-Pfad).
- `tests/integration/admin-usage.test.js` — Routen mit Mock-DB (Jobs + Chats vorseeden, Aggregate matchen erwartete USD).
- `tests/integration/budget-enforcement.test.js` — Job-POST mit Hard-Cap erreicht → 429; Soft-Cap → 200 + `overrun=true` in Folge-Config-Response.

### Docs

- `README.md`: ENV-Vars `DEFAULT_USER_BUDGET_USD`, `DEFAULT_USER_BUDGET_MODE`, `ADMIN_EMAIL` + `ADMIN_PASSWORD` (siehe Phase 4a/4c). Hinweis auf Anthropic-Preisseite + Update-Disziplin.
- `docs/erd.md`: neue `app_users`-Spalten + Stand-Zeile.
- Spickzettel `docs/admin.md` (neu, optional): Cost-Tracking-Doku + Pricing-Update-Workflow.

### Feature- und Schreibaktivität (zusätzliche Tabs in `AdminUsageCard`)

Die App persistiert bereits drei Aktivitäts-Quellen, die der Admin pro User aggregiert sehen will. Implementiert als zusätzliche Tabs in der `AdminUsageCard` (gleiche Karte, gleicher `requireAdmin`-Guard, keine neue Migration — Tabellen existieren):

- [user_feature_usage](../db/migrations.js) (`user_email`, `feature_key`, `last_used`, `use_count`) — welche Karte/Aktion wie oft.
- [writing_time](../db/migrations.js) (`user_email`, `book_id`, `date`, `seconds`) — Editor-/Fokus-Zeit pro Tag pro Buch.
- [lektorat_time](../db/migrations.js) (`user_email`, `book_id`, `page_id`, `date`, `seconds`) — Prüfmodus-Zeit pro Tag pro Buch/Seite.

#### DB-Queries (zusätzlich in [db/admin-usage.js](../db/admin-usage.js))

- `listFeatureUsage({ from, to })` — `GROUP BY user_email, feature_key`, Summe `use_count` im Zeitraum (Range via `last_used`). Liefert `[{ email, feature_key, count, last_used }]`.
- `featureUsageTotals({ from, to })` — `GROUP BY feature_key`, Top-N global. Für Summary-Tab „beliebteste Features".
- `listWritingTime({ from, to })` — `GROUP BY user_email, book_id`, Summe `seconds`. Liefert `[{ email, book_id, seconds }]`.
- `listLektoratTime({ from, to })` — analog, Summe `seconds` pro `(user_email, book_id)`.
- `dailyTimeSeries(email, bookId, { from, to })` — `GROUP BY date`, kombiniert writing + lektorat, für Trend-Linie pro User-Buch.

#### Admin-Routen (Ergänzung in [routes/admin-usage.js](../routes/admin-usage.js))

- `GET /admin/usage/features?from&to` → `listFeatureUsage` + `featureUsageTotals`.
- `GET /admin/usage/time?from&to` → `listWritingTime` + `listLektoratTime`, gemerged auf `(email, book_id)` mit Spalten `writingSeconds`, `lektoratSeconds`, `totalSeconds`.
- `GET /admin/usage/time/:email/:bookId/series?from&to` → `dailyTimeSeries` für Drill-Down-Chart.

Alle hinter `requireAdmin`. Privacy-Boundary identisch zur 4d-Hauptsektion: `book_id` als anonyme ID, **kein** JOIN auf `books.name`. Feature-Keys sind ohnehin technische Identifier (`overview`, `review`, `figuren`, …) — kein Inhalts-Leak.

#### Frontend-Tabs (Ergänzung in [admin-usage-card.js](../public/js/cards/admin-usage-card.js))

- **Features**: Datumsbereich-Picker. Tabelle Email | Feature | Count | Letzte Nutzung; sortierbar. Optional Top-N-Bar (Chart.js) der globalen `featureUsageTotals`.
- **Zeit**: Datumsbereich-Picker. Tabelle Email | Buch-ID | Schreibzeit (`hh:mm`) | Lektoratszeit (`hh:mm`) | Gesamt. Klick auf Zeile öffnet Drill-Down-Chart (tägliche Series). Sekunden formatieren via Helper, der `< 60s` als `< 1 min`, sonst `Xh Ym` rendert.

Locale-Format wie 4d (`de-CH`/`en-US`). Apostroph-Tausender bei Stunden ≥ 1’000 (selten, aber konsistent).

#### i18n (zusätzlich)

- `admin.usage.tab.features`, `admin.usage.tab.time`
- `admin.usage.feature.key`, `admin.usage.feature.count`, `admin.usage.feature.lastUsed`
- `admin.usage.time.writing`, `admin.usage.time.lektorat`, `admin.usage.time.total`
- `admin.usage.time.book`, `admin.usage.time.series`
- Formate via bestehende `t(…, { hours, minutes })`-Parameter-Map; kein neues Format-Modul.

#### Tests

- `tests/unit/admin-usage-queries.test.mjs` — `listFeatureUsage` / `listWritingTime` / `listLektoratTime` mit gemockten Rows, Aggregate matchen erwartete Summen, Datums-Boundary korrekt.
- `tests/integration/admin-usage.test.js` (bestehend) erweitern um Feature- und Time-Routen.

### Out-of-Scope für 4d

- **Echtzeit-Token-Counter im UI während eines Jobs** — könnte schön sein, braucht aber SSE-Verlängerung auf nicht-Streaming-Jobs. Folge-Phase.
- **Email-Alerts an Admin bei Overrun** — SMTP-Setup ist nicht universell self-hostable; bewusst weggelassen. Manuell via Dashboard-Polling.
- **Per-Buch-Budget** — User-Budget reicht initial. Per-Buch nur falls Sharing (Phase 4b) zu Konflikten führt (z.B. Lektor verbraucht Editor-Budget).
- **Token-Refund bei Job-Fail** — aktuell zählen auch failed Jobs (Anthropic stellt Tokens trotzdem in Rechnung, sofern API-Call zurückkam). Bei `AbortError` vor erstem `message_start` → tokens=0, wirkt automatisch.

---

## Phase 5 — ENTFÄLLT (Dual-Write)

Im Multi-Backend-Modell schreibt jeder Backend in seine eigene Wahrheit. Gleichzeitiges Schreiben in BookStack **und** localdb wäre nur sinnvoll, wenn beide gleichzeitig autoritativ wären — das wäre Konflikt-Hölle ohne nutzbaren Mehrwert. Stattdessen: ein Backend zur Zeit, Backend-Wechsel via Phase-8-Bulk-Copy-Job.

Falls künftig „Offline-Edit + Push-when-online" gefragt wird, ist das ein orthogonaler Pfad (Service-Worker-Outbox), nicht Dual-Write.

---

## Phase 6 — Tags + Kategorien

**Migration N+6**:

```sql
CREATE TABLE book_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES book_categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  color TEXT,
  position INTEGER DEFAULT 0,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_book_categories_parent ON book_categories(parent_id);

ALTER TABLE books ADD COLUMN category_id INTEGER
  REFERENCES book_categories(id) ON DELETE SET NULL;
CREATE INDEX idx_books_category ON books(category_id);

CREATE TABLE book_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  color TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE book_tag_assignments (
  book_id INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES book_tags(id) ON DELETE CASCADE,
  assigned_at TEXT DEFAULT (datetime('now')),
  assigned_by TEXT,
  PRIMARY KEY (book_id, tag_id)
);
CREATE INDEX idx_bta_tag ON book_tag_assignments(tag_id);
```

**Sichtbarkeit**: Tag-/Kategorie-Pool ist **global** (alle App-User sehen denselben Pool). Zuordnung an ein Buch erfordert `editor`+ auf dem Buch. Filter in Buchliste respektiert ACL — Bücher ausser Sichtweite werden nicht durch Tag-Filter „enthüllt".

**Admin-Sichtbarkeit**: Admin sieht weiterhin keine Bücher, aber kann Tag-/Kategorie-Pool verwalten (Create/Edit/Delete) — das ist Strukturarbeit, kein Inhaltszugriff.

**Routen**:
- `GET/POST/PUT/DELETE /local/categories` (POST/PUT/DELETE: Admin).
- `GET/POST/PUT/DELETE /local/tags` (POST: jeder authentifizierte User; DELETE: Admin).
- `PUT /books/:id/category`, `PUT /books/:id/tags` (Owner/Editor).

**Frontend**: BookSettings-Card bekommt Combobox „Kategorie" + Multi-Select „Tags". Inline neuer Tag via Free-Input. Filter-Pills in Buchliste. Admin-Karte für Kategorie-Verwaltung.

**i18n**: `book.category`, `book.tags`, `categories.empty`, `tags.empty`, `tag.new`, `book.filter.byCategory`, `book.filter.byTag`.

---

## Phase 7 — Volltextsuche (SQLite FTS5)

Eigene Volltextsuche über alle App-Inhalte. Läuft parallel zu BookStack-Search während Replica-Phase; in Phase 8 wird nur noch der BookStack-Pfad entfernt.

**Scope (was indexiert wird)**:
- Bücher: `books.name`, `books.description`.
- Kapitel: `chapters.chapter_name`, `chapters.description`.
- Pages: `pages.page_name`, `pages.body_html` (HTML-stripped).
- Domain-Objekte (App-eigen, BookStack-frei): `figures.name` + `figures.beschreibung`, `locations.name` + `locations.beschreibung`, `figure_scenes` (Titel/Beschreibung), `ideen.titel` + `ideen.text`.

Ein einziger FTS5-Index für alles. Diskriminator über `kind`-Spalte; ACL über `book_id`.

**Migration N+7**:

```sql
-- Externer Content via UNINDEXED-Spalten (FTS5-Pattern: own-content)
CREATE VIRTUAL TABLE search_index USING fts5(
  kind UNINDEXED,         -- 'book' | 'chapter' | 'page' | 'figure' | 'location' | 'scene' | 'idea'
  entity_id UNINDEXED,    -- PK des indexierten Datensatzes
  book_id UNINDEXED,      -- für ACL-JOIN (NULL bei Domain-Objekten ohne Buch-Bindung — keine in dieser App)
  lang UNINDEXED,         -- 'de' | 'en' | NULL
  title,                  -- gewichtbar via bm25(search_index, 5.0, 1.0)
  body,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '-_'"
);

-- Trigram-Index für Substring/Typo-Suche (zusätzlich, kleinere Spalten)
CREATE VIRTUAL TABLE search_trigram USING fts5(
  kind UNINDEXED,
  entity_id UNINDEXED,
  book_id UNINDEXED,
  title,
  tokenize = "trigram"
);

-- Optimization-Tracker (vacuum-ähnlich, FTS5 baut Segmente)
CREATE TABLE search_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO search_meta (key, value) VALUES ('last_optimize', NULL);
```

**Tokenizer-Wahl**:
- `unicode61 remove_diacritics 2` — Umlaut-Folding (ä→a, ö→o, ü→u, ß bleibt), Unicode-aware Wortsegmentierung. Behandelt DE + EN gleichzeitig ohne Stemmer-Streit.
- `tokenchars '-_'` — Bindestrich-Wörter zusammenhalten („read-only", „pre-print").
- **Kein Porter-Stemmer**: nur Englisch, schlechtes DE-Verhalten. Verzicht akzeptabel; FTS5 hat eingebautes Präfix-Match (`word*`).
- **Zweiter trigram-Index** für Typo-Toleranz / Substring (z.B. „lekto" → „Lektorat"). Stoss-Fall: nur in Titeln, da Body-Trigram-Index quadratisch wächst.

**Sync-Strategie**:
- Application-level statt SQL-Trigger. Warum: HTML→Text-Stripping muss in JS passieren (selbe Normalisierung wie [routes/sync.js](../routes/sync.js)#htmlToText — siehe CLAUDE.md-Regel „HTML→Text-Normalisierung für Stats: Frontend MUSS Server matchen"). Trigger könnte Plain-Text nicht extrahieren.
- Hook-Punkte:
  - Page-Save (Phase 2 `page_revisions`-Hook): nach erfolgreicher PUT/lokal-Save → `searchIndex.upsert('page', page_id, ...)`.
  - Chapter-Update: `routes/sync.js` + zukünftige lokale Chapter-Update-Route.
  - Book-Update: BookSettings-Save-Route.
  - Domain-Object-CRUD ([routes/figures.js](../routes/figures.js), [routes/locations.js](../routes/locations.js), [routes/ideen.js](../routes/ideen.js)): jedes Insert/Update/Delete schreibt FTS.
  - Sync-Pull (Phase 1): bei Body-Update → FTS-Reindex der Page.
- Lib `lib/search.js` (neu) als Single Entry Point: `upsert(kind, id, fields)`, `remove(kind, id)`, `query(text, opts)`, `reindexAll()`.

**HTML→Text-Normalisierung** (für `body`-Spalte):
- Reuse von [lib/html-clean.js](../lib/html-clean.js) (CLAUDE.md-Regel „BookStack-Cleaner single chokepoint") + `htmlToText`-Variante mit Tag→Space + `\s+`→Single-Space (identisch zu `routes/sync.js`/Frontend). **Pflicht-Konsistenz** — sonst Drift zu `page_stats.chars`.

**Search-API** (neu, `routes/search.js`):

```
GET /search?q=...&kind=page,chapter&book_id=42&limit=50&offset=0
```

- ACL-Filter zwingend: JOIN auf `book_access` mit `req.session.user_email`. Pages/Chapters ohne sichtbares Buch werden nie geliefert.
- Query-Plan (vereinfacht):
  ```sql
  SELECT s.kind, s.entity_id, s.book_id, b.name AS book_name,
         snippet(search_index, 4, '<mark>', '</mark>', '…', 24) AS snippet,
         bm25(search_index, 5.0, 1.0) AS score
    FROM search_index s
    JOIN book_access ba ON ba.book_id = s.book_id AND ba.user_email = :user
    JOIN books b ON b.book_id = s.book_id
   WHERE search_index MATCH :query
     AND (:kind_filter IS NULL OR s.kind IN (:kind_list))
     AND (:book_filter IS NULL OR s.book_id = :book_filter)
   ORDER BY score
   LIMIT :limit OFFSET :offset;
  ```
- Query-Parsing: User-Input `"`-quote-Phrasen, `-`-Negationen, `*`-Präfix. Spezialzeichen escapen (`"`, `:`, `*`, `(`, `)`). Bei Single-Word + kein Treffer → Fallback auf `search_trigram` (Typo-Toleranz).
- BM25-Gewichtung: Title 5x stärker als Body. Sortierung nach `score ASC` (kleiner = besser bei FTS5-BM25).
- Snippet-Spalte: `4` = Index der `body`-Spalte (kind, entity_id, book_id, lang, title, body → 0,1,2,3,4,5; **`body` ist Index 5**, korrigieren).
- Default-Filter: Pages + Chapters. Bücher + Domain-Objekte als Opt-In via `kind`.

**Lokale-Bestimmung (`lang`-Spalte)**:
- Pro Page aus `books.language` (falls vorhanden) oder Session-Default. Heutige App ist DE-first, EN nur UI. `lang` heute nicht zwingend gefüllt — Spalte nullbar, später für mehrsprachiges Tokenizer-Routing nachrüstbar.

**Frontend**:
- **Command-Palette-Integration**: neuer Provider `searchProvider` in [public/js/cards/palette-providers.js](../public/js/cards/palette-providers.js). Prefix `?` für Volltext-Modus (analog zu `#`/`!`/`@` heute, die Namen-basiert sind). Mixed-Mode (kein Prefix) bekommt Top-3-Volltexttreffer als zusätzliche Sektion.
- **Eigene Search-Karte** `SearchCard` (Pill „Suche", `FEATURES`+`EXCLUSIVE_CARDS`+`ALLOWED_KEYS`-Eintrag):
  - Search-Input mit `kind`-Filter-Pills (Bücher/Kapitel/Pages/Figuren/Orte/Ideen).
  - Buch-Combobox (Default: alle sichtbaren).
  - Ergebnisliste mit Snippet, Kontextzeile (Pfad: Buch → Kapitel → Page), Klick navigiert via Hash-Router auf Treffer.
  - Tastatur: Cursor up/down, Enter öffnet.
- **Highlight im Treffer**: nach Navigation auf Page wird via Query-Param `?q=...` an Editor-Find weitergereicht; vorhandenes Find-Highlight aus [public/js/editor/find.js](../public/js/editor/find.js) markiert Treffer.

**Performance + Index-Maintenance**:
- FTS5 schreibt segmentbasiert; gelegentliches `INSERT INTO search_index(search_index) VALUES('optimize')` (Daily-Cron, parallel zum bestehenden 02:00-Sync-Cron).
- Initial-Build via `lib/search.js#reindexAll()` beim Migrations-Lauf (oder ersten Server-Start, falls Datenmenge gross): batched in 500er-Chunks.
- Index-Grösse-Erwartung: ~30-40% der indexierten Text-Grösse. Bei 100 Büchern à 200 Pages à 5 KB → ~100 MB DB-Wachstum. Vertretbar.

**ACL-Test (Pflicht)**: Unit-Test, der zwei User mit unterschiedlichen `book_access`-Mengen erzeugt und prüft, dass `/search?q=*` nur Treffer aus sichtbaren Büchern liefert. Test gegen Privacy-Boundary aus Phase 4b.

**i18n**: `search.title`, `search.placeholder`, `search.filter.kind`, `search.filter.book`, `search.empty`, `search.results.count` (mit `{n}`), `search.kind.book|chapter|page|figure|location|scene|idea`, `search.snippet.unavailable`.

**Tests**:
- Unit: Query-Parser (Escaping, Phrasen, Negationen).
- Unit: HTML→Text-Normalisierung match Frontend/Sync (`page-stats-normalization.test.mjs`-analog).
- Integration: Index-Sync nach Page-Save, nach Domain-Object-CRUD, nach Sync-Pull.
- Integration: ACL-Boundary (siehe oben).
- E2E: Suche → Klick → Navigation + Highlight.

---

## Phase 8 — Backend-Migration-Tool (Bulk-Copy)

Voraussetzung: Phasen 1–7 stabil. Beide Backends sind betrieblich okay; Admin kann jetzt **gerichtet umziehen**. Kein „Kill" — `bookstack`-Backend bleibt als gleichwertige Option im Code.

**Job-Typ `backend-migrate`** ([routes/jobs/backend-migrate.js](../routes/jobs/backend-migrate.js)) — Standard-Pattern (`runBackendMigrateJob` + Status-Polling), Admin-only.

**Trigger** über Admin-Karte `AdminBackendMigrationCard` (eigene Karte, Admin-only):
- Quelle/Ziel-Auswahl (`bookstack` → `localdb` ist primärer Fall; `localdb` → `bookstack` symmetrisch implementiert, aber als „selten" markiert).
- Wahl: alle Bücher oder Einzel-Buch.
- Checkbox „Quelle nach erfolgreichem Copy auf read-only setzen" (empfohlen).
- „Migration starten" → Job in Queue.

**Pipeline pro Buch**:

1. **Source-Read-Only-Marker** setzen: `app_settings` Key `app.migrate.source_readonly = '<source-backend>'`. Content-Store-Facade blockiert ab da `savePage`/`createPage` für den Source-Backend (alle Edits → 423 Locked mit i18n-Text).
2. **Bulk-Copy**: pro Page/Chapter im Source → Lesen via Source-Backend → Schreiben via Target-Backend. ID-Mapping-Tabelle `backend_migration_idmap (source_backend, source_id, target_backend, target_id, kind, migrated_at)` für nachträgliche Referenz-Reparatur.
3. **FK-Repair**: alle Tabellen mit `book_id`/`page_id`/`chapter_id`-FKs (Phase 0/4b/6/7-Tabellen) werden via ID-Map umverdrahtet. Transaction pro Buch.
4. **FTS-Reindex** (Phase 7) für migrierte Bücher.
5. **Cutover**: nach erfolgreichem Copy aller selektierten Bücher: `app.backend = <target>` (atomar). Source-Read-Only-Marker bleibt — falls Admin später zurück will, ist Source noch konsistent.
6. **Abort/Rollback**: Job-Cancel rollt nur die laufende Buch-Transaction zurück. Bereits migrierte Bücher bleiben — ID-Map ist Wahrheit. Admin sieht „N von M migriert; nicht migrierte Bücher bleiben in `<source>`."

**Schritt-für-Schritt-Mismatches** (Implementierungs-Details):
- BookStack-Pages ohne Markdown → `body_markdown=NULL` (localdb akzeptiert).
- BookStack-`priority` → wird in `book_order.order_json` (Phase 3) materialisiert.
- BookStack-Tags (falls genutzt) → werden in Phase 6 `book_tag_assignments` migriert (wenn `app.backend='bookstack'` aktuell Tags pflegt — sonst no-op).
- localdb → BookStack: BS-API verlangt Reihenfolge (Books → Chapters → Pages), Pages-`html` als POST. BS akzeptiert sauber-cleantes HTML. Custom-PDF-Profile sind Backend-agnostisch.

**Idempotenz**: Re-Run mit denselben Source/Target ist no-op pro bereits migriertem Buch (ID-Map-Check). Force-Re-Migrate via UI-Toggle „bereits migrierte Bücher überschreiben".

**Logging**: Pro Buch `[backend-migrate|admin@…|<book_id>] copied chapters=N pages=M elapsed=Ts`.

**Tests**:
- Integration: Mock-BS + In-Memory-DB → migrate `bookstack` → `localdb`, alle Pages/Bodies/Order erhalten, FK-`page_revisions` zeigen weiter auf richtige Page.
- Integration: Migrate-symmetrisch zurück, Round-Trip-Body identisch (Byte-Vergleich nach `cleanPageHtml`).
- Unit: ID-Map-FK-Repair (`figure_appearances`, `chat_sessions`, `book_tag_assignments` etc.) — alle Spalten-Treffer durchgehen.

**i18n**:
- `admin.backendMigration.title`, `admin.backendMigration.source`, `admin.backendMigration.target`
- `admin.backendMigration.startButton`, `admin.backendMigration.warnSourceReadonly`
- `admin.backendMigration.progress` (mit `{done}/{total}`)
- `admin.backendMigration.error.<reason>`

### ID-Vergabe im `localdb`-Mode

Pages/Chapters/Books, die im `localdb`-Mode neu angelegt werden, brauchen IDs ohne Kollision mit BookStack-Range-IDs (positive Integer < 100k typisch). Phase 1 hat die Backend-Implementierung; dieser Block dokumentiert die ID-Sequence formal — relevant sowohl für Neu-Installationen (nur localdb) als auch für migrierte Bestände.

**Migration N+8 (FK-Recreate-Pattern, einmalig):** `books`, `chapters`, `pages` werden auf `INTEGER PRIMARY KEY AUTOINCREMENT` umgestellt. Heute fehlt `AUTOINCREMENT` (BookStack lieferte die Werte) — ohne `AUTOINCREMENT` würde SQLite gelöschte IDs wiederverwenden, was bei sentinel-naher Logik (`book_id=0` als User-Default in `pdf_export_profile`) und alten Job-Results gefährlich wäre. Mit `AUTOINCREMENT` ist `sqlite_sequence` führend, IDs sind strikt monoton.

```sql
-- Pseudocode, ausgeführt via Recreate-Pattern aus CLAUDE.md
db.pragma('foreign_keys = OFF');

CREATE TABLE books_new (
  book_id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- restliche Spalten identisch zu books
  ...
);
INSERT INTO books_new SELECT * FROM books;  -- bestehende IDs bleiben erhalten
DROP TABLE books; ALTER TABLE books_new RENAME TO books;

-- Wasserzeichen: nächste neu vergebene ID > MAX(bisherige IDs, BookStack-Range).
-- Im `localdb`-Mode setzen wir das Wasserzeichen explizit auf eine hohe Schwelle
-- (z.B. 1_000_000), um BookStack-Range-IDs frei zu halten für künftige BS-Imports.
INSERT OR REPLACE INTO sqlite_sequence (name, seq)
  VALUES ('books',    MAX(1000000, (SELECT COALESCE(MAX(book_id),    0) FROM books))),
         ('chapters', MAX(1000000, (SELECT COALESCE(MAX(chapter_id), 0) FROM chapters))),
         ('pages',    MAX(1000000, (SELECT COALESCE(MAX(page_id),    0) FROM pages)));

db.pragma('foreign_keys = ON');
db.pragma('foreign_key_check');  -- muss leer sein
```

**Folgen:**

- Bestehende Rows behalten ihre IDs für immer. Alle ~40 FK-Spalten (`figures.book_id`, `page_stats.page_id`, `chapter_reviews.chapter_id`, `page_revisions.page_id`, `lektorat_time.page_id`, `chat_sessions.page_id`, `pdf_export_profile.book_id`, …) bleiben gültig. Historie ungebrochen.
- Neue Bücher/Kapitel/Seiten im `localdb`-Mode: SQLite vergibt `seq + 1` aus `sqlite_sequence`. Klare Trennung von BookStack-Range — bei Bedarf später Re-Import aus BookStack ohne ID-Konflikt.
- Im `bookstack`-Mode bleibt BookStack die ID-Quelle; lokale Tabellen übernehmen die externen IDs wie heute (Phase 0b/1).
- IDs aus gelöschten Rows werden **nicht** wiederverwendet (AUTOINCREMENT-Garantie). Schützt vor „Zombie-FK".
- Sentinel `book_id = 0` (User-Default-PDF-Profile) bleibt safe.
- App-eigene Surrogat-Tabellen (`figures.id`, `locations.id`, `figure_scenes.id`, `ideen.id`, …) bleiben unverändert.

**Alternativlösung verworfen:** UUIDs / ULIDs als PKs. Würde alle ~40 FK-Spalten + sämtlichen Client-Code (URL-Parameter `:book_id`, Hash-Router, Job-Results, Caches) brechen. Kein Mehrwert für Self-Hosted-App.

---

## Phase 9 — Doku-Update (Multi-Backend-Sweep)

Nach Phase 8 ist Backend-Pluralität betrieblich Realität. Doku muss reflektieren: BookStack ist **eine Option**, kein zwingender Bestandteil. Reine Doku-Phase, kein Code-Risiko.

**Zu aktualisieren:**

- **[README.md](../README.md)** — Intro neu: „Schreiben/Lektorat/Buchanalyse mit KI. Storage-Backend wählbar: SQLite (Default) oder BookStack." Deployment-Block (LXC + systemd) in zwei Varianten: Minimal-Setup (nur App + SQLite) als Default, BookStack-Setup als optionaler Pfad. Env-Variablen-Liste: `BOOKSTACK_BASE_URL`/`BOOKSTACK_TOKEN_ID`/`BOOKSTACK_TOKEN_SECRET` als „optional, nur bei `app.backend=bookstack` nötig" markieren. **`ADMIN_EMAIL` + `ADMIN_PASSWORD` als Pflicht-ENV dokumentieren** (Admin-Login-Pfad neben Google-OIDC). Architektur-Diagramm: BookStack-Box gestrichelt (optional).
- **[CLAUDE.md](../CLAUDE.md)** — Header-Zeile umformulieren: „BookStack als optionales Storage-Backend (eines von zweien)". Architektur-Überblick: Content-Store-Facade als zentrale Storage-Abstraktion dokumentieren; BookStack-Proxy-Routen (`/api/*`) bleiben, sind aber als Backend-spezifisch markiert. Harte Regeln durchgehen: `bsGetAll`/`bsGet`/`bsPut`-Regel auf „nur in `lib/bookstack.js` + `lib/content-store/backends/bookstack.js`" verschärfen (Vor-Phase Schritt 6 wirkt hier weiter); `bsGet(..., { fresh: true })`-Regel bleibt, gilt nur im `bookstack`-Mode. Read-Modify-Write-Pfade um localdb-Variante ergänzen. Editor-Sektion bleibt (CodeMirror, kein Wechsel). Spickzettel-Verweis auf [docs/bookstack-exit.md](bookstack-exit.md) bleibt, weil die Datei zur Multi-Backend-Architekturbeschreibung mutiert ist.
- **[LICENSE](../LICENSE)** — bleibt wie heute (BookStack ist nicht mehr zwingend, also keine AGPL-Pflicht durch Abhängigkeit; bewusste Wahl möglich). Lizenzfrage als separates Ticket markieren, nicht Pflicht innerhalb von Phase 9.
- **Deploy-Doku** (README-Block + ggf. `docs/deploy.md` neu): Zwei Setup-Pfade. Minimal (`app.backend=localdb`): nur App + SQLite-Datei, kein zusätzlicher Container. Klassisch (`app.backend=bookstack`): wie heute, BookStack-Sub-Container + MariaDB. Backup-Strategie pro Backend dokumentieren.
- **Spickzettel-Update** in [docs/](./):
  - [bookstack-templates.md](bookstack-templates.md) — bleibt (Templates sind BookStack-Feature; im `localdb`-Mode nicht verfügbar bzw. eigene Template-Tabelle Future-Work).
  - [bookstack-exit.md](bookstack-exit.md) (diese Datei) — wandelt sich von „Plan" zu „Multi-Backend-Architektur-Doku". Beim Abschluss aller Phasen die abgehakten Schritte streichen, übrig bleibt der dauerhafte Architektur-Block (Backends, Content-Store-Facade, Migration-Tool). CLAUDE.md-Verweis bleibt; aus „Migrationsplan" wird „Architektur-Spickzettel".
  - [erd.md](erd.md), [jobs.md](jobs.md), [i18n.md](i18n.md), [ai-providers.md](ai-providers.md), [testing.md](testing.md), [figur-werkstatt.md](figur-werkstatt.md), [buchchat-tools.md](buchchat-tools.md), [focus-editor.md](focus-editor.md), [state-modell.md](state-modell.md), [finetuning.md](finetuning.md), [wordpress-import.md](wordpress-import.md) — jeweils auf BookStack-Annahmen grep'pen, wo nötig auf „Backend-agnostisch" oder „nur `bookstack`-Backend" umstellen.
- **`package.json`** — bleibt (keine zwingende Änderung).
- **Tests-Doku** — [tests/](../tests/) README (falls vorhanden): klarmachen, dass Integration-Tests gegen beide Backends laufen sollten (Mock-BS und In-Memory-SQLite-DB).

**Reihenfolge innerhalb Phase 9:** README + CLAUDE.md zuerst (Einstiegspunkte für neue Contributors + Sessions), dann Deploy-Block, dann Spickzettel.

---

## Phase 10 — Schema-Squash

Ziel: 100+ Migrationen zu einem konsolidierten Initial-Schema kollabieren. Nach Phase 9 ist die DB-Struktur stabil (BookStack-Exit komplett, keine ALTER-Wellen mehr in Sicht). Squash entfernt Wegwerf-Migrationen (FK-Recreate-Zwischenschritte, Reverted-Columns, alte Cache-Schemas), reduziert Boot-Zeit auf frischen Installs und macht [db/migrations.js](../db/migrations.js) wieder lesbar.

**Warum erst hier:** Squash vor Phase 8/9 wäre Wegwerfarbeit — Phase 1–9 bringt nochmals 15–25 Migrationen (Replica, ACL, Tags, FTS5, Editor-Wechsel). Erst nach Phase 9 ist die Migration-Liste „eingefroren genug".

**Vorgehen:**

1. **Cut-Schema generieren.** Auf einer frischen DB Migrationen 1–N durchlaufen, dann `sqlite3 db.sqlite '.schema'` → kanonisches CREATE-Skript. Manuell aufräumen: konsistente Spalten-Reihenfolge, Namens-Konventionen, FK-Aktionen explizit (`ON DELETE CASCADE`/`SET NULL` statt Default), Indexe pro Tabelle gruppiert.
2. **Tooling: `tools/squash-migrations.js`** (neues Script) — generiert das CREATE-Skript aus einer Roh-Migration-DB, vergleicht es per `.schema` mit einer auf altem Pfad migrierten DB. Diff muss leer sein (Byte-Vergleich nach Normalisierung); sonst Squash-Stop.
3. **Neuer Initial-Block** in [db/migrations.js](../db/migrations.js): Migrationen 1 bis N werden durch einen einzigen Branch ersetzt, der bei `version === 0` das gesamte `SQUASHED_SCHEMA` einspielt und `schema_version` auf N setzt. Anschliessend startet das übliche `if (version < N+1)`-Muster für künftige Migrationen.
4. **Compat-Branch für Bestandsinstallationen:** `if (version > 0 && version < N) { … legacy-Migrationen 1..N nacheinander … }` bleibt vorerst drin, damit existierende DBs nicht reissen. Erst nach 1 Major-Release entfernen, dokumentiert als Breaking-Change (User mit `version < N` müssen vorher ein „Bridge-Release" durchlaufen).
5. **Initial-Schema in [docs/erd.md](erd.md) abgleichen.** Stand-Zeile (Schema-Version) auf gesquashte Version setzen, Block-Definitionen direkt aus `SQUASHED_SCHEMA` regenerieren — ein einziger SSoT pro Tabelle.
6. **Tests:**
   - **Frische DB:** Migration läuft, `foreign_key_check` ist leer, Smoke-Insert pro Tabelle erfolgreich.
   - **Bestandsdaten:** Snapshot einer Pre-Squash-DB durch Compat-Branch ziehen, danach Frische-Schema-Diff = leer.
   - **CI-Job:** „No-drift"-Check vergleicht Bestand- vs. Frisch-Pfad Schema bei jedem Build.
7. **Indexe + Triggers separat squashen:** SQLite trennt `CREATE INDEX`/`CREATE TRIGGER` vom Table-DDL. Squash-Skript baut sortiert: Tables → Indexes → Triggers → Views → Virtual Tables (FTS5).
8. **FTS5-Triggers (aus Phase 7):** im Squash mit drin, kein separater Sync-Pfad.

**Anti-Patterns vermeiden:**
- Kein `DROP TABLE … RECREATE` im gesquashten Block — Squash ist „Initial Install", nicht „Re-Migration".
- Keine ENV-Bedingungen im Squash. Wer ENV-bedingte Spalten will, dokumentiert das als reguläre Migration N+1.
- Keine Data-Backfills im Squash (`UPDATE foo SET …`). Frische DB hat keine Daten. Backfills bleiben in der Bestands-Migrationsbranche.

**Aufwand:** ~1–2 Tage (Skript + manueller Schema-Cleanup + Tests). Risiko: mittel — falsche Spalten-Reihenfolge ändert keinen Run-Effekt, aber `SELECT *` bricht in Tests. Strenger Diff-Test gegen Bestandsmigration ist Pflicht.

**Rollback:** Squashed-Block durch Compat-Branch ersetzen (alle Original-Migrationen liegen in `git`). Schema-Version-Sprung muss bedacht werden — Re-Migrieren rückwärts geht nicht, aber `version === N` ist nach beiden Pfaden identisch.

---

## Risiken / offene Fragen

- **Lektor-Apply-Range-Drift**: Lektorat-Findings haben Positionen im damaligen Body. Primärer Schutz ist der **Page-Lock** während der Lektorat-Session (siehe Phase 4b „Page-Lock während Lektorat-Session") — solange der Lektor die Findings-Card offen hat, lehnen Free-Edit-Routen mit `423 Locked` ab, also kann kein paralleler Editor-Save die Range-Positionen verschieben. Fallback bleibt der `updatedAt`-Staleness-Check (CLAUDE.md-Regel „Job-Ergebnisse mit `updatedAt`-Staleness-Check") für Edge-Cases: Lock abgelaufen (User 30 min weg), Owner-Override hat den Lock gebrochen, oder Edit kam vor dem Acquire. In dem Fall lehnt die Apply-Route mit 409 ab, wenn `pages.updated_at` vom Snapshot des Findings differiert.
- **Viewer-Lean-Endpoint**: separater `?lean=true`-Pfad für Buchliste/Overview vermeidet, dass Viewer-Frontend versehentlich Analyse-Daten lädt (Token-Verbrauch via Lazy-Refresh, Privacy bei „Was lektoriert hat KI?"). Alternativ: Server liefert für `viewer` per default lean, ohne Param. Letzteres robuster, Konsequenz: Tile-Layout muss leere Slots verkraften.
- **Lektor + Buch-Chat**: Buch-Chat ist heute Analyse-Werkzeug ohne Schreibwirkung — könnte Lektor sehen dürfen. Default: nein (sonst werden Token-Kosten unkontrolliert). Toggleable in BookSettings durch Owner.
- **`can_invite_users` ohne Buch-Share**: User mit Invite-Recht aber ohne aktuelle Buch-Rolle (z.B. Ex-Mitarbeiter, deren Share widerrufen wurde, behalten Invite-Flag) sehen nichts in der App. Nicht falsch, aber UX-Hinweis nötig.
- **Owner-Transfer-Workflow**: Auto-Accept oder zweistufig (neuer Owner bestätigt)? Solo-Tenant heute: Auto-Accept reicht.
- **Email-Versand**: Invites + Ownership-Transfer brauchen SMTP, sonst Token-Copy-Workflow. Akzeptabel als MVP, später ausbaubar.
- **Feature-Parität zwischen Backends**: Jedes neue Feature muss in beiden Backends laufen. Risiko: jemand baut etwas localdb-only und vergisst BS-Backend. **Gegenmittel**: Content-Store-Vertrag (Vor-Phase Schritt 4) + Tripwire (Schritt 6) — `bsGet`/`bsPut` ausserhalb `lib/content-store/backends/bookstack.js` schlägt im CI-Grep fehl. Neue Feature-PR ohne Test gegen beide Backends wird im Review abgelehnt.
- **BS-Eigene Edits ausserhalb der App**: Wer im `bookstack`-Mode parallel via BookStack-UI editiert, umgeht App-Revisions, FTS-Index und Page-Lock. Sync-Worker fängt es zwar ein (kein Datenverlust), aber Lektor/Editor-Apply kann auf veraltetem Body operieren. **Empfehlung**: App-Doku rät dringend zu „BookStack-UI nicht parallel benutzen, ausser zum Lesen". Kein technischer Lock möglich, weil BS-UI ein eigenständiger Stack ist.
- **Backend-Migration mit Jobs in Flight**: Wenn während Phase-8-Migration ein KI-Job läuft, der gerade `loadPage(old_id)` aufgerufen hat und später `savePage(old_id)` versucht: nach Cutover ist `old_id` evtl. via ID-Map auf `new_id` umgemapt. **Gegenmittel**: Migration startet erst, wenn Job-Queue für betroffene Bücher leer ist (Pre-Check); während Migration werden neue Jobs für migrierende Bücher abgelehnt (423 Locked).
- **Privacy bei Logs**: Winston-Logs enthalten `user_email`. Bleibt — Self-Hosted, Betreiber sieht Logs sowieso.
- **Audit-Tabelle vs. DSGVO**: bei Hard-Delete-Request müsste `user_sessions_audit` ebenfalls anonymisiert werden. Heute irrelevant (Solo-Self-Hosted), aber Schema-Spalte für Pseudonymisierung offen halten.

---

## Aufwand grob

| Phase | Aufwand | Risiko |
|---|---|---|
| 0 | 0.5 Tag | niedrig |
| 0c | 1 h | niedrig (PRAGMAs) |
| 0d | 0.5 Tag | niedrig (TTL-DELETE) |
| 1 | 4-6 Tage | mittel (Backend-Disjunktion, Test-Pflege gegen beide) |
| 2 | 2-3 Tage | niedrig |
| 3 | 2-3 Tage | niedrig |
| 4a | 4-6 Tage | mittel (FK-Recreate, Login-Flow) |
| 4b | 4-5 Tage | mittel (Rollen-Matrix + Apply-Routen + minRole-Filter) |
| 4b1 | 0.5-1 Tag | niedrig (Print-CSS + readOnly-Guard, keine neuen Tabellen) |
| 4c | 4-6 Tage | mittel (Backend-Switch + Hot-Reload + Test-Probes + ENV-Migration in vielen Modulen) |
| 4c1 | 1-2 Tage | niedrig (eigenständige Wizard-Page, kleines Form-State-Modell) |
| 5 | — | ENTFÄLLT |
| 6 | 2-3 Tage | niedrig |
| 7 | 4-6 Tage | mittel (FTS5-Schema + Sync-Hooks + UI) |
| 8 | 4-6 Tage | mittel-hoch (Bulk-Copy + FK-Repair + ID-Map + Round-Trip-Tests) |
| 9 | 1-2 Tage | niedrig (Doku-Sweep) |
| 10 | 1-2 Tage | mittel (Diff-Test gegen Bestand) |

Gesamt ca. 7-8 Wochen Vollzeit, mit Puffer (Phase 0c/0d/10 marginal). Spart gegenüber alter „Kill"-Variante v. a. Phase 5 (Dual-Write) + Editor-Wechsel; gegenüber Original-Plan zusätzlich ~4 Tage durch 4b1-Skalierung (E-Reader → Print-CSS).
