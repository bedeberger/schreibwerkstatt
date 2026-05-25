# Share-Link (Seite/Kapitel public teilen)

Opaker Token pro Seite **oder** Kapitel. Reader sehen Read-Only-View ohne Login, können (optional) kommentieren. Owner sieht Links + Kommentare in eigener Karte.

## Architektur in einem Bild

```
Browser (anon)       → GET  /share/:token         → SSR-HTML
Browser (anon)       → POST /share/:token/comment → Redirect 303 oder JSON
Browser (auth Owner) → /share/api/links*          → JSON-CRUD
```

`/share/:token` + `/share/:token/comment` sind die **einzigen** Public-Routen im App-Body. Mount-Reihenfolge in [server.js](../server.js): Share-Router **vor** dem Session-Guard montiert; gleichzeitig steht `/share/api/` in `API_PREFIXES`, damit Owner-Calls 401-JSON statt HTML-Redirect bekommen. Reihenfolge nicht durcheinanderbringen, sonst landet entweder Reader im Login oder Owner-API liefert HTML.

## Datenmodell (Migration 145)

Zwei Tabellen, beide via FK ans bestehende Schema gehängt:

- **`share_links`** — Token-PK, `kind IN ('page','chapter')`, FKs auf `books`/`pages`/`chapters`/`app_users` (alle `ON DELETE CASCADE`), `intro` (Plaintext, max 2000 Zeichen), `expires_at`/`revoked_at`/`view_count`/`owner_last_seen_at`. CHECK erzwingt exakt eines von `page_id`/`chapter_id` je nach `kind` (Sentinel-frei).
- **`share_comments`** — `share_token` FK auf `share_links(token)` CASCADE, `reader_name` (optional, max 80), `body` (max 4000), `ip_hash` (SHA-256 mit Server-Salt, 16 Hex-Slice — GDPR: kein Klartext-IP).

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
2. **In-Memory-Bucket** in [lib/share-ratelimit.js](../lib/share-ratelimit.js): 3 Kommentare pro `(token, ip_hash)` pro 60 min. Process-Restart resettet — bewusst, kein Cluster-Setup. IP-Hash: SHA-256 mit `SHARE_IP_SALT` (Env oder zufällig pro Prozess) + 16-Hex-Slice. Bei Hit setzt der Handler `Retry-After`-Header.

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
- **Mail-Notification** bei neuem Kommentar war im MVP-Plan bewusst out-of-scope (Spam-Vektor, manuelles Polling reicht). Falls reaktiviert: Owner-Opt-in, dieselbe Mail-Pipeline wie Registration-Mails.
- **Snapshot-Modus** (Inhalt zum Share-Zeitpunkt einfrieren) wäre eigene Spalte `frozen_html`/`frozen_at` plus Toggle bei Create — aktuell live.
