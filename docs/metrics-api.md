# Metrics-API (Prometheus-Endpoint)

`GET /metrics` liefert alle Admin-Console-Kennzahlen im Prometheus-Text-Format 0.0.4. Konsumenten: Prometheus, Home Assistant (`prometheus`-Integration), Grafana, VictoriaMetrics, alle Standard-Monitoring-Tools.

Auth: Bearer-Token mit Scope `metrics:read`. Verwaltung pro Admin im Tab **API / Metrics** der AdminSettingsCard ([public/partials/admin-settings.html](../public/partials/admin-settings.html)).

## Endpoint

| Methode | Pfad | Auth | Antwort |
|---|---|---|---|
| GET | `/metrics` | `Authorization: Bearer sw_<hex>` (Scope `metrics:read`) | `text/plain; version=0.0.4; charset=utf-8` |

401-Fehler liefern `WWW-Authenticate: Bearer …`-Header und JSON-Body `{ error_code: 'BEARER_REQUIRED' \| 'INVALID_TOKEN' }`. 403 bei fehlendem Scope. Niemals Redirect — Scraper sind keine Browser. Mount-Reihenfolge in [server.js](../server.js) liegt deshalb **vor** dem Session-Guard.

## Token-Lifecycle

Plain-Token-Format: `sw_<64 Hex-Zeichen>` (`crypto.randomBytes(32)`, 256 bit Entropie). DB speichert ausschliesslich den SHA-256-Hash in `api_tokens.token_hash` (UNIQUE-Index). Der Klartext verlässt den Server **einmalig** in der POST-Response `/admin/api-tokens` und wird im UI direkt nach Create einmal eingeblendet; Reload macht ihn unsichtbar. Wer den Klartext verliert, muss einen neuen Token anlegen.

Lifecycle-Spalten:

- `expires_at` (optional): ISO-Timestamp. `findActiveTokenByPlain` filtert abgelaufene Tokens automatisch raus.
- `revoked_at` (Soft-Revoke): nach Klick auf „Widerrufen" gesetzt. Token sofort ungültig.
- `last_used_at` + `last_used_ip`: bei jedem erfolgreichen Scrape geupdated (`touchTokenUsage`). Admin sieht im UI direkt, welcher Token „lebt".
- FK `admin_email → app_users(email) ON DELETE CASCADE`: gelöschter Admin → seine Tokens fliegen mit raus.

Admin-CRUD läuft hinter `requireAdmin` ([lib/admin-mw.js](../lib/admin-mw.js)) und filtert ausschliesslich Tokens des aufrufenden Admins (`WHERE admin_email = session.user.email`). Cross-Admin-Sichtbarkeit gibt es bewusst nicht.

## Exponierte Metriken

Naming-Convention: Prefix `sw_`, Counter mit `_total`-Suffix, Gauges ohne. Label-Werte werden via `escLabel()` quotiert (Backslash, Newline, Quote-Escape).

### Build + User

- `sw_build_info{version}` — Gauge konstant 1, Label = `package.json#version`.
- `sw_users{status}` — Gauge, count pro `app_users.status` (`invited`/`active`/`suspended`/`deleted`).
- `sw_active_users_24h`, `sw_active_users_7d` — Gauge, distincte User mit `last_seen_at` im Zeitfenster.

### Content

- `sw_books`, `sw_pages`, `sw_chapters` — Gauge, `COUNT(*)`.
- `sw_chars`, `sw_words` — Gauge, `SUM(page_stats.chars|words)`.
- `sw_normseiten` — Gauge, `round(sw_chars / 1800)` (Normseite = 1800 Zeichen).

### Writing-Activity (heute, app.timezone)

- `sw_writing_seconds_today`, `sw_lektorat_seconds_today` — Gauge, `SUM(seconds)` aus `writing_time` / `lektorat_time` für `date = localIsoDate(new Date())` ([lib/local-date.js](../lib/local-date.js)).

### Job-Queue (In-Memory)

Inspiziert die in CJS geteilten Maps aus [routes/jobs/shared/state.js](../routes/jobs/shared/state.js).

- `sw_jobs_running` — Gauge, Jobs mit `status === 'running'`.
- `sw_jobs_queued` — Gauge, `max(jobs[status==='queued'], jobQueue.length)`.
- `sw_jobs_in_memory{type,status}` — Gauge, Verteilung der `jobs`-Map (inkl. fertiger Jobs vor Cleanup).

### Persistente Job-Historie

- `sw_jobs_finished_total{type,status}` — Counter, `COUNT(*)` aus `job_runs` gruppiert.

### Tokens + Kosten

Aggregiert pro `(provider, model)` aus `job_runs ∪ chat_messages WHERE role='assistant'`. Cost wird zur Lese-Zeit aus `(tokensIn, tokensOut, cacheReadIn, cacheCreationIn)` via [lib/pricing.js](../lib/pricing.js)`#costUsd` re-computed — additiv-korrekt und O(unique provider×model).

- `sw_tokens_in_total{provider,model}`
- `sw_tokens_out_total{provider,model}`
- `sw_cache_read_tokens_total{provider,model}`
- `sw_cache_creation_tokens_total{provider,model}`
- `sw_cost_usd_total{provider,model}`

Lokale Provider (`ollama`, `llama`) liefern Cost 0 (siehe `costUsd` — Strom/Compute des Betreibers, nicht App-Sache).

## Beispiele

### Prometheus (`prometheus.yml`)

```yaml
scrape_configs:
  - job_name: schreibwerkstatt
    scheme: https
    metrics_path: /metrics
    static_configs:
      - targets: ['app.example.com']
    authorization:
      type: Bearer
      credentials: sw_REPLACE_WITH_TOKEN
```

### Home Assistant

Vollständige Sensor-Config + Lovelace-Dashboard: [homeassistant/](homeassistant/) (README, `configuration.yaml`, `dashboard.yaml`). Deckt alle 20 Metriken ab inkl. abgeleiteter Werte (Minuten, Normseiten, Cache-Hit-Ratio) und einer fertigen Übersichts-View mit Gauges, Glance-Tiles und History-Graphs. `rest`-Plattform (Top-Level, nicht `sensor: - platform: rest`) gruppiert mehrere Sensoren pro Endpoint — ein Request, alle Werte. `unique_id` pro Sensor ist Pflicht, sonst kein Entity-Registry-Eintrag (kein Umbenennen, keine Energy-Dashboard-Aufnahme).

Die Admin-UI im Tab **API / Metrics** zeigt diese Snippets aufklappbar inkl. Host-Substitution.

### Grafana

Fertiges Dashboard: [grafana/schreibwerkstatt.json](grafana/schreibwerkstatt.json). Import via Grafana → *Dashboards → New → Import → Upload JSON file* → Datasource `${DS_PROMETHEUS}` auswählen. Panels: Übersicht (Build/User/Aktiv), Inhalt (Bücher/Kapitel/Seiten/Zeichen/Wörter + Korpus-Wachstum), Schreib-Aktivität heute, Job-Queue (Running/Queued/Completion-Rate/Fehler/Kumuliert), Tokens + Kosten (Cache-Hit-Ratio, Cost-Rate, Token-Rates, Provider/Model-Tabelle).

## Pflicht-Invarianten

- **Mount vor Guard.** `/metrics` MUSS in [server.js](../server.js) **vor** dem Session-Guard montiert werden. Andernfalls redirected der Guard externe Scraper auf `/login` und der Token wird nie geprüft.
- **Plain-Token nie ein zweites Mal exposed.** Server speichert nur den Hash; Re-Display ist unmöglich. Wer das Verhalten brechen will (z. B. Backup-Export), legt eigene Tokens an oder rotiert.
- **Scope-Membership prüfen.** Künftige Scopes (`admin:read`, `jobs:write`, …) gehören als Komma-Liste in `api_tokens.scopes` und werden in [lib/bearer-auth.js](../lib/bearer-auth.js)`#tokenHasScope` validiert. Keine impliziten Scopes, keine `*`-Wildcards.
- **401 statt Redirect.** Bei jedem Auth-Fehler im Bearer-Pfad: 401 JSON + `WWW-Authenticate`. Kein HTML, kein Redirect.
- **Cost re-computed, nicht materialisiert.** `sw_cost_usd_total` nutzt `costUsd()` zur Lese-Zeit. Preis-Update in [lib/pricing.js](../lib/pricing.js) wirkt sofort rückwirkend auf alle Counter-Werte. Niemals `usd` als Spalte in `job_runs`/`chat_messages` materialisieren.
- **Counter sind kumuliert seit DB-Init.** Server-Restart resetted die In-Memory-Job-Queue-Gauges, NICHT die `*_total`-Counter aus `job_runs`. Prometheus berechnet `rate()` selbst — keine Reset-Logik beim Collector.

## Code-Karte

- [db/api-tokens.js](../db/api-tokens.js) — CRUD, Hash-Roundtrip, Lifecycle-Filter
- [lib/bearer-auth.js](../lib/bearer-auth.js) — `requireBearer(scope)`
- [lib/metrics-collector.js](../lib/metrics-collector.js) — Prometheus-Text-Builder
- [routes/metrics.js](../routes/metrics.js) — öffentlicher Endpoint
- [routes/admin-api-tokens.js](../routes/admin-api-tokens.js) — Admin-CRUD
- [public/partials/admin-settings.html](../public/partials/admin-settings.html) — Tab `api`
- [public/js/admin/admin-settings.js](../public/js/admin/admin-settings.js) — `adminApiTokens*`-Methoden
- [public/js/cards/admin-settings-card.js](../public/js/cards/admin-settings-card.js) — State-Felder
- [public/css/admin/admin-settings.css](../public/css/admin/admin-settings.css) — `.admin-api-tokens-table`, `.admin-api-token-reveal`, `.admin-api-snippet`
