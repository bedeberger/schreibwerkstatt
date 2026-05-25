# Home Assistant Integration

Konsumiert den `/metrics`-Endpoint ([../metrics-api.md](../metrics-api.md)) als Prometheus-Scrape via Home Assistants `rest`-Integration und stellt alle Schreibwerkstatt-Kennzahlen als Sensoren bereit. Inklusive Lovelace-Dashboard mit Live-Tiles, Trends und Kosten-Tracking.

## Voraussetzungen

- Schreibwerkstatt erreichbar von HA (HTTPS empfohlen, Self-signed funktioniert via `verify_ssl: false` im `rest:`-Block).
- API-Token mit Scope `metrics:read`. Anlegen im Admin-Tab **API / Metrics** ([Admin-Settings](../../public/partials/admin-settings.html)). Token-Klartext erscheint **einmalig** — direkt speichern.
- Home Assistant 2024.x oder neuer (`rest:`-Top-Level-Integration mit Multi-Sensor-Block).

## Installation

### 1. Token in `secrets.yaml`

```yaml
schreibwerkstatt_token: "Bearer sw_REPLACE_WITH_TOKEN"
schreibwerkstatt_url: "https://app.example.com/metrics"
```

### 2. Sensor-Config

Inhalt von [configuration.yaml](configuration.yaml) in die HA-`configuration.yaml` mergen. Enthält:

- **`rest:`-Block** mit einem HTTP-Call alle 60 s. Parst Prometheus-Text via `regex_findall_index` und befüllt 20 Sensoren in einem Rutsch.
- **`template:`-Block** für abgeleitete Werte (Minuten, Normseiten, Cache-Hit-Ratio).

Anschliessend HA neu starten (Settings → System → Restart).

### 3. Dashboard

Inhalt von [dashboard.yaml](dashboard.yaml) als neues Dashboard anlegen: Settings → Dashboards → **Add Dashboard** → **New dashboard from scratch** → drei Punkte oben rechts → **Raw configuration editor** → einfügen.

## Sensor-Übersicht

| Sensor | Quelle | Typ |
|---|---|---|
| `sensor.schreibwerkstatt_version` | `sw_build_info{version}` | String |
| `sensor.schreibwerkstatt_users_active` / `_invited` / `_suspended` | `sw_users{status}` | Count |
| `sensor.schreibwerkstatt_active_users_24h` / `_7d` | `sw_active_users_24h/7d` | Count |
| `sensor.schreibwerkstatt_books` / `_pages` / `_chapters` | `sw_books/pages/chapters` | Count |
| `sensor.schreibwerkstatt_chars` / `_words` | `sw_chars/words` | Total |
| `sensor.schreibwerkstatt_normseiten` | Template (chars / 1800) | Total |
| `sensor.schreibwerkstatt_writing_seconds_today` / `_minutes` | `sw_writing_seconds_today` | Duration |
| `sensor.schreibwerkstatt_lektorat_seconds_today` / `_minutes` | `sw_lektorat_seconds_today` | Duration |
| `sensor.schreibwerkstatt_jobs_running` / `_queued` | `sw_jobs_running/queued` | Gauge |
| `sensor.schreibwerkstatt_jobs_finished_total` | `sw_jobs_finished_total` (Sum) | Counter |
| `sensor.schreibwerkstatt_tokens_in_total` / `_out_total` | `sw_tokens_*_total` (Sum) | Counter |
| `sensor.schreibwerkstatt_cache_read_tokens` / `_creation_tokens` | `sw_cache_*_tokens_total` (Sum) | Counter |
| `sensor.schreibwerkstatt_cost_usd_total` | `sw_cost_usd_total` (Sum) | Counter |
| `sensor.schreibwerkstatt_cache_hit_ratio` | Template (cache_read / tokens_in) | Percent |

## Dashboard-Layout

Eine View **Übersicht** mit folgenden Sektionen:

1. **Header** — Version + Active-User-Snapshot via Markdown.
2. **Heute schreiben** — Writing- und Lektorat-Minuten (Entity-Cards).
3. **Inhalte** — Bücher / Kapitel / Seiten / Zeichen / Normseiten (Glance, 5 Spalten).
4. **User** — Status-Aufschlüsselung + Aktivitäts-Fenster (Glance).
5. **Job-Queue (Live)** — Zwei Gauges mit Severity-Schwellen (grün / gelb / rot).
6. **KI-Kosten & Tokens** — Kumulierte USD, Input-/Output-Tokens, Cache-Hit (Glance).
7. **Trends** — Drei `history-graph`-Karten: Zeichen-Wachstum 7d, Job-Queue 24h, Schreib-Minuten 24h, Kosten 30d.

## Per-Provider-/Model-Aufschlüsselung

Counter mit Labels (`sw_cost_usd_total{provider,model}`) werden in der Standard-Config zu einem Summen-Sensor zusammengefasst. Per-Kombi-Sensor:

```yaml
- name: Schreibwerkstatt Cost Claude Sonnet
  unique_id: sw_cost_claude_sonnet_4_6
  unit_of_measurement: USD
  value_template: >
    {{ value | regex_findall_index(
       'sw_cost_usd_total\{provider="claude",model="claude-sonnet-4-6"\}\s+([0-9.eE+-]+)',
       0) | float(0) | round(4) }}
  state_class: total_increasing
```

Für jede gewünschte `(provider, model)`-Kombi einen Sensor klonen. Provider/Model-Namen exakt aus dem Metrics-Output kopieren (Quote-Escape im Regex beachten).

## Alerting (optional)

Beispiel: Notification bei kumulierten Kosten > 50 USD:

```yaml
automation:
  - alias: Schreibwerkstatt Kosten-Alarm
    trigger:
      - platform: numeric_state
        entity_id: sensor.schreibwerkstatt_cost_usd_total
        above: 50
    action:
      - service: notify.mobile_app
        data:
          title: Schreibwerkstatt
          message: "KI-Kosten kumuliert über 50 USD."
```

Weitere sinnvolle Trigger:

- `sensor.schreibwerkstatt_jobs_queued` `above: 10` (Backlog-Alarm).
- `sensor.schreibwerkstatt_jobs_running` `above: 4` für `for: minutes: 10` (Worker-Stau).
- `sensor.schreibwerkstatt_cache_hit_ratio` `below: 20` (Prompt-Cache greift nicht mehr).

## Troubleshooting

- **`unavailable` auf allen Sensoren** — Token falsch oder abgelaufen. Check via `curl -H "Authorization: Bearer sw_…" https://app.example.com/metrics`. Status 401 → Token rotieren.
- **Sensor zeigt `unknown`** — Regex matcht nicht. Metric-Name aus `/metrics`-Output direkt prüfen (Backslash-Escape in `\{` / `\}` ist Pflicht in HA-YAML).
- **Wert springt auf 0 nach Server-Restart** — Nur In-Memory-Gauges (`sw_jobs_running`, `sw_jobs_queued`). `*_total`-Counter persistieren in `job_runs`. Erwartetes Verhalten — siehe Pflicht-Invariante "Counter sind kumuliert seit DB-Init" in [metrics-api.md](../metrics-api.md).
- **History-Graph leer** — `state_class` muss gesetzt sein (in [configuration.yaml](configuration.yaml) bereits gepflegt). Recorder läuft sonst nicht auf den Sensor.

## Dateien

- [configuration.yaml](configuration.yaml) — Sensor-Block für HA.
- [dashboard.yaml](dashboard.yaml) — Lovelace-Dashboard.
