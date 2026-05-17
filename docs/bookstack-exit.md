# Storage-Backend-Pluralisierung — offene Arbeit

Storage-Backend ist Admin-konfigurierbar. Zwei gleichwertige First-Class-Backends:

- **`localdb`** (Default für Neu-Installationen): Pages/Chapters/Order/Body in lokaler SQLite-DB. Eigene Persistenz, eigene Revisionen, eigene Suche.
- **`bookstack`** (für bestehende Deployments + alle, die BookStack-UI parallel weiter nutzen wollen): Pages/Chapters/Body in BookStack. App-DB bleibt Cache.

Admin wählt global via `app.backend` in `app_settings`. Wechsel ist Bulk-Copy-Job (Phase 8), kein Runtime-Hot-Swap. Kein Dual-Write. Inhaltliche Features (User-Mgmt, ACL, Reader-View, Revisions, Tags, FTS) gelten für beide Backends, sind backend-agnostisch durch die Content-Store-Facade.

Editor + WYSIWYG ändern sich nicht: App nutzt eigenen CodeMirror-basierten Editor, Body bleibt HTML. BookStack-TinyMCE-Iframe wird nie eingebunden.

Diese Datei beschreibt die Multi-Backend-Architektur als Plan — bewusste Ausnahme zur CLAUDE.md-Doku-Stil-Regel. Sobald eine Phase live ist, gehört der dauerhafte Teil davon in CLAUDE.md / passende `docs/`-Spickzettel; hier verschwindet sie.

---

## Leitplanken

### Privacy-Boundary

- **Admin sieht keine Bücher.** Admin-Rolle ist auf User-Verwaltung + globale App-Konfiguration beschränkt.
- **Buch-Zugriff nur via `book_access`-Row.** Admin bekommt *keine* Auto-Rows. Will Admin Bücher sehen, braucht es einen zweiten User-Account mit `global_role='user'` und expliziten Share.
- **`global_role` und `book_access` sind orthogonal.** Kein Cross-Effekt.
- **Buchliste-Endpoints filtern strikt** über `book_access`. Admin-Aufrufe sehen leere Liste, wenn keine Share-Row existiert.

### UI-Patterns

Jede neue Karte/Komponente in offenen Phasen respektiert [DESIGN.md](../DESIGN.md). Vor neuer UI: Pattern-Katalog prüfen, wiederverwenden statt parallel neu erfinden. Existiert Pattern nicht: erst in `DESIGN.md` dokumentieren (Markup + CSS + Use-Case), dann verwenden. Gilt auch für `AdminBackendMigrationCard` (Phase 8), `SearchCard` (Phase 7), Tag-/Kategorie-UI (Phase 6), `page-history-card`-Umstellung (Phase 2).

### Was BookStack heute noch liefert

Im `bookstack`-Mode weiterhin aus BookStack: Storage-Hierarchie + Body-HTML, native Page-Revisions (durch Phase 2 ersetzt), Drafts, Tags (durch Phase 6 ersetzt), WYSIWYG (App nutzt CodeMirror — irrelevant), Volltextsuche (durch Phase 7 ersetzt). User-DB und Auth laufen schon eigenständig via Google-OIDC; Export läuft schon eigenständig via Phase-4b2-Builder.

Bewusst out-of-scope: Attachments, Shelves, Templates.

---

## Architektur-Invarianten

`books`/`chapters`/`pages` sind `INTEGER PRIMARY KEY AUTOINCREMENT` mit `sqlite_sequence`-Wasserzeichen `≥ 1_000_000`:

- **Bestandsrows** behalten ihre BookStack-IDs (`<100k` typisch). Alle ~40 FK-Spalten bleiben gültig.
- **Neue `localdb`-Items** kriegen IDs `≥ 1_000_001`. Klare Trennung vom BookStack-Range — Phase-8-Switch bleibt konfliktfrei.
- **Gelöschte IDs** werden nicht wiederverwendet (AUTOINCREMENT-Garantie).
- **Sentinel `book_id = 0`** (User-Default-PDF-Profile) bleibt safe.

Phase-0-Spalten im aktuellen Schema:

- `pages`: `body_html`, `body_markdown`, `position`, `priority`, `slug`, `local_updated_at`, `remote_updated_at`, `dirty` (NOT NULL DEFAULT 0). FK `chapter_id → chapters(chapter_id) ON DELETE SET NULL`. Index `idx_pages_dirty WHERE dirty = 1` für Sync-Pull.
- `chapters`: `position`, `priority`, `slug`, `description`. FK `book_id → books(book_id) ON DELETE CASCADE`.
- `books`: `description`, `cover_image BLOB`, `owner_email`. Index `idx_books_owner_email` für ACL-Filter.

`dirty` + `remote_updated_at` = Konflikterkennung beim BookStack-Sync-Pull (Phase 1).

---

## Offene Phasen (Reihenfolge)

`8b (localdb → bookstack) → 10`.

Erledigt: Phase 1 (`localdb`-Backend) + Phase 2 (Page-Revisions) + Phase 3 (Eigene Sortierung) + Phase 6 (Tags + Kategorien) + Phase 7 (FTS5-Volltextsuche) + Phase 8a (bookstack → localdb) + Phase 9 (Doku-Sweep) + Phase 11 (Per-User-AI-Provider-Override) — siehe Code-Pfade in den jeweiligen Abschnitten.

---

## Phase 1 — `localdb`-Backend (erledigt)

Implementiert; Code-Pfade:

**Architektur** ([lib/content-store/](../lib/content-store/)):

```
lib/content-store/
  ├─ index.js              Facade — dispatcht via app_settings.app.backend
  └─ backends/
     ├─ bookstack.js       BookStack-API-Aufrufe + Token-Resolver
     └─ localdb.js         Lokale SQLite-Tabellen (books/chapters/pages)
```

- **Dispatcher** ([lib/content-store/index.js](../lib/content-store/index.js)): liest `app.backend` per-Call aus `app_settings`. Default `bookstack` für Bestandsdeployments. Hot-Reload via `app-settings:changed`-Event ohne Restart. Konsumenten importieren weiter `require('../lib/content-store')`.
- **Bookstack-Backend** ([lib/content-store/backends/bookstack.js](../lib/content-store/backends/bookstack.js)): `bsGet`/`bsPut`/`bsGetAll`-Calls + Token-Resolver. Tripwire-Allowlist aktualisiert.
- **Localdb-Backend** ([lib/content-store/backends/localdb.js](../lib/content-store/backends/localdb.js)): vollständiger Vertrag gegen SQLite. CRUD auf books/chapters/pages, bookTree mit JOIN, searchPages LIKE-Fallback (bis Phase 7 FTS5 kommt). IDs aus `sqlite_sequence` (≥ 1_000_001 dank Phase-0-Wasserzeichen). `savePage` setzt `local_updated_at` + `dirty=0`. `NOT_FOUND`-Errors mit `code` + `status: 404`.
- **Sync-Worker** ([routes/sync.js](../routes/sync.js)): backend-agnostisch. `syncBook(bookId, ctx)` liest via Content-Store-Facade — im `bookstack`-Mode mit Per-User-Token-ctx (`getAllUserTokens`-Loop in `_syncAllBooksInner`), im `localdb`-Mode mit `ctx=null` und Buch-Enumeration direkt aus `books`-Tabelle. `_isBookstackBackend()` schaltet nur die Branch im inneren Loop; alle Routen (`POST /sync/book/:book_id`, `POST /sync/pages/:book_id`, `POST /sync/page-stats/:book_id`) fordern Token nur im `bookstack`-Mode. Befüllt in beiden Modes: `page_stats` (inkl. Style-Metriken `sentences`/`dialog_chars`/`filler_count`/`passive_count`/`adverb_count`/`pronoun_counts`/`lix`/`flesch_de`), `page_figure_mentions`, `book_stats_history`-Tagessnapshot. Cron-Tick 02:00 in [server.js](../server.js) unverändert.
- **Tripwire** ([tests/unit/content-store-tripwire.test.mjs](../tests/unit/content-store-tripwire.test.mjs)): `bs*`-Calls + `BOOKSTACK_URL`-Referenzen nur in `lib/bookstack.js` + `lib/content-store/backends/bookstack.js` + `routes/sync.js` + `routes/jobs/shared/bookstack.js` + `routes/proxies.js` + `lib/pdf-render/images.js`.

### ACL-Mirror nach Backfill

Backfill ([db/backfill.js](../db/backfill.js)) setzt `books.owner_email` und legt im selben Transaction-Block per `INSERT OR IGNORE` eine `book_access(role='owner', granted_by='backfill')`-Row an — ohne Privilege-Escalation fuer bestehende Sharings. Migration 118 spiegelt zusaetzlich `books.owner_email → book_access` retro fuer alle Buecher, deren Owner in `app_users` existiert (Backfill-Buecher aus dem Zeitraum vor diesem Fix). Buecher mit Owner-Email ohne `app_users`-Eintrag bleiben ownerless — Admin weist ueber [routes/admin-books.js](../routes/admin-books.js) (`POST /admin/books/:id/assign-owner`) plus `AdminBooksCard` ([public/js/cards/admin-books-card.js](../public/js/cards/admin-books-card.js) + [public/partials/admin-books.html](../public/partials/admin-books.html)) einen aktiven User zu. Tile in [admin-home.html](../public/partials/admin-home.html); Hash `#admin/books`; Reassignment bestehender Owner laeuft weiter ueber `/books/:id/transfer-ownership`.

### Devmode-Seed ([lib/dev-seed.js](../lib/dev-seed.js))

Auto-Seed bei `LOCAL_DEV_MODE=true` + `LOCAL_DEV_SEED!=false` + `app.backend='localdb'` + leerer `books`-Tabelle. 4 Guards alle Pflicht. Inhalt: 1 Buch (`'Devmode-Testbuch'`, `owner_email='dev@local'`) + 2 Kapitel + 5 Pages mit Kafka-„Verwandlung"-Public-Domain-Prosa. IDs ≥ 1_000_001. Hook in [server.js](../server.js) nach `bootstrapFromEnv()`. Test: [tests/unit/dev-seed.test.mjs](../tests/unit/dev-seed.test.mjs).

### i18n-Sweep für backend-agnostische Save-Strings

In beiden Locales angepasst:
- `bs.savingToBookStack` → "Speichere…" / "Saving…"
- `editor.savedTitle` → "Gespeichert" / "Saved"
- `chat.changeSaved` → "Änderung gespeichert." / "Change saved."
- `tree.connecting` → "Lade Buchliste…" / "Loading book list…"

**Offen — Folge-Sweep für backend-spezifische Strings**: `book.openInBookstack`, `editor.openInBookstack`, `editor.revisionsTitle`, `bs.timeoutGet`/`bs.timeoutPut`/`bs.apiError*`, `session.bookstackTokenInvalid`, `tokenSetup.*`, `profile.bookstackToken`, `error.NO_BOOKSTACK_TOKEN`/`error.BOOKSTACK_UNAUTHED`/`error.BOOKSTACK_UNREACHABLE`, `job.error.noBookstackToken`/`job.error.bookstack*`, `palette.action.token` bleiben — werden in Phase 9 (Multi-Backend-Sweep) backend-conditional (`$app.currentBackend === 'bookstack'`). Server-Status-Keys (`'job.phase.savingToBookStack'`) existieren derzeit keine; bei Bedarf bei Phase 9 mit aufnehmen.

### Tests
- [tests/integration/content-store-localdb.test.js](../tests/integration/content-store-localdb.test.js): 9 Cases — Domain-Shape, savePage-dirty-Reset, createPage-Wasserzeichen, bookTree-Gruppierung, searchPages-LIKE, deletePage NOT_FOUND, loadPagesBatch ohne Token.
- [tests/integration/backfill-sweep.test.js](../tests/integration/backfill-sweep.test.js): Auto-Sweep bei `app.backend`-Wechsel (Phase 0b).

---

## Phase 2 — Eigene Page-Revisions (erledigt)

Implementiert; Code-Pfade:

- **Migration 112** ([db/migrations.js](../db/migrations.js)): `page_revisions` mit FK auf `pages(page_id)` ON DELETE CASCADE + `books(book_id)` ON DELETE CASCADE. CHECK auf `source IN ('focus','main','chat-apply','lektorat-apply','bookstack-sync','import','conflict')`. Indexe `idx_page_revisions_page`/`idx_page_revisions_book`.
- **DB-Helper** ([db/page-revisions.js](../db/page-revisions.js)): `insert/listForPage/get/countForPage/pruneOverLimit` + `VALID_SOURCES`-Set.
- **Schreib-Chokepoint** ([lib/content-store/index.js#savePage](../lib/content-store/index.js)): nach Backend-PUT bei `body.html`-Save Revision schreiben. `source` aus `body.source` (Default `'main'`), `summary` aus `body.summary` (max 500 Zeichen). Reine Rename-/Reorder-Saves erzeugen keine Revision. Backend-agnostisch — beide Backends durchlaufen denselben Pfad.
- **Routen** ([routes/content.js](../routes/content.js)): `GET /content/pages/:id/revisions` (viewer), `GET /content/pages/:id/revisions/:rev_id` (viewer, voller Body), `POST /content/pages/:id/revisions/:rev_id/restore` (editor + Page-Lock-Check).
- **Setting**: `app.page_revision_limit` (Default `50`, Range 10..500).
- **Retention** ([lib/cache-cleanup.js](../lib/cache-cleanup.js)): POLICIES-Eintrag `{ table: 'page_revisions', kind: 'per-page-limit', setting: 'app.page_revision_limit' }`. Cron 02:00 ruft `pruneOverLimit(limit)` — Single-Statement-DELETE mit `ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY created_at DESC)`. `app-settings` + `page-revisions` werden lazy-importiert (Test-Schema-Kompatibilität).
- **Frontend** ([public/js/cards/page-revisions-card.js](../public/js/cards/page-revisions-card.js) + [public/partials/page-revisions.html](../public/partials/page-revisions.html)): Versionsliste unter dem Editor mit Restore-Button. Collapsible via `.collapsible-toggle` + `.history-chevron`-Pattern. CSS in [public/css/tree-history.css](../public/css/tree-history.css) `.page-revisions-bar`/`-list`. Reload-Hook via Custom-Event `page-revisions:changed`.
- **Viewer** ([public/partials/page-revisions.html](../public/partials/page-revisions.html) `<dialog class="revision-viewer">` + [public/css/page-revision-viewer.css](../public/css/page-revision-viewer.css)): Klick auf Revisionszeile oeffnet natives `<dialog>` mit Tabs `Inhalt | Vergleich`. Inhalt rendert `body_html` ueber `page-content-view`. Vergleich nutzt Word-Level-Diff gegen die aktuelle Page (`originalHtml`); Diff-Lib `Diff` (jsdiff 9.0.0) wird lazy via [public/js/lazy-libs.js#loadDiff](../public/js/lazy-libs.js) aus `vendor/diff-9.0.0.min.js` nachgeladen. Reiner Renderer in [public/js/page-revision-diff.js](../public/js/page-revision-diff.js) (pure-function, dependency-injectable diffLib). Restore-Aktion liegt im Viewer-Footer; Liste behaelt zusaetzlich einen schnellen Restore-Button mit `@click.stop` pro Zeile.
- **i18n**: `editor.revisions.{count,chars,restore,restoring,restoreTitle,restored,restoreFailed,restoreConfirm}` + 7 `editor.revisions.source.*`-Labels + 9 `editor.revisions.viewer.*`-Labels (Open/Close/Tabs/Loading/NoChanges/Restore) — de + en.
- **Tests**: [tests/unit/page-revisions-cleanup.test.mjs](../tests/unit/page-revisions-cleanup.test.mjs) — Pruning pro page_id, leere Tabelle, invalides Setting → Error-Path. [tests/unit/page-revision-diff.test.mjs](../tests/unit/page-revision-diff.test.mjs) — `htmlToPlainText`-Normalisierung + Word-Diff-Rendering (add/del/eq, unchanged, escHtml-Sicherheit, fehlende Lib wirft).

---

## Phase 3 — Eigene Sortierung (Kapitel + Seiten) (erledigt)

Implementiert; Code-Pfade:

- **Migration 114** ([db/migrations.js](../db/migrations.js)): `book_order` mit `book_id PRIMARY KEY REFERENCES books(book_id) ON DELETE CASCADE`, `order_json TEXT NOT NULL`, `updated_at`, `updated_by`.
- **DB-Helper** ([db/book-order.js](../db/book-order.js)): `validateTree`/`materializeTree`/`getOrder`/`putOrder`/`buildFromCurrentState`/`reconcile`/`ensureTree` + `TreeValidationError` mit `status: 400`. `putOrder` validiert + materialisiert + persistiert in einer Transaction; `ensureTree` initialisiert aus aktuellen `chapters.position`/`pages.position` (Auto-Init bei erstem Read) und reconciliert neue/geloeschte Items vor jedem Read.
- **Routen** ([routes/content.js](../routes/content.js)): `GET /content/books/:id/order` (viewer-ACL) + `PUT /content/books/:id/order` (editor-ACL) mit `{ order_json: [...] }`. Validierungs-Fehler werden als `400 { error_code: 'INVALID_TREE', reason, detail }` zurueckgegeben.
- **Facade-Overlay** ([lib/content-store/index.js](../lib/content-store/index.js)): `bookTree` ruft Backend, ordnet das Ergebnis dann nach `book_order.ensureTree`. Beide Backends (localdb + bookstack) profitieren, ohne dass das Backend Order-Kenntnis braucht. `_applyOrder` filtert raw chapters/topPages durch den gespeicherten Tree.
- **Frontend-Repo** ([public/js/repo/content.js](../public/js/repo/content.js)): `loadOrder(id)` + `saveOrder(id, tree)` mit CONTENT_CACHE-Invalidation auf `books/:id/order` + `books/:id/tree`.
- **Frontend** ([public/js/cards/book-organizer-card.js](../public/js/cards/book-organizer-card.js)): `_buildTreeFromWorkstate()` baut Tree aus `workTree` + `soloPages`. `_persistOrder()` ersetzt die per-Item-Renumber-Loops — ein einziges PUT, keine N+M HTTP-Calls bei Reorder. `_mirrorChapterOrderInRoot`/`_mirrorPageMembershipInRoot` synchronisieren root.tree/root.pages in-place.
- **Hierarchie-Invarianten** (Server): genau zwei Ebenen (Buch -> Kapitel|Seite -> Seite); `type` + `id` Pflicht; IDs gehoeren zum Buch; Vollstaendigkeit (alle Chapter+Pages des Buches genau einmal); keine `children` an Seiten; keine verschachtelten Kapitel.
- **Materialisierung** (Spalten `chapters.position`, `pages.position`, `pages.chapter_id`): 0-basiert, pro Bucket lueckenlos. Wird nur fuer Querys/JOINs (Filter, Sort in figures/locations/jobs) benoetigt; SSoT bleibt `order_json`.
- **Konflikt mit Replica-Pull** (`bookstack`-Mode): Sync-Pull synct Body + Metadaten, nicht Order. `ensureTree` reconciliert in BookStack neu hinzugefuegte Pages/Chapters an das Ende des Trees an. Auf BookStack-UI vorgenommene Reorder werden ignoriert.

**Tests:** [tests/integration/book-order.test.js](../tests/integration/book-order.test.js) — Validator (vollstaendiger Baum, Doppel-Page, fehlende Page, unbekannte ID, verschachteltes Kapitel), Materializer (chapters/pages position + chapter_id), `putOrder` (order_json + updated_by), `ensureTree` (Initial-Fill + Reconcile), Facade-Overlay (bookTree liest order_json).

---

## Phase 6 — Tags + Kategorien (erledigt)

Implementiert; Code-Pfade:

- **Migration 115** ([db/migrations.js](../db/migrations.js)): `book_categories` (hierarchisch via `parent_id` ON DELETE SET NULL, UNIQUE slug), `book_tags` (flach, UNIQUE name + UNIQUE slug), `book_tag_assignments` (M:N-Bridge, PK `(book_id, tag_id)`, ON DELETE CASCADE auf beiden Seiten), `books.category_id` (FK ON DELETE SET NULL). Indexe `idx_book_categories_parent`, `idx_books_category`, `idx_bta_tag`.
- **Slug-Helper** ([lib/slug.js](../lib/slug.js)): `slugify(name)` (lowercase + Umlaut-Folding `ä→ae`/`ö→oe`/`ü→ue`/`ß→ss` + NFD-Diakritika-Strip + `\s+`→`-` + Multi-Dash-Collapse + 64-Char-Trim). `uniqueSlug(base, exists)` haengt `-2`, `-3` … bei Konflikt an.
- **DB-Helper** ([db/book-categories.js](../db/book-categories.js), [db/book-tags.js](../db/book-tags.js)): CRUD + `setForBook` (atomic Replace) + `listAssignmentsForBooks` (Bulk-Map fuer Listen-Endpoint).
- **Routen**:
  - [routes/categories.js](../routes/categories.js) mount `/local/categories`: GET (alle), POST/PUT/DELETE (admin via `requireAdmin`).
  - [routes/tags.js](../routes/tags.js) mount `/local/tags`: GET + POST (alle Auth-User, Inline-Create), PUT/DELETE (admin).
  - [routes/book-access.js](../routes/book-access.js) ergaenzt: GET/PUT `/books/:book_id/category`, GET/PUT `/books/:book_id/tags` (editor+ via `aclParamGuard`).
  - [routes/content.js](../routes/content.js) `GET /content/books` liefert `category_id` + `tags`-Array pro Buch (fuer Frontend-Filter).
- **Frontend**:
  - BookSettings-Card ([public/js/book/book-settings.js](../public/js/book/book-settings.js) + [public/partials/book-settings.html](../public/partials/book-settings.html)): Kategorie via Combobox (Save on Change), Tags als Chip-Toggle-Pool + Inline-Create-Input.
  - Admin-Karte ([public/js/cards/admin-categories-card.js](../public/js/cards/admin-categories-card.js) + [public/partials/admin-categories.html](../public/partials/admin-categories.html)): Pool-Verwaltung (Create/Rename/Delete fuer Kategorien + Tags). Eintrag im Avatar-Menue (admin-only).
  - Filter-Pills in der Buchliste ([public/index.html](../public/index.html) + `filteredBooks()` in [public/js/book/tree.js](../public/js/book/tree.js)): Kategorie + Tags als Toggle-Pills, AND-Kombination, Pool aus aktuellem Bestand abgeleitet.
- **Sichtbarkeit**: Pool global; Admin kann verwalten, sieht aber keine Buecher (Privacy-Boundary unveraendert). Zuordnung an Buch erfordert editor+. Frontend-Filter respektiert ACL automatisch (filtert nur Buecher, die `/content/books` ohnehin schon liefert).
- **i18n** (de + en): `book.category`, `book.tags`, `categories.empty`, `tags.empty`, `tag.new`, `book.filter.byCategory`, `book.filter.byTag`, `book.filter.clear`, `admin.categories.title`, `admin.cat.*`, `admin.tag.*`. Plus `error.NAME_REQUIRED`/`NAME_TOO_LONG`/`INVALID_ID`/`INVALID_CATEGORY_ID`/`CATEGORY_NOT_FOUND`/`TAG_NOT_FOUND`/`TAG_IDS_REQUIRED`/`SELF_PARENT`.
- **Tests**: [tests/unit/slug.test.mjs](../tests/unit/slug.test.mjs) (slugify + uniqueSlug), [tests/unit/book-categories-tags.test.js](../tests/unit/book-categories-tags.test.js) (CRUD, Slug-Uniqueness, self-parent-Check, FK SET NULL + CASCADE, atomic setForBook, listAssignmentsForBooks).

---

## Phase 7 — Volltextsuche (SQLite FTS5) (erledigt)

Implementiert; Code-Pfade:

- **Migration 116** ([db/migrations.js](../db/migrations.js)): `search_index` (FTS5, unicode61 `remove_diacritics 2` + `tokenchars '-_'`, Spalten `kind|entity_id|book_id|lang` UNINDEXED + `title`+`body` indexiert) + `search_trigram` (FTS5 trigram, Titel-only) + `search_meta` (key/value-Store). Migration setzt `reindex_required=1`; Server.js boot-hook ruft `reindexIfNeeded()` in setImmediate. FTS5 unterstuetzt keine FKs — Index-Pflege via Application-Hooks (s.u.).
- **Lib** ([lib/search.js](../lib/search.js)): Single Entry Point. `upsertPage/Chapter/BookMeta/Figure/Location/Scene/Idea(id)` liest die aktuelle Row und schreibt sie in beide FTS5-Tabellen (DELETE-then-INSERT, idempotent). `remove(kind, id)` + `removeAllForBook(bookId)` + `removeKindForBook(kind, bookId)` fuer Full-Replace-Pfade (figures/locations/scenes). `query(input, { allowedBookIds, kinds, bookId, limit, offset })` → BM25 mit `bm25(search_index, 5.0, 1.0)` (title 5x), Single-Word-Zero-Hit faellt automatisch auf Trigram-Titel-Match zurueck. `buildMatchQuery()` parsed `"phrasen"`, `-negation`, `prefix*` und stripped Non-Word-Zeichen (`/[^\p{L}\p{N}_-]/u`) — User-Input kann keinen FTS5-Syntax-Error werfen. Alle Upserts safe-wrapped (Failure → warn-Log, kein Throw — Search-Sync darf den Save nicht abbrechen). HTML→Text identisch zu [routes/sync.js#htmlToText](../routes/sync.js) und [db/page-revisions.js](../db/page-revisions.js) (Pflicht-Konsistenz).
- **Schreib-Hooks**:
  - [lib/content-store/index.js](../lib/content-store/index.js): `createBook`/`deleteBook` → upsertBookMeta/removeAllForBook; `createChapter`/`updateChapter`/`deleteChapter` → upsertChapter/remove; `createPage`/`savePage`/`deletePage` → upsertPage/remove. searchIndex lazy-import (Test-Schema-Kompatibilitaet).
  - [routes/figures.js](../routes/figures.js) `PUT /:book_id`: nach `saveFigurenToDb` Full-Replace per `removeKindForBook('figure', bookId)` + Re-Upsert aller Figuren des Buchs. `DELETE /scenes/:book_id` analog fuer Szenen.
  - [routes/locations.js](../routes/locations.js) `PUT /:book_id`: nach `saveOrteToDb` Full-Replace.
  - [routes/ideen.js](../routes/ideen.js): POST/PATCH/DELETE rufen `upsertIdea`/`remove`. content = Plain-Text, erste Zeile als Titel (Trigram + bm25-Boost).
  - [routes/jobs/komplett/remap.js#saveSzenenAndEvents](../routes/jobs/komplett/remap.js): nach figure_scenes-Full-Replace alle drei Domain-Indizes (scene/figure/location) fuer das Buch neu aufbauen.
  - [routes/sync.js#syncBook](../routes/sync.js): nach BookStack-Pull `upsertBookMeta(bookId)` + Re-Upsert aller Kapitel + indexierten Seiten.
  - [db/pages.js#pruneStaleBookData](../db/pages.js): nach Stale-Cleanup explizite `remove('page'/'chapter', id)`-Calls. searchIndex lazy-import + try/catch (Cron-Pfad).
- **Search-API** ([routes/search.js](../routes/search.js)): `GET /search?q=...&kind=page,chapter&book_id=42&limit=50&offset=0`. ACL strikt: ohne `book_id` filtert serverseitig via `bookAccess.listBookIdsForUser(email)` (leere Liste → leere Hits, kein Cross-Buch-Leak). Mit `book_id` zusaetzlicher viewer-Guard. Default-`kind` = `page,chapter`; `kind=*` aktiviert alle Domain-Objekte. Mount in [server.js](../server.js): `app.use('/search', require('./routes/search'))`. `/search` in `NEVER_CACHE_PREFIXES` von [public/sw.js](../public/sw.js).
- **Cron**: Tagliche `INSERT INTO search_index(search_index) VALUES('optimize')` im bestehenden 23:00-Cron-Block ([server.js](../server.js)) — kein separater 02:00-Cron. `last_optimize` in `search_meta`.
- **Frontend**:
  - `SearchCard` ([public/js/cards/search-card.js](../public/js/cards/search-card.js), Partial [public/partials/search.html](../public/partials/search.html)): Search-Input mit Debouncing (220 ms), Kind-Filter-Pills (alle 7 Typen, Default `page,chapter`), Scope-Toggle (aktuelles Buch ↔ alle), Snippet-Render via `<mark>`. Treffer-Klick dispatcht auf `gotoPageById`/`openKapitelReviewForChapter`/`openFigurById`/`openOrtById`/`openSzeneById` je nach `kind`. Hash-Route `#search` (book-unabhaengig).
  - `FEATURES`+`EXCLUSIVE_CARDS`-Eintrag in [public/js/cards/feature-registry.js](../public/js/cards/feature-registry.js) (`minRole: 'viewer'`); `showSearchCard` in [public/js/app/app-state.js](../public/js/app/app-state.js); `toggleSearchCard` in [public/js/app/app-view.js](../public/js/app/app-view.js); `search` in `ALLOWED_KEYS` von [routes/usage.js](../routes/usage.js); Hash-Router-watcher + parse/build/category in [public/js/app/app-hash-router.js](../public/js/app/app-hash-router.js).
  - Command-Palette-Provider `fulltext` mit Prefix `?` in [public/js/cards/palette-providers.js](../public/js/cards/palette-providers.js): async `fetch('/search?...')` mit Query-Cache pro `(q,bookId)`-Paar, Re-Render via `palette:rerender`-Event ([public/js/cards/palette-card.js](../public/js/cards/palette-card.js)). `?` in Palette-Legend.
  - Card-Accent: `--card-accent-search` in [public/css/tokens/colors.css](../public/css/tokens/colors.css) (Light + Dark) + Mapping in [public/css/card-accents.css](../public/css/card-accents.css). UI-Styles in [public/css/search.css](../public/css/search.css) (`.card--search`, Kind-Pills, Scope-Toggle, Treffer-Liste mit BM25-Snippet).
- **i18n**: `tile.search{,.desc,.title}` + `search.{title,subtitle,placeholder,clear,loading,empty,fallback,untitled,results.count,scope.book,scope.all,kind.*}` + `palette.legend.fulltext` + `palette.section.fulltext` in beiden Locale-Files.
- **Tests**: [tests/unit/search-query.test.mjs](../tests/unit/search-query.test.mjs) (10 Cases — Query-Parser fuer Phrasen/Negation/Prefix/Sanitization, htmlToText-Parity, empty-allowedBookIds short-circuit). [tests/integration/search-index.test.js](../tests/integration/search-index.test.js) (10 Cases — Upsert+Query, Title-BM25-Boost, Umlaut-Folding `remove_diacritics=2`, ACL-Filter, kind-Filter, Idempotenz, remove/removeAllForBook, reindexAll, Trigram-Fallback, Empty-Row-Skip).

---

## Phase 8 — Backend-Migration-Tool (Bulk-Copy)

**Aktueller Stand:** `bookstack → localdb` landed; symmetrischer Pfad `localdb → bookstack` weiterhin offen.

### Erledigt: `bookstack → localdb` (ID-erhaltend)

- **Job** ([routes/jobs/backend-migrate.js](../routes/jobs/backend-migrate.js)): `runBackendMigrateJob` + `POST /jobs/backend-migrate` (Admin-only via `requireAdmin`). Body: `{ source, target, bookId?, setSourceReadOnly?, cutover? }`. Dedup-Key `migrate:global` (genau ein Migrate-Job zur Zeit). Aktuell akzeptierte Werte: `source='bookstack'`, `target='localdb'`. Reads gehen direkt am Bookstack-Backend vorbei an der Facade, Writes über `backfillBookTransactional` (ID-erhaltend via `ON CONFLICT(page_id) DO UPDATE`).
- **Source-Read-Only-Marker**: `app_settings` Key `app.migrate.source_readonly` (Default `''`). `_assertWritable` in [lib/content-store/index.js](../lib/content-store/index.js) wirft `BACKEND_READ_ONLY` (status 423), wenn Marker == `currentBackend()`. Greift auf alle Write-Calls (savePage, createPage, deletePage, createChapter, updateChapter, deleteChapter, createBook, deleteBook). Reads bleiben erlaubt.
- **FTS-Reindex**: pro migriertem Buch `removeAllForBook` + iterativer `upsertChapter`/`upsertPage`-Sweep, damit Phase-7-Suche unter localdb sofort konsistent ist.
- **Cutover**: nach Erfolg aller Bücher `appSettings.set('app.backend', 'localdb', …)`. `app-settings:changed`-Event löst Hot-Reload aus; ein neuerlicher Switch nach `bookstack` bleibt blockiert, solange der Read-Only-Marker steht.
- **Rollback-Helfer**: `POST /jobs/backend-migrate/clear-readonly` (Admin) löscht den Marker explizit.
- **Status-Endpoint**: `GET /jobs/backend-migrate/status` liefert `{ currentBackend, sourceReadOnly }` für die UI ohne Umweg über `/admin/settings`.
- **Admin-UI** ([public/js/cards/admin-backend-migration-card.js](../public/js/cards/admin-backend-migration-card.js) + [public/partials/admin-backend-migration.html](../public/partials/admin-backend-migration.html)): Status-Block, Form mit Buch-Filter, Read-Only-/Cutover-Checkboxen, Job-Polling via `startPoll` + `runningJobStatus`. Card-Tile in [public/partials/admin-home.html](../public/partials/admin-home.html). Hash `#admin/migration`. Registriert in `EXCLUSIVE_CARDS` ([public/js/cards/feature-registry.js](../public/js/cards/feature-registry.js)). Admin-only, nicht in `FEATURES`/Palette.
- **ID-Strategie**: localdb übernimmt BookStack-PKs 1:1 (Phase 0b-Invariante; AUTOINCREMENT-Wasserzeichen hält BS-Range frei). Keine ID-Map, kein FK-Repair — alle ~40 FK-Spalten zeigen weiter auf dieselben Integer-IDs.
- **Idempotenz**: `backfillBookTransactional` ist Upsert; Re-Run aktualisiert Bodies.
- **Tests** ([tests/integration/backend-migrate.test.js](../tests/integration/backend-migrate.test.js)): Bulk-Copy + ID-Erhalt, Cutover, Cutover-Skip, Read-Only-Guard wirft `BACKEND_READ_ONLY`/423, idempotenter Re-Run mit aktualisiertem Body.

### Offen: `localdb → bookstack` (Symmetrie-Pfad)

BookStack-API vergibt frische IDs beim POST → ID-Mapping zwingend:

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

FK-Repair iteriert alle ~40 FK-Spalten und mapped `source_id → target_id` via Join, dann `UPDATE … WHERE source_id IN map`. Transaction pro Buch. `foreign_key_check` am Ende der Buch-Transaction muss leer sein, sonst Rollback. BS-API verlangt Reihenfolge Books → Chapters → Pages; Pages-`html` als POST. Job- + UI-Skelett stehen — die symmetrische Richtung erweitert nur `runBackendMigrateJob`, den `target`-Validator und ergänzt die ID-Map-Schreib-Pipeline.

---

## Phase 9 — Doku-Update (Multi-Backend-Sweep) (erledigt)

Doku-Sweep abgeschlossen. Konkret:

- **[README.md](../README.md)** — Intro auf Backend-Wahl umgestellt (SQLite Default, BookStack optional). BookStack-Voraussetzungen + Token-Setup als `bookstack`-Mode-only markiert. Backup-Block pro Backend; Backend-Wechsel-Hinweis auf Admin-Migration-Card.
- **[CLAUDE.md](../CLAUDE.md)** — Header listet beide Backends + Content-Store-Facade. Harte Regel ergänzt: Content-Store-Facade ist Pflicht-Einstieg, `bs*`-Calls nur in Tripwire-Allowlist. `bsGet(..., { fresh: true })`-Regel jetzt explizit `bookstack`-Mode. Architektur-Überblick: `/content/*` + `/search/*` + `/local/*` Routen ergänzt; Content-Store-Facade als zentrale Abstraktion dokumentiert.
- **Spickzettel-Sweep:** [erd.md](erd.md) (`body_html` als Wahrheit im localdb-/Cache im bookstack-Mode, `priority` als bedingter Mirror), [testing.md](testing.md) (Mock-BookStack nur für `bookstack`-Mode-Suiten; Parametrisierung `for (const backend of [...])`), [focus-editor.md](focus-editor.md) (Phantom-Revision-Hinweise backend-agnostisch), [buchchat-tools.md](buchchat-tools.md) (`userToken` + `get_pages` jetzt backend-bedingt), [state-modell.md](state-modell.md) (`currentBackend` neuer Shell-State, bookstack-Search/api-bookstack als `bookstack`-Mode-only), [wordpress-import.md](wordpress-import.md) + [bookstack-templates.md](bookstack-templates.md) (Header-Disclaimer `bookstack`-Mode-only).
- **i18n-Restposten (erledigt):** Backend-conditional Rendering via `backend === 'bookstack'` (Root) bzw. `$app.backend === 'bookstack'` (Sub-Cards) angewandt auf alle bookstack-only UI-Sinks: Hero-Row `btn-bookstack-link` ([public/index.html](../public/index.html)), Editor-Subline `editor.openInBookstack` + `editor.revisionsTitle` ([public/partials/editor.html](../public/partials/editor.html)), Kapitelreview-Chapter-Link ([public/partials/kapitelreview.html](../public/partials/kapitelreview.html)), Bookoverview-Header-Link ([public/partials/bookoverview.html](../public/partials/bookoverview.html)). `profile.bookstackToken`-Block in [public/partials/user-settings.html](../public/partials/user-settings.html) war schon gated. Token-Setup-Modal (`tokenSetup.*`) öffnet automatisch nur, wenn `backend === 'bookstack' && !bookstackTokenOk` ([public/js/app.js#L728](../public/js/app.js)); manueller Pfad via Palette-Action `action.tokenChange` durch `requiresBookstack: true` ([public/js/cards/feature-registry.js](../public/js/cards/feature-registry.js)) gegated. Reine String-Pools (`bs.timeout*`, `bs.apiError*`, `session.bookstackTokenInvalid`, `error.NO_BOOKSTACK_TOKEN`/`BOOKSTACK_UNAUTHED`/`BOOKSTACK_UNREACHABLE`, `job.error.noBookstackToken`/`bookstack*`, `admin.settings.bookstack.tokenHint`, `editor.revisions.source.bookstack-sync`) bleiben in `i18n/{de,en}.json` — referenziert ausschliesslich aus bookstack-spezifischen Code-Pfaden, die im `localdb`-Mode nicht erreicht werden.

---

## Phase 10 — Schema-Squash

100+ Migrationen zu einem konsolidierten Initial-Schema kollabieren. Nach Phase 9 ist die DB-Struktur stabil. Squash entfernt Wegwerf-Migrationen (FK-Recreate-Zwischenschritte, Reverted-Columns), reduziert Boot-Zeit auf frischen Installs.

**Vorgehen:**

1. **Cut-Schema generieren.** Auf frischer DB Migrationen 1–N durchlaufen, dann `sqlite3 db.sqlite '.schema'` → kanonisches CREATE-Skript. Manuell aufräumen: konsistente Spalten-Reihenfolge, FK-Aktionen explizit, Indexe pro Tabelle gruppiert.
2. **Tooling: `tools/squash-migrations.js`** — generiert CREATE-Skript aus Roh-Migration-DB, vergleicht via `.schema` mit alt-migrierter DB. Byte-Diff = leer, sonst Stop.
3. **Neuer Initial-Block** in [db/migrations.js](../db/migrations.js): Migrationen 1..N werden zu einem Branch, der bei `version === 0` das `SQUASHED_SCHEMA` einspielt und `schema_version` auf N setzt.
4. **Compat-Branch** für Bestandsinstallationen: `if (version > 0 && version < N) { … legacy 1..N … }` bleibt 1 Major-Release lang. Danach Breaking-Change.
5. **[docs/erd.md](erd.md)** Stand-Zeile + Blöcke aus `SQUASHED_SCHEMA` regenerieren.
6. **Tests:**
   - Frische DB: Migration läuft, `foreign_key_check` leer, Smoke-Insert pro Tabelle.
   - Bestandsdaten: Pre-Squash-Snapshot durch Compat-Branch ziehen, Frische-Schema-Diff = leer.
   - CI: „No-drift"-Check zwischen Bestand- und Frisch-Pfad.
7. **Indexe + Triggers separat squashen.** Reihenfolge: Tables → Indexes → Triggers → Views → Virtual Tables (FTS5).

**Anti-Patterns vermeiden:**
- Kein `DROP TABLE … RECREATE` im gesquashten Block — Squash ist „Initial Install".
- Keine ENV-Bedingungen, keine Data-Backfills (UPDATE) im Squash.

**Rollback:** Squashed-Block durch Compat-Branch ersetzen (alle Original-Migrationen liegen in `git`).

---

## Phase 11 — Per-User-AI-Provider-Override (erledigt)

Implementiert; Code-Pfade:

- **Migration 117** ([db/migrations.js](../db/migrations.js)): `app_users.ai_provider_override TEXT` (NULL = follows global; CHECK `IN ('claude','ollama','llama') OR NULL`). `provider`-Spalte in alle 7 KI-Caches (Teil des PRIMARY KEY): `chapter_extract_cache`, `book_extract_cache`, `chapter_review_cache`, `book_review_cache`, `chapter_macro_review_cache`, `synonym_cache`, `lektorat_cache`. Backfill bestehender Cache-Eintraege auf den aktuellen `ai.provider`-Globalwert.
- **Resolver** ([lib/ai.js](../lib/ai.js)): `resolveProvider({ userEmail })` liest ALS-Ctx oder explizites `userEmail` → `app_users.ai_provider_override` → `app_settings.ai.provider` → `'claude'`. `callAIChat`/`callAIWithTools` rufen den Resolver, wenn `provider` nicht explizit uebergeben wird.
- **Per-Provider-Kontext** ([lib/ai.js](../lib/ai.js)): `getContextConfigFor(provider)` liefert `{ contextWindow, maxTokensOut, charsPerToken, inputBudgetTokens, inputBudgetChars }` aus `ai.<provider>.context_window` + `ai.<provider>.max_tokens_out`. Defaults: claude 200 000, ollama/llama 32 000. Boot-Konstanten (`INPUT_BUDGET_TOKENS` etc.) bleiben Claude-Default fuer Backwards-Compat; neue Pfade nutzen den Helper.
- **DB-Helper** ([db/app-users.js](../db/app-users.js)): `setAiProviderOverride(email, provider|null)` mit Validierung; `getUser`/`listUsers` liefern `ai_provider_override`.
- **Admin-Route** ([routes/admin-users.js](../routes/admin-users.js)): `PUT /admin/users/:email` akzeptiert `ai_provider_override`. Validiert gegen konfigurierte Provider (`ai.<p>.host`/`ai.claude.api_key`); fehlend → `400 AI_PROVIDER_NOT_CONFIGURED`. Audit-Event `ai-provider-changed`.
- **/auth/me** ([routes/auth.js](../routes/auth.js)): Antwort enthaelt `aiProvider` (resolvt) + `aiProviderSource: 'global' | 'override'`.
- **Cache-Helpers** ([db/schema.js](../db/schema.js)): `loadXxxCache(…, provider)` / `saveXxxCache(…, provider)`. Caller in [routes/jobs/komplett/phases.js](../routes/jobs/komplett/phases.js), [routes/jobs/review.js](../routes/jobs/review.js), [routes/jobs/kapitel.js](../routes/jobs/kapitel.js), [routes/jobs/lektorat.js](../routes/jobs/lektorat.js), [routes/jobs/synonyme.js](../routes/jobs/synonyme.js) reichen den `effectiveProvider` (am Job-Start einmal resolvt) durch.
- **Admin-UI** ([public/js/cards/admin-users-card.js](../public/js/cards/admin-users-card.js) + [public/partials/admin-users.html](../public/partials/admin-users.html)): Spalte „KI-Provider" mit Combobox `(Global: <name>)` | `claude` | `ollama` | `llama`. Auswahl `(Global)` setzt Override = NULL. `adminUsersGlobalProvider` wird aus `/admin/settings/ai.provider` mitgeladen.
- **i18n** (de + en): `admin.users.aiProvider`, `admin.users.aiProvider.global`, `admin.users.aiProvider.notConfigured`, `admin.users.aiProvider.effective`, `error.AI_PROVIDER_INVALID`, `error.AI_PROVIDER_NOT_CONFIGURED`, `chat.providerHint`.
- **Tests**: [tests/unit/ai-resolve.test.mjs](../tests/unit/ai-resolve.test.mjs) — Auflösungs-Reihenfolge (Default/Global/Override/NULL-Fallback), Validierung des Override-Werts, per-Provider-Context, Synonym- + Lektorat-Cache mit Provider-Split.

**Mutex** bleibt providerspezifisch (nicht userspezifisch) — VRAM ungeteilt. **In-Flight-Jobs** beim Override-Wechsel laufen mit dem alten Provider zu Ende (Closure haelt den Singleton).

**Bewusst nicht implementiert:** Self-Service-Override in [routes/usersettings.js](../routes/usersettings.js) (Cost-Verteilung = Admin-Kontrakt). Per-User-API-Keys (Future-Work).

---

## Offene Risiken

- **Backend-Migration mit Jobs in Flight (Phase 8):** Bei `localdb → bookstack` mit umgemappter ID, bei `bookstack → localdb` mit Source-Read-Only-Marker. Gegenmittel: Migration startet erst bei leerer Job-Queue für betroffene Bücher; neue Jobs für migrierende Bücher → 423 Locked.
- **Hot-Reload-Race bei Backend-Switch (Phase 1/4c):** Laufender Job hält Closure-Referenz auf alten Client/Backend. Gegenmittel: Backend-Switch verlangt leere Job-Queue (Pre-Check) oder Admin-Warn-Modal. Verdrahtung in [routes/admin-settings.js](../routes/admin-settings.js) per Pre-Save-Guard.
- **BS-Eigene Edits ausserhalb der App (`bookstack`-Mode):** Wer im BookStack-UI parallel editiert, umgeht App-Revisions/FTS/Page-Lock. Sync-Worker fängt es ein (kein Datenverlust), aber Apply kann auf veraltetem Body operieren. App-Doku rät: „BookStack-UI nicht parallel editieren".
- **CI-Pipeline gegen beide Backends:** Integration-Tests pro Job-Typ je einmal gegen Mock-BookStack **und** In-Memory-SQLite. Convention: `for (const backend of ['bookstack','localdb'])`-Loop.
- **Feature-Parität zwischen Backends:** Risiko: localdb-only-Feature ohne BS-Backend. Gegenmittel: Content-Store-Vertrag + Tripwire (`bsGet`/`bsPut` ausserhalb `lib/content-store/backends/bookstack.js` schlägt im CI-Grep fehl). Neue Feature-PR ohne Test gegen beide Backends im Review ablehnen.

---

## Aufwand grob (offene Phasen)

| Phase | Aufwand | Risiko |
|---|---|---|
| 8b | 3–4 Tage | mittel-hoch (FK-Repair + ID-Map + Round-Trip-Tests) |
| 10 | 1–2 Tage | mittel (Diff-Test gegen Bestand) |

**Realistischer Rahmen:** ≈ 4–6 Vollzeit-Tage Coding für offene Phasen. Test-Sweep gegen beide Backends + i18n-Doppelpflege + ERD-Update sind im Tages-Wert nicht voll abgebildet.
