# Blog-Sync (WordPress ↔ Buch)

Spec für bidirektionale Synchronisation zwischen einem self-hosted WordPress-Blog und einem Buch vom Typ `blog`.

## Eckdaten

- **Mapping:** 1 Blog == 1 Buch. 1 WP-Post == 1 Page in der App.
- **Gating:** Verbindung nur konfigurierbar, wenn `buchtyp === 'blog'` (siehe `prompt-config.json`).
- **Auth:** Basic-Auth über HTTPS. URL/User/Password pro Buch in den Bucheinstellungen.
- **Trigger:** manuell. Einmaliger Initial-Import + ad-hoc Pull/Push. Kein Cron.
- **Editor:** WordPress Block-Editor (Gutenberg) only. Classic-Editor-Posts werden importiert, beim Push wieder als Block-HTML rausgeschrieben.
- **Out-of-Scope:** Categories/Tags-Mapping, Medien-Upload (Featured-Image, Inline-Bilder), Auto-Pull, Mehrere Blogs pro Buch.

## Konflikt-Strategie (LWW)

Vergleich `wp.modified_gmt` ↔ `pages.updated_at`. 4 Fälle pro Pull:

| WP neuer als Link | App neuer als Link | Aktion |
|---|---|---|
| ja | nein | WP → App (Update der Page) |
| nein | ja | nichts; gehört in Push |
| nein | nein | no-op |
| ja | ja | `conflict_state='detected'` → User löst via Diff |

`blog_page_links.last_pulled_at` ist der Referenzpunkt für „App seit letztem Pull geändert".

## Schema-Migration N

Zwei neue Tabellen. Pflicht: `foreign_key_check`, `UPDATE schema_version`, `npm run squash:regen`, [erd.md](erd.md) updaten.

```sql
CREATE TABLE blog_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL UNIQUE REFERENCES books(book_id) ON DELETE CASCADE,
  base_url TEXT NOT NULL,                -- https:// nur
  username TEXT NOT NULL,
  password_enc BLOB NOT NULL,            -- AES via lib/crypto.js
  default_status TEXT NOT NULL DEFAULT 'draft'
    CHECK(default_status IN ('draft','publish','private')),
  initial_import_done_at TEXT,           -- NULL = noch nie importiert
  last_pull_at TEXT,
  last_push_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE blog_page_links (
  page_id INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
  blog_id INTEGER NOT NULL REFERENCES blog_connections(id) ON DELETE CASCADE,
  wp_post_id INTEGER NOT NULL,
  wp_modified_at TEXT NOT NULL,
  wp_status TEXT,
  wp_slug TEXT,
  last_pulled_at TEXT,
  last_pushed_at TEXT,
  conflict_state TEXT
    CHECK(conflict_state IN (NULL,'detected','resolved-app','resolved-wp')),
  UNIQUE(blog_id, wp_post_id)
);
CREATE INDEX idx_blog_page_links_blog ON blog_page_links(blog_id);
```

## Server-Module

| File | Inhalt |
|---|---|
| `lib/wp-client.js` | Basic-Auth-Header, HTTPS-Pflicht (`validateBaseUrl`), Pagination via `X-WP-TotalPages`, Retry/Backoff bei 429/5xx. Methoden: `me()`, `listPosts({ page, perPage, modifiedAfter? })`, `getPost(id)`, `createPost(payload)`, `updatePost(id, payload)`. Keine Media/Categories/Tags-Endpoints. |
| `lib/wp-html.js` | `wpToAppHtml(raw)`: strip alle `<!-- wp:* -->`/`<!-- /wp:* -->` Kommentare, dann durch `lib/html-clean.js` (Single Chokepoint). `appToWpHtml(html)`: parse via linkedom, pro Block-Element passenden Gutenberg-Kommentar wrappen (siehe Block-Mapping). `<img>`/`<figure>` werden gestrippt. |
| `db/blogs.js` | CRUD für `blog_connections` + `blog_page_links`. Passwort beim Read via `lib/crypto.js` entschlüsseln, nie an Client returnen. |
| `routes/blog.js` | `GET /blog/:book_id/status`, `POST /blog/:book_id/connect`, `DELETE /blog/:book_id/disconnect`. `router.param('book_id', bookParamHandler)` aus `lib/log-context.js`. Connect prüft serverseitig `buchtyp === 'blog'` (sonst 400 `BLOG_REQUIRES_BLOG_TYPE`). |
| `routes/jobs/blog-sync.js` | Job-Typen `blog-import`, `blog-pull`, `blog-push`. Dedup via `findActiveJobId(type, bookId, userEmail)`. |

## Gutenberg-Block-Mapping (Push)

App-HTML → WP-Block-HTML:

| App-Tag | Gutenberg-Wrap |
|---|---|
| `<p>` | `<!-- wp:paragraph -->\n<p>…</p>\n<!-- /wp:paragraph -->` |
| `<h2>` | `<!-- wp:heading {"level":2} -->\n<h2>…</h2>\n<!-- /wp:heading -->` |
| `<h3>` | `<!-- wp:heading {"level":3} -->\n<h3>…</h3>\n<!-- /wp:heading -->` |
| `<ul>` | `<!-- wp:list -->\n<ul>…</ul>\n<!-- /wp:list -->` |
| `<ol>` | `<!-- wp:list {"ordered":true} -->\n<ol>…</ol>\n<!-- /wp:list -->` |
| `<blockquote>` | `<!-- wp:quote -->\n<blockquote class="wp-block-quote">…</blockquote>\n<!-- /wp:quote -->` |
| `<pre>` | `<!-- wp:code -->\n<pre class="wp-block-code">…</pre>\n<!-- /wp:code -->` |
| `<hr>` | `<!-- wp:separator -->\n<hr class="wp-block-separator"/>\n<!-- /wp:separator -->` |
| Inline (`strong`, `em`, `a`, `u`) | unverändert innerhalb des Blocks |
| `<img>`, `<figure>` | strip (Medien ignorieren) |

Unit-Test pro Mapping in `tests/unit/wp-html.test.mjs`.

## Sync-Jobs

### `runBlogImportJob(bookId)` — einmalig

Gated: `initial_import_done_at IS NULL`. Zweiter Aufruf → 400 `ALREADY_IMPORTED`.

1. paginate `listPosts({ perPage: 100 })`
2. pro Post: Page via Content-Store (`createPage`) anlegen mit `wpToAppHtml(content.rendered)`, `page_name = title.rendered`
3. Link-Eintrag in `blog_page_links` mit `wp_modified_at = post.modified_gmt`, `last_pulled_at = NOW_ISO_SQL`
4. Status via `updateJob` mit Key `job.blog.import.progress`, Params `{done, total}`
5. am Ende `initial_import_done_at = NOW_ISO_SQL`

### `runBlogPullJob(bookId)` — manuell, Delta

Voraussetzung: Initial-Import durch. Sonst 400 `IMPORT_FIRST`.

1. `listPosts({ modifiedAfter: conn.last_pull_at })` paginieren
2. pro Post: 4-Fall-LWW aus „Konflikt-Strategie"
3. neue Posts (kein Link, kein Slug-Match) → Page anlegen + Link
4. `last_pull_at = NOW_ISO_SQL`

### `runBlogPushJob(bookId, pageIds[])` — manuell, Multi-Select

1. pro `pageId`:
   - kein Link → `createPost({ title, content: appToWpHtml, status: conn.default_status, slug })` → Link anlegen.
     **Datums-Bump:** matcht `page_name` das Pattern `^(\d{4}-\d{2}-\d{2})(:\s.*)$` und das Datum ≠ `localIsoDate()`, wird vor dem Create auf heute umgeschrieben — WP-Titel und lokaler `page_name` synchron via `contentStore.savePage`. Updates rühren den Titel nicht an.
   - Link da, kein Konflikt → `updatePost(id, …)`, `wp_modified_at` aus Response übernehmen
   - `conflict_state='detected'` → skip, Fehler in Job-Result
2. `last_push_at = NOW_ISO_SQL`

## UI

### BookSettings-Tab „Blog-Verbindung"

Sichtbar nur bei `buchtyp === 'blog'`. Form-Felder:

- URL (HTTPS-Validierung, sonst Submit-Button disabled + Hint)
- Username
- Password (write-only; Read liefert `hasCredentials: true`)
- Default-Status (Combobox: draft/publish/private)
- Test-Button → `users/me` mit `capabilities.edit_posts`-Check

Status-Panel: `initial_import_done_at`, `last_pull_at`, `last_push_at` (alle via `tzOpts`).

Aktion-Buttons:
- **„Initial-Import starten"** — nur sichtbar wenn `!initial_import_done_at`
- **„Pull"** — nur sichtbar wenn Import durch
- **„Disconnect"** — löscht Connection-Row + Links via FK-CASCADE

### Buchorganizer

Pro Page ein eckiges Badge (`--card-accent-blog`) mit Status:

- `synced` — `wp_modified_at == link.wp_modified_at && page.updated_at <= link.last_pulled_at`
- `push-needed` — `page.updated_at > link.last_pulled_at`
- `pull-needed` — Pull hat neueren WP-Modified-Stamp gesehen (selten direkt im Tree, da Pull schon mergt)
- `conflict` — `conflict_state='detected'`

Tooltip via `data-tip`.

Page-Kontext:
- „Zu Blog pushen"
- „Konflikt lösen → Diff" — öffnet `page-revision-diff` gegen `getPost`

Buch-Level: Multi-Select aus Tree + „Lokale Änderungen pushen".

## i18n

Neue Keys in `public/js/i18n/de.json` + `public/js/i18n/en.json`:

```
blog.connect.title|url|user|password|defaultStatus|test|save|disconnect
blog.status.synced|pushNeeded|pullNeeded|conflict|notImported|imported
blog.action.import|pull|push|resolveConflict
blog.error.httpOnly|authFailed|notBlogType|conflictDetected|alreadyImported|importFirst
job.blog.import.progress
job.blog.pull.fetch|job.blog.pull.merge
job.blog.push.upload
```

Persistierte Conflict-Notice in DB: `__i18n:blog.conflict.detected__`.

Buchtyp-Label in [prompt-config.json](../prompt-config.json):

```json
"buchtypen": {
  "de": { "blog": { "label": "Blog", "zusatz": "Blog-Einträge. Pro Eintrag eigenständig…" } },
  "en": { "blog": { "label": "Blog", "zusatz": "Blog posts. Each entry self-contained…" } }
}
```

## Sicherheit

- `base_url` MUSS mit `https://` beginnen — sonst 400 `BLOG_HTTPS_REQUIRED`
- Passwort: AES-Encrypt via [lib/crypto.js](../lib/crypto.js). `GET /blog/:book_id/status` liefert nur `{ hasCredentials, baseUrl, username, defaultStatus, …timestamps }`. PW nie an Client.
- Connect-Test: `users/me` muss `capabilities.edit_posts === true` zurückgeben.
- 401 von WP → Job-Fehler `blog.error.authFailed`
- Buchtyp-Gate serverseitig hart: Connect/Import/Pull/Push prüfen `buchtyp === 'blog'`, sonst 400 `BLOG_REQUIRES_BLOG_TYPE`
- Job-Dedup via `findActiveJobId` verhindert parallele Pull/Push pro Buch
- `setContext({ book: bookId })` in jedem Job-POST (Logging-Slot)

## Tests

### Unit (`tests/unit/`)
- `wp-html.test.mjs` — Block-Wrap/Unwrap Round-Trip, Inline-Erhalt, Image-Strip, alle 8 Block-Mappings
- `wp-client.test.mjs` — Pagination via `X-WP-TotalPages`, 401-Handling, HTTPS-Reject, Backoff bei 429/5xx
- `blog-merge.test.mjs` — alle 4 LWW-Fälle, Slug-Match bei neuen Posts

### Integration (`tests/integration/`)
- `blog-sync.test.js` — Express-WP-Stub, Round-Trip: Initial-Import → lokales Edit → Push → Pull → no-op. Konflikt-Pfad: gleichzeitige Änderung beidseits → `conflict_state='detected'`.

### Drift
- `tests/unit/erd-drift.test.mjs` grünt nach ERD-Update
- `tests/unit/squash-drift.test.mjs` grünt nach `npm run squash:regen`

## Reihenfolge der Umsetzung

1. Buchtyp `blog` in [prompt-config.json](../prompt-config.json) (de+en)
2. Migration N + ERD + `npm run squash:regen` + Drift-Tests grün
3. `lib/wp-client.js` + Unit-Tests
4. `lib/wp-html.js` + Block-Mapping + Unit-Tests
5. `db/blogs.js` + `routes/blog.js` (mit Buchtyp-Gate)
6. `routes/jobs/blog-sync.js` (Import → Pull → Push) + Integration-Tests
7. BookSettings-Tab (Form + Aktionen)
8. Buchorganizer-Badges + Push-Action + Konflikt-Diff-Reuse
9. i18n komplett (de + en synchron)
10. `SHELL_CACHE` bump in [public/sw.js](../public/sw.js)
11. Manuell gegen echte WP-Instanz testen (Test-Buch 102 als Typ `blog`)
