# BookStack-Exit-Plan

Schrittweise Loslösung von BookStack als Storage/Auth/Editor-Backend. Eigene Persistenz, eigene Benutzerverwaltung, eigener Editor. Jede Phase shippable, hinter Feature-Flag, reversibel bis Phase 7. Replica-Modell zuerst (BookStack bleibt Wahrheit), später Flip auf eigene SSoT.

**Diese Datei ist ein Migrationsplan, kein Stand-Dokument** — bewusste Ausnahme zur CLAUDE.md-Doku-Stil-Regel. Sobald eine Phase live ist, gehört der dauerhafte Teil davon in CLAUDE.md / passende `docs/`-Spickzettel; dieser Plan wird dann beim Abhaken gestrichen.

---

## Vor-Phase — Repo-Indirektion (Architektur-Abstraktion ohne Storage-Swap)

Ziel: Editor/Lektorat/Chat/History sprechen nur noch mit einer Domain-Repository-API (`contentRepo` Frontend, `content-store` Server). BookStack-URL-Form, BookStack-JSON-Shape und Token-Hantierung bleiben auf wenige Dateien begrenzt. Phase 1 (Read-Replica) tauscht dann nur Implementierungen, keine Call-Sites.

**Status:**

- [x] **Schritt 1 — Server: Normalisierte Endpunkte.** [lib/content-mapper.js](../lib/content-mapper.js) (mapBook/mapChapter/mapPage/mapPageMeta) + [routes/content.js](../routes/content.js) gemountet unter `/content`. Endpunkte: `GET /content/books`, `GET /content/books/:id`, `GET /content/books/:id/tree`, `GET /content/chapters/:id`, `GET /content/pages/:id`, `PUT /content/pages/:id` (mit `cleanPageHtml`), `POST /content/books` (upserted lokale books-Row). Intern weiter `bsGet`/`bsGetAll`/`bsPut`/`bsPost` aus [lib/bookstack.js](../lib/bookstack.js) — `bsPut` neu für symmetrischen Write-Chokepoint. Unit-Test: [tests/unit/content-mapper.test.mjs](../tests/unit/content-mapper.test.mjs).
- [ ] **Schritt 2 — Frontend: Repository-Modul.** `public/js/repo/content.js` mit `listBooks/bookTree/loadPage/savePage/createBook`. SW-Cache-Namespace `/content/*` (kein Konflikt mit `/api/*`-Legacy-Cache).
- [ ] **Schritt 3 — Call-Sites umstellen:** [public/js/tree.js](../public/js/tree.js) (3× `bsGetAll` → `bookTree`), [public/js/api-bookstack.js](../public/js/api-bookstack.js) (page-load/save), [public/js/editor/edit.js](../public/js/editor/edit.js), Chat-Apply, History-Restore, Lektorat-Apply. `routes/books.js` POST → ruft intern `contentRouter`-Logik bzw. Frontend → `POST /content/books`.
- [ ] **Schritt 4 — Server-Loader-Abstraktion:** `lib/content-store.js` mit `loadPage/loadBook/savePage`; [routes/jobs/shared/loader.js](../routes/jobs/shared/loader.js) und [routes/content.js](../routes/content.js) konsumieren `content-store`, Token-Param verschwindet aus Job-Routen.
- [ ] **Schritt 5 — Token-Leak schliessen:** `req.session.bookstackToken` nur noch in [lib/bookstack.js](../lib/bookstack.js) + `content-store.js`. [routes/books.js](../routes/books.js)/[routes/book-editor.js](../routes/book-editor.js)/[routes/export.js](../routes/export.js) lesen Token nicht mehr direkt.
- [ ] **Schritt 6 — Tripwires:** Grep-Check in CI: `bsGet|bsPut|bsPost|bsGetAll` nur in `lib/bookstack.js`, `lib/content-store.js`, `lib/load-book-contents.js`, `routes/content.js` (Server) + `public/js/api-bookstack.js`, `public/js/repo/content.js` (Frontend). Sonst Fail.

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
| 1 | Read-Replica (Pull-only) | ja (Flag) | keiner | 0 |
| 2 | Eigene Page-Revisions | ja | feinere History | 0 |
| 3 | Eigene Sortierung | ja (Push-back) | schnellerer Reorder | 0, 1 |
| 4a | App-User-Verwaltung | mittel (FK-Recreate) | Admin-Karte; restriktive Logins; User-Invite-Flag | 0 |
| 4b | Book-ACL + Sharing (owner/editor/lektor/viewer) | ja | Buchliste filtert auf Shares; Rollen-Matrix | 0, 4a |
| 4b1 | Reader-View (Kindle-artig) | ja | Lese-UI für viewer (und alle) | 4b |
| 4c | Admin-Settings (Claude-Config) | ja | Admin-UI für Provider/Modell | 4a |
| 5 | Dual-Write | mittel | offline-fähig | 1, 2, 3 |
| 6 | Tags/Kategorien | ja | Filter-UI | 0, 4a |
| 7 | Volltextsuche (FTS5) | ja | App-eigene Suche, parallel zu BookStack | 1, 2, 4b |
| 8 | Kill BookStack | one-way | Editor-Wechsel sichtbar | 1–7 |
| 9 | Doku-Update (Standalone) | ja | keiner (Doku) | 8 |

**Start-Reihenfolge:** 0 → 4a → 4c → 4b → 4b1 → 2 → 6 → 1 → 3 → 7 → 5 → 8 → 9.
4a/4c/4b zuerst, weil User-Identität und ACL die SSoT für alle folgenden Phasen sind. Reader-View (4b1) direkt danach, weil sie der einzige UI-Pfad für Viewer ist — ohne sie hat Viewer-Rolle kein sinnvolles Frontend. Phase 7 (Suche) **vor** Phase 8 (Kill), damit BookStack-Search-Pfad beim Exit nur noch entfernt, nicht ersetzt werden muss.

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

## Phase 1 — Read-Replica (Pull-only)

Ziel: Lesepfad zieht aus lokaler DB, BookStack nur noch beim Sync.

**Sync-Worker** `lib/replica-sync.js` (neu):
- Pro Buch: `GET /api/books/:id` + `GET /api/books/:id/chapters` + Pages-Paginierung via `bsGetAll`.
- Body via Page-Detail (`GET /api/pages/:id`).
- Diff via `updated_at`: stale → Refetch + Update.
- Hierarchie/Order: BookStack-`priority` → lokales `position` (lockstep).
- Trigger: `POST /sync/book/:id` manuell + Cron 02:00 (existiert in [routes/sync.js](../routes/sync.js)) + bei jedem Page-Open ein Lazy-Refresh-Check.

**Read-Routes** (neu, lokal):
- `GET /local/books`, `/local/books/:id`, `/local/books/:id/contents`, `/local/pages/:id`.

**Frontend**: `bsGet`/`bsGetAll`-Wrapper kriegt Feature-Flag `USE_LOCAL_READS`. Shadow-Phase (beide Pfade aufrufen, Diff im Log) → harter Switch.

Bestehende Caches (`page_stats`, `chapter_extract_cache`) lesen schon aus lokalen Tabellen — kein Bruch.

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

**Login-Flow** (Umbau in [routes/auth.js](../routes/auth.js)):
1. Google-OIDC-Callback liefert verifizierte Email.
2. Lookup in `app_users`.
3. `status='active'` → Session anlegen, `last_seen_at` updaten, Audit `login`.
4. `status='suspended'` oder `'deleted'` → 403, Audit `login-denied`.
5. Kein Treffer, aber gültiger Invite-Token (Query-Param `?invite=…`) → User aus Invite anlegen, `status='active'`, Invite `accepted_at` setzen.
6. Kein Treffer, kein Invite → 403, Hinweis „Zugang nicht freigeschaltet".

**Open-Signup-Schalter**: Env `ALLOW_OPEN_SIGNUP=false` (Default). Wenn `true`: Schritt 6 legt User automatisch als `status='active', global_role='user'` an.

**Initial-Admin**: Env `INITIAL_ADMIN_EMAIL`. Beim ersten Server-Start nach 4a: wenn `app_users` leer, wird genau dieser User mit `global_role='admin'` angelegt (bzw. beim ersten Login promoted).

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
- `INITIAL_ADMIN_EMAIL` → wenn matched, `global_role='admin'`.

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

**Backfill**: Migration scannt `books.owner_email`, schreibt Owner-Row in `book_access`. Bücher ohne `owner_email`: erste Person, die nach 4b zugreift, wird Owner — aber nur, wenn `INITIAL_ADMIN_EMAIL` nicht greift (Admin darf gerade kein Buch-Owner werden, sonst Privacy-Bruch). Konkret: Backfill fragt manuell pro Legacy-Buch oder lässt es im „herrenlos"-Zustand mit Admin-Hint.

---

## Phase 4b1 — Reader-View (Kindle-artiger Lesemodus)

Eigene Lese-UI für `viewer` (optional auch von Owner/Editor/Lektor als „Lesen statt Bearbeiten"-Variante nutzbar). Ziel: ablenkungsfreier Buch-Lesemodus, der wie ein E-Reader (Kindle-Web, Apple Books, Readwise Reader) funktioniert — nicht der heutige Editor-im-Read-Only-Mode.

**Abgrenzung zum heutigen Editor**: Editor zeigt eine Page in Roh-HTML mit Toolbar/Findings/Margins/Logs/Chrome. Reader zeigt **Buch als kontinuierlichen Lese-Fluss** über Kapitelgrenzen, schöne Typo, kein App-Chrome, Tastatur-Navigation.

**Neue Karte `ReaderCard`** (`FEATURES`+`EXCLUSIVE_CARDS`+`ALLOWED_KEYS`-Eintrag, `minRole: 'viewer'`):

Layout:
- Vollflächiger Lese-Container, max-width ~680px (Buch-Spaltenbreite). Side-Margins via CSS `--reader-margin`. Mobile: full-bleed mit Padding.
- Header dünn: Buchtitel, aktuelles Kapitel, Progress-Bar (gelesene Zeichen / Gesamt), Schliessen-Button.
- Footer dünn: Vor/Zurück-Kapitel, Page-Indikator („Seite 3 von 12 in Kapitel X").
- Body: Kapitel-für-Kapitel zusammenhängend gerendert (BookStack-Pages innerhalb eines Kapitels nahtlos verkettet, gleiche HTML→Render-Pipeline wie heute). Page-Trenner subtil: kleiner zentrierter Glyph oder dünne hr.
- Kapitel-Trenner: Kapitel-Titel als grosse H1 auf eigener „Seite" (Scroll-Snap-Punkt). Inhalt davor mit grosszügigem Bottom-Padding.

Reader-Features:
- **Theme**: hell / sepia / dunkel. Toggle als kleines Floating-Control oben rechts. Persistiert in `user_settings.reader_theme`.
- **Typo-Settings**: Schriftgrösse (S/M/L/XL), Zeilenhöhe (kompakt/normal/luftig), Schrift (Serif-Default „Source Serif"/„Lora", Sans-Option, Dyslexie-freundliche Option „Atkinson Hyperlegible"). Alles in `user_settings.reader_typo` als JSON.
- **Spalten**: einspaltig (Default), zweispaltig auf breiten Viewports (>1400px). Reine CSS-`column-count`-Geschichte, keine eigene Pagination-Engine.
- **Lesefortschritt pro Buch**: `reader_progress`-Tabelle (Phase 4b1-Migration) speichert pro `(book_id, user_email)` den zuletzt gelesenen `page_id` + Scroll-Offset (in Prozent der Page-Höhe). Beim Öffnen springt Reader an die Stelle.
- **Bookmarks**: User markiert Position. Liste in Sidebar/Modal. CRUD auf `reader_bookmarks` (`id, book_id, user_email, page_id, anchor TEXT, label TEXT, created_at`).
- **Highlights + Notizen** (optional, Phase 4b1.1): Selektion → Floating-Toolbar mit Farben + Notiz-Feld. Speichert Range + Color + Note in `reader_highlights`. Render legt absolute Overlays über Text. Solid-State: nur Bookmarks ohne Range — Highlights als Stretch-Goal markieren.
- **TOC-Drawer**: Slide-in von links mit Kapitel-Liste (Klick = Sprung), aktueller Eintrag highlighted.
- **Suche im Buch** (Phase 7 wiederverwenden): Cmd/Ctrl+F im Reader → Inline-Find-Bar. Wenn Phase 7 noch nicht da: simple `textContent`-Suche im aktuellen Kapitel-Markup.
- **Tastatur**: Pfeiltasten = Scroll, Page Up/Down = Seitenweise (CSS-Scroll-Snap), `n`/`p` = nächstes/vorheriges Kapitel, `b` = Bookmark setzen, `t` = TOC.
- **Keine KI-Funktionen, keine Stats, keine Margin-Annotations, keine Toolbar**. Reader ist Lese-Modus, nichts weiter.

Migration N+4b1:

```sql
CREATE TABLE reader_progress (
  book_id INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
  user_email TEXT NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  page_id INTEGER REFERENCES pages(page_id) ON DELETE SET NULL,
  scroll_pct REAL DEFAULT 0,  -- 0..100, Position innerhalb der page_id
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (book_id, user_email)
);

CREATE TABLE reader_bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
  user_email TEXT NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  page_id INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
  anchor TEXT,    -- CSS-Selector oder Char-Offset für Sub-Page-Position
  label TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_reader_bookmarks_user_book ON reader_bookmarks(user_email, book_id);

ALTER TABLE user_settings ADD COLUMN reader_theme TEXT DEFAULT 'light';
ALTER TABLE user_settings ADD COLUMN reader_typo_json TEXT;
```

Routen:
- `GET /reader/:book_id` → kompletter Buchinhalt (Kapitel + Pages, Body-HTML, Reihenfolge aus Phase 3-`book_order`). ACL: `viewer`+. Einmaliger Bulk-Load, kein Page-by-Page-Fetch — Reader soll offline-tauglich sein (Stretch).
- `GET /reader/:book_id/progress`, `PUT /reader/:book_id/progress`.
- `GET /reader/:book_id/bookmarks`, `POST`, `PUT /:id`, `DELETE /:id`.
- Export-Route (`/export/...`) bleibt — Reader hat „Buch herunterladen"-Button als Shortcut.

Frontend-Module:
- `public/js/cards/reader-card.js` — Alpine-Card mit Lifecycle (load → render → restore-progress → throttled-progress-save bei Scroll).
- `public/js/reader/` (Subfolder, weil > 600 LOC erwartbar):
  - `reader-render.js` — Buchinhalt → HTML-Stream mit Kapitel-Sections, page-data-Attributen für Progress-Tracking.
  - `reader-progress.js` — IntersectionObserver auf Page-Markern, throttled PUT `/progress`.
  - `reader-bookmarks.js` — CRUD + Drawer-Rendering.
  - `reader-typo.js` — Theme/Schrift/Grösse-Preferences.
- CSS in `public/css/reader/` (Subfolder): `reader-shell.css`, `reader-typo.css` (font-family per Theme, line-height-Stufen), `reader-themes.css` (hell/sepia/dunkel als CSS-Custom-Prop-Overrides), `reader-bookmarks.css`. `<link>`-Reihenfolge in [public/index.html](../public/index.html) ergänzen + `SHELL_CACHE` bumpen.

i18n:
- `reader.title`, `reader.theme.light|sepia|dark`, `reader.typo.size|line|font`
- `reader.font.serif|sans|dyslexic`
- `reader.bookmark.add|remove|empty`, `reader.toc.title`
- `reader.progress.read` (mit `{pct}`), `reader.chapter.of` (mit `{i}`/`{n}`)

Lifecycle / Sub-Komponenten-Pattern:
- `ReaderCard` ist eigene Sub-Komponente (`Alpine.data('readerCard', …)`). Wegen Vollfläche: macht `_closeOtherMainCards('reader')` beim Open.
- Toggle via Buchliste-Menü („Lesen") + Quick-Pill „Reader" + Command-Palette-Action `action.reader`.
- Schliessen via Esc, Schliessen-Button, oder Klick auf anderen Buchwechsel-Trigger.
- Hash-Router-Eintrag `#reader/:book_id` (+ optional `#reader/:book_id/p/:page_id`).

Tests:
- Unit: Reader-Render (Buchinhalt → erwartete Kapitel-Anker-Struktur, Bulk-Load-Format).
- Unit: Progress-Throttle (Mock-IntersectionObserver, prüft maximal 1 PUT/2s).
- E2E: Reader öffnen → Theme wechseln → Bookmark setzen → schliessen → erneut öffnen → Position wiederhergestellt.
- A11y: Tastatur-Nav alle Shortcuts, Screenreader-Landmarks (header/main/footer roles).

Aufwand: 4-6 Tage (inkl. Typo-Refinement + Themes; ohne Highlights). Highlights als +2 Tage optional.

---

## Phase 4c — Admin-Settings (Claude-Config)

Admin-Domäne ist User + Provider-Konfiguration. KI-Provider-Settings wandern von `.env` in DB (oder Hybrid).

**Migration N+4c**:

```sql
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by TEXT
);
```

**Verwaltete Keys** (alle scoped auf `ai.*` / `app.*`):
- `ai.provider` → `'claude'|'ollama'|'llama'`.
- `ai.claude.api_key` → AES-256-GCM-encrypted (`enc:v1:`-Prefix, siehe [lib/crypto.js](../lib/crypto.js)).
- `ai.claude.model` (Override für `MODEL_NAME`).
- `ai.claude.max_tokens_out` (Override für `MODEL_TOKEN`).
- `ai.claude.context_window` (Override für `MODEL_CONTEXT`).
- `ai.ollama.host`, `ai.ollama.model`, `ai.ollama.temperature`.
- `ai.llama.host`, `ai.llama.model`, `ai.llama.temperature`.
- `app.allow_open_signup` (Override für ENV).
- `app.initial_admin_email` (read-only nach Setup).

**Auflösungs-Reihenfolge** in [lib/ai.js](../lib/ai.js):
1. DB-Setting (`app_settings`).
2. ENV-Variable.
3. Hardcoded-Default.

ENV bleibt Bootstrap-Mechanismus für erstes Start-Up (insb. Initial-Admin-Email + Anthropic-Key, falls Setup-UI noch nicht erreichbar). Sobald DB-Setting existiert, hat es Vorrang.

**Routen** (Admin-only):
- `GET /admin/settings` → liefert alle Keys (API-Keys maskiert: nur letzte 4 Zeichen).
- `PUT /admin/settings/:key` → Single-Key-Update.
- `POST /admin/settings/test-provider` → führt Mini-Probecall (1-Token-Output) gegen den aktuell konfigurierten Provider aus, gibt Latenz + Erfolg zurück.

**Frontend — neue Karte `AdminSettingsCard`** (zweite Admin-Karte neben `AdminUsersCard`):
- Tab „Provider": Auswahl Claude/Ollama/Llama + Per-Provider-Inputs.
- Tab „Modell": Modell-ID, Token-Limits, Kontext-Grösse.
- Tab „Auth": Open-Signup-Toggle, Initial-Admin-Anzeige.
- „Verbindung testen"-Button → Probecall.
- API-Key-Input mit Masking. Save sendet ungespeichert nur, wenn Wert geändert.

**i18n**:
- `admin.settings.title`, `admin.settings.provider`, `admin.settings.model`
- `admin.settings.testConnection`, `admin.settings.connectionOk`, `admin.settings.connectionFail`
- `admin.settings.apiKeyMasked`

**Sicherheit**:
- API-Keys nie im Klartext über die Wire (auch nicht Admin → Frontend). Beim Lesen Maskierung; beim Schreiben akzeptiert Backend einen Sentinel-Wert „unchanged" für Felder, die nicht angefasst wurden.
- DB-Spalte AES-256-GCM-verschlüsselt mit `MASTER_KEY`-ENV (existiert schon für Bookstack-Tokens, [lib/crypto.js](../lib/crypto.js)).

---

## Phase 5 — Dual-Write

Schreibpfad hybrid:
1. Lokal schreiben (Page-Body, Revision-Row, Order).
2. `pages.dirty=1`.
3. Async-Push-Worker pusht zu BookStack; bei Erfolg `dirty=0`, `remote_updated_at` neu.

**Konflikt** (BookStack-`updated_at` weicht ab beim Push): Konflikt-Revision (`source='conflict'`) + Page-Flag im Tree → User entscheidet manuell.

Frontend `bsPut` → `localPut`. Lokale Routes brauchen keinen SW-API-Cache-Invalidation. `fresh:true`-Pflicht reduziert sich auf BookStack-Direktzugriffe (= nur noch im Push-Worker).

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

## Phase 8 — Kill BookStack

Voraussetzung: Phasen 1–7 stabil, Push-Worker schmerzfrei, keine Edits über BookStack-UI mehr, eigene Suche live.

- Sync auf bidirektional → dann einmalig-final.
- BookStack-Container abschalten.
- Löschen aus Code:
  - [routes/proxies.js](../routes/proxies.js) (BookStack-Teil)
  - `public/js/api-bookstack.js`
  - `public/js/bookstack-search.js` (BookStack-Search-Pfad; eigene Suche aus Phase 7 bleibt)
  - `bsGet`/`bsPut`-Wrapper
  - `bookstackToken` aus Session
- **WYSIWYG**: TipTap einbauen (Phase 8a, eigener PR). Body bleibt HTML-kompatibel. Editor-Subs (`editor-toolbar`, `editor-find`, `editor-synonyme`, `editor/edit`) liegen schon hier; nur die TinyMCE-Schnittstelle muss ersetzt werden.
- **Export**: BookStack-`/export/{fmt}`-Proxy ersetzen durch eigene Renderer (HTML/Markdown). Custom-PDF bleibt wie heute.
- **Templates**: falls genutzt (siehe [docs/bookstack-templates.md](bookstack-templates.md)) — eigene Template-Tabelle + Picker.

---

## Phase 9 — Doku-Update (Standalone-App)

Nach Phase 8 ist BookStack als Abhängigkeit raus. Sämtliche Doku, die noch von „BookStack-Basis", „bewusste Abhängigkeit" oder BookStack-Setup spricht, wird auf Standalone-Realität umgestellt. Reine Doku-Phase, kein Code-Risiko.

**Zu aktualisieren:**

- **[README.md](../README.md)** — Intro neu (Standalone-App, kein BookStack-Backend mehr), Deployment-Block (LXC + systemd) auf neue Architektur ohne BookStack-Container, Env-Variablen-Liste durchgehen: `BOOKSTACK_BASE_URL`/`BOOKSTACK_TOKEN_ID`/`BOOKSTACK_TOKEN_SECRET` etc. raus, neue App-eigene Vars rein (eigener Editor, eigene Suche, eigene User-DB). Architektur-Diagramm: BookStack-Box entfernen, NGINX → Express direkt.
- **[CLAUDE.md](../CLAUDE.md)** — Header-Zeile „Auf BookStack-Basis (bewusste Abhängigkeit — Storage, Auth, Editor)" löschen. Architektur-Überblick: BookStack-Proxy-Routen (`/api/*`) raus, eigene Page-/Editor-Routen rein. Harte Regeln durchgehen: `bsGetAll`/`bsGet`/`bsPut`-Regel raus oder durch App-eigene RMW-Regel ersetzen; `bsGet(..., { fresh: true })`-Regel entweder löschen (kein SW-API_CACHE mehr für BS-Calls) oder auf eigene Cache-Schicht umformulieren. Read-Modify-Write-Pfade neu beschreiben. `lib/bookstack.js` aus Projektstruktur raus. Editor-Sektion: TipTap statt TinyMCE-Schnittstelle. Spickzettel-Links: [docs/bookstack-exit.md](bookstack-exit.md) und [docs/bookstack-templates.md](bookstack-templates.md) streichen.
- **[LICENSE](../LICENSE)** — Lizenzdatei prüfen: bisheriger Stand orientierte sich an BookStack-Kontext (AGPL-Pflicht durch BookStack-Abhängigkeit). Standalone-App kann frei wählen — Lizenzwahl bewusst neu treffen (AGPL beibehalten / MIT / proprietär self-hosted). Copyright-Header (`Copyright © …`) auf aktuellen Stand bringen. Third-Party-Notices: BookStack-Erwähnung raus, neue Deps (TipTap, eigene Search-Lib) ergänzen.
- **Deploy-Doku** (README-Block + ggf. `docs/deploy.md` neu) — LXC-Container-Setup ohne BookStack-Sub-Container. systemd-Unit der App bleibt; BookStack-Unit + MariaDB-Backup-Snippets entfallen. NGINX-Konfig: Proxy-Pass auf `/api/` raus, Reverse-Proxy nur noch auf App-Port 3737. Backup-Strategie: nur noch eigene SQLite-DB + Uploads (statt MariaDB-Dump + BookStack-Storage). Migration-Notes für bestehende User: BookStack-DB final exportiert → App-DB übernommen, BookStack-Container kann gestoppt + entfernt werden.
- **Spickzettel-Cleanup** in [docs/](./):
  - [bookstack-templates.md](bookstack-templates.md) — entweder ersatzlos löschen oder in neue „Template-Verwaltung"-Doku überführen, falls Templates aus Phase 8 übernommen.
  - [bookstack-exit.md](bookstack-exit.md) (diese Datei) — beim Abschluss von Phase 9 streichen; CLAUDE.md-Verweis darauf ebenfalls entfernen (steht aktuell als Ausnahme zur „Stand-only"-Regel drin).
  - [erd.md](erd.md), [jobs.md](jobs.md), [i18n.md](i18n.md), [ai-providers.md](ai-providers.md), [testing.md](testing.md), [figur-werkstatt.md](figur-werkstatt.md), [buchchat-tools.md](buchchat-tools.md), [focus-editor.md](focus-editor.md), [state-modell.md](state-modell.md), [finetuning.md](finetuning.md), [wordpress-import.md](wordpress-import.md) — jeweils auf BookStack-Referenzen grep'pen und auf Standalone-Pendants umstellen.
- **`package.json`** — Description-Feld + `keywords` von BookStack-bezogenen Begriffen befreien. Repo-URL / Homepage aktualisieren, falls bisher auf BookStack-Fork verwies.
- **Tests-Doku** — [tests/](../tests/) README (falls vorhanden) auf neue Editor-/Persistenz-Schicht anpassen. E2E-Tests, die `bsGet`-Mocks brauchten, sind in Phase 8 schon umgestellt; Doku synchron.

**Reihenfolge innerhalb Phase 9:** README + CLAUDE.md zuerst (Einstiegspunkte für neue Contributors + Sessions), dann LICENSE, dann Deploy-Block, dann Spickzettel.

---

## Risiken / offene Fragen

- **Lektor-Apply-Range-Drift**: Lektorat-Findings haben Positionen im damaligen Body. Wenn Lektor anwendet und Page zwischenzeitlich von Editor verändert wurde, greift bereits der `updatedAt`-Staleness-Check (CLAUDE.md-Regel „Job-Ergebnisse mit `updatedAt`-Staleness-Check"). Lektor-Apply muss denselben Vergleich machen — Server-Route lehnt 409 ab, wenn `pages.updated_at` differiert vom Snapshot, der das Finding erzeugt hat.
- **Viewer-Lean-Endpoint**: separater `?lean=true`-Pfad für Buchliste/Overview vermeidet, dass Viewer-Frontend versehentlich Analyse-Daten lädt (Token-Verbrauch via Lazy-Refresh, Privacy bei „Was lektoriert hat KI?"). Alternativ: Server liefert für `viewer` per default lean, ohne Param. Letzteres robuster, Konsequenz: Tile-Layout muss leere Slots verkraften.
- **Lektor + Buch-Chat**: Buch-Chat ist heute Analyse-Werkzeug ohne Schreibwirkung — könnte Lektor sehen dürfen. Default: nein (sonst werden Token-Kosten unkontrolliert). Toggleable in BookSettings durch Owner.
- **`can_invite_users` ohne Buch-Share**: User mit Invite-Recht aber ohne aktuelle Buch-Rolle (z.B. Ex-Mitarbeiter, deren Share widerrufen wurde, behalten Invite-Flag) sehen nichts in der App. Nicht falsch, aber UX-Hinweis nötig.
- **Owner-Transfer-Workflow**: Auto-Accept oder zweistufig (neuer Owner bestätigt)? Solo-Tenant heute: Auto-Accept reicht.
- **Email-Versand**: Invites + Ownership-Transfer brauchen SMTP, sonst Token-Copy-Workflow. Akzeptabel als MVP, später ausbaubar.
- **veraPDF**-artiger optionaler Setup-Schritt für TipTap-Editor-Erweiterungen (Inline-Bilder, Tabellen): später entscheiden.
- **Privacy bei Logs**: Winston-Logs enthalten `user_email`. Bleibt — Self-Hosted, Betreiber sieht Logs sowieso.
- **Audit-Tabelle vs. DSGVO**: bei Hard-Delete-Request müsste `user_sessions_audit` ebenfalls anonymisiert werden. Heute irrelevant (Solo-Self-Hosted), aber Schema-Spalte für Pseudonymisierung offen halten.

---

## Aufwand grob

| Phase | Aufwand | Risiko |
|---|---|---|
| 0 | 0.5 Tag | niedrig |
| 1 | 3-5 Tage | niedrig (Shadow-Phase) |
| 2 | 2-3 Tage | niedrig |
| 3 | 2-3 Tage | niedrig |
| 4a | 4-6 Tage | mittel (FK-Recreate, Login-Flow) |
| 4b | 4-5 Tage | mittel (Rollen-Matrix + Apply-Routen + minRole-Filter) |
| 4b1 | 4-6 Tage | niedrig (reines Frontend + 2 Mini-Tabellen) |
| 4c | 2-3 Tage | niedrig |
| 5 | 4-6 Tage | mittel-hoch (Konflikt-Pfad) |
| 6 | 2-3 Tage | niedrig |
| 7 | 4-6 Tage | mittel (FTS5-Schema + Sync-Hooks + UI) |
| 8 | 1-2 Wochen | hoch (Editor-Wechsel, Export-Renderer) |
| 9 | 1-2 Tage | niedrig (Doku-Sweep) |

Gesamt ca. 8-11 Wochen Vollzeit, mit Puffer.
