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

`3 → 6 → 7 → 8 → 9 → 10 → 11`. Phase 11 (Per-User-AI-Provider) ist additiv und kann eingeschoben werden, sobald `app_users` (steht) + `app_settings` (steht) konsolidiert sind.

Phase 1 (`localdb`-Backend) + Phase 2 (Page-Revisions) gelandet — siehe Code-Pfade in den jeweiligen Abschnitten.

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
- **Sync-Worker** ([routes/sync.js](../routes/sync.js)): bestehender Per-User-Sync-Cron mit Backend-Mode-Guard `_isBookstackBackend()`. `syncAllBooks()` + `POST /sync/book/:book_id` → no-op (Cron) / 409 (Route) bei `localdb`-Backend. Cron-Tick 02:00 in [server.js](../server.js) bleibt unverändert.
- **Tripwire** ([tests/unit/content-store-tripwire.test.mjs](../tests/unit/content-store-tripwire.test.mjs)): `bs*`-Calls + `BOOKSTACK_URL`-Referenzen nur in `lib/bookstack.js` + `lib/content-store/backends/bookstack.js` + `routes/sync.js` + `routes/jobs/shared/bookstack.js` + `routes/proxies.js` + `lib/pdf-render/images.js`.

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
- **i18n**: `editor.revisions.{count,chars,restore,restoring,restoreTitle,restored,restoreFailed,restoreConfirm}` + 7 `editor.revisions.source.*`-Labels (de + en).
- **Tests**: [tests/unit/page-revisions-cleanup.test.mjs](../tests/unit/page-revisions-cleanup.test.mjs) — Pruning pro page_id, leere Tabelle, invalides Setting → Error-Path.

---

## Phase 3 — Eigene Sortierung (Kapitel + Seiten)

Deckt **alle** Strukturoperationen ab: Kapitel-Reihenfolge, Seiten-Reihenfolge innerhalb eines Kapitels, Seiten direkt unter Buch, Seiten zwischen Kapiteln umhängen, Seiten zwischen Top-Level und Kapitel umhängen.

**Migration:**

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
- Genau zwei Ebenen: Buch → (Kapitel ODER Seite) → Seite.
- `type` (`'chapter'|'page'`) + numerische `id` pro Eintrag.
- Alle IDs gehören zum betreffenden `book_id`.
- Keine doppelten IDs, alle Pages/Kapitel des Buches kommen genau einmal vor (Vollständigkeit erzwingen — verhindert „verlorene" Pages).
- `children` nur bei `type='chapter'`.

**Materialisierte Spalten** (`pages.position`, `chapters.position`, `pages.chapter_id`): Server-Hook beim `PUT /local/books/:id/order` traversiert Tree, vergibt Positionen (0-basiert, lückenlos), setzt `pages.chapter_id` (NULL für Top-Level). Atomar in Transaction. Materialisierung dient nur Querys/JOINs; Tree-Render liest aus `order_json` (SSoT).

**Routen:**
- `GET /local/books/:id/order` → `{ order_json, updated_at, updated_by }`.
- `PUT /local/books/:id/order` `{ order_json }` → Validierung + Materialisierung + Save in Transaction.
- Keine Per-Item-Move-Routen — Frontend sendet immer den vollständigen Tree.

**Frontend** ([public/js/tree.js](../public/js/tree.js)): Drag-Reorder berechnet neuen Tree clientseitig, sendet komplettes Snapshot. Optimistic-Update + Rollback bei 4xx. UI-Granularitäten (Kapitel verschieben, Seite verschieben, Umhängen Top-Level↔Kapitel) verwenden dasselbe Endpoint.

**Initial-Fill** beim Aktivieren: Migration baut `order_json` aus den vorhandenen `pages.priority`/`chapters.priority`. Danach übernimmt `book_order` die Wahrheit.

**Konflikt mit Replica-Pull** (`bookstack`-Mode): Sync-Pull synct nur Body + Metadaten, nie Order. Auf BookStack-UI vorgenommene Reorder werden ignoriert. Admin-Log-Hint.

**Tests:**
- Unit: Tree-Validator (Schema, Vollständigkeit, Doppel-IDs, Verschachtelungsgrenze).
- Unit: Materialisierung (Tree → `pages.chapter_id`/`*.position`).
- E2E: Drag-Reorder über alle 5 Granularitäten.

---

## Phase 6 — Tags + Kategorien

**Migration:**

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

**Slug-Generierung** (`lib/slug.js`): `slugify(name)` = lowercase + ASCII-Folding (`ä→ae`, `ö→oe`, `ü→ue`, `ß→ss`, `NFD`+`/\p{Diacritic}/u` strip) + `\s+` → `-` + `[^a-z0-9-]` raus + Multi-Dash collabsen + Trim 64 Zeichen. Dedup auf DB-Ebene: bei `UNIQUE`-Konflikt Suffix `-2`, `-3`, …

**Sichtbarkeit**: Tag-/Kategorie-Pool ist **global** (alle App-User sehen denselben Pool). Zuordnung an Buch erfordert `editor`+. Filter respektiert ACL.

**Admin**: kann Pool verwalten (Create/Edit/Delete), sieht aber keine Bücher.

**Routen:**
- `GET/POST/PUT/DELETE /local/categories` (POST/PUT/DELETE: Admin).
- `GET/POST/PUT/DELETE /local/tags` (POST: jeder Auth-User; DELETE: Admin).
- `PUT /books/:id/category`, `PUT /books/:id/tags` (Owner/Editor).

**Frontend**: BookSettings-Card mit Combobox „Kategorie" + Multi-Select „Tags". Inline neuer Tag via Free-Input. Filter-Pills in Buchliste. Admin-Karte für Kategorie-Pool.

**i18n**: `book.category`, `book.tags`, `categories.empty`, `tags.empty`, `tag.new`, `book.filter.byCategory`, `book.filter.byTag`.

---

## Phase 7 — Volltextsuche (SQLite FTS5)

Eigene Volltextsuche über alle App-Inhalte. Läuft parallel zu BookStack-Search während Replica-Phase; in Phase 8 wird nur noch der BookStack-Pfad entfernt.

**Scope:**
- Bücher: `books.name`, `books.description`.
- Kapitel: `chapters.chapter_name`, `chapters.description`.
- Pages: `pages.page_name`, `pages.body_html` (HTML-stripped).
- Domain-Objekte: `figures.name` + `figures.beschreibung`, `locations.name` + `locations.beschreibung`, `figure_scenes` (Titel/Beschreibung), `ideen.titel` + `ideen.text`.

Ein einziger FTS5-Index; Diskriminator über `kind`-Spalte; ACL über `book_id`.

**Migration:**

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
  kind UNINDEXED,         -- 'book' | 'chapter' | 'page' | 'figure' | 'location' | 'scene' | 'idea'
  entity_id UNINDEXED,
  book_id UNINDEXED,      -- für ACL-JOIN
  lang UNINDEXED,         -- 'de' | 'en' | NULL
  title,                  -- gewichtbar via bm25(search_index, 5.0, 1.0)
  body,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '-_'"
);

CREATE VIRTUAL TABLE search_trigram USING fts5(
  kind UNINDEXED,
  entity_id UNINDEXED,
  book_id UNINDEXED,
  title,
  tokenize = "trigram"
);

CREATE TABLE search_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO search_meta (key, value) VALUES ('last_optimize', NULL);
```

**Tokenizer-Wahl:**
- `unicode61 remove_diacritics 2` — Umlaut-Folding, DE+EN gemeinsam.
- `tokenchars '-_'` — Bindestrich-Wörter zusammenhalten.
- Kein Porter-Stemmer (nur EN, schlecht für DE).
- Zweiter trigram-Index nur in Titeln für Typo-Toleranz.

**Sync-Strategie**: Application-level, nicht SQL-Trigger (HTML→Text-Stripping muss in JS passieren, Konsistenz zu [routes/sync.js](../routes/sync.js)#htmlToText). Hook-Punkte:
- Page-Save (Phase-2-Hook): `searchIndex.upsert('page', page_id, …)`.
- Chapter-Update, Book-Update.
- Domain-Object-CRUD ([routes/figures.js](../routes/figures.js), [routes/locations.js](../routes/locations.js), [routes/ideen.js](../routes/ideen.js)).
- Sync-Pull (Phase 1): bei Body-Update → FTS-Reindex der Page.

Lib `lib/search.js` als Single Entry Point: `upsert(kind, id, fields)`, `remove(kind, id)`, `query(text, opts)`, `reindexAll()`.

**HTML→Text-Normalisierung** für `body`: Reuse von [lib/html-clean.js](../lib/html-clean.js) + `htmlToText`-Variante (Tag→Space + `\s+`→Single-Space — identisch zu `routes/sync.js`/Frontend). Pflicht-Konsistenz, sonst Drift zu `page_stats.chars`.

**Search-API** (`routes/search.js`):

```
GET /search?q=...&kind=page,chapter&book_id=42&limit=50&offset=0
```

- ACL-Filter zwingend: JOIN auf `book_access` mit `req.session.user_email`.
- BM25-Gewichtung: Title 5x stärker als Body.
- Query-Parsing: `"`-quote-Phrasen, `-`-Negationen, `*`-Präfix; Spezialzeichen escapen. Single-Word + kein Treffer → Fallback auf `search_trigram`.
- Default-Filter: Pages + Chapters. Rest als Opt-In via `kind`.

**Frontend:**
- **Command-Palette-Integration**: Provider `searchProvider` in [public/js/cards/palette-providers.js](../public/js/cards/palette-providers.js). Prefix `?` für Volltext-Modus.
- **`SearchCard`** (eigene Pill, `FEATURES`+`EXCLUSIVE_CARDS`+`ALLOWED_KEYS`-Eintrag): Search-Input, `kind`-Filter-Pills, Buch-Combobox, Ergebnisliste mit Snippet+Pfad, Tastatur-Navigation. Treffer-Klick navigiert via Hash-Router; Query-Param `?q=...` an Editor-Find weiterreichen → Markierung via [public/js/editor/find.js](../public/js/editor/find.js).

**Performance:**
- Daily `INSERT INTO search_index(search_index) VALUES('optimize')` im 02:00-Sync-Cron.
- Initial-Build via `lib/search.js#reindexAll()` beim Migrations-Lauf, batched 500er-Chunks.
- Erwartete Index-Grösse ~30-40% der indexierten Text-Grösse.

**ACL-Test (Pflicht)**: zwei User mit unterschiedlichen `book_access`-Mengen, `/search?q=*` liefert nur Treffer aus sichtbaren Büchern.

**i18n**: `search.title`, `search.placeholder`, `search.filter.kind`, `search.filter.book`, `search.empty`, `search.results.count` (`{n}`), `search.kind.{book,chapter,page,figure,location,scene,idea}`, `search.snippet.unavailable`.

**Tests**: Unit (Query-Parser, HTML→Text-Match), Integration (Index-Sync nach Save/CRUD/Pull, ACL-Boundary), E2E (Suche → Klick → Highlight).

---

## Phase 8 — Backend-Migration-Tool (Bulk-Copy)

Voraussetzung: Phasen 1–7 stabil. Beide Backends sind betrieblich okay; Admin zieht **gerichtet** um.

**Job-Typ `backend-migrate`** ([routes/jobs/backend-migrate.js](../routes/jobs/backend-migrate.js)) — Standard-Pattern, Admin-only.

**Trigger** über Admin-Karte `AdminBackendMigrationCard`:
- Quelle/Ziel-Auswahl (`bookstack` → `localdb` ist Primärfall; `localdb` → `bookstack` symmetrisch).
- Wahl: alle Bücher oder Einzel-Buch.
- Checkbox „Quelle nach erfolgreichem Copy auf read-only setzen" (empfohlen).

**Pipeline pro Buch:**

1. **Source-Read-Only-Marker**: `app_settings` Key `app.migrate.source_readonly = '<source-backend>'`. Content-Store-Facade blockiert ab da `savePage`/`createPage` für den Source-Backend (Edits → 423 Locked mit i18n-Text).
2. **Bulk-Copy**: pro Page/Chapter Source-Lesen → Target-Schreiben.
3. **FK-Repair**: richtungsabhängig (siehe ID-Strategie).
4. **FTS-Reindex** (Phase 7) für migrierte Bücher.
5. **Cutover**: nach erfolgreichem Copy aller selektierten Bücher: `app.backend = <target>` (atomar). Source-Read-Only-Marker bleibt — Rollback-Option.
6. **Abort/Rollback**: Job-Cancel rollt nur die laufende Buch-Transaction zurück.

**ID-Strategie pro Richtung:**

- **`bookstack → localdb` (Primärfall, ID-erhaltend):** localdb übernimmt BookStack-PKs 1:1 (Phase 0b-Invariante; AUTOINCREMENT-Wasserzeichen hält BS-Range frei). **Keine ID-Map, kein FK-Repair** — alle ~40 FK-Spalten zeigen weiter auf dieselben Integer-IDs. Implementierung: `INSERT INTO pages (page_id, …) VALUES (?, …) ON CONFLICT(page_id) DO UPDATE`.
- **`localdb → bookstack` (Symmetrie-Pfad):** BookStack-API vergibt frische IDs beim POST. ID-Mapping zwingend:

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

  FK-Repair iteriert alle ~40 FK-Spalten und mapped `source_id → target_id` via Join, dann `UPDATE … WHERE source_id IN map`. Transaction pro Buch.

In beiden Richtungen: `foreign_key_check` am Ende der Buch-Transaction muss leer sein, sonst Rollback.

**Implementierungs-Details:**
- BookStack-Pages ohne Markdown → `body_markdown=NULL`.
- BookStack-`priority` → wird in `book_order.order_json` (Phase 3) materialisiert.
- BookStack-Tags (falls genutzt) → werden in Phase-6-`book_tag_assignments` migriert.
- localdb → BookStack: BS-API verlangt Reihenfolge (Books → Chapters → Pages), Pages-`html` als POST.

**Idempotenz**: Re-Run mit denselben Source/Target ist no-op pro bereits migriertem Buch (ID-Map-Check). Force-Re-Migrate via UI-Toggle.

**Logging**: Pro Buch `[backend-migrate|admin@…|<book_id>] copied chapters=N pages=M elapsed=Ts`.

**Tests:**
- Integration: Mock-BS + In-Memory-DB → migrate `bookstack` → `localdb`, alle Pages/Bodies/Order erhalten, FK-`page_revisions` zeigen weiter auf richtige Page.
- Integration: Migrate-symmetrisch zurück, Round-Trip-Body identisch (Byte-Vergleich nach `cleanPageHtml`).
- Unit: ID-Map-FK-Repair (alle Spalten-Treffer durchgehen).

**i18n**: `admin.backendMigration.{title,source,target,startButton,warnSourceReadonly,progress,error.<reason>}`.

---

## Phase 9 — Doku-Update (Multi-Backend-Sweep)

Nach Phase 8 ist Backend-Pluralität betrieblich Realität. Reine Doku-Phase, kein Code-Risiko.

**Zu aktualisieren:**

- **[README.md](../README.md)** — Intro: „Storage-Backend wählbar: SQLite (Default) oder BookStack." Deployment in zwei Varianten: Minimal-Setup (App + SQLite) als Default, BookStack-Setup optional. ENV-Variablen `BOOKSTACK_BASE_URL`/`BOOKSTACK_TOKEN_ID`/`BOOKSTACK_TOKEN_SECRET` als „optional, nur bei `app.backend=bookstack`". Architektur-Diagramm: BookStack-Box gestrichelt.
- **[CLAUDE.md](../CLAUDE.md)** — Header: „BookStack als optionales Storage-Backend (eines von zweien)". Architektur-Überblick: Content-Store-Facade als zentrale Storage-Abstraktion. Harte Regeln: `bsGetAll`/`bsGet`/`bsPut`-Regel auf „nur in `lib/bookstack.js` + `lib/content-store/backends/bookstack.js`" verschärfen; `bsGet(..., { fresh: true })`-Regel gilt nur im `bookstack`-Mode. Read-Modify-Write-Pfade um localdb-Variante ergänzen.
- **Deploy-Doku**: Zwei Setup-Pfade. Backup-Strategie pro Backend.
- **Spickzettel-Sweep** in [docs/](./) — [bookstack-templates.md](bookstack-templates.md) bleibt (nur `bookstack`-Mode); [erd.md](erd.md), [jobs.md](jobs.md), [i18n.md](i18n.md), [ai-providers.md](ai-providers.md), [testing.md](testing.md), [figur-werkstatt.md](figur-werkstatt.md), [buchchat-tools.md](buchchat-tools.md), [focus-editor.md](focus-editor.md), [state-modell.md](state-modell.md), [finetuning.md](finetuning.md), [wordpress-import.md](wordpress-import.md): auf BookStack-Annahmen grep'pen.
- **[bookstack-exit.md](bookstack-exit.md)** (diese Datei) — bei Abschluss aller Phasen wird daraus „Multi-Backend-Architektur-Spickzettel" (Backends, Content-Store-Facade, Migration-Tool); alle Phasen-Blöcke verschwinden.
- **Tests-Doku** — Integration-Tests laufen gegen beide Backends.
- **i18n-Restposten** — Phase 1 hat den Save-Pfad bereits entbookstackifiziert. Phase 9 grep't beide Locale-Files erneut auf `BookStack`/`bookstack`-Strings: (a) backend-spezifisch (Conditional auf `$app.currentBackend`), (b) generisch umformuliert, (c) tot → entfernen.

Reihenfolge: README + CLAUDE.md zuerst, dann Deploy-Block, dann Spickzettel.

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

## Phase 11 — Per-User-AI-Provider-Override

Admin weist pro User KI-Provider zu. Globaler `ai.provider` aus `app_settings` bleibt Default.

### Modell

Provider-**Wahl** pro User; Provider-**Credentials** bleiben global in `app_settings`. Kein Per-User-API-Key (Future-Work).

### Migration

```sql
ALTER TABLE app_users ADD COLUMN ai_provider_override TEXT
  CHECK(ai_provider_override IN ('claude','ollama','llama') OR ai_provider_override IS NULL);
```

`NULL` = User folgt globalem `ai.provider`. Non-NULL gewinnt. Bestand bleibt `NULL` → identisches Verhalten.

### Auflösungs-Reihenfolge

In [lib/ai.js](../lib/ai.js) `callAI(ctx, …)`:

1. `ctx.userEmail` → `app_users.ai_provider_override`.
2. Fallback: `app_settings.ai.provider`.
3. Hardcoded Default (`'claude'`).

`ctx.userEmail` muss in jeden `callAI`-Pfad durchgereicht werden. Worker: aus `job.userEmail` im ALS-Context von [routes/jobs/shared/queue.js](../routes/jobs/shared/queue.js). SSE-Routes: `req.session.email`.

**`MODEL_TOKEN`/`MODEL_CONTEXT`-Implikation:** Provider-Wechsel ändert Kontextfenster (Claude 200k, lokal 32k–128k). `INPUT_BUDGET_TOKENS` muss **pro Call** vom resolvten Provider abhängen, nicht vom Boot-Default. `SINGLE_PASS_LIMIT`/`PER_CHUNK_LIMIT` (Module-Konstanten in [routes/jobs/shared.js](../routes/jobs/shared.js)) → pro Job-Run aus `aiClient.contextWindow` neu berechnet. Cache-Keys bekommen `provider`-Feld (s.u.).

### Admin-UI — Erweiterung `AdminUsersCard`

- Spalte „Provider" mit Combobox: `(Global: claude)` | `claude` | `ollama` | `llama`. Auswahl `(Global)` setzt `ai_provider_override = NULL`.
- `PUT /admin/users/:email` akzeptiert `ai_provider_override` (Admin-only).
- Anzeige des effektiven Providers: `claude (Global)` für Default-Follower, `ollama (Override)` für Override-User.
- Validierung: Combobox-Optionen aus konfigurierten Providern; `ollama` ohne `ai.ollama.host` → disabled. API-Guard als zweite Schicht: PUT lehnt Override auf nicht-konfigurierten Provider mit 400 ab.

### Self-Service — bewusst nein

Kein User-sichtbares Override in [routes/usersettings.js](../routes/usersettings.js). Cost-Verteilung gehört zum Admin-Kontrakt. `GET /me` liefert den resolvten Provider read-only (`{ … aiProvider: 'claude' }`) für Frontend-Statuszeile.

### Hot-Reload

Pro Provider ein Singleton (`claudeClient`, `ollamaClient`, `llamaClient`), `callAI` wählt nach resolvtem Provider. Per-User-Override-Wechsel triggert kein Client-Rebuild — nur Routing-Tabelle ändert sich.

### Mutex / VRAM-Schutz

Ollama/Llama-Mutex bleibt providerspezifisch, nicht userspezifisch — VRAM verträgt keine Parallelität. UI-Hinweis: „Lokale Provider serialisieren Job-Pipeline".

### Cost-Tracking-Integration

`callAI` gibt resolvten Provider zurück, `recordTokenUsage(provider, …)` schreibt in bestehende `token_usage.provider`-Spalte. Admin-Dashboard aus Phase 4d zeigt Kosten pro User korrekt aufgeschlüsselt.

### Cache-Key-Erweiterung (Pflicht)

Cache-Keys ohne Provider würden Claude-Output an Ollama-User ausliefern. `provider`-Spalte in den Caches (`chapter_extract_cache`, `book_extract_cache`, `chapter_review_cache`, `book_review_cache`, `chapter_macro_review_cache`, `synonym_cache`, `lektorat_cache`) **Pflicht** mit dieser Migration. UNIQUE-Indexe anpassen.

Bestehende Cache-Einträge bekommen `provider = ai.provider`-Default im Backfill.

### i18n

`admin.users.aiProvider`, `admin.users.aiProvider.global`, `admin.users.aiProvider.notConfigured`, `admin.users.aiProvider.effective` (`{provider} ({source})`-Pattern). `chat.providerHint` (`Antwortet via {provider}`).

### Tests

- Unit: `tests/unit/ai-resolve.test.mjs` — Override > Global > Default, NULL-Fallback, ungültiger Override.
- Unit: `tests/unit/context-budget-per-provider.test.mjs` — `INPUT_BUDGET_TOKENS` skaliert; Cache-Key enthält Provider.
- Integration: `tests/integration/per-user-provider.test.js` — drei Mock-User mit Overrides, Job-Run, richtiger Mock-AI-Endpoint.
- E2E: Smoke gegen `AdminUsersCard`-Combobox.

### Risiko / Edge-Cases

- **In-Flight-Jobs beim Override-Wechsel:** Job hält alten Client-Singleton via Closure → läuft mit altem Provider zu Ende. Akzeptabel.
- **Buch-Owner ≠ Job-Starter:** Provider des **Job-Starters** zählt; Cost-Budget gehört zum Starter.

### Doku

- [docs/erd.md](erd.md) — `ai_provider_override`-Spalte + `provider`-Spalten in Cache-Blöcken + Stand-Zeile.
- [docs/ai-providers.md](ai-providers.md) — Auflösungs-Reihenfolge, Cache-Key-Erweiterung.
- [CLAUDE.md](../CLAUDE.md) — KI-Provider-Block: Per-User-Override-Hinweis (kurz, Verweis auf `ai-providers.md`).

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
| 0b Frontend | 0.5–1 Tag | niedrig (2 Trigger-Punkte anbinden) |
| 1 | 4–6 Tage | mittel (Backend-Disjunktion, Test-Pflege gegen beide) |
| 2 | 2–3 Tage | niedrig |
| 3 | 2–3 Tage | niedrig |
| 6 | 2–3 Tage | niedrig |
| 7 | 4–6 Tage | mittel (FTS5-Schema + Sync-Hooks + UI) |
| 8 | 4–6 Tage | mittel-hoch (Bulk-Copy + FK-Repair + ID-Map + Round-Trip-Tests) |
| 9 | 1–2 Tage | niedrig (Doku-Sweep) |
| 10 | 1–2 Tage | mittel (Diff-Test gegen Bestand) |
| 11 | 1.5–2 Tage | niedrig-mittel (Cache-Key-Migration, Per-Call-Resolve) |

**Realistischer Rahmen:** ≈ 20–35 Vollzeit-Tage Coding für offene Phasen. Test-Sweep gegen beide Backends + i18n-Doppelpflege + ERD-Update sind im Tages-Wert nicht voll abgebildet.
