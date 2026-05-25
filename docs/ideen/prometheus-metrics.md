# Prometheus-Metrics-Endpoint mit Bearer-Tokens

- **Status:** Implemented (Migration 146)
- **Aufwand:** S (1 Migration, 1 Bearer-Middleware, 1 Collector, 1 Public-Route, 1 Admin-CRUD-Route, 1 zusätzlicher Tab im AdminSettingsCard)
- **Severity:** Low (additives Feature, kein Eingriff in Auth-Flow oder bestehende Routen)

## Context

User betreibt Home Assistant und möchte Schreibwerkstatt-Kennzahlen direkt im HA-Dashboard sehen. Generischer als HA-only: das Format **Prometheus-Text-0.0.4** wird von Home Assistant (`prometheus`-Integration), Grafana (`prometheus`-Datasource), VictoriaMetrics, Loki-Promtail und allen anderen Standard-Monitoring-Tools verstanden. Damit ist ein einziger Endpoint für alle externen Beobachter ausreichend.

App ist self-hosted hinter Auth-Guard: Cookie-Session ist für Browser-Nutzer gemacht, taugt nicht für headless Scraper. Lösung: Bearer-Token-Auth mit eigener Token-Verwaltung in der Admin-Console, davor vor dem Session-Guard im Express-Stack montiert.

## Scope MVP

- Pro Admin beliebig viele Tokens, jeder mit eigenem Display-Label, optionalem Ablaufdatum und Scope-Liste (aktuell nur `metrics:read`).
- Plain-Token (`sw_<64 hex chars>`, 256 bit Entropie) wird nur einmal direkt nach Create im UI angezeigt; DB speichert ausschliesslich SHA-256-Hash.
- `GET /metrics` mit `Authorization: Bearer …` liefert alle Admin-Console-Kennzahlen im Prom-Text-Format:
  - User-Counts pro Status, aktive User 24h/7d.
  - Bücher/Seiten/Kapitel/Zeichen/Wörter Gesamt.
  - Writing-/Lektorat-Sekunden heute (lokale TZ aus `app.timezone`).
  - In-Memory Job-Queue: running/queued + Breakdown nach Typ/Status.
  - Persistente Job-Historie als kumulierte Counter aus `job_runs`.
  - Tokens/Cache-Tokens/Kosten pro Provider+Modell kumuliert (job_runs + chat_messages, Cost via [lib/pricing.js](../../lib/pricing.js#L66) Re-Compute).
- Admin-Console: neuer Tab „API / Metrics" in der existierenden AdminSettingsCard mit:
  - Token-Anlage-Formular (Label + optionales Ablaufdatum).
  - Sortierbarer Token-Liste mit Status-Badge (aktiv/widerrufen/abgelaufen).
  - Revoke + Delete (revoke = Soft, delete = Hard).
  - Copy-to-Clipboard für Plain-Token + Verbergen-Button.
  - Aufklappbare Snippet-Boxen mit Prometheus- und Home-Assistant-Konfigurationsbeispielen.

## Out-of-Scope

- Pro-User-Tokens (jeder authentifizierte Admin kann eigene Tokens anlegen; aber Scope ist immer `metrics:read`).
- Schreibende API-Tokens (keine `metrics:write` oder andere Scopes — Lese-only).
- Mehrere Endpoints (z. B. `/metrics/jobs`, `/metrics/users`) — ein Endpoint, alle Kennzahlen, Filterung beim Konsumenten.
- IP-Whitelisting oder Rate-Limits für `/metrics` (Token = Vertrauen, Scraper sollte ohnehin auf privater Netzwerkschicht laufen).
- OAuth/JWT-Tokens — opake Random-Strings reichen.
- Audit-Log für Token-Lifecycle (Winston-Logging im `info`-Level genügt; bei Bedarf später `app_settings_audit`-Pattern adaptierbar).
- Push-Modus (Pushgateway / OpenTelemetry-Exporter) — Pull-Modell ist Prometheus-Standard.

## Done when

- [x] Migration 146 läuft auf Legacy- und Fresh-DB grün durch (`foreign_key_check` leer).
- [x] Admin kann neuen Token erstellen, kopieren, in `curl -H "Authorization: Bearer sw_…" https://app/metrics` verwenden und Prom-Text-Output sehen.
- [x] Revoke setzt sofort 401 für den Token.
- [x] Admin sieht in der Liste, wann ein Token zuletzt benutzt wurde (Audit-Light).
- [x] Plain-Token erscheint im UI nur einmal direkt nach Create; Reload macht ihn unsichtbar.
- [x] Globaler Auth-Guard redirected `/metrics`-Scraper **nicht** auf `/login` (Mount-Reihenfolge vor Guard).
- [x] i18n DE+EN komplett, kein hartcodierter Text.

## Hard-Rule-Audit

Pflicht-Check der Hard Rules aus [CLAUDE.md](../../CLAUDE.md):

- **Editor-Spezifikation:** n/a — Feature greift in keinen der drei Editoren ein.
- **UI-Patterns aus DESIGN.md:** Neuer Tab nutzt das existierende `admin-settings-tab` + `admin-settings-subsection`-Pattern aus [admin-settings.css](../../public/css/admin/admin-settings.css). Eckige Badges (`badge` + `badge-ok/badge-warn/badge-err`) aus [components/buttons-badges.css](../../public/css/components/buttons-badges.css). Sortierbare Token-Tabelle Pflicht via `sortableTable`.
- **Prompts:** keine.
- **KI-Calls nur via Job-Queue:** n/a, keine KI-Calls.
- **`callAI` JSON-Only:** n/a.
- **Styles nur in public/css/:** neue Regeln in bestehender [admin-settings.css](../../public/css/admin/admin-settings.css). `SHELL_CACHE` bumpen.
- **UI-Strings nur in i18n-JSON:** alle neuen Keys unter `admin.settings.api.*` + `common.hide` in [de.json](../../public/js/i18n/de.json) + [en.json](../../public/js/i18n/en.json) gleichzeitig.
- **Content-Store-Facade:** n/a — Metrics-Collector liest aus `page_stats`/`pages`/`chapters` per Aggregat-COUNTs, kein Page-Inhalt.
- **HTML→Text-Stats:** n/a.
- **Job-Ergebnisse mit `updatedAt`:** n/a.
- **401-Handling:** `/metrics` antwortet **immer** 401 JSON bei fehlendem/ungültigem Token, **nie** Redirect — Scraper sind nie Browser. `WWW-Authenticate`-Header wird gesetzt.
- **Logging-Context `book`:** n/a, kein Buch-Scope.
- **`x-html` escaping:** n/a, kein neues `x-html`-Sink.
- **A11y:** Tab-Button erbt `.admin-settings-tab`-Pattern, Status-Badges haben Text statt nur Farbe.
- **Kein globaler Fokus-Ring:** keine neuen `:focus-visible`-Regeln.
- **Progress-Bars:** n/a.
- **Card-Animationen:** AdminSettingsCard nutzt nur `x-show` + `x-cloak`.
- **Combobox/numInput:** Datepicker für `expires_at` ist `<input type="date">` (native), Label ist Text-Input.
- **File-Limits:** Collector < 200 LOC, Migration < 30 LOC, Route < 80 LOC. Admin-Settings-Partial wächst um ~110 Zeilen (Gesamt < 600 LOC).
- **Memo-Pattern:** n/a — Token-Liste ist klein, keine teuren Compute-Methoden.
- **State explizit:** alle Token-State-Vars im `Alpine.data`-Initial-Block von [admin-settings-card.js](../../public/js/cards/admin-settings-card.js).
- **Mobile-Strategie:** Media-Query `@media (max-width: 600px)` für Token-Liste — Tab ist Viewport-bezogen, nicht Tile.
- **DB-Timestamps ISO+Z:** `api_tokens.created_at`-Default + alle INSERTs via `${NOW_ISO_SQL}`.
- **Frontend-Datums-Display:** Token-Liste rendert via `tzOpts()`-Wrapper.

## Abhängigkeiten

- [db/now.js](../../db/now.js) für `NOW_ISO_SQL`.
- [lib/admin-mw.js](../../lib/admin-mw.js) für `requireAdmin` an der Admin-CRUD-Route.
- [lib/pricing.js](../../lib/pricing.js) für `costUsd`-Re-Compute im Metrics-Collector.
- [lib/local-date.js](../../lib/local-date.js) für „heute"-Datums-Buckets im Collector.
- [routes/jobs/shared/state.js](../../routes/jobs/shared/state.js) für In-Memory-Job-Queue-Inspektion.
- Keine neuen npm-Deps. `crypto.randomBytes(32)` + `crypto.createHash('sha256')` aus Node-Stdlib.

## Backend

### Routen

| Methode | Pfad | Auth | Verhalten |
|---|---|---|---|
| GET | `/metrics` | Bearer | Prometheus-Text-0.0.4. 401 bei fehlendem/ungültigem Token, 403 bei fehlendem Scope. |
| GET | `/admin/api-tokens` | Session+Admin | Liste der Tokens des aktuellen Admins. |
| POST | `/admin/api-tokens` | Session+Admin | Body `{ display_name, expires_at? }`. Liefert **einmalig** `plain_token` zurück. |
| POST | `/admin/api-tokens/:id/revoke` | Session+Admin | Soft-Revoke (setzt `revoked_at`). |
| DELETE | `/admin/api-tokens/:id` | Session+Admin | Hard-Delete. |

### Bearer-Middleware ([lib/bearer-auth.js](../../lib/bearer-auth.js))

`requireBearer(scope)` extrahiert `Authorization: Bearer <plain>`, hasht via SHA-256, lookup in `api_tokens` (excludes revoked + expired), prüft Scope-Membership, touched `last_used_at`/`last_used_ip` und setzt einen Minimal-`req.session.user`-Stub (`role: 'admin'`, `via: 'api_token'`), damit nachgelagerte `requireAdmin`-Guards passieren würden — aktuell ungenutzt, da `/metrics` keinen `requireAdmin` davor hat, aber zukunftssicher für weitere Scopes.

### Metrics-Collector ([lib/metrics-collector.js](../../lib/metrics-collector.js))

Synchroner Builder: liest pro Call eine Reihe Aggregat-Queries gegen `app_users`, `books`, `pages`, `chapters`, `page_stats`, `writing_time`, `lektorat_time`, `job_runs`, `chat_messages` und inspiziert die In-Memory-Job-Queue-Maps aus `routes/jobs/shared/state`. Cost wird pro `(provider, model)`-Aggregat einmal via `costUsd()` re-computed — additiv-korrekt und O(unique provider×model).

Format: ein String, Content-Type `text/plain; version=0.0.4; charset=utf-8`, Cache-Control `no-store`.

Naming-Convention: Prefix `sw_`, Counter mit `_total`-Suffix, Gauges ohne. Labels: `version` (build), `status` (user/job), `provider`+`model` (token/cost), `type` (job).

## Frontend

### Tab in AdminSettingsCard

`adminSettingsTab`-Liste erweitert um `'api'` (zwischen `languagetool` und `advanced`). `adminSettingsSwitchTab('api')` lazy-loaded die Token-Liste. Eigener `<section x-show="adminSettingsTab === 'api'">`-Block in [admin-settings.html](../../public/partials/admin-settings.html) mit:

1. Intro + Endpoint-Anzeige.
2. Plain-Token-Reveal-Banner (nur sichtbar wenn `adminApiTokensJustCreated`).
3. Create-Form (Label, optionales Ablaufdatum).
4. Sortierbare Token-Tabelle.
5. Aufklappbare Scrape-Snippets (Prometheus, Home Assistant).

### State

Alle neuen Felder im Initial-Block von [admin-settings-card.js](../../public/js/cards/admin-settings-card.js):
`adminApiTokensList`, `adminApiTokensLoading`, `adminApiTokensLoaded`, `adminApiTokensError`, `adminApiTokensCreating`, `adminApiTokensNewName`, `adminApiTokensNewExpiresAt`, `adminApiTokensJustCreated`, `adminApiTokensCopiedAt`.

### Methoden in [admin-settings.js](../../public/js/admin/admin-settings.js)

`adminApiTokensLoad`, `adminApiTokensCreate`, `adminApiTokensRevoke`, `adminApiTokensDelete`, `adminApiTokensCopyPlain`, `adminApiTokensDismissPlain`.

## CSS

Neue Regeln am Ende von [admin-settings.css](../../public/css/admin/admin-settings.css) vor der Media-Query: `.admin-api-tokens-table`, `.admin-api-token-reveal`, `.admin-api-token-reveal-row`, `.admin-api-token-plain`, `.admin-api-snippet`, `.admin-settings-refresh-inline`. Keine neue CSS-Datei nötig — passt thematisch zur AdminSettingsCard.

## i18n

DE+EN gleichzeitig gepflegt. Neue Keys:
- `admin.settings.tab.api`
- `admin.settings.api.intro` / `endpointLabel` / `justCreatedTitle` / `justCreatedHint`
- `admin.settings.api.createTitle` / `nameLabel` / `namePlaceholder` / `expiresLabel` / `expiresHint` / `createButton`
- `admin.settings.api.listTitle` / `empty`
- `admin.settings.api.col.{name,scopes,created,lastUsed,expires,status}`
- `admin.settings.api.status.{active,revoked,expired}`
- `admin.settings.api.{revokeButton,deleteButton,confirmRevoke,confirmDelete,errorNameRequired}`
- `admin.settings.api.snippetsTitle` / `snippetsHint` / `snippetPrometheus` / `snippetHomeAssistant`
- Zusätzlich: `common.hide`

## DB

### Migration 146

```sql
CREATE TABLE api_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_email   TEXT NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  scopes        TEXT NOT NULL DEFAULT 'metrics:read',
  last_used_at  TEXT,
  last_used_ip  TEXT,
  expires_at    TEXT,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_api_tokens_admin ON api_tokens(admin_email);
CREATE INDEX idx_api_tokens_hash  ON api_tokens(token_hash);
```

FK auf `app_users(email)` mit `CASCADE` — wenn ein Admin gelöscht wird, fliegen seine Tokens automatisch raus.

## Security

- Plain-Token verlässt den Server nur in der direkten POST-Response (HTTPS-Pflicht via NGINX).
- DB speichert nur SHA-256-Hash; ein DB-Leak gibt nicht den nutzbaren Token preis.
- Token-Format `sw_<64 hex>` ist grepbar in Pastes/Logs/Secret-Scanner-Setups.
- 256 bit Entropie via `crypto.randomBytes(32)` — Brute-Force nicht praktikabel.
- Scope-Check als Token-Property: künftige Scopes (z. B. `admin:read`) ohne neue Auth-Schicht ergänzbar.
- `WWW-Authenticate`-Header bei 401 (Bearer-RFC-konform).
- Constant-time-Vergleich nicht nötig — Hash-Lookup ist via UNIQUE-Index direkt, kein Per-Byte-String-Compare.

## Telemetrie

- `last_used_at` + `last_used_ip` werden bei jedem erfolgreichen `/metrics`-Scrape upgedatet → Admin sieht im UI direkt, welcher Token „lebt".
- Winston-Log bei Create/Revoke/Delete (info-Level).
- Kein separater Audit-Trail; bei Verdacht reichen Server-Logs + DB-State.

## Reversibilität

- Token-Tabelle isoliert — Drop von `api_tokens` macht das Feature unsichtbar, ohne anderswo zu brechen.
- Mount-Reihenfolge in [server.js](../../server.js) ist die einzige Änderung am bestehenden Stack; Entfernen der `/metrics`-Mount-Zeile schaltet den Endpoint sofort ab.
- Migration 146 ist additiv — kein Recreate-Pattern nötig, Rollback per `DROP TABLE` möglich.

## Tests

- Unit: Bearer-Middleware (Hash-Roundtrip, Scope-Check, Revoked/Expired-Filterung), Metrics-Format (HELP/TYPE-Header, Label-Escaping), Pricing-Aggregat.
- Integration: Bearer → Mount → Output Round-Trip.
- E2E (Playwright): Tab-Wechsel → Create → Plain-Reveal → Copy → List-Refresh → Revoke → 401 für widerrufenen Token.

## Edge-Cases

- Admin-User wird zu `status='suspended'` gesetzt: Bearer-Token bleibt formal gültig (FK ist CASCADE-on-delete, nicht status-aware). Bewusst, weil Suspend kein Logout/Token-Invalidate ist. Wer eskalieren will: in [bearer-auth.js](../../lib/bearer-auth.js) `admin_email`-Lookup gegen `app_users.status` validieren.
- Server-Restart: In-Memory-Job-Queue (jobs-Map) ist leer → `sw_jobs_running`/`sw_jobs_queued` zeigen 0 direkt nach Boot. Persistente Job-Counter aus `job_runs` bleiben kumuliert (Counter-Semantik).
- Mehrere Admins teilen sich denselben physischen Endpoint, jeder hat eigene Tokens. Token-Liste filtert pro Admin (`admin_email = session.user.email`). Cross-Admin-Sichtbarkeit ist Out-of-Scope.
- Pricing-Modell unbekannt: `costUsd` loggt einmalig Warn und liefert 0 — `sw_cost_usd_total` für diese Kombi wird 0, sichtbar in der Time-Series.

## Kritische Dateien Modify/Create

**Created:**
- [db/api-tokens.js](../../db/api-tokens.js)
- [lib/bearer-auth.js](../../lib/bearer-auth.js)
- [lib/metrics-collector.js](../../lib/metrics-collector.js)
- [routes/metrics.js](../../routes/metrics.js)
- [routes/admin-api-tokens.js](../../routes/admin-api-tokens.js)

**Modified:**
- [db/migrations.js](../../db/migrations.js) (Migration 146)
- [db/squashed-schema.js](../../db/squashed-schema.js) (regenerated via `npm run squash:regen`)
- [server.js](../../server.js) (Mount `/metrics` vor Guard, `/admin/api-tokens` nach Guard)
- [public/partials/admin-settings.html](../../public/partials/admin-settings.html) (Tab + Section)
- [public/js/cards/admin-settings-card.js](../../public/js/cards/admin-settings-card.js) (State)
- [public/js/admin/admin-settings.js](../../public/js/admin/admin-settings.js) (Methoden)
- [public/css/admin/admin-settings.css](../../public/css/admin/admin-settings.css) (Token-Liste + Reveal + Snippets)
- [public/js/i18n/de.json](../../public/js/i18n/de.json) + [public/js/i18n/en.json](../../public/js/i18n/en.json)
- [public/sw.js](../../public/sw.js) (`SHELL_CACHE` bump)
- [docs/erd.md](../erd.md) (neue Tabelle + Stand-Zeile)

## Offene Fragen

Keine.
