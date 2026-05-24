# Share-Link für Seite/Kapitel

- **Status:** Draft
- **Aufwand:** M (DB-Migration + 1 neuer Public-Route-Cluster + Standalone-Reader-View + Owner-Card + 1 zusätzliche Toolbar/Sidebar-Buttons)
- **Severity:** Low (additives Feature, kein Eingriff in bestehende Editoren oder Auth)

## Context

User will einzelne Seiten oder ganze Kapitel an Externe (Lektoren, Beta-Reader, Freunde) verschicken, ohne dass diese ein Konto im System brauchen. Heute existiert nur die ACL-basierte Freigabe via `book_access` — setzt Account voraus, gibt Schreib-/Lese-Rechte aufs ganze Buch, ist zu schwer für „kurz mal Kapitel 3 zeigen".

Lösungs-Idee: pro Seite/Kapitel ein opaker Share-Token. Wer Link kennt, sieht Read-Only-View mit Autor-Intro oben und Kommentar-Form unten. Inhalt **live** — Autor editiert weiter, Link bleibt synchron.

## Scope MVP

- Owner kann pro Seite **und** pro Kapitel einen Share-Link erstellen.
- Link enthält 22-Zeichen base64url-Token (~128 bit Entropie; nicht erratbar).
- Public-Route `/share/:token` ohne Auth zeigt:
  - Buchtitel + Kapitel-/Seitenname + Autor-Name (Display).
  - Optional vom Owner gesetztes Intro (Plaintext mit `\n\n`→`<p>`, max 2000 Zeichen) als Blockquote.
  - Page-HTML direkt (bereits via [lib/html-clean.js](../../lib/html-clean.js) beim Save sanitisiert).
  - Bei Chapter-Share: alle Seiten des Kapitels in `book_order`-Reihenfolge sequenziell.
  - Kommentar-Liste (chronologisch absteigend) + Submit-Form.
- Owner-UI:
  - Share-Button im Notebook-Editor-Toolbar (Page-Share).
  - Share-Button im Sidebar-Kapitel-Header (Chapter-Share).
  - Neue Karte „Geteilte Links" → Liste aller eigenen Links mit Status (aktiv/expired/revoked), View-Count, Kommentaren (löschbar), Revoke/Update.
- Lifecycle: optionales `expires_at` (Datepicker, leer = nie) + jederzeit revoke (setzt `revoked_at`).
- Spam-Schutz Reader-Kommentare: Honeypot-Hidden-Field + Server-Rate-Limit (3 Kommentare/Stunde pro Token+IP-Hash).
- Mail-Notification an Owner bei neuem Kommentar (synchron via [lib/mailer.js](../../lib/mailer.js)).
- Mobile-/Desktop-Lesbarkeit: zentrierter Text max 70ch, serif body, light/dark via `prefers-color-scheme`, generöse line-height.

## Out-of-Scope

- Edit-Berechtigung für Reader (nur Read-Only).
- Reader-Account-Erstellung („claim this share").
- Volle Buch-Freigabe via Token (nur Page/Chapter).
- Versionierung / Snapshot-Zeitpunkt einfrieren (live only).
- Captcha (Honeypot + Rate-Limit reicht für MVP — Self-hosted, Betreiber kann nachrüsten).
- Markdown-Editor für Intro.
- Owner-Notification via Browser-Push.
- Statistiken jenseits Roh-View-Count (Geo, Referrer, UA-Breakdown).

## Done when

- DB-Migration 145 läuft auf Legacy- und Fresh-DB grün durch (`foreign_key_check` leer, Squash regen).
- Owner kann von Editor + Sidebar einen Link erstellen, kopieren, in Inkognito-Tab öffnen und Inhalt lesen.
- Reader kann ohne Login Kommentar absenden; Owner sieht ihn in der Karte „Geteilte Links" + per Mail.
- Expired/Revoked Links zeigen 410-Gone-View statt Inhalt.
- Mobile (375px viewport) und Desktop (1280px) sehen ansprechend aus; Lighthouse Accessibility ≥95.
- Unit-Tests für Token-Generator + Rate-Limit + CHECK-Constraint grün. Playwright E2E: Share-Flow End-to-End.
- i18n DE+EN komplett, kein hartcodierter Text.

## Hard-Rule-Audit

Pflicht-Check der Hard Rules aus [CLAUDE.md](../../CLAUDE.md):

- **Editor-Spezifikation:** Share-Button wird im **Notebook-Editor**-Toolbar platziert (Code [public/js/cards/editor-toolbar-card.js](../../public/js/cards/editor-toolbar-card.js)). Focus-Editor und Bucheditor erhalten **keinen** Share-Button im MVP. Chapter-Share-Button liegt im Sidebar-Kapitel-Header, **nicht** in einem Editor.
- **UI-Patterns aus DESIGN.md:** Owner-Karte „Geteilte Links" als Standard-Card mit `--card-accent-share`. Eckige Badges für Status (aktiv/expired/revoked). `data-tip` statt `title`. `.collapsible-toggle` falls Kommentar-Listen pro Link gefaltet werden.
- **Prompts:** Feature ruft **keine** KI — keine Prompt-Änderungen.
- **KI-Calls nur via Job-Queue:** n/a.
- **`callAI` JSON-Only:** n/a.
- **Styles nur in public/css/:** neue Datei [public/css/components/share-links.css](../../public/css/components/share-links.css) (Owner-Karte) und [public/css/share.css](../../public/css/share.css) (Reader-Standalone-View). `SHELL_CACHE` bumpen. DESIGN.md „CSS-File-Inventar" ergänzen.
- **UI-Strings nur in i18n-JSON:** alle neuen Keys unter `share.*` in [public/js/i18n/de.json](../../public/js/i18n/de.json) + [public/js/i18n/en.json](../../public/js/i18n/en.json) gleichzeitig. Reader-View nutzt Server-Side `lib/i18n-server.js` mit Sprach-Erkennung aus `Accept-Language` (DE Default, EN Fallback) — User-Setting des Owners ist nicht massgeblich, da Reader kein Account.
- **Content-Store-Facade:** Reader-View liest Pages/Chapters ausschliesslich via `require('lib/content-store')`.
- **HTML→Text-Stats:** n/a (kein neuer Schreibpfad auf `pages`).
- **Job-Ergebnisse mit `updatedAt`:** n/a.
- **401-Handling:** Reader-Route ist **public** — kein 401, sondern 404/410 für invalid/expired. Owner-API-Routes sind auth-pflichtig (Standard).
- **Logging-Context `book`:** Reader-Route lädt Token → setzt `setContext({ book: bookId })` aus [lib/log-context.js](../../lib/log-context.js) nach Token-Resolve. Owner-Routes ebenfalls.
- **`x-html` escaping:** Reader-View ist Server-Side-rendered ohne Alpine — kein `x-html`-Sink. Page-Content kommt bereits sanitisiert via html-clean. Intro + Kommentar-Body werden Server-Side via `escapeHtml`-Helper escaped vor Template-Interpolation. Owner-Karte rendert Kommentar-Body via Alpine-Text-Bindung (kein `x-html`).
- **A11y:** Reader-View bekommt `lang="de"`/`lang="en"`, semantische Headings, Skip-Link zum Inhalt. Owner-Buttons sind echte `<button>`s.
- **Kein globaler Fokus-Ring:** Reader-CSS setzt nichts wildcard. Form-Inputs erben Browser-Default.
- **Progress-Bars:** n/a.
- **Card-Animationen:** Owner-Karte nutzt nur `x-show` + `x-cloak`, keine `x-transition`.
- **Combobox/numInput:** keine Selects oder Number-Inputs in MVP.
- **File-Limits:** Reader-Template < 250 LOC; Owner-Card < 600 LOC. Reader-CSS < 600 LOC.
- **Memo-Pattern:** Owner-Karte hat Methoden, die mehrfach pro Render aufgerufen werden (z.B. `linkStatus(link)`) — `_memo`-Pattern verwenden.
- **State explizit:** Owner-Karten-State (`links[]`, `selectedLinkId`, `editingIntro`, `commentsByToken`) als Initial-Felder im `Alpine.data`-Objekt.
- **Mobile-Strategie:** Reader-CSS Media-Query (`@media (max-width: 600px)`) — Reader-View ist Top-Level, kein Container-Query nötig.
- **DB-Timestamps ISO+Z:** alle `*_at`-Spalten + Defaults via `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. INSERTs liefern `${NOW_ISO_SQL}` explizit.
- **Frontend-Datums-Display:** Owner-Karte rendert `created_at`/`expires_at` via `tzOpts()`-Wrapper. Reader-View rendert Kommentar-Zeitstempel server-side via [lib/local-date.js](../../lib/local-date.js).

## Abhängigkeiten

- Existierende Module: [lib/content-store/](../../lib/content-store/) (Pages/Chapters lesen), [lib/html-clean.js](../../lib/html-clean.js) (Annahme: alle gespeicherten Pages sind sanitisiert), [lib/mailer.js](../../lib/mailer.js) (Notification), [lib/log-context.js](../../lib/log-context.js), [lib/local-date.js](../../lib/local-date.js), [lib/admin-login-ratelimit.js](../../lib/admin-login-ratelimit.js) als Rate-Limit-Pattern-Vorlage, [db/now.js](../../db/now.js).
- Keine neuen npm-Deps. `crypto.randomBytes(16)` aus Node-Stdlib für Token.

## Backend

### Routen-Struktur (`routes/share.js`)

**Public (vor Auth-Guard in [server.js](../../server.js) mounten — Reihenfolge wichtig):**

| Methode | Pfad | Verhalten |
|---|---|---|
| GET | `/share/:token` | SSR-HTML. 404 bei unbekanntem Token, 410-Gone bei `revoked_at` oder `expires_at < now`. Bei erfolgreichem Render: View-Count inkrementieren. |
| POST | `/share/:token/comment` | JSON-Body `{ reader_name?, body, _hp? }`. `_hp` (Honeypot) muss leer sein. Rate-Limit: 3 pro `(token, ip_hash)` pro 60 min. IP-Hash via SHA-256 (ip + Server-Salt) Slice 16 Hex. Owner-Mail nach Insert. |

**Auth (Standard-Guard):**

| Methode | Pfad | Verhalten |
|---|---|---|
| GET | `/share/api/links` | Owner-eigene Links (mit View-Count und Kommentar-Anzahl als JOIN). |
| POST | `/share/api/links` | Body: `{ kind, page_id?, chapter_id?, intro?, expires_at? }`. Validiert Owner-ACL auf Buch (via [lib/acl.js](../../lib/acl.js)). Erzeugt Token. |
| PATCH | `/share/api/links/:token` | Owner-Check. Update Intro, Expires. |
| DELETE | `/share/api/links/:token` | Owner-Check. Setzt `revoked_at` (Soft-Delete, behält Kommentare). |
| GET | `/share/api/links/:token/comments` | Owner-Check. Liste. |
| DELETE | `/share/api/comments/:id` | Owner-Check via JOIN auf Link. |

### Token-Generator

`crypto.randomBytes(16).toString('base64url')` → 22 Zeichen, ~128 bit Entropie. Kollisions-Check beim Insert via UNIQUE-Constraint (DB-Level, PK) + Retry-Schleife (max 3x).

### Reader-Render-Pipeline

1. Token lookup → Link-Row + `setContext({ book: bookId })`.
2. Expiry/Revoke-Check → ggf. 410.
3. ACL: Wenn Owner-Account inzwischen gelöscht → bereits 404 via CASCADE.
4. Content-Load via Content-Store: `loadPage(page_id)` oder `loadChapterPages(chapter_id)` in book_order-Reihenfolge.
5. Display-Daten zusammenstellen: Buchname, Kapitelname, Autor-Display-Name (aus `app_users.display_name`), Intro, Page-HTML(s).
6. Kommentare laden (DESC `created_at`).
7. Template-Rendering via einfache Tagged-Template-Funktion oder String-Replace (kein neuer Template-Engine).
8. View-Count inkrementieren (separater Statement, non-blocking via `setImmediate`).

### Rate-Limit-Helper (`lib/share-ratelimit.js`)

In-Memory-Map `${token}:${ip_hash}` → `[timestamps]`, alte > 60min werden beim Check abgeschnitten. Process-Restart resettet (akzeptabel für MVP, kein Cluster-Setup).

### Mailer-Template

Ergänze in [lib/mailer-templates.js](../../lib/mailer-templates.js): `shareCommentNotification({ ownerLang, bookName, targetName, readerName, body, ownerLinkToCard })`. DE + EN.

## Frontend

### Owner-UI

**Share-Button im Notebook-Editor-Toolbar** ([public/js/cards/editor-toolbar-card.js](../../public/js/cards/editor-toolbar-card.js)):
- Icon: `share-2` aus Lucide-Sprite (kein Unicode-Glyph).
- Klick → öffnet/togglet `shareLinksCard` mit Fokus auf „Diese Seite teilen"-Sektion.

**Share-Button im Sidebar-Kapitel-Header** ([public/partials/book-tree.html](../../public/partials/book-tree.html) — Pfad bei Implementation verifizieren): analog für Chapter.

**Neue Karte `shareLinksCard`:**
- Datei: [public/js/cards/share-links-card.js](../../public/js/cards/share-links-card.js).
- Partial: [public/partials/share-links.html](../../public/partials/share-links.html).
- Eintrag in `FEATURES` + `EXCLUSIVE_CARDS` ([public/js/cards/feature-registry.js](../../public/js/cards/feature-registry.js)).
- Eintrag in `ALLOWED_KEYS` von [routes/usage.js](../../routes/usage.js).
- Show-Flag `showShareLinksCard` in `cardsState` ([public/js/app/app-state.js](../../public/js/app/app-state.js)).
- Hash-Router-Branch in [public/js/app/app-hash-router.js](../../public/js/app/app-hash-router.js).
- State (Initial-Felder): `links` (Array), `commentsByToken` (Object), `loadingLinks` (Boolean), `creatingLink` (Object oder null mit `{kind, targetId, intro, expiresAt}`), `editingTokenId` (String oder null), `_memos` ({}).
- Methoden: `loadLinks()`, `createLink(kind, targetId)`, `revokeLink(token)`, `updateLink(token, patch)`, `loadComments(token)`, `deleteComment(id)`, `copyLink(token)` (Clipboard-API), `linkStatus(link)` (memoized via `_memo`), `linkUrl(token)`.

### Reader-View Standalone

- Datei: [public/share.html](../../public/share.html) — wird als String-Template in `routes/share.js` geladen und mit Daten interpoliert (Server-Side-Rendering).
- Server liest Template einmal beim Modulladen via `fs.readFileSync`, ersetzt Platzhalter `{{title}}`, `{{intro_html}}`, `{{content_html}}`, `{{comments_html}}`, `{{lang}}`, `{{t_*}}` für i18n-Strings.
- Kein Alpine, kein React. Vanilla-JS-Snippet inline für Form-Submit (fetch POST, zeigt Success/Error inline).
- Honeypot: `<input type="text" name="_hp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px">`.
- Form wird Server-Side gar nicht gerendert wenn `expires_at < now` oder `revoked_at !== null`.

## CSS

- **Neu:** [public/css/components/share-links.css](../../public/css/components/share-links.css) für Owner-Karte. Akzent über `var(--card-accent)` (Mapping `.card--share { --card-accent: var(--card-accent-share); }` in [public/css/card-accents.css](../../public/css/card-accents.css), Hue in [public/css/tokens/colors.css](../../public/css/tokens/colors.css) Light+Dark).
- **Neu:** [public/css/share.css](../../public/css/share.css) für Reader-View. Lädt nur `tokens.css` + sich selbst. Setzt:
  - Body: serif, 1.7 line-height, max-width 70ch, padding generös.
  - `prefers-color-scheme: dark` → dunkle Token-Werte automatisch via Tokens.
  - `.share-header` sticky top mit Backdrop-Blur.
  - `.share-intro` als Blockquote mit Akzent-Border-Left.
  - `.share-content` mit Heading-Hierarchie h1-h3, optimierte `text-rendering`.
  - `.share-comments` Liste + Form.
  - Mobile (`@media (max-width: 600px)`): kleinere Margins, Header-Height reduziert.
- **Index-Eintrag:** Owner-Karten-CSS in [public/index.html](../../public/index.html); Reader-CSS lädt das Standalone-Template selbst.
- **`SHELL_CACHE`** bumpen in [public/sw.js](../../public/sw.js).
- **DESIGN.md** „CSS-File-Inventar" um beide Einträge ergänzen.

## i18n

Neue Key-Gruppe `share.*` in beiden Locale-Files:

- `share.title`, `share.create.page`, `share.create.chapter`
- `share.intro.label`, `share.intro.placeholder`
- `share.expires.label`, `share.expires.never`
- `share.copy`, `share.copied`, `share.revoke`, `share.revoked`, `share.expired`, `share.active`
- `share.comments.label`, `share.comments.empty`, `share.comments.delete`
- Reader-Strings: `share.reader.author_intro`, `share.reader.comments_heading`, `share.reader.comment_form_name`, `share.reader.comment_form_body`, `share.reader.comment_form_submit`, `share.reader.comment_submitted`, `share.reader.comment_rate_limited`, `share.reader.expired_heading`, `share.reader.revoked_heading`, `share.reader.expired_body`, `share.reader.revoked_body`
- Mailer-Strings: `share.mail.subject`, `share.mail.greeting`, `share.mail.body`, `share.mail.cta`

## DB

### Migration 145 ([db/migrations.js](../../db/migrations.js))

SQL-Statements im neuen `if (version < 145) { ... }`-Block:

```sql
CREATE TABLE IF NOT EXISTS share_links (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('page','chapter')),
  page_id INTEGER REFERENCES pages(page_id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES chapters(chapter_id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
  owner_email TEXT NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  intro TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (kind='page' AND page_id IS NOT NULL AND chapter_id IS NULL) OR
    (kind='chapter' AND chapter_id IS NOT NULL AND page_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_share_links_book ON share_links(book_id);
CREATE INDEX IF NOT EXISTS idx_share_links_owner ON share_links(owner_email);
CREATE INDEX IF NOT EXISTS idx_share_links_page ON share_links(page_id);
CREATE INDEX IF NOT EXISTS idx_share_links_chapter ON share_links(chapter_id);

CREATE TABLE IF NOT EXISTS share_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_token TEXT NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,
  reader_name TEXT,
  body TEXT NOT NULL,
  ip_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_share_comments_token ON share_comments(share_token);
```

Migration-Block schliesst mit `foreign_key_check`-Assertion + `UPDATE schema_version SET version = 145` (Standard-Pattern aus CLAUDE.md).

### Squash-Regen

Nach Migration: `npm run squash:regen` ausführen → [db/squashed-schema.js](../../db/squashed-schema.js) regenerieren. Drift-Test [tests/unit/squash-drift.test.mjs](../../tests/unit/squash-drift.test.mjs) muss grün bleiben.

### ERD-Update

[docs/erd.md](../erd.md) im selben Commit:
- Stand-Zeile Schema-Version 144 → 145, Tabellen-Anzahl +2.
- Zwei neue Blöcke `share_links { ... }` + `share_comments { ... }` in Übersicht.
- FK-Kanten: `share_links` → `books`/`pages`/`chapters`/`app_users`, `share_comments` → `share_links`.
- Thematisches Sub-Diagramm: neuer Abschnitt „Sharing" oder Erweiterung „Buch-Hierarchie".

### DB-Helper-Modul

Neu: [db/share-links.js](../../db/share-links.js) — exportiert `createShareLink`, `getShareLinkByToken`, `listSharesByOwner`, `revokeShareLink`, `updateShareLink`, `incrementViewCount`, `insertComment`, `listComments`, `deleteComment`. Alle Timestamps via `${NOW_ISO_SQL}` aus [db/now.js](../../db/now.js).

## Security

- **Token-Entropie:** 128 bit — nicht erratbar via Brute-Force.
- **Rate-Limit Reader-Kommentare:** 3/Stunde pro Token+IP-Hash (in-memory; Mailer-Bombing via wechselnde IPs theoretisch möglich → in OBSERVE behalten).
- **Honeypot-Field:** filtert die meisten naiven Bots.
- **XSS:**
  - Intro + Kommentar-Body Server-Side escapen vor Template-Interpolation. Eigene `escapeHtml`-Funktion oder vorhandene wiederverwenden.
  - Page-HTML kommt aus DB, bereits via [lib/html-clean.js](../../lib/html-clean.js) sanitisiert beim Save — keine weitere Verarbeitung nötig.
- **CSRF:** POST-Endpoint `/share/:token/comment` ist explizit für anonyme Fremd-Domains gedacht → kein CSRF-Token, kein SameSite-Cookie-Pflicht. Risiko: Site X postet Kommentar von Visitor → akzeptabel weil Body sichtbar im UI, kein State-Change auf Owner-Account.
- **Open-Redirect:** keine Redirects in Reader-Pipeline.
- **Owner-ACL:** alle Auth-Routen prüfen `owner_email === req.session.user.email`. ACL aufs Buch (Owner/Editor) wird beim CREATE geprüft via [lib/acl.js](../../lib/acl.js).
- **Email-Notification:** Owner-Email kommt aus DB, nicht aus User-Input → kein Header-Injection-Risk.
- **GDPR:** Reader-IP wird gehasht gespeichert (nicht plain), ip_hash dient nur Rate-Limit. Self-hosted → Memory-Regel: Compliance ist Betreiber-Sache; trotzdem keine raw-IPs.

## Telemetrie

- Winston-Logs (deutsch, geht in `schreibwerkstatt.log`):
  - INFO bei `createShareLink`, `revokeShareLink`, `insertComment`.
  - WARN bei Rate-Limit-Hit.
  - WARN bei 410-Gone-Response (expired/revoked access).
- View-Count als zählende Spalte `share_links.view_count`. Inkrement pro GET (non-blocking).
- Kein zusätzliches Analytics-Pixel.

## Reversibilität

- **DB:** Rollback via `DROP TABLE share_comments; DROP TABLE share_links; UPDATE schema_version SET version = 144`. Daten gehen verloren (Links + Kommentare). Kein Datenverlust an Bestandsdaten.
- **Code:** alle neuen Dateien sind isoliert (`routes/share.js`, `db/share-links.js`, `lib/share-ratelimit.js`, `public/css/share.css`, `public/css/components/share-links.css`, `public/share.html`-Template, `public/js/cards/share-links-card.js`, `public/partials/share-links.html`). Entfernen reicht; punktuelle Edits in [server.js](../../server.js) (Route-Mount), [public/js/cards/editor-toolbar-card.js](../../public/js/cards/editor-toolbar-card.js) (Button), [public/js/cards/feature-registry.js](../../public/js/cards/feature-registry.js) (Eintrag), [public/index.html](../../public/index.html) (CSS-Link, Partial-Placeholder), [public/sw.js](../../public/sw.js) (`SHELL_CACHE`), [routes/usage.js](../../routes/usage.js) (`ALLOWED_KEYS`), Locale-Files.
- **i18n-Keys:** Entfernen schadet nicht — `t()` liefert sichtbare Keys zurück falls Aufrufer übrig.

## Tests

### Unit ([tests/unit/](../../tests/unit/))

- `share-token.test.js` — Token-Format (22 Zeichen, base64url), Kollisions-Freiheit über 10k Samples.
- `share-ratelimit.test.js` — Bucket-Expiry, Hit/Miss-Verhalten, Reset bei neuem IP-Hash.
- `share-db.test.js` — CHECK-Constraint blockiert ungültige `kind`/`page_id`/`chapter_id`-Kombinationen; CASCADE löscht Comments mit Link.
- `squash-drift.test.mjs` — bestehend, muss grün bleiben nach Squash-Regen.
- `erd-drift.test.mjs` — bestehend, muss grün bleiben nach ERD-Update.

### Integration ([tests/integration/](../../tests/integration/))

- `share.test.js` — POST `/share/api/links` als Owner, GET `/share/:token` ohne Auth, POST Comment, GET Comments als Owner, DELETE Link → 410 auf Reader-Route.

### E2E ([tests/e2e/](../../tests/e2e/))

- `share-link.spec.js` — Owner erstellt Link aus Notebook-Toolbar, kopiert URL, öffnet in Inkognito-Context, sieht Inhalt, postet Kommentar, Owner sieht Kommentar in Karte.

## Edge-Cases

- Owner löscht Buch → CASCADE löscht alle Links → Reader-Route 404 (nicht 410, weil Token unbekannt).
- Owner löscht Seite mit aktivem Page-Share → CASCADE löscht Link → 404.
- Chapter-Share, danach werden Pages verschoben/umsortiert → Reader sieht neue Reihenfolge (live).
- Chapter-Share, danach werden Pages in anderes Kapitel verschoben → Pages verschwinden aus Reader-View (Content-Store filtert per `chapter_id`).
- Owner-Account wird gelöscht → CASCADE durch `owner_email` FK → 404. Kommentare gehen mit verloren.
- Page-HTML enthält Such-Highlights, Findings-Marks o.ä. → Reader-CSS neutralisiert das Styling visuell (kein Strip nötig, weil HTML strukturell harmlos ist).
- Mehrere Owner teilen dieselbe Seite mit unterschiedlichen Links → erlaubt (kein UNIQUE auf `(kind, target_id)`).
- Sehr lange Kapitel (50+ Seiten) → Reader-View streamt sequenziell; bei Bedarf später Pagination — MVP rendert alles.
- Reader Submit Comment mit `body=""` → Server 400.
- `expires_at` in der Vergangenheit beim Create → Server 400.
- Reader liest Link kurz nach Revoke → 410 Gone mit i18n-Begründung.
- Owner ändert Intro während Reader liest → nächster Reload zeigt neues Intro.

## Kritische Dateien

### Modify

- [server.js](../../server.js) — Public-Route-Mount **vor** Session-Guard.
- [db/migrations.js](../../db/migrations.js) — Migration 145.
- [db/squashed-schema.js](../../db/squashed-schema.js) — via `npm run squash:regen`.
- [docs/erd.md](../erd.md) — Stand-Zeile, Blocks, Edges.
- [public/sw.js](../../public/sw.js) — `SHELL_CACHE`-Bump.
- [public/index.html](../../public/index.html) — `<link>` für `components/share-links.css`, Partial-Placeholder `<div id="partial-share-links">`.
- [public/js/app/app-state.js](../../public/js/app/app-state.js) — `showShareLinksCard`.
- [public/js/app/app-hash-router.js](../../public/js/app/app-hash-router.js) — Branch + Flag-Liste.
- [public/js/app/app-view.js](../../public/js/app/app-view.js) — Toggle-Methode (folgt `_toggleCardGeneric`-Pattern, kein Custom-Code).
- [public/js/cards/feature-registry.js](../../public/js/cards/feature-registry.js) — `FEATURES` + `EXCLUSIVE_CARDS`.
- [public/js/cards/editor-toolbar-card.js](../../public/js/cards/editor-toolbar-card.js) — Share-Button.
- [public/partials/book-tree.html](../../public/partials/book-tree.html) (oder Tree-Source-File) — Chapter-Share-Button im Header.
- [public/js/app.js](../../public/js/app.js) — `registerShareLinksCard()` aufrufen.
- [public/js/i18n/de.json](../../public/js/i18n/de.json) + [public/js/i18n/en.json](../../public/js/i18n/en.json) — `share.*` Keys.
- [routes/usage.js](../../routes/usage.js) — `ALLOWED_KEYS` ergänzt um `shareLinks`.
- [lib/mailer-templates.js](../../lib/mailer-templates.js) — Notification-Template.
- [DESIGN.md](../../DESIGN.md) — CSS-File-Inventar + ggf. Pattern-Eintrag für Reader-View.

### Create

- [routes/share.js](../../routes/share.js) — Public + Auth-Routen.
- [db/share-links.js](../../db/share-links.js) — DB-Helper.
- [lib/share-ratelimit.js](../../lib/share-ratelimit.js) — Rate-Limit.
- [public/share.html](../../public/share.html) — Reader-Standalone-Template (Server-Side gerendert).
- [public/css/share.css](../../public/css/share.css) — Reader-View-Styles.
- [public/css/components/share-links.css](../../public/css/components/share-links.css) — Owner-Karte.
- [public/js/cards/share-links-card.js](../../public/js/cards/share-links-card.js) — Owner-Karte JS.
- [public/partials/share-links.html](../../public/partials/share-links.html) — Owner-Karte HTML.
- [tests/unit/share-token.test.js](../../tests/unit/share-token.test.js), [tests/unit/share-ratelimit.test.js](../../tests/unit/share-ratelimit.test.js), [tests/unit/share-db.test.js](../../tests/unit/share-db.test.js).
- [tests/integration/share.test.js](../../tests/integration/share.test.js).
- [tests/e2e/share-link.spec.js](../../tests/e2e/share-link.spec.js).

## Offene Fragen

- Soll `view_count` öffentlich für Owner sichtbar sein, oder nur intern für Analytics? (Default: ja, sichtbar.)
- Sollen Reader-Kommentare an alle Buch-Owner (bei Co-Authoring via `book_access`) gehen oder nur an den Link-Ersteller? (Default: nur Link-Ersteller.)
- Display-Name des Autors in Reader-View: aus `app_users.display_name`, oder anonymisiert („Der Autor"/"The author")? (Default: `display_name`; Buchorganizer-Setting für anonymen Modus später.)
- Sollen Findings-/Suche-Highlight-Marken (CSS-Klassen wie `.finding-mark`) server-side aus dem Page-HTML gestrippt werden, oder reicht es, im Reader-CSS deren Styling zu neutralisieren? (Default: CSS neutralisiert visuell — kein Strip nötig.)
- Soll Share-Button auch in Focus-Editor und Bucheditor erscheinen, oder bleibt MVP auf Notebook + Sidebar beschränkt?
