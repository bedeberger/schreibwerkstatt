# Share-Link (Seite/Kapitel public teilen)

Opaker Token pro Seite **oder** Kapitel. Reader sehen Read-Only-View ohne Login, können (optional) kommentieren — **allgemein** am Seitenende **oder verankert** an einer markierten Textstelle (Beta-Leser-Feedback). Verankerte + allgemeine Kommentare bilden **Threads**, auf die Reader und Owner antworten (bidirektional). Owner sieht Links + Threads in eigener Karte (Unread-Tracking, Reply, Resolve).

## Architektur in einem Bild

```
Browser (anon)       → GET  /share/:token          → SSR-HTML
Browser (anon)       → GET  /share/:token/threads   → JSON (Threads, no-store)
Browser (anon)       → POST /share/:token/comment   → Redirect 303 oder JSON (+ optional Anker/parent_id)
Browser (auth Owner) → /share/api/links*            → JSON-CRUD (+ POST .../comments Reply, PATCH .../comments/:id/resolve)
```

`/share/:token` + `/share/:token/comment` sind die **einzigen** Public-Routen im App-Body. Mount-Reihenfolge in [server.js](../server.js): Share-Router **vor** dem Session-Guard montiert; gleichzeitig steht `/share/api/` in `API_PREFIXES`, damit Owner-Calls 401-JSON statt HTML-Redirect bekommen. Reihenfolge nicht durcheinanderbringen, sonst landet entweder Reader im Login oder Owner-API liefert HTML.

## Datenmodell (Migration 145)

Zwei Tabellen, beide via FK ans bestehende Schema gehängt:

- **`share_links`** — Token-PK, `kind IN ('page','chapter')`, FKs auf `books`/`pages`/`chapters`/`app_users` (alle `ON DELETE CASCADE`), `intro` (Plaintext, max 2000 Zeichen), `expires_at`/`revoked_at`/`view_count`/`owner_last_seen_at`. CHECK erzwingt exakt eines von `page_id`/`chapter_id` je nach `kind` (Sentinel-frei).
- **`share_comments`** — `share_token` FK auf `share_links(token)` CASCADE, `reader_name` (optional, max 80), `body` (max 4000), `ip_hash` (SHA-256 mit Server-Salt, 16 Hex-Slice — GDPR: kein Klartext-IP). **Threading + Anker (Migration 200):** `parent_id` (Self-FK CASCADE, NULL=Root, sonst Reply — Threads eine Ebene tief, Replies erben den Anker des Roots), `anchor_bid`/`anchor_quote`/`anchor_start`/`anchor_end` (verankert an einem Block via `data-bid`, NULL=allgemeine Anmerkung), `author_email` (FK app_users SET NULL — gesetzt bei Owner-Antwort; Identitäts-Quelle ist im Code exklusiv: entweder `author_email` ODER `reader_*`), `resolved_at` (Owner-Resolve, nur Root), `reader_token` (opaker Per-Browser-Token aus localStorage für Self-Erkennung). Index auf `parent_id` + `author_email`.

## Verankerung an `data-bid`

Jede verankerte Anmerkung haftet an einem Block via dessen stabiler `data-bid`-ID ([lib/html-clean.js](../lib/html-clean.js)#ensureBlockIds, bereits im persistierten Page-HTML) + dem markierten Quote-Text. Der Inhalt ist **live** (Autor editiert weiter), darum ist der Quote der Robustheits-Anker: beim Rendern wird re-verankert (Block per `data-bid` finden → `anchor_quote` darin suchen, Offsets nur als Hinweis). Findet sich der Quote nicht mehr (Block gelöscht/Text geändert), bleibt der Thread gelistet, aber **ohne** Inline-Highlight (Markierung „Stelle geändert") — nie wird die falsche Stelle markiert.

## Threads (Reader + Owner)

- **Public-Endpunkte:** `GET /share/:token/threads?rt=<reader_token>` (no-store, JSON, serverseitig leser-sicher serialisiert — nie `author_email`/`reader_token`/`ip_hash`; `mine` gegen `rt` berechnet). `POST /share/:token/comment` nimmt zusätzlich optional `parent_id`, `anchor_bid`/`anchor_quote`/`anchor_start`/`anchor_end`, `reader_token` (alle defensiv validiert: bid-Regex, Offset-Ints, Reply nur auf Root **dieses** Tokens).
- **Owner-API:** `POST /share/api/links/:token/comments` `{ parent_id, body }` (Owner-Antwort, `author_email`=Session), `PATCH /share/api/comments/:id/resolve` `{ resolved }` (Root als erledigt markieren/öffnen).
- **Reader-Frontend** ([public/js/share-reader.js](../public/js/share-reader.js)): Selektion im Artikel → schwebender „Kommentieren"-Button → Composer; Inline-Highlights via **CSS Custom Highlight API** (`::highlight(share-anchor)`, kein DOM-Eingriff am Content → kein neuer XSS-Sink); Klick auf Highlight (caret-Mapping) fokussiert den Thread; Reader-Identität (`reader_token` + Name) in localStorage. SSR-Fallback ohne JS: nur allgemeine Root-Anmerkungen + klassische Form.
- **Owner-Karte:** Threads gruppiert (verankerte zuerst, Quote-Anzeige), Owner-Reply-Box + Resolve/Reopen pro Root. Unread-Query zählt nur Reader-Kommentare (`author_email IS NULL`) neuer als `owner_last_seen_at` — eigene Antworten sind nie „neu".
- **Sprung in den Editor (Owner):** Klick auf die „Markiert:"-Zeile eines verankerten Kommentars öffnet die betroffene Seite im Notebook-Editor und hebt die Textstelle transient hervor (CSS Custom Highlight `::highlight(share-comment-jump)`, nach 6 s entfernt). Seiten-Auflösung: Page-Share → `link.page_id`; Chapter-Share → `GET /share/api/links/:token/locate?bid=…` sucht den Block in den Kapitel-Seiten (Anker speichert keine page_id). Die Re-Anchor-Logik (`locateRange`) liegt als SSoT in [public/js/share-anchor.js](../public/js/share-anchor.js) und wird von Reader **und** Owner-Karte geteilt.

Schreib-/Lesepfad: ausschliesslich [db/share-links.js](../db/share-links.js). Reader-Content kommt über die **Content-Store-Facade** ([lib/content-store/](../lib/content-store/)), nicht direkt aus SQL.

## Token

22 Zeichen base64url aus `crypto.randomBytes(16)` (~128 bit). UNIQUE-Constraint + 3x Retry bei Kollision. Regex-Vorvalidierung in der Reader-Route: `^[A-Za-z0-9_-]{16,32}$`.

## Reader-View (SSR ohne Alpine)

Zwei statische Templates werden beim Modulladen einmal in `routes/share.js` per `fs.readFileSync` geladen:

- [public/share.html](../public/share.html) — OK-View mit Platzhaltern `{{title}}`, `{{intro_block}}`, `{{content_html}}`, `{{comments_html}}`, `{{form_block}}`, i18n-Strings `{{t_*}}`, `{{lang}}`.
- [public/share.gone.html](../public/share.gone.html) — 410-View für `revoked_at` bzw. `expires_at <= now`.

`fillTemplate(tpl, vars)` ersetzt `{{key}}` einfach. **Alles, was aus DB/User kommt, wird vor der Interpolation per `escHtml()` escaped** — Ausnahme: Page-HTML (Content-Store), das bereits beim Save durch [lib/html-clean.js](../lib/html-clean.js) sanitisiert wurde.

Reader-Form benutzt **klassischen `<form method="POST">` mit 303-Redirect-Fallback** + progressive Enhancement via [public/js/share-reader.js](../public/js/share-reader.js) (fetch + inline Status). Darum verteilt der POST-Handler je nach `Content-Type` (`application/json` → JSON-Response, sonst → Redirect mit `?cmt=ok|rate|empty|long|err|gone`). Heisst: View funktioniert auch ohne JS.

Sprache wird per `Accept-Language` erkannt (DE Default, EN-Prefix → EN). Server-i18n via [lib/i18n-server.js](../lib/i18n-server.js); Owner-User-Setting ist explizit **nicht** massgeblich (Reader hat kein Konto).

## Rate-Limit + Spam-Schutz

POST-Comment hat **zwei** Schichten:

1. **Honeypot** `_hp`-Input (hidden via CSS, `tabindex="-1"`) — gesetzt → 400, geloggt mit Token-Prefix.
2. **In-Memory-Bucket** in [lib/share-ratelimit.js](../lib/share-ratelimit.js): 30 Kommentare pro `(token, ip_hash)` pro 60 min (grosszügig, da Beta-Leser viele Inline-Anmerkungen pro Sitzung hinterlassen). Process-Restart resettet — bewusst, kein Cluster-Setup. IP-Hash: SHA-256 mit `SHARE_IP_SALT` (Env oder zufällig pro Prozess) + 16-Hex-Slice. Bei Hit setzt der Handler `Retry-After`-Header.

`db/share-links.js#countRecentCommentsByTokenIp` ist als DB-Pendant da, wird aktuell nicht eingesetzt — für künftige Cluster-Persistenz vorbereitet.

## Owner-UI

[public/js/cards/share-links-card.js](../public/js/cards/share-links-card.js) + [public/partials/share-links.html](../public/partials/share-links.html). Standard-Karte (Eintrag in `FEATURES` + `EXCLUSIVE_CARDS` in [feature-registry.js](../public/js/cards/feature-registry.js), `ALLOWED_KEYS` in [routes/usage.js](../routes/usage.js)). Open-Trigger ist der Share-Button im Notebook-Editor-Toolbar (Page-Share) bzw. ein Eintrag im Sidebar-Kontextmenü für Kapitel.

Unread-Tracking: `share_links.owner_last_seen_at` (eine Spalte, kein Bridge — pro Link gibt es genau einen Owner). Beim GET `/share/api/links/:token/comments?mark_seen=1` wird der Timestamp gesetzt. Owner-List-Queries liefern `comment_count` + `unread_count` als Sub-Selects mit.

## Sicherheits-Invarianten

- **Owner-Check**: jede `/share/api/*`-Route filtert via `link.owner_email === req.session.user.email`. ACL aufs Buch (`editor`+) wird beim `POST /share/api/links` per [lib/acl.js](../lib/acl.js)#`requireBookAccess` geprüft.
- **CSRF bewusst aus**: Reader-Comment-POST kommt explizit cross-origin (Link auf WhatsApp/Mail → fremde Domain → eigene Domain). Kein State-Change auf Owner-Account, Body steht sowieso im UI — Risiko akzeptiert.
- **XSS**: Page-HTML aus DB ist bereits via html-clean sanitisiert; alles andere durchläuft `escHtml`. Owner-Karte rendert Kommentar-Body via Alpine-Text-Bindung, **keinen** `x-html`-Sink.
- **GDPR**: nur IP-Hash gespeichert. Reader-Name optional, vor Render Server-Side escaped.

## Cache-Headers

Reader-Response setzt `Cache-Control: no-store` — Content ist live (Autor editiert weiter, Reader-Reload soll neuesten Stand zeigen). Service-Worker-`SHELL_CACHE` precachet `/share` (Standalone-Shell) und `/js/share-reader.js`.

## Tests

- Unit: Token-Format/Kollision, Rate-Limit-Bucket-Verhalten, CHECK-Constraint blockt invalid kind/page_id/chapter_id-Kombi, CASCADE löscht Comments mit Link.
- Integration: Owner CRUD + Reader-View 200/410, Honeypot 400, Rate-Limit 429.
- E2E: Owner erzeugt Link → Reader-Inkognito sieht Inhalt + postet Kommentar → Owner sieht Unread-Badge.

## Erweiterungs-Hinweise

- **Cluster/Mehrprozess-Setup**: Rate-Limit auf DB umstellen (Helper steht in `db/share-links.js`).
- **Page-Range statt ganzem Kapitel**: aktuell lädt Chapter-Share alle Pages der Direkt-Children über `listPages(book_id)` + Filter — Sub-Kapitel werden **nicht** mitgenommen (MVP). Erweiterung müsste die Hierarchie traversieren (siehe [docs/chapter-hierarchy.md](chapter-hierarchy.md)).
- **Mail-Notification** bei neuem Kommentar: implementiert via `notify.maybeNotifyShareComment` (Template `share-comment-owner`, [lib/mailer-templates.js](../lib/mailer-templates.js)). Owner-Mail, gedrosselt pro Link (ein Throttle-Fenster — eine Lese-Sitzung mit vielen Inline-Anmerkungen löst nicht eine Mail-Flut aus), Opt-out via `mail.notify.owner_on_share_comment === false` (Default an). Owner-eigene Antworten lösen nichts aus.
- **Snapshot-Modus** (Inhalt zum Share-Zeitpunkt einfrieren) wäre eigene Spalte `frozen_html`/`frozen_at` plus Toggle bei Create — aktuell live.
