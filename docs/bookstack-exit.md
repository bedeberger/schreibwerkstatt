# Storage-Backend-Pluralisierung

Storage-Backend wird Admin-konfigurierbar. Zwei gleichwertige First-Class-Backends:

- **`localdb`** (Default für Neu-Installationen): Pages/Chapters/Order/Body leben in lokaler SQLite-DB. Eigene Persistenz, eigene Revisionen, eigene Suche. Keine BookStack-Dependency mehr nötig.
- **`bookstack`** (für bestehende Deployments + alle, die BookStack-UI parallel weiter nutzen wollen): Pages/Chapters/Body leben in BookStack. App-DB bleibt Cache (page_stats, FTS-Index, App-Domain-Daten).

Admin wählt global via `app.backend` in `app_settings` (Phase 4c). Wechsel ist Bulk-Copy-Job (Phase 8), nicht Runtime-Hot-Swap. Kein Dual-Write — ein Backend zur Zeit. Inhaltliche Features (eigene User-Mgmt, ACL, Reader-View, Revisions, Tags, FTS) gelten für beide Backends, sind Backend-agnostisch durch die Content-Store-Abstraktion.

## Vor-Phase (abgeschlossen)

Storage-Abstraktion + Frontend-Repo-Layer sind bereits gelandet — Voraussetzung für alle Backend-Disjunktions-Phasen. Phase 1 erweitert dieselbe Facade um den `localdb`-Dispatch, ohne Re-Refactor des BookStack-Pfads.

- **[lib/content-store.js](../lib/content-store.js)** als Facade mit Vertrag (`listBooks`, `loadBook`, `createBook`, `loadChapter`, `createChapter`, `updateChapter`, `deleteChapter`, `listPages`, `loadPage`, `savePage`, `createPage`, `deletePage`, `bookTree`, `loadPagesBatch`, `streamExport`, `searchPages`). Single Entry Point für Server-Code.
- **[routes/content.js](../routes/content.js)** als `/content/*`-Frontend-API hinter der Facade.
- **[public/js/repo/content.js](../public/js/repo/content.js)** als Client-Repo-Layer; Frontend ruft `bs*` nirgends mehr direkt.
- `routes/books.js` toter Mount entfernt.
- Tripwire-Konvention: `bsGet`/`bsPut`/`bsGetAll` nur in [lib/bookstack.js](../lib/bookstack.js), [lib/content-store.js](../lib/content-store.js), [routes/sync.js](../routes/sync.js), [routes/jobs/shared/bookstack.js](../routes/jobs/shared/bookstack.js). CI-Grep gegen Frontend + andere Server-Module schlägt fehl. Bei Phase 1 wird `lib/content-store.js` in Backend-Submodule (`lib/content-store/backends/{bookstack,localdb}.js`) zerlegt; Tripwire wandert mit auf `lib/content-store/backends/bookstack.js`.

Editor + WYSIWYG ändern sich nicht: App nutzt eigenen CodeMirror-basierten Editor, Body bleibt HTML. BookStack-TinyMCE-Iframe wird von der App nie eingebunden — historisch nicht, auch nicht im `bookstack`-Modus.

**Diese Datei beschreibt die Multi-Backend-Architektur als Plan** — bewusste Ausnahme zur CLAUDE.md-Doku-Stil-Regel. Sobald eine Phase live ist, gehört der dauerhafte Teil davon in CLAUDE.md / passende `docs/`-Spickzettel. Diese Datei bleibt liegen, solange offene Phasen existieren; vollständig erledigte Phasen werden gestrichen, der Rest bleibt als Architekturbeschreibung für künftige Code-Sessions.

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
- Export (`/api/books/:id/export/{fmt}`, nur Buch-Scope, PDF/HTML/TXT/MD) — durch Eigenbau ersetzt (Phase 4b2: Sync-Route `GET /export/:scope/:id/:fmt` + Builder pro Format); im `localdb`-Backend ohnehin nicht verfügbar.
- Templates, Shelves.

App verwendet schon eigenständig: Google-OIDC-Login, Custom-PDF-Export, Focus-Editor, alle KI-Jobs, Page-Stats, Job-Queue. BookStack bleibt für Persistenz + WYSIWYG + User-DB.

Bewusst out-of-scope (User-Wunsch): Attachments (werden nicht genutzt → kein Mirror).

---

## Phasen-Übersicht

| # | Phase | Reversibel? | User-Impact | Abhängigkeiten |
|---|---|---|---|---|
| 0b | Backfill: Frontend-Trigger (Backend + Auto-Login-Trigger stehen) | ja | manueller „BookStack-synchronisieren"-Button + Lazy-Backfill | — |
| 1 | `localdb`-Backend implementieren (Content-Store-Variante) | ja (Flag) | keiner solange `app.backend='bookstack'` | 0b |
| 2 | Eigene Page-Revisions | ja | feinere History (beide Backends) | 0 |
| 3 | Eigene Sortierung | ja | `localdb`-only nativ; `bookstack` weiter via BS-`priority` | 0, 1 |
| 4a2 | Public Landing + Request-Register | ja | Öffentliche Startseite mit Login + Registrierungsanfrage; Admin moderiert Anfragen | 4c2 |
| 4b | Book-ACL + Sharing (owner/editor/lektor/viewer) | ja | Buchliste filtert auf Shares; Rollen-Matrix | — |
| 4b1 ✓ | Lese-Modus (Print-CSS + readOnly) | ja | Druckansicht + readOnly für viewer | 4b |
| 4b2 ✓ | Export-Konsolidierung (Eigenbau alle Scopes + Formate) | ja | Export-Karte für Buch/Kapitel/Seite; kein BookStack-Pass-Through mehr | 4b |
| 4c1 ✓ | First-Run-Setup-Wizard (`/setup`) | ja | Admin loggt sich via `ADMIN_PASSWORD` ein und konfiguriert OAuth/KI/Backend/SMTP Schritt für Schritt; auch später wieder aufrufbar | — |
| 4d | Token-Budget + Cost-Tracking (Admin) | ja (additiv) | Admin-Karte Usage; pro-User-Monats-Budget hard/soft; 429 bei Hard-Cap | — |
| 6 | Tags/Kategorien | ja | Filter-UI (beide Backends) | — |
| 7 | Volltextsuche (FTS5) | ja | App-eigene Suche (beide Backends) | 1, 2, 4b |
| 8 | Backend-Migration-Tool (Bulk-Copy) | one-way pro Direction | Admin-UI „Backend wechseln" | 1–7 |
| 9 | Doku-Update (Multi-Backend-Sweep) | ja | keiner (Doku) | 8 |
| 10 | Schema-Squash | ja | keiner | 9 |
| 11 | Per-User-AI-Provider-Override | ja (additiv) | Admin weist pro User claude/ollama/llama zu; User folgt sonst globalem Default | 4c, 4d |

**Start-Reihenfolge:** 0b → 4a2 → 4d → 4b → 4b1 → 4b2 → 2 → 6 → 1 → 3 → 7 → 8 → 9 → 10.
10 (Squash) zuletzt — Squash vorher wäre Wegwerfarbeit, weil bis dahin viele Migrationen dazukommen. Phase 11 (Per-User-AI-Provider-Override) ist additiv und kann nach 4d eingeschoben werden, sobald die Hauptkette steht.

**Erledigt:**
- Phase 0c (PRAGMA-Tuning, [db/connection.js](../db/connection.js) + `PRAGMA optimize` im SIGTERM-Handler von [server.js](../server.js)).
- Phase 0d (TTL-Cache-Cleanup, [lib/cache-cleanup.js](../lib/cache-cleanup.js) im 23:00-Cron-Tick, manuell via `npm run cache:cleanup [-- --vacuum]`).
- Phase 0 (Schema-Skelett, Migration 105 + 106 in [db/migrations.js](../db/migrations.js): additive Phase-0-Spalten auf pages/chapters/books + AUTOINCREMENT-Recreate mit `sqlite_sequence`-Wasserzeichen `≥ 1_000_000`). Dauerhafte Invariante steht oben in „Schema-Invariante (aus Phase 0)". Tests: `tests/unit/db-pragmas.test.js`, `tests/unit/cache-cleanup.test.js`, `tests/unit/schema-phase0.test.js`.
- Phase 4a (App-User-Verwaltung): Migration 107 (`app_users` + `user_invites` mit Partial-UNIQUE + `user_sessions_audit` + `users.email`-FK), [db/app-users.js](../db/app-users.js) Helper-API, ENV-getriebener Admin-Bootstrap, OIDC-Lookup mit Status-Gate + Invite-Accept + ALLOW_OPEN_SIGNUP, `POST /auth/admin-login` mit `timingSafeEqual` + Rate-Limit ([lib/admin-login-ratelimit.js](../lib/admin-login-ratelimit.js)), `GET /login`-Landing-Page mit Google-Button + Admin-Form, `/admin/users`-Routen (Liste, Invite, Update, Soft-Delete, Audit) hinter [lib/admin-mw.js#requireAdmin](../lib/admin-mw.js), `POST /me/invite` mit `can_invite_users`-Gate, Frontend-Karte `AdminUsersCard` ([public/js/cards/admin-users-card.js](../public/js/cards/admin-users-card.js)) + Avatar-Menu-Link für Admins. Tests: `tests/unit/app-users.test.js`, `tests/unit/admin-login-ratelimit.test.js`, `tests/unit/admin-users-routes.test.js`, `tests/unit/login-page.test.js`.
- Phase 4c (Admin-Settings): Migration 108 (`app_settings` + `app_settings_audit`), [lib/app-settings.js](../lib/app-settings.js) als SSoT-Helper mit DEFAULTS, `bootstrapFromEnv()` für initiale ENV→DB-Spiegelung (server.js-Startup), AES-Crypto via [lib/crypto.js](../lib/crypto.js) für `ENCRYPTED_KEYS`-Set (api_key, secrets, tokens), Sentinel `__unchanged__` für Re-PUTs ohne Klartext, `changed`-EventEmitter für Hot-Reload (z.B. OIDC-Client-Invalidate in [routes/auth.js](../routes/auth.js) bei `app.public_url`/`auth.google.*`-Wechsel). `/admin/settings`-Routen ([routes/admin-settings.js](../routes/admin-settings.js)) mit GET/PUT/DELETE + Test-Probes (`test-provider`, `test-oauth`). Frontend `AdminSettingsCard` ([public/js/cards/admin-settings-card.js](../public/js/cards/admin-settings-card.js)) mit 8 Tabs (auth, provider, model, backend, jobs, cron, pdfa, advanced) + Save-Diff (sendet nur dirty Keys). **Strict-ENV-Kill (Phase 4c-E):** Konsumenten lesen migrierte Keys ausschliesslich aus `app_settings` (kein ENV-Fallback mehr) — [lib/ai.js](../lib/ai.js), [lib/pdfa-validate.js](../lib/pdfa-validate.js), [lib/prompts-loader.js](../lib/prompts-loader.js), [routes/proxies.js](../routes/proxies.js), [routes/chat.js](../routes/chat.js), alle [routes/jobs/](../routes/jobs/)-Module, [routes/auth.js](../routes/auth.js) (Google-OIDC + Whitelist + Open-Signup), [server.js](../server.js) (Stale-Cron + CRON_TIMEZONE). Per-Call-Live-Getter für hot-reloadable Werte (`ai.provider`, Modelle, Hosts, Temps, Claude-Retry-Max/Timeout/Phase1-Concurrency, BookChat-Mode/Iter/Budget, MaxConcurrentJobs, PDF/A-Flavour/Disabled). Boot-frozen bleiben Budget-Ableitungen (`CHARS_PER_TOKEN`, `MAX_TOKENS_OUT`, `MODEL_CONTEXT`, `INPUT_BUDGET_*`), weil downstream-Module (`shared/loader.js#SINGLE_PASS_LIMIT/PER_CHUNK_LIMIT`) sie bei Modul-Load lesen. ENV-Map um `CLAUDE_RETRY_MAX`, `CLAUDE_TIMEOUT_MS`, `CLAUDE_PHASE1_CONCURRENCY` erweitert. Boot-Layer-ENVs (PORT, DB_PATH, SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, TZ, LOG_LEVEL, LOCAL_DEV_MODE, VERAPDF_BIN, BOOKSTACK_URL, TOKEN_ID/TOKEN_KENNWORT) bleiben in ENV (Krypto-Master + Backend-Bootstrap). Tests: `tests/unit/app-settings.test.js`, `tests/unit/admin-settings-routes.test.js`, `tests/unit/login-page.test.js`.
- Phase 4c1 (First-Run-Setup-Wizard): [routes/setup.js](../routes/setup.js) mit `GET /setup` (HTML), `GET /setup/state` (Steps + Values + Masked-Flags), `POST /setup/:step` (publicUrl/oauth/emails/ai/backend/smtp je atomar, Encrypted-Sentinel `__unchanged__` honored, leerer Secret-Wert = kein Overwrite), `POST /setup/test/{oauth,provider,backend,smtp}` (smtp-Probe Stub bis Phase 4c2), `POST /setup/complete` (setzt `app.setup_completed=true` + spiegelt `ADMIN_EMAIL` nach `auth.admin_email`). Standalone-Wizard-Frontend ([public/setup.html](../public/setup.html) + [public/js/setup.js](../public/js/setup.js) + [public/css/setup.css](../public/css/setup.css)) ohne Alpine, eigene Inline-i18n (DE/EN aus `navigator.language`). Admin-only via `requireAdmin`. `/config` liefert `setupCompleted`-Flag; `toggleAdminUsersCard` + `toggleAdminSettingsCard` redirecten auf `/setup`, solange Admin nicht abgeschlossen hat. Tests: `tests/unit/setup-routes.test.js` (18 Cases — Guards, Step-Validierung, Encrypted-Sentinel, Complete, smtp-Stub).
- Phase 4c2 (SMTP-Mailer): nodemailer-Dep, [lib/mailer.js](../lib/mailer.js) als Singleton-Service mit Mode-Auflösung (`disabled`/`gmail-oauth`/`gmail-app-password`/`generic`), In-Memory-Rate-Limit (30/min Default), Settings-Change-Event-Hook (Cache-Invalidate bei `smtp.*`-Wechsel), Test-Transport-Factory für Tests. [lib/mailer-templates.js](../lib/mailer-templates.js) mit `invite` + `test`-Template, i18n-Lookup (de/en), HTML-Escape gegen Injection. Admin-Routen `GET /admin/settings/smtp/test-config` + `POST /admin/settings/smtp/test-send`. Frontend `AdminSettingsCard`-Tab „SMTP / Mailer" mit Mode-abhängigen Feldern + Test-Mail-Button. ENCRYPTED_KEYS-Set in `app-settings.js` deckt `smtp.gmail.client_secret`, `smtp.gmail.refresh_token`, `smtp.gmail.app_password`, `smtp.password` ab. Tests: `tests/unit/mailer.test.mjs` (Templates inkl. Escape, getStatus, send-Pfade, jsonTransport-Roundtrip, Settings-Reload).
- Phase 4b1 (Lese-Modus): Frontend-Role-Wiring (4b-Vorgriff) — `bookRoles`-Cache + `currentBookRole` am Root, Getter `canEdit()`/`canReview()`/`isViewer()` in [tree.js](../public/js/tree.js), Fetch via `GET /books/:id/access` in `_loadBookRole()` (Best-Effort: 403/Fehler → null → Legacy-Fallback erlaubt Edit, bis 4b serverseitig alle Schreibpfade enforced). Editor-Buttons in [editor.html](../public/partials/editor.html) (Edit/Fokus/Chat/Korrekturen) hinter `canEdit()`/`canReview()`; `startEdit`/`saveEdit`/`quickSave` mit `canEdit()`-Defense-in-Depth. [public/css/print.css](../public/css/print.css) (`@media print`) blendet UI-Chrome aus, rendert nur `.page-content-view` als Serif-Buchsatz mit `@page`-Margen + Page-Break-Hints. `readerPrint()`-Methode in [app-view.js](../public/js/app-view.js) + „Drucken"-Button in der Editor-Toolbar (callt `window.print()`; cancelEdit vorher, wenn nicht dirty, damit keine Findings-Marks im Druck). i18n-Keys `reader.print`/`reader.printHint` (DE+EN). `SHELL_CACHE` bumped.
- Phase 0b Backend (Backfill-Job in [routes/jobs/backfill.js](../routes/jobs/backfill.js), Upserts in [db/backfill.js](../db/backfill.js), Mock-BookStack `book_id]?=`-Filter-Fix, 5 Integration-Tests in [tests/integration/backfill.test.js](../tests/integration/backfill.test.js)). Frontend-Trigger-Punkte siehe Phase-0b-Block unten.
4a/4c/4b zuerst, weil User-Identität, `app.backend`-Schalter und ACL die SSoT für alle folgenden Phasen sind. Lese-Modus (4b1, Print-CSS + readOnly) direkt nach 4b, weil viewer-Rolle erst dann existiert. Phase 7 (Suche) **vor** Phase 8, damit FTS schon steht, wenn Admin Backend wechselt — Index wird beim Bulk-Copy mitgefüllt.

4d (Token-Budget + Cost) folgt 4a (braucht `app_users.global_role='admin'`). Vor 4b einsortiert, weil Kostenkontrolle vor Sharing-Welle (mehr Co-Editoren = mehr KI-Calls) bestehen muss; rein additiv (neue Spalten/Tabelle/Routen, kein Refactor) und kann bei Bedarf vorgezogen werden.

4c2 (SMTP-Mailer) sitzt nach 4c1, weil der Setup-Wizard die SMTP-Keys mit befüllt — Mailer-Code ohne Settings wäre toter Pfad. 4a2 (Public Landing + Request-Register) hängt an 4c2, weil Registrierungsanfragen per Mail an den Admin gehen; ohne Mailer fällt der Flow auf In-App-Inbox zurück (siehe 4a2-Fallback).

**Phase 5 (Dual-Write) entfällt.** Im Multi-Backend-Modell schreibt jeder Backend in seine eigene Wahrheit; ein gleichzeitiges Schreiben in BookStack **und** localdb wäre nur sinnvoll bei „Migration mit Rollback-Schutz" — und das deckt Phase 8 als One-Shot-Bulk-Copy mit veraltetem Quell-Backend-Read-Only-Marker während des Runs ab.

---

## Schema-Invariante (aus Phase 0, dauerhaft)

`books`/`chapters`/`pages` sind `INTEGER PRIMARY KEY AUTOINCREMENT` mit `sqlite_sequence`-Wasserzeichen `≥ 1_000_000`. Heisst:

- **Bestandsrows** behalten ihre BookStack-IDs (`<100k` typisch). Alle ~40 FK-Spalten (`figures.book_id`, `page_stats.page_id`, `chapter_reviews.chapter_id`, `page_revisions.page_id`, `lektorat_time.page_id`, `chat_sessions.page_id`, `pdf_export_profile.book_id`, …) bleiben gültig.
- **Neue `localdb`-Items** kriegen IDs `≥ 1_000_001`. Klare Trennung vom BookStack-Range — Phase 8-Backend-Switch bleibt konfliktfrei, BS-Re-Imports landen im freien Range.
- **Gelöschte IDs** werden nicht wiederverwendet (AUTOINCREMENT-Garantie) → keine „Zombie-FK".
- **Sentinel `book_id = 0`** (User-Default-PDF-Profile) bleibt safe.
- App-eigene Surrogat-Tabellen (`figures.id`, `locations.id`, `figure_scenes.id`, `ideen.id`, …) sind unverändert.

Phase-0-Spalten im aktuellen Schema:

- `pages`: `body_html`, `body_markdown`, `position`, `priority`, `slug`, `local_updated_at`, `remote_updated_at`, `dirty` (NOT NULL DEFAULT 0). FK `chapter_id → chapters(chapter_id) ON DELETE SET NULL` weiter aktiv. Index `idx_pages_dirty WHERE dirty = 1` für Sync-Pull.
- `chapters`: `position`, `priority`, `slug`, `description`. FK `book_id → books(book_id) ON DELETE CASCADE` weiter aktiv.
- `books`: `description`, `cover_image BLOB`, `owner_email`. Index `idx_books_owner_email` für ACL-Filter.

`dirty` + `remote_updated_at` = Konflikterkennung beim BookStack-Sync-Pull (Phase 1). `owner_email` wird beim Backfill (Phase 0b) mit Session-User befüllt, sofern leer; ab Phase 4b regelt `book_access` die Sichtbarkeit.

**Verworfen:** UUIDs/ULIDs als PKs — würde alle ~40 FK-Spalten + Client-Code (URL-Parameter `:book_id`, Hash-Router, Job-Results, Caches) brechen ohne Mehrwert für Self-Hosted.

---

## Phase 0b — Backfill: Frontend-Trigger (offen)

Backend-Backfill steht: Job-Typ `'backfill'` in [routes/jobs/backfill.js](../routes/jobs/backfill.js) (`runBackfillJob` + `POST /jobs/backfill`), Upsert-Helpers in [db/backfill.js](../db/backfill.js), Idempotenz + FK-Reihenfolge (books → chapters → pages) + `foreign_key_check` getestet in [tests/integration/backfill.test.js](../tests/integration/backfill.test.js). Dedup auf User-Ebene; Body `{ bookId }` schraenkt auf Einzelbuch ein; `owner_email` wird nur beim Erst-Backfill gesetzt (Erst-Backfiller „erbt" das Buch; Phase 4b regelt spaeter Sharing).

**Offen — zwei Trigger-Punkte:**
- **Manuell** in „Buch-Einstellungen" oder „User-Einstellungen": Button „BookStack synchronisieren" → `POST /jobs/backfill` (optional `{ bookId }` aus Buch-Settings-Kontext). Reicht fuer initialen Roll-Out.
- **Pro Buch on-demand:** beim ersten Page-Open eines Buchs ohne lokale Bodies → Lazy-Backfill `POST /jobs/backfill { bookId }`.

**Erledigt — Auto-Login-Trigger:** [routes/jobs/backfill.js#maybeAutoBackfillOnLogin](../routes/jobs/backfill.js), aufgerufen aus [routes/auth.js](../routes/auth.js) nach erfolgreichem OIDC-Callback. Globale Heuristik: `SELECT 1 FROM pages WHERE body_html IS NOT NULL LIMIT 1` — leer → Auto-Backfill anstossen. Idempotent via `findActiveJobId`; Fehler werden geloggt, blockieren Login nicht. Sobald irgendein Body in der DB liegt, schaltet der Auto-Trigger ab (pro-User-Tracking kommt erst mit Phase 4a `app_users.last_backfill_at`).

Phase 1 (Sync-Worker) uebernimmt nach Erst-Backfill inkrementelle Updates per `updated_at`-Diff. Re-Run bleibt idempotent (Cron-tauglich).

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
- `createBook(name, owner_email)` / `createChapter` / `createPage` → `INSERT` ohne expliziten PK; SQLite vergibt aus `sqlite_sequence` (Wasserzeichen ≥ 1_000_000 aus Phase 0).
- Kein HTTP, kein Token, keine BookStack-Berührung.

**ID-Strategie**: BookStack-IDs sind positive Integer aus BS-DB (typisch < 100k). `localdb`-Neu-Items beginnen ab `seq+1 ≥ 1_000_001` dank Wasserzeichen in `sqlite_sequence` (siehe „Schema-Invariante" oben). Klare Trennung, kein Kollisionsrisiko bei späterer Backend-Migration. FK-Constraints bleiben intakt, weil `books`/`chapters`/`pages` ihre PKs unverändert führen.

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

### Devmode-Seed

Im `localdb`-Mode ist `books` beim Erststart leer — auf `LOCAL_DEV_MODE=true` landet der Dev-User damit ohne Buch und ohne sinnvolle UI. Lösung: einmaliger Auto-Seed direkt nach Migrations.

**Trigger-Bedingung** (alle vier):
- `LOCAL_DEV_MODE === 'true'`
- `LOCAL_DEV_SEED !== 'false'` (Default an; explizit auf `false` für Empty-State-Test)
- `app.backend === 'localdb'` (im `bookstack`-Mode irrelevant — Backfill aus BS füllt `books`)
- `SELECT COUNT(*) FROM books = 0` (idempotent — Re-Boot erzeugt nicht doppelt)

**Inhalt** (just enough, damit alle Karten Daten haben):
- 1 Buch (`name='Devmode-Testbuch'`, `owner_email='dev@local'`, `slug='devmode-testbuch'`).
- 2 Kapitel (`'Kapitel 1'`, `'Kapitel 2'`).
- 5 Pages mit echtem Prosa-Text (Public-Domain — Kafka „Verwandlung" Eröffnungs-Absätze o.ä.). Pro Page genug Material, dass `figuren`/`szenen`/`lektorat`/`komplett` echte Findings erzeugen, nicht Empty-State.
- IDs aus Wasserzeichen (`≥ 1_000_001`, dank `sqlite_sequence`-Bump aus Phase 0).

**Code**: [lib/dev-seed.js](../lib/dev-seed.js) (neu) — `runDevSeedIfNeeded()`, einmaliger Call in [server.js](../server.js) nach `runMigrations()`, vor Route-Mount. Prosa-Text inline (kein Asset-Loader). Logger-Warn bei Seed: `'LOCAL_DEV_SEED: Buch "Devmode-Testbuch" (id=N) mit 2 Kapiteln + 5 Pages angelegt.'`.

**Prod-Safety**: Doppelter Guard. `LOCAL_DEV_MODE` ist Pflicht — selbst wenn `LOCAL_DEV_SEED=true` versehentlich in Prod-ENV landet, läuft Seed ohne `LOCAL_DEV_MODE` nicht. Zusätzlich: `app.backend==='localdb'`-Check verhindert Seed in einer prod-`bookstack`-Instanz, die zufällig leer auf einen ersten Sync wartet.

**Empty-State-Flow trotzdem erreichbar**: `LOCAL_DEV_SEED=false` → User landet ohne Buch, muss `POST /content/books` via UI auslösen (testet First-Run-Erlebnis aus Prod-Sicht).

**Tests**: Unit in `tests/unit/dev-seed.test.mjs` — gegen In-Memory-DB: (a) idempotent (zweiter Call no-op), (b) Guards greifen einzeln (`LOCAL_DEV_MODE=false` → kein Seed, `LOCAL_DEV_SEED=false` → kein Seed, `app.backend='bookstack'` → kein Seed), (c) IDs ≥ 1_000_001.

**User-sichtbare Strings backend-agnostisch machen** (i18n-Sweep, beide Locales `de`+`en` in [public/js/i18n/](../public/js/i18n/)): solange Save in BookStack ging, war „in BookStack gespeichert" als Texte eindeutig — im Multi-Backend-Modell muss der User-Text vom gewählten Backend unabhängig sein. Save-Pfad zuerst, weil sichtbarste Stelle:

- `bs.savingToBookStack` „Speichere in BookStack…" → umbenennen zu `editor.saving` „Speichere…" (Status-Toast während PUT).
- `editor.savedTitle` „Auf BookStack gespeichert" → „Gespeichert" (Editor-Indicator nach erfolgreichem Save).
- `chat.changeSaved` „Änderung in BookStack gespeichert." → „Änderung gespeichert." (Chat-Apply-Toast).
- `tree.connecting` „Verbinde mit BookStack…" → „Lade Buchliste…" (Tree-Initial-Load).

Backend-spezifische Strings bleiben, werden aber nur im `bookstack`-Mode angezeigt (Frontend prüft `$app.currentBackend === 'bookstack'`): `book.openInBookstack`, `editor.openInBookstack`, `editor.revisionsTitle`, `book.search.placeholder` (BookStack-Variante), `bs.timeoutGet`/`bs.timeoutPut`/`bs.apiError*`, `session.bookstackTokenInvalid`, `tokenSetup.*`, `profile.bookstackToken`, `error.NO_BOOKSTACK_TOKEN`/`error.BOOKSTACK_UNAUTHED`/`error.BOOKSTACK_UNREACHABLE`, `job.error.noBookstackToken`/`job.error.bookstack*`, `palette.action.token`. Im `localdb`-Mode sind diese Pfade tot — Strings werden nie referenziert, müssen aber aus Konsistenz vorhanden bleiben (Test-Helper checkt `de.json`/`en.json`-Symmetrie).

Texte mit `BookStack-Papierkorb`/`BookStack-Export`/`BookStack-Seiten` (delete-Confirm, export-Hint, pdf-export-Chapter-Hints, bookOrganizer-Confirms) bekommen jeweils zwei Varianten oder werden generisch formuliert (kein Backend-Name im Text). Pflicht: Frontend liefert keinen Backend-spezifischen Text in localdb-Mode-Sichten.

**Server-Status-Keys**: `routes/jobs/shared/queue.js` und Save-Job-Helper setzen `statusText` ausschliesslich als generischer i18n-Key (`'job.phase.saving'`, nicht `'job.phase.savingToBookStack'`). Bestehende Job-Phasen-Keys grep'pen und entbookstackifizieren.

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

Jeder erfolgreiche `content-store.savePage`-Pfad (Editor-Save, Focus-Save, Chat-Apply, Lektorat-Apply, History-Restore) schreibt Revision **vor** PUT mit `source`-Tag — gilt für beide Backends, weil die Facade der einzige Schreib-Chokepoint ist. Sync-Pull (nur `bookstack`-Mode) schreibt Revision `source='bookstack-sync'`, wenn Body sich änderte; im `localdb`-Mode taucht dieser Source-Wert nie auf.

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
| Buch-Chat senden                                  | ja    | ja     | nein¹  | nein   |
| Analyse-Jobs (Komplett, Review, Kontinuität, …)   | ja    | ja     | nein   | nein   |
| Figuren/Orte/Szenen/Ideen CRUD                    | ja    | ja     | nein   | nein   |
| BookSettings ändern (Buchtyp, Freitext, Tags)     | ja    | ja     | nein   | nein   |
| Sharing-Verwaltung                                | ja    | nein   | nein   | nein   |
| Buch löschen / Ownership-Transfer                 | ja    | nein   | nein   | nein   |

¹ **Buch-Chat für Lektor optional aktivierbar:** Owner kann pro Buch `BookSettings.allow_lektor_book_chat = true` setzen. Default `false` (Token-Kosten-Vermeidung). Wenn `true`, gilt für Lektor-Rolle `Buch-Chat senden: ja`. Migration `book_settings ADD COLUMN allow_lektor_book_chat INTEGER NOT NULL DEFAULT 0`. UI-Toggle in BookSettings-Card unter Sharing-Sektion.

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

**Audit-Pflicht (kein implizites Default):** Vor Phase-4b-Merge wird jeder bestehende `FEATURES`-Eintrag explizit klassifiziert (`grep -n "minRole" public/js/cards/feature-registry.js` muss vollständig sein). Sonst greift implizit `editor` und Viewer/Lektor sehen plötzlich Cards, die sie nicht aufrufen dürfen — Server-Guard fängt es zwar (403), aber UX bleibt verwirrend. Test: `tests/unit/feature-registry-minrole.test.mjs` iteriert über alle `FEATURES` und prüft, dass jeder Entry ein `minRole` setzt.

**Karten-Sichtbarkeit global** (App-Ebene): `AdminUsersCard` + `AdminSettingsCard` weiterhin nur `global_role='admin'`. `UserSettingsCard` (Self-Profile) für alle.

**Backfill**: Migration scannt `books.owner_email`, schreibt Owner-Row in `book_access`. Bücher ohne `owner_email`: erste Person, die nach 4b zugreift, wird Owner — aber nur, wenn `ADMIN_EMAIL` nicht greift (Admin darf gerade kein Buch-Owner werden, sonst Privacy-Bruch). Konkret: Backfill fragt manuell pro Legacy-Buch oder lässt es im „herrenlos"-Zustand mit Admin-Hint.

**Shared-Book-Backfill (BookStack-Mehrfachzugriff → localdb-ACL)**: Phase 0b mirrort pro User dessen sichtbare Bücher in dieselbe `books`-Row (gleiche BookStack-`book_id`). `owner_email` bekommt nur der Erst-Backfiller; alle anderen Berechtigten verlieren bei BookStack-Kill den Zugriff, weil `book_access` für sie leer bleibt. Ohne Gegenmassnahme fällt ein heute geteiltes Buch wie „Das erotische Tagebuch" für alle ausser dem Erst-Backfiller raus.

Migrationsschritt (läuft als Teil der Phase-4b-Migration, **vor** dem `books.owner_email` → `book_access`-Scan):

1. **Discovery**: für jedes Buch in `books` BookStack-API `GET /api/books/:id/permissions` (bzw. role/permission-Endpoints) mit Admin-Token abrufen → Liste aller User-Mails mit `view`-Recht.
2. **Persist**: pro `(book_id, email)` Row in `book_access` schreiben. Erst-Backfiller (`books.owner_email`) → `role='owner'`. Übrige BookStack-Berechtigte → Default `role='editor'` (konservativ — Lese-only-User aus BookStack waren bisher Vollzugriff, weil App keine ACL hatte; Admin kann nachher pro Buch downgraden).
3. **Fallback ohne BookStack-Verfügbarkeit**: Admin-CLI `npm run migrate:shared-books -- --book <id> --grant <email1,email2>` für manuelle Pflege, falls BookStack zum Migrationszeitpunkt schon weg ist. CLI schreibt direkt in `book_access`.
4. **Audit-Log**: pro geschriebene Row Event `book-access-migrated` mit `source='bookstack-permissions'|'cli'` in `user_sessions_audit` (Phase 4a-Tabelle).
5. **Idempotenz**: `INSERT OR IGNORE` — Re-Run überschreibt keine inzwischen vom Owner manuell geänderten Rollen.

**Vorbedingung Phase 8 (Backend-Kill)**: Admin-Checkliste vor BookStack-Shutdown bekommt Punkt „Shared-Books-Mapping geprüft" — Reportabfrage `SELECT b.book_id, b.name, COUNT(ba.user_email) AS shares FROM books b LEFT JOIN book_access ba ON ba.book_id=b.book_id GROUP BY b.book_id` muss für jedes BookStack-shared Buch ≥ Anzahl ehemaliger BS-Berechtigter zeigen.

---

## Phase 4b1 — Lese-Modus (Print-CSS + readOnly-Editor) — erledigt

Ablenkungsfreier Lese-Pfad für `viewer` (und alle, die „nur lesen" wollen). **Bewusst minimal**: kein eigener Render-Stack, kein E-Reader-Klon — der existierende Editor im readOnly-Mode + Print-CSS reichen für Solo/Multi-User-Self-Host.

**Implementiert:**

1. **Role-aware Editor** — `bookRoles`-Cache + `currentBookRole` am Root ([app-state.js](../public/js/app-state.js)). `_loadBookRole(bookId)` in [tree.js](../public/js/tree.js) fetcht `GET /books/:id/access` und cached pro Buch. Getter `canEdit()` (editor + owner), `canReview()` (lektor + editor + owner), `isViewer()`. Buttons in [editor.html](../public/partials/editor.html) (Bearbeiten/Fokus/Chat/Korrekturen) hinter den Gettern. `startEdit`/`saveEdit`/`quickSave` mit Defense-in-Depth-Guard.
2. **Print-CSS** ([public/css/print.css](../public/css/print.css)) — `@media print` blendet UI-Chrome aus, rendert `.page-content-view` als Serif-Buchsatz mit `@page`-Margen, Page-Break-Hints, Korrekturmark-Stripping. Verlinkt in [index.html](../public/index.html) + [tests/fixtures/focus-harness.html](../tests/fixtures/focus-harness.html) via `media="print"`. `SHELL_CACHE` bumped.
3. **„Drucken"-Button** in der Editor-Toolbar ruft `readerPrint()` ([app-view.js](../public/js/app-view.js)) → `cancelEdit()` (falls nicht dirty) + `window.print()`. i18n-Keys `reader.print`/`reader.printHint` (DE+EN).

**Fallback:** `currentBookRole === null` (Endpoint-403, fehlende `book_access`-Row) → `canEdit()` liefert `true`, damit Legacy-Bücher bis zur vollen 4b-Enforcement nicht UI-seitig gesperrt sind. Server-Guard ist sowieso die Sicherheits-Ebene.

**Explizit weggelassen (gegenüber ursprünglichem Plan):**
- Keine `reader_progress`/`reader_bookmarks`-Tabellen.
- Keine `user_settings.reader_theme`/`reader_typo_json`-Spalten.
- Keine `ReaderCard` Sub-Komponente.
- Keine eigene Render-Pipeline (`reader-render.js` etc.).
- Keine Theme-Toggles (hell/sepia/dunkel), keine Typo-Settings, keine TOC-Drawer, keine Highlights/Notizen.
- Keine `/reader/*`-Routen.

**Begründung:** Custom-PDF-Export ([routes/jobs/pdf-export.js](../routes/jobs/pdf-export.js)) existiert bereits als „Buch sauber konsumieren"-Pfad mit Profilen/Cover/Schrift. Print-CSS deckt den Browser-Pfad ab. Eigenes E-Reader-UI ist Aufwand ohne klaren Mehrwert für Self-Host.

---

## Phase 4b2 — Export-Konsolidierung (Eigenbau alle Scopes + Formate)

Heute zwei Wege nebeneinander: [routes/export.js](../routes/export.js) (Buch-Sync-Download, PDF/HTML/TXT/MD per BookStack-Pass-Through über `streamExport`, EPUB/DOCX als Eigenbau) und [routes/jobs/pdf-export.js](../routes/jobs/pdf-export.js) (Buch-async-Job, Custom-PDF mit Profilen). Im `localdb`-Backend gibt es kein BookStack-Pass-Through mehr — alles muss eigenbau sein. Diese Phase **konsolidiert** beide Wege und ergänzt gleichzeitig Kapitel- und Seiten-Scope.

**Endzustand:**
- Ein Loader (`lib/load-contents.js`) für Buch/Kapitel/Seite.
- Pro Format ein Builder in `lib/export-builders/` (`pdf.js`, `html.js`, `txt.js`, `md.js`, `epub.js`, `docx.js`).
- Eine Sync-Route `GET /export/:scope/:id/:fmt` (Default-Styling, kein Profil).
- Eine Async-Job-Route `POST /jobs/pdf-export` mit Scope-Param (Custom-Profil/Cover/Schrift).
- `content-store.streamExport` + `lib/bookstack.js`-Import in `routes/export.js` ersatzlos gestrichen.

### Lib-Refactor

**[lib/load-book-contents.js](../lib/load-book-contents.js) → [lib/load-contents.js](../lib/load-contents.js)** (umbenennen + erweitern), exportiert genau einen Dispatcher:

```js
loadContents({ scope, id }, ctx) → { scope, book, chapters?, pages, groups }
```

- `scope === 'book'`: alle Kapitel + Pages, Multi-Chapter-Grouping (heutige Logik).
- `scope === 'chapter'`: `contentStore.loadChapter(id)` → `contentStore.listPages(book_id)` gefiltert auf `chapter_id`, position-sortiert → `{ groups: [oneGroup] }`. `CHAPTER_EMPTY` analog `BOOK_EMPTY`.
- `scope === 'page'`: `contentStore.loadPage(id)` → `{ groups: [{ chapter: null, pages: [x] }] }`. `PAGE_EMPTY` bei `!html`.

Gemeinsame Grouping-Hilfsfunktion bleibt intern; Buch ruft sie mit allen Chapters, Kapitel mit einem, Seite mit einer Pseudo-Gruppe. Alle Konsumenten (`routes/export.js`, `routes/jobs/pdf-export.js`) schalten auf `loadContents` um. `load-book-contents.js` wird gelöscht.

**Format-Builders** in [lib/export-builders/](../lib/export-builders/) — eine Datei pro Format, jeweils `buildXxx({ scope, book, groups, options? }) → Buffer`:

- `pdf.js` — wrappt [lib/pdf-render.js](../lib/pdf-render.js). Default-Profil aus [lib/pdf-export-defaults.js](../lib/pdf-export-defaults.js)#`defaultConfig()`. Kein Cover/keine Custom-Font. Scope-Flags an Render-Pipeline (Cover/TOC/Title-Page unten).
- `html.js` — Single-File-HTML mit `<style>`-Wrapper (Print-CSS aus Phase 4b1 wiederverwendet) + Kapitel-/Page-Headings.
- `txt.js` — HTML→Text via [lib/html-clean.js](../lib/html-clean.js) + `htmlToText`-Variante (Tag→Space, `\s+`→Single-Space — **dieselbe** Normalisierung wie [routes/sync.js](../routes/sync.js)#htmlToText, CLAUDE.md-Regel „HTML→Text-Normalisierung").
- `md.js` — Multi-Source-Strategie: bevorzugt `pages.body_markdown` (in `localdb` ab Phase 0b vorhanden), Fallback `turndown` (`html → md`) für Pages ohne Markdown-Spalte. Kapitel- und Page-Titel als `#`/`##`-Headings prepended.
- `epub.js` — bestehender Build aus heutigem `routes/export.js`, hierher verschoben + scope-fähig (Single-Group für Chapter/Page).
- `docx.js` — bestehender Build, ebenfalls hierher + scope-fähig.

### Sync-Route

**Eine Route ersetzt alle bisherigen:** `GET /export/:scope/:id/:fmt` in [routes/export.js](../routes/export.js).

- `scope ∈ {'book','chapter','page'}`, `fmt ∈ {pdf,html,txt,md,epub,docx}`.
- `toIntId(req.params.id)` validieren.
- `loadContents({ scope, id })` → liefert `book` (für Filename-Slug + `setContext({ book })`).
- Builder pro Format aus `lib/export-builders/` aufrufen → `Buffer`.
- `buildExportFilename({ prefix: scope, slug: chapter?.slug ?? page?.slug ?? book.slug, ext: fmt, date })`. Filename-Builder bleibt unverändert; nur neuer Prefix-Wert (`'book'|'chapter'|'page'`).
- Response: `Content-Type` aus Format-Map, `Content-Disposition` mit Filename, `Content-Length`, `res.end(buf)`. BOM-Prepend für `txt`/`md` (Notepad-Mojibake) wie bisher.
- Alte Routen `GET /export/book/:id/:fmt` ersatzlos entfernt (war ohnehin nur ein Pfad; ein Reverse-Proxy-Redirect ist nicht nötig — keine externen Konsumenten ausser unserer eigenen Frontend-Karte).

### Streichungen

- `content-store.streamExport` aus [lib/content-store.js](../lib/content-store.js) entfernt + aus `module.exports`.
- `BOOKSTACK_URL`/`authHeader`-Import in [routes/export.js](../routes/export.js) entfernt (heute schon WIP-modifiziert, nutzt `streamExport` — Phase 4b2 finalisiert den Cut).
- Server-Tripwire-Allowlist um `lib/content-store.js`-Streaming-Pfad verkürzt.
- BookStack-Inventory-Bullet „Export (`/api/books/:id/export/{fmt}`)" verliert in `localdb`-Mode Bedeutung; bleibt nur als historischer Hinweis. Bei `bookstack`-Backend liest die App weiterhin Body-HTML via `content-store.loadPage`, aber Export-Rendering läuft im App-Server (keine BookStack-Renderer-Aufrufe mehr).

### Custom-PDF-Job

[routes/jobs/pdf-export.js](../routes/jobs/pdf-export.js) bekommt Scope-Parameter im POST-Body:

```js
{ profileId, scope: 'book'|'chapter'|'page', entityId }
```

`entityId` ist `book_id`/`chapter_id`/`page_id`. Statt `loadBookContents` → `loadContents({ scope, id: entityId })`. Render-Pipeline ([lib/pdf-render.js](../lib/pdf-render.js)) bleibt unverändert (konsumiert `groups`); nur Scope-Flags an TOC/Cover/Title-Page:

- **Cover:** bei `chapter`/`page` weglassen (Default). Optional Profil-Toggle „Cover auch bei Teil-Export".
- **TOC:** bei `page` weglassen, bei `chapter` einstufig.
- **Title-Page:** bei `chapter`/`page` Kapitel-/Seitentitel statt Buchtitel; Untertitel zeigt Buchtitel als Kontext.

Profile bleiben Buch-scoped (`pdf_export_profile.book_id`); ein Profil gilt für alle drei Scopes desselben Buchs. Job-Result-JSON enthält wie bisher Metadaten, Buffer-Stream über `/jobs/pdf-export/:id/file`.

### Sync vs. Async — Aufteilung

- **`GET /export/:scope/:id/:fmt`** = synchron, Default-Styling, kein Profil. Schnellpfad für „eben mal Kapitel als DOCX an Lektor".
- **`POST /jobs/pdf-export`** = asynchron, Custom-Profil/Cover/Font/veraPDF-Check. Schwerer Pfad für „druckfertige PDF/A".

Beide Wege teilen `loadContents` + (im PDF-Fall) `lib/pdf-render.js`. Keine doppelte Render-Logik.

### Frontend

[public/js/cards/export-card.js](../public/js/cards/export-card.js) bekommt Scope-Combobox (Pflicht-Pattern aus CLAUDE.md):

- Optionen: „Ganzes Buch", „Aktuelles Kapitel" (nur wenn `selectedChapterId`), „Aktuelle Seite" (nur wenn `currentPageId`).
- Default: „Ganzes Buch".
- Format-Buttons-URL: `/export/${scope}/${entityId}/${fmt}`.

[public/js/cards/pdf-export-card.js](../public/js/cards/pdf-export-card.js) bekommt denselben Scope-Combobox neben dem Profil-Selector. Render-Trigger postet `{ profileId, scope, entityId }`.

Quick-Pills + Command-Palette: kein neuer `FEATURES`-Eintrag nötig — die Karten `export`/`pdfExport` bleiben SSoT, Scope ist Karten-internes Detail. Optional Editor-Toolbar-Knöpfe „Kapitel als PDF" / „Seite als PDF" hinter eigenem `FEATURES`-Eintrag.

### Rollen-Matrix

`export` und `pdfExport` bleiben `minRole: 'viewer'` (siehe Phase 4b). Scope ändert nichts — wer ein Buch sehen darf, darf auch Auszüge davon exportieren.

### i18n

Neue Keys: `export.scope.book`, `export.scope.chapter`, `export.scope.page`, `export.error.chapterEmpty`, `export.error.pageEmpty`. Beide Locales pflegen (CLAUDE.md-Regel).

### Tests

- **Unit pro Builder** in [tests/unit/export-builders/](../tests/unit/export-builders/): jeweils gegen synthetische `{ scope, book, groups }`-Fixtures. PDF: Magic-Bytes `%PDF-`. EPUB/DOCX: ZIP-Magic + Manifest-Entry. HTML: Wohlgeformtheit. TXT/MD: Normalisierung match `sync.js`#htmlToText.
- **Unit `loadContents`**: scope-Dispatch, `CHAPTER_EMPTY`/`PAGE_EMPTY`, Page-Sort.
- **Integration**: Round-Trip pro Format pro Scope gegen Mock-`content-store`.
- **E2E**: Scope-Combobox in Export-Karte rendert nur sichtbare Optionen je nach Navigation-State.
- **Tripwire**: Tests, die `fetch`/`streamExport` in `routes/export.js` erwarten, werden entfernt; neuer Tripwire prüft, dass `routes/export.js` keine `BOOKSTACK_URL`-Imports mehr enthält.

### Aufwand

3-4 Tage (Loader-Konsolidierung + 6 Builder-Module + Sync-Route-Refactor + Job-Scope + Frontend-Combobox + Test-Sweep). Doppelt so gross wie die ursprüngliche „nur-Scopes"-Variante, weil Pass-Through-Branch und drei BookStack-Renderer (PDF/HTML/TXT) durch Eigenbau ersetzt werden müssen.

---

## Phase 4c1 — First-Run-Setup-Wizard (`/setup`) — erledigt

Implementiert; siehe Erledigt-Block oben für Code-Pfade + Test. Aktuelle Invarianten:

- **Trigger**: Admin-Session ohne `app.setup_completed=true` → `toggleAdmin{Users,Settings}Card` redirected auf `/setup` (Frontend-Guard auf `setupCompleted`-Flag aus `/config`). `/setup` bleibt nach `setup_completed=true` aufrufbar — Wizard zeigt dann ersten Schritt, kein Auto-Redirect mehr.
- **Wizard-Reihenfolge**: welcome → public-url → oauth → emails → ai → backend → smtp → done. Jeder Schritt schreibt atomar; Encrypted-Felder akzeptieren leeren String (= behalten) oder Klartext (= überschreiben).
- **Banner „Setup unvollständig"**: derzeit kein Hauptansicht-Banner — Wizard-Redirect über Admin-Karten reicht. Banner kann nachgereicht werden, sobald sich konkrete Lücken-Signale (z.B. fehlender KI-Provider) als störend zeigen.
- **`auth.admin_email`** wird bei `/setup/complete` aus `process.env.ADMIN_EMAIL` gespiegelt; UI nutzt den Wert read-only (Spiegel, keine Edit-Möglichkeit über Wizard).
- **smtp-Test-Probe** ist Stub bis Phase 4c2 — antwortet `{ ok: false, error: 'MAILER_NOT_AVAILABLE' }`, sobald `lib/mailer.js` fehlt. Sobald 4c2 fertig ist, übernimmt der Mailer-Singleton den Versand.

Offene Restpunkte (nicht-blockierend):
- Banner „Setup unvollständig" in der Haupt-SPA, falls KI- oder Backend-Settings fehlen.
- Globale i18n-Keys für Banner (Wizard selbst kommt mit eigenen Inline-Strings aus).

---

## Phase 4a2 — Public Landing + Request-Register

Ziel: Frische, nicht-eingeloggte Besucher sehen eine schlichte Startseite mit „Login" und „Zugang anfordern". Heute redirected `/` direkt auf die SPA, die ohne Session sofort 401-Bouncing macht — kein öffentliches Gesicht der App. Mit 4a2 gibt es einen sauberen unauth-Einstiegspunkt + einen moderiert-offenen Registrierungspfad ohne `ALLOW_OPEN_SIGNUP=true` (das bleibt für vollautomatische Setups).

### Abhängigkeiten

- Phase 4a (`app_users`, `user_invites`, Audit, OIDC-Callback mit `?invite=…`-Param).
- Phase 4c2 (Mailer) — Admin-Benachrichtigung + Approve/Deny-Notification. Ohne Mailer: Fallback auf In-App-Inbox in `AdminUsersCard`.

### Migration N+4a2

```sql
CREATE TABLE registration_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  display_name TEXT,           -- optional, User füllt aus
  message TEXT,                -- Freitext „Warum will ich Zugang"
  ip TEXT,
  user_agent TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','denied','expired')),
  created_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT,
  reviewed_by TEXT,            -- admin-email
  review_reason TEXT,          -- bei denied optional, bei approved leer
  invite_id INTEGER,           -- gesetzt bei approval, FK auf user_invites(id)
  FOREIGN KEY (invite_id) REFERENCES user_invites(id) ON DELETE SET NULL
);
CREATE INDEX idx_reg_req_status ON registration_requests(status, created_at DESC);
-- Partial UNIQUE: nur pending-Anfragen blockieren erneuten Antrag desselben Mails.
CREATE UNIQUE INDEX idx_reg_req_pending_email
  ON registration_requests(email)
  WHERE status = 'pending';
```

Mit `foreign_key_check` am Migrations-Ende (siehe CLAUDE.md Pflicht-Block).

### Public-Routen (nicht hinter Session-Guard)

Bestehender Auth-Guard in [server.js](../server.js) hängt aktuell vor `/` — wir spalten:
- `/` → wenn eingeloggt → SPA-Shell `index.html`; wenn nicht → `landing.html`. Keine 401-Bounce mehr.
- `/landing` → immer öffentliches `landing.html` (auch eingeloggt aufrufbar, z.B. zum Ausloggen-anschauen).
- `GET /login` → Login-Page mit Buttons „Mit Google anmelden" (`/auth/google`, wenn Google-Client konfiguriert ist) und „Admin-Login" (Form `/auth/admin-login`, wenn `ADMIN_PASSWORD` gesetzt). Beide Buttons können ausgeblendet sein, wenn Voraussetzungen fehlen.
- `GET /register` → Formular: Email (Pflicht), Anzeigename (optional), Nachricht (optional, 500 Zeichen). Captcha siehe Sicherheit. Kein Passwortfeld — Login läuft immer via Google-OAuth nach Approval.
- `POST /register` `{ email, displayName?, message?, captchaToken? }` → Insert in `registration_requests`. Rate-Limit pro IP (3/Stunde via `express-rate-limit`). Mailt Admin via `registration-request-admin`-Template. Antwortet immer 202 mit derselben Erfolgsmeldung („Anfrage eingegangen — du erhältst eine Mail, sobald sie geprüft wurde"), unabhängig davon ob Email schon existiert / bereits pending ist (kein User-Enumeration-Leak).

### Public-Frontend

Drei statische HTML-Files (kein Alpine-Root nötig — minimaler Footprint, separat ausgeliefert):
- [public/landing.html](../public/landing.html) — Hero-Block: App-Name + Untertitel + zwei Buttons („Login", „Zugang anfordern"). Footer-Links nach Wunsch.
- [public/login.html](../public/login.html) — zwei Login-Buttons (Google / Admin) + Link zurück zu Landing.
- [public/register.html](../public/register.html) — Formular + Captcha-Slot + Hinweis „Wir antworten per Mail an die angegebene Adresse".

CSS via bestehendes [public/css/tokens.css](../public/css/tokens.css) (eingelagerter `<link>`-Tag), plus dünner File `public/css/landing.css` für Hero-Spezifika. Kein Service-Worker-Eingriff — Landing-Routen `Cache-Control: no-store`.

**i18n im Public-Frontend**: Locale aus `Accept-Language`-Header (`de`/`en`-Fallback `de`). Statische HTML wird durch Express-Template-Replacement (`String.replace`-Pass auf Pre-Defined-Keys) oder einfache Mini-Template-Function in [routes/public.js](../routes/public.js) gerendert. Keine schwere Templating-Engine — nur Key-Substitution.

### Admin-Workflow

`AdminUsersCard` (Phase 4a) erweitert um Tab „Anfragen":
- Liste der `pending`-Requests mit Email, Name, Message, Zeitstempel, IP.
- Pro Request zwei Aktionen:
  - **Annehmen** `POST /admin/registration-requests/:id/approve` `{ role='user' }` → erzeugt `user_invites`-Row + Token, setzt `status='approved'`, sendet `registration-approved`-Mail mit `inviteUrl = ${APP_URL}/login?invite=${token}`. Login-Page leitet `?invite`-Param an `/auth/google` weiter; OIDC-Callback liest Invite und legt `app_users`-Row beim ersten Login an (Phase 4a, Schritt 5).
  - **Ablehnen** `POST /admin/registration-requests/:id/deny` `{ reason? }` → `status='denied'`, sendet optional `registration-denied`-Mail mit Reason.
- Bulk-Aktionen: Mehrfachauswahl → batch approve/deny.
- Auto-Expire: täglicher Cron-Job markiert `pending`-Requests älter als 30 Tage als `expired` (keine Mail, nur Status).

Wenn `smtp.mode='disabled'` → Approve/Deny mailen nicht, sondern setzen `review_reason` mit Hinweis „Mailer deaktiviert — Admin muss User manuell informieren". `AdminUsersCard` zeigt dann Invite-URL inline zum Kopieren.

### Sicherheit

- **Captcha**: hCaptcha als optionale Default-Schutzschicht (`auth.captcha.{site_key,secret_key}` in `app_settings`, encrypted). Wenn nicht konfiguriert → Captcha-Feld ausgeblendet, harter Rate-Limit (3/h/IP) bleibt. Hinweis-Box in AdminSettingsCard-Auth-Tab: „Ohne Captcha könnte Register-Formular für Spam missbraucht werden."
- **User-Enumeration verhindern**: `POST /register` antwortet immer gleich — kein „Email existiert bereits". Doppel-Requests werden über Partial-UNIQUE-Index abgewiesen, aber API-Response bleibt 202.
- **HTML-Escape**: `message`-Feld geht durch Escape (siehe Mailer-Sektion) bevor es im Admin-UI oder in Admin-Mail landet.
- **IP-Logging**: kein DSGVO-Pseudonymisierungs-Aufwand — Self-Host-Pattern ([[project_self_hosted_oss]]), Verantwortung beim Betreiber, Hinweis im Datenschutz-Footer-Link der Landing-Page (Betreiber pflegt Inhalt).
- **Audit**: `user_sessions_audit`-Eintrag bei Approve mit `event='role-changed'` + `meta_json={ from: 'request', request_id: N }`.

### Tests

- Unit: Rate-Limit-Logik, User-Enumeration-Antwortgleichheit, Captcha-Bypass-Pfad bei Nicht-Konfiguration.
- Integration: `POST /register` → Admin-Mail-Versand (Stream-Transport), Approve → Invite-Erstellung + Mail.
- E2E (Playwright): Landing → Register-Formular → Confirmation. Admin-User: Anfragen-Tab → Approve → Invite-URL sichtbar.

### i18n

- `landing.{title,subtitle,login,register,footer}`.
- `login.{title,withGoogle,withAdminPassword,backToLanding,denied.notInvited,denied.suspended}`.
- `register.{title,emailLabel,nameLabel,messageLabel,submit,success,error.rateLimit,error.invalidEmail,captchaLabel}`.
- `admin.users.tab.requests`, `admin.users.requests.{empty,email,name,message,createdAt,approve,deny,expired,bulkApprove,bulkDeny,deniedReason,approvedAt,inviteUrlCopy,mailerDisabledHint}`.

### Aufwand

Mittel — 3 statische HTML-Files + Mini-i18n-Render, 1 Public-Router, neue `registration_requests`-Tabelle, neuer Tab in `AdminUsersCard`, Mail-Templates (in 4c2 schon vorgesehen), Captcha-Optional-Schicht, E2E-Tests.

---

## Phase 4d — Token-Budget + Cost-Tracking (Admin)

Ziel: Admin sieht USD-Kosten pro User/Job/Monat und konfiguriert pro User ein Monats-Budget. Bei Überschreitung wahlweise hart blocken (HTTP 429) oder weich warnen. Voraussetzung für Multi-User-Self-Host: ein einzelner User darf das Anthropic-Budget des Betreibers nicht leersaugen.

**Abhängigkeit auf 4a**: Admin-Rolle = `app_users.global_role='admin'`. 4d setzt 4a voraus (Start-Reihenfolge: 4a → 4c → 4c1 → 4d). `requireAdmin`-Middleware in [lib/admin.js](../lib/admin.js) liest ausschliesslich das DB-Flag — kein ENV-Fallback nötig, weil `app_users.global_role='admin'` zum 4d-Startzeitpunkt garantiert existiert.

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
- `tests/unit/admin-auth.test.mjs` — `requireAdmin` 403/200, Session-Flag aus `app_users.global_role='admin'`.
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

**Slug-Generierung** (neu `lib/slug.js`): `slugify(name)` = lowercase + ASCII-Folding (`ä→ae`, `ö→oe`, `ü→ue`, `ß→ss`, restliche Diacritics via `NFD`+`/\p{Diacritic}/u` strip) + `\s+` → `-` + alles ausser `[a-z0-9-]` raus + Multi-Dash collabsen + Trim auf 64 Zeichen. Dedup auf DB-Ebene: bei `UNIQUE`-Konflikt Suffix `-2`, `-3`, … bis frei. Wahrheit liegt im Konflikt-Check zur Save-Zeit, nicht im Generator. Frontend zeigt finalen Slug nach Save.

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
         snippet(search_index, 5, '<mark>', '</mark>', '…', 24) AS snippet,
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
- Snippet-Spalte: Index `5` = `body` (Spaltenfolge: `kind`, `entity_id`, `book_id`, `lang`, `title`, `body` → 0..5).
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
2. **Bulk-Copy**: pro Page/Chapter im Source → Lesen via Source-Backend → Schreiben via Target-Backend.
3. **FK-Repair**: nur richtungsabhängig nötig (siehe nächster Block).
4. **FTS-Reindex** (Phase 7) für migrierte Bücher.
5. **Cutover**: nach erfolgreichem Copy aller selektierten Bücher: `app.backend = <target>` (atomar). Source-Read-Only-Marker bleibt — falls Admin später zurück will, ist Source noch konsistent.
6. **Abort/Rollback**: Job-Cancel rollt nur die laufende Buch-Transaction zurück. Bereits migrierte Bücher bleiben. Admin sieht „N von M migriert; nicht migrierte Bücher bleiben in `<source>`."

**ID-Strategie pro Richtung** (kritisch — Plan-Default ist ID-Erhalt, NICHT Mapping):

- **`bookstack → localdb` (Primärfall, ID-erhaltend):** localdb-Tabellen übernehmen die BookStack-PKs 1:1 (Phase 0b-Invariante; AUTOINCREMENT-Wasserzeichen aus Phase 0 hält BS-Range frei). **Keine ID-Map nötig, kein FK-Repair nötig** — alle ~40 FK-Spalten zeigen weiter auf dieselben Integer-IDs. `figures.book_id`, `page_revisions.page_id`, `chat_sessions.page_id`, … bleiben gültig ohne Anpassung. Implementierung: `INSERT INTO pages (page_id, …) VALUES (?, …) ON CONFLICT(page_id) DO UPDATE`.
- **`localdb → bookstack` (Symmetrie-Pfad):** BookStack-API vergibt frische IDs beim POST (`/api/books`, `/api/chapters`, `/api/pages`). Hier ist ID-Mapping zwingend:

  ```sql
  CREATE TABLE backend_migration_idmap (
    kind          TEXT NOT NULL CHECK(kind IN ('book','chapter','page')),
    source_id     INTEGER NOT NULL,
    target_id     INTEGER NOT NULL,
    migrated_at   TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (kind, source_id)
  );
  CREATE INDEX idx_idmap_target ON backend_migration_idmap(kind, target_id);
  ```
  FK-Repair iteriert alle ~40 FK-Spalten und mapped `source_id → target_id` via Join, dann `UPDATE … WHERE source_id IN map`. Transaction pro Buch. Anschliessend `app_settings`-Bezüge prüfen (z.B. `pdf_export_profile.book_id`).

In beiden Richtungen: `foreign_key_check` am Ende der Buch-Transaction muss leer sein, sonst Rollback + Fehler-Job.

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
- **i18n-Restposten** — Phase 1 hat den Save-Pfad bereits entbookstackifiziert. Phase 9 grep't beide Locale-Files (`public/js/i18n/{de,en}.json`) erneut auf `BookStack`/`bookstack`-Strings und teilt auf: (a) backend-spezifisch (nur in `bookstack`-Mode gerendert, Frontend-Conditional auf `$app.currentBackend`), (b) generisch umformuliert, (c) tot (keine Referenz mehr im Code → entfernen). Ziel: keine BookStack-Erwähnung mehr in `localdb`-Mode-Sichten.

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

## Phase 11 — Per-User-AI-Provider-Override

Ziel: Admin weist pro User einen KI-Provider zu. Beispiel-Verteilung: User A + B auf `claude` (zahlende Kunden), User C auf `ollama` (Self-Service-Stufe), User D auf `llama` (Test). Globaler `ai.provider` aus Phase 4c bleibt Default für alle User ohne Override.

**Abhängigkeit:** Phase 4a (`app_users`), Phase 4c (`app_settings` als Quelle der Provider-Credentials). Phase 4d (Cost-Tracking) wertet den Override pro User aus, damit Budget-Abrechnung den tatsächlich genutzten Provider trifft.

### Modell

Provider-**Wahl** ist pro User; Provider-**Credentials** bleiben global in `app_settings` (`ai.claude.api_key`, `ai.ollama.host`, …). Kein Per-User-API-Key — Admin schaltet Zugang zu vorhandenen Providern frei, verteilt aber keine getrennten Keys. Variante „eigene Keys pro User" ist Future-Work (würde `ai.<provider>.api_key` in `app_users` spiegeln müssen, mit Encryption-Roundtrip).

### Migration N+11

```sql
ALTER TABLE app_users ADD COLUMN ai_provider_override TEXT
  CHECK(ai_provider_override IN ('claude','ollama','llama') OR ai_provider_override IS NULL);
```

`NULL` = User folgt globalem `ai.provider`. Nicht-NULL = User-Override gewinnt. Keine eigene Tabelle nötig — 1:1-Beziehung, kein Verlauf, kein Sub-Feld.

Bestand: alle Rows bleiben `NULL` → identisches Verhalten wie vor der Migration.

### Auflösungs-Reihenfolge

In [lib/ai.js](../lib/ai.js) `callAI(ctx, …)`:

1. `ctx.userEmail` → `app_users.ai_provider_override`.
2. Fallback: `app_settings.ai.provider`.
3. Hardcoded Default (`'claude'`).

`ctx.userEmail` muss bis in jeden `callAI`-Aufrufpfad durchgereicht werden. Worker-Pfad: `job.userEmail` ist in [routes/jobs/shared/queue.js](../routes/jobs/shared/queue.js) bereits im ALS-Context — als `userEmail` aus dem Context lesen, nicht durch jeden Funktionsparameter neu fädeln. SSE-Routes (Seiten-Chat) lesen `req.session.email`.

**`MODEL_TOKEN`/`MODEL_CONTEXT`-Implikation:** Provider-Wechsel ändert Kontextfenster (Claude 200k, lokale Modelle 32k–128k). `INPUT_BUDGET_TOKENS`-Berechnung in [lib/ai.js](../lib/ai.js) muss **pro Call** vom resolvten Provider abhängen, nicht vom Boot-Default. Konsequenz: `SINGLE_PASS_LIMIT`/`PER_CHUNK_LIMIT` (heute Module-Konstanten in [routes/jobs/shared.js](../routes/jobs/shared.js)) werden pro Job-Run aus `aiClient.contextWindow` neu berechnet. Cache-Keys (`chapter_extract_cache`, `book_extract_cache`) bekommen `provider` als zusätzliches Feld — sonst liefert Claude-Cache an Ollama-User stale Chunks anderer Granularität zurück.

### Admin-UI — Erweiterung `AdminUsersCard`

- Spalte „Provider" in der User-Tabelle. Combobox: `(Global: claude)` | `claude` | `ollama` | `llama`. Auswahl `(Global)` setzt `ai_provider_override = NULL`.
- `PUT /admin/users/:email` ([routes/admin-users.js](../routes/admin-users.js), aus Phase 4a) akzeptiert zusätzliches Feld `ai_provider_override` (Admin-only).
- Anzeige des effektiven Providers für jeden User (resolved value), nicht nur des Overrides, damit Admin auf einen Blick sieht, „wer läuft auf was". Spalten-Format: `claude (Global)` für Default-Follower, `ollama (Override)` für Override-User.
- Validierung: Combobox-Optionen werden serverseitig aus den **konfigurierten** Providern berechnet — wenn `ai.ollama.host` leer ist, wird `ollama` in der UI mit „nicht konfiguriert" disabled. Vermeidet Override auf einen Provider, der für keinen User funktionieren würde.

### Self-Service — bewusst nein

Kein User-sichtbares Self-Service-Override in [routes/usersettings.js](../routes/usersettings.js) / `userSettingsCard`. Grund: Cost-Verteilung gehört zum Admin-Kontrakt mit dem User („du bist auf Plan X"). Eigenmächtiges Hochstufen auf `claude` durch den User würde Phase 4d-Budgets unterlaufen. Admin behält Hoheit.

`GET /me` liefert den resolvten Provider aber **read-only** mit (`{ … aiProvider: 'claude' }`), damit Frontend in der Statuszeile / Card-Footern korrekt anzeigen kann „Antwortet via Claude" — wichtig für User-Erwartung an Latenz.

### Hot-Reload

KI-Client-Instanzen werden bisher pro Server-Boot einmal aus `app_settings.ai.*` aufgebaut und auf `app-settings:changed`-Event rebuilt (Phase 4c). Mit Per-User-Override muss der Aufbau **pro Request/Job** den User berücksichtigen. Variante A: pro Provider ein Singleton (`claudeClient`, `ollamaClient`, `llamaClient`), `callAI` wählt nach resolvtem Provider. Variante B: pro Call ad-hoc bauen. **Variante A**, sonst kostet jede Klein-Inferenz Setup-Roundtrip.

Singletons hängen weiterhin am `app-settings:changed`-Event und bauen sich auf Credential-Wechsel komplett neu. Per-User-Override-Wechsel triggert kein Rebuild — nur die Routing-Tabelle ändert sich, die Clients bleiben warm.

### Mutex / VRAM-Schutz

Ollama/Llama serialisieren heute global über einen Mutex (CLAUDE.md „KI-Provider" Tabelle). Bleibt: Mutex ist providerspezifisch, nicht userspezifisch. Wenn drei User auf `ollama` zugewiesen sind und alle gleichzeitig einen Job starten, läuft trotzdem nur einer — VRAM verträgt keine Parallelität. Admin muss die Verteilung wissen (UI-Hinweis im Provider-Tab: „Lokale Provider serialisieren Job-Pipeline").

### Cost-Tracking (Phase 4d-Integration)

[lib/cost-tracker.js](../lib/cost-tracker.js) aus Phase 4d liest Pricing pro Provider. Per-User-Override fliesst in die Kalkulation automatisch ein, weil `callAI` den resolvten Provider zurückgibt und `recordTokenUsage(provider, …)` das in `token_usage.provider` schreibt (existiert bereits oder muss in Phase 4d ergänzt werden — bei Phase-11-Implementierung gegen 4d-Schema prüfen). Admin-Dashboard zeigt Kosten pro User korrekt aufgeschlüsselt, ohne dass Phase 11 separates Reporting bauen muss.

### i18n

`admin.users.aiProvider`, `admin.users.aiProvider.global`, `admin.users.aiProvider.notConfigured`, `admin.users.aiProvider.effective` (`{provider} ({source})`-Pattern, `source` = `global|override`). Frontend-Statuszeile: `chat.providerHint` (`Antwortet via {provider}`).

### Tests

- **Unit:** `tests/unit/ai-resolve.test.mjs` — Auflösungs-Reihenfolge (Override > Global > Default), inkl. NULL-Fallback und ungültiger Override-Wert (CHECK fängt; defensiv testen, dass `callAI` bei manuell injizierten Bad-Daten nicht crasht, sondern auf Default zurückfällt).
- **Unit:** `tests/unit/context-budget-per-provider.test.mjs` — `INPUT_BUDGET_TOKENS` skaliert mit Provider-Wechsel; Cache-Key enthält Provider.
- **Integration:** `tests/integration/per-user-provider.test.js` — Drei Mock-User mit unterschiedlichen Overrides, Job-Run, Assert auf richtigen Mock-AI-Endpoint.
- **E2E:** Smoke gegen `AdminUsersCard`-Combobox (Override setzen, `GET /me` als Ziel-User reflektiert Wechsel).

### Risiko / Edge-Cases

- **Override auf nicht-konfigurierten Provider:** Admin setzt `ollama` ohne `ai.ollama.host`. Erste Inferenz schlägt fehl, User sieht generischen Fehler. **Gegenmittel**: PUT-Route lehnt Override mit 400 ab, wenn Ziel-Provider keine Credentials in `app_settings` hat. UI-Combobox bereits disabled, aber API-Guard als zweite Schutzschicht.
- **In-Flight-Jobs beim Override-Wechsel:** Admin ändert User-Override während ein Job läuft. Job hält den alten Client-Singleton via Closure → läuft mit altem Provider zu Ende. Akzeptabel (analog zur Phase-4c-`app-settings:changed`-Race).
- **Buch-Owner ≠ Job-Starter (Phase 4b Sharing):** Lektor B startet Job auf Buch von Owner A. Welcher Provider zählt? **Antwort: Provider des Job-Starters** (Lektor B), nicht des Buch-Owners. Cost-Tracking läuft auf den User, der den Call ausgelöst hat — Phase 4d-Budget gehört zu B, nicht zu A.
- **Cache-Vergiftung:** Cache-Keys ohne Provider würden Claude-Output an Ollama-User ausliefern (oder umgekehrt) — Schema wäre dasselbe, Stil-/Qualität nicht. `provider`-Spalte in den Caches (`chapter_extract_cache`, `book_extract_cache`, `chapter_review_cache`, `book_review_cache`, `chapter_macro_review_cache`, `synonym_cache`, `lektorat_cache`) **Pflicht** mit dieser Migration. Migration N+11 also nicht nur `ALTER TABLE app_users`, sondern auch `ALTER TABLE <cache> ADD COLUMN provider TEXT` für jede Cache-Tabelle, plus angepasste UNIQUE-Indexe.

### Doku-Update

- [docs/erd.md](erd.md) — `ai_provider_override`-Spalte in `app_users`-Block, Stand-Zeile bumpen, `provider`-Spalten in den Cache-Blöcken.
- [docs/ai-providers.md](ai-providers.md) — Auflösungs-Reihenfolge, Pro-User-Override-Verhalten, Cache-Key-Erweiterung.
- [CLAUDE.md](../CLAUDE.md) — KI-Provider-Block um Per-User-Override-Hinweis ergänzen (kurz, Verweis auf `ai-providers.md`).

**Aufwand:** ~1.5–2 Tage. Risiko: niedrig–mittel — Cache-Key-Erweiterung ist die einzige Bestandsdaten-relevante Stelle (bestehende Cache-Einträge bekommen `provider = ai.provider`-Default im Backfill, Stand bleibt valide).

---

## Risiken / offene Fragen

- **Lektor-Apply-Range-Drift**: Lektorat-Findings haben Positionen im damaligen Body. Primärer Schutz ist der **Page-Lock** während der Lektorat-Session (siehe Phase 4b „Page-Lock während Lektorat-Session") — solange der Lektor die Findings-Card offen hat, lehnen Free-Edit-Routen mit `423 Locked` ab, also kann kein paralleler Editor-Save die Range-Positionen verschieben. Fallback bleibt der `updatedAt`-Staleness-Check (CLAUDE.md-Regel „Job-Ergebnisse mit `updatedAt`-Staleness-Check") für Edge-Cases: Lock abgelaufen (User 30 min weg), Owner-Override hat den Lock gebrochen, oder Edit kam vor dem Acquire. In dem Fall lehnt die Apply-Route mit 409 ab, wenn `pages.updated_at` vom Snapshot des Findings differiert.
- **Viewer-Lean-Endpoint**: separater `?lean=true`-Pfad für Buchliste/Overview vermeidet, dass Viewer-Frontend versehentlich Analyse-Daten lädt (Token-Verbrauch via Lazy-Refresh, Privacy bei „Was lektoriert hat KI?"). Alternativ: Server liefert für `viewer` per default lean, ohne Param. Letzteres robuster, Konsequenz: Tile-Layout muss leere Slots verkraften.
- **Lektor + Buch-Chat**: Buch-Chat ist heute Analyse-Werkzeug ohne Schreibwirkung. Default `nein` (Token-Kosten-Vermeidung), Owner kann pro Buch via `BookSettings.allow_lektor_book_chat` freischalten — siehe Fussnote `¹` der Phase 4b-Permissions-Matrix.
- **`can_invite_users` ohne Buch-Share**: User mit Invite-Recht aber ohne aktuelle Buch-Rolle (z.B. Ex-Mitarbeiter, deren Share widerrufen wurde, behalten Invite-Flag) sehen nichts in der App. Nicht falsch, aber UX-Hinweis nötig.
- **Owner-Transfer-Workflow**: Auto-Accept oder zweistufig (neuer Owner bestätigt)? Solo-Tenant heute: Auto-Accept reicht.
- **Email-Versand**: Invites + Ownership-Transfer brauchen SMTP, sonst Token-Copy-Workflow. Akzeptabel als MVP, später ausbaubar.
- **Feature-Parität zwischen Backends**: Jedes neue Feature muss in beiden Backends laufen. Risiko: jemand baut etwas localdb-only und vergisst BS-Backend. **Gegenmittel**: Content-Store-Vertrag (Vor-Phase Schritt 4) + Tripwire (Schritt 6) — `bsGet`/`bsPut` ausserhalb `lib/content-store/backends/bookstack.js` schlägt im CI-Grep fehl. Neue Feature-PR ohne Test gegen beide Backends wird im Review abgelehnt.
- **BS-Eigene Edits ausserhalb der App**: Wer im `bookstack`-Mode parallel via BookStack-UI editiert, umgeht App-Revisions, FTS-Index und Page-Lock. Sync-Worker fängt es zwar ein (kein Datenverlust), aber Lektor/Editor-Apply kann auf veraltetem Body operieren. **Empfehlung**: App-Doku rät dringend zu „BookStack-UI nicht parallel benutzen, ausser zum Lesen". Kein technischer Lock möglich, weil BS-UI ein eigenständiger Stack ist.
- **Backend-Migration mit Jobs in Flight**: Wenn während Phase-8-Migration ein KI-Job läuft, der gerade `loadPage(old_id)` aufgerufen hat und später `savePage(old_id)` versucht: bei `localdb → bookstack` ist `old_id` via ID-Map auf `new_id` umgemapt; bei `bookstack → localdb` ist die ID identisch, aber der Source-Read-Only-Marker blockiert den Save. **Gegenmittel**: Migration startet erst, wenn Job-Queue für betroffene Bücher leer ist (Pre-Check); während Migration werden neue Jobs für migrierende Bücher abgelehnt (423 Locked).
- **Hot-Reload-Race bei Provider-/Backend-Switch (Phase 4c)**: `app-settings:changed`-Event rebuilt KI-Client- und Content-Store-Singletons. Laufender Job hält evtl. eine Referenz auf den alten Client (Promise mit captured `aiClient`). Re-Try nach Switch könnte mit altem Key/Backend zurückkommen. **Gegenmittel**: Provider-/Backend-Switch verlangt entweder leere Job-Queue (Pre-Check, analog Phase 8) oder Admin akzeptiert Warn-Modal „N laufende Jobs schliessen mit altem Provider ab". Verdrahtung in [routes/admin-settings.js](../routes/admin-settings.js) per Pre-Save-Guard.
- **CI-Pipeline gegen beide Backends**: Integration-Tests müssen pro Job-Typ je einmal gegen Mock-BookStack (`tests/integration/_helpers/mock-bookstack.js`) **und** In-Memory-SQLite-localdb laufen. Pflicht-Convention: jeder Job-Test bekommt `for (const backend of ['bookstack','localdb'])`-Loop, sonst rutscht Backend-Drift durch Review (zusammen mit Tripwire-Grep aus Vor-Phase).
- **Privacy bei Logs**: Winston-Logs enthalten `user_email`. Bleibt — Self-Hosted, Betreiber sieht Logs sowieso.
- **Audit-Tabelle vs. DSGVO**: bei Hard-Delete-Request müsste `user_sessions_audit` ebenfalls anonymisiert werden. Heute irrelevant (Solo-Self-Hosted), aber Schema-Spalte für Pseudonymisierung offen halten.

---

## Aufwand grob

| Phase | Aufwand | Risiko |
|---|---|---|
| 0b | 0.5-1 Tag | niedrig (3 Frontend-Trigger an das Backend anbinden, kein neuer Code) |
| 1 | 4-6 Tage | mittel (Backend-Disjunktion, Test-Pflege gegen beide) |
| 2 | 2-3 Tage | niedrig |
| 3 | 2-3 Tage | niedrig |
| 4b | 4-5 Tage | mittel (Rollen-Matrix + Apply-Routen + minRole-Filter) |
| 4b1 | 0.5-1 Tag | niedrig (Print-CSS + readOnly-Guard, keine neuen Tabellen) |
| 4b2 ✓ | 3-4 Tage | erledigt |
| 4c1 | 1-2 Tage | niedrig (eigenständige Wizard-Page, kleines Form-State-Modell) |
| 5 | — | ENTFÄLLT |
| 6 | 2-3 Tage | niedrig |
| 7 | 4-6 Tage | mittel (FTS5-Schema + Sync-Hooks + UI) |
| 8 | 4-6 Tage | mittel-hoch (Bulk-Copy + FK-Repair + ID-Map + Round-Trip-Tests) |
| 9 | 1-2 Tage | niedrig (Doku-Sweep) |
| 10 | 1-2 Tage | mittel (Diff-Test gegen Bestand) |
| 11 | 1.5-2 Tage | niedrig-mittel (Cache-Key-Migration, Per-Call-Provider-Resolve) |

**Nett-Summe nach Tagen** ≈ 40-55 Vollzeit-Tage Coding. Realistische Wand-Zeit deutlich höher:

- Test-Sweep pro Phase (Unit + Integration gegen **beide** Backends + E2E + i18n-Doppelpflege + ERD-Update) ist im Tages-Wert je Phase **nicht** voll abgebildet.
- Bugfix-Wellen nach Merge (besonders 4a/4b/4c → User-sichtbarer Flow), Bestandsdaten-Migrations-Fixes, CLAUDE.md-Anpassungen.
- Schedule-Friction: bei Solo-Dev als Nebenprojekt ohne Vollzeit-Fokus.

**Realistischer Rahmen:** 3-4 Monate Wand-Zeit für Vollumsetzung Phase 0 → 10, falls nebenher laufendes Geschäft besteht. Bei 4-5h Coding-Tagen + Test-Disziplin liegt der Median näher an Quartal-Ende als an Acht-Wochen-Sprint. Gegenüber alter „Kill"-Variante gespart: Phase 5 (Dual-Write) + Editor-Wechsel; gegenüber Original-Plan zusätzlich ~4 Tage durch 4b1-Skalierung (E-Reader → Print-CSS).

**Empfehlung:** Erste Milestones nach 0/0b/0c/0d + 4a + 4c + 4c1 schneiden — danach Re-Estimate, weil dann Test-Discipline + Bugfix-Last echt messbar sind. ACL- und FTS-Phasen kommen sonst auf Annahmen-Basis ins Schätzraster.
