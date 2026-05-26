# Presence: Self-Multi-Device-Sichtbarkeit

- **Status:** Ready
- **Aufwand:** S (1 PR; DB-Migration + Server-Endpunkt-Anpassung + Frontend-Indicator)
- **Severity:** Feature (UX-Hinweis bei Same-User-Dual-Device — verhindert Last-Write-Wins-Überraschung)

## Context

Aktuelle Presence ([db/page-presence.js](../../db/page-presence.js), [routes/content.js](../../routes/content.js) `/content/books/:book_id/presence`) filtert eigene Sessions serverseitig raus ([routes/content.js:278](../../routes/content.js#L278)). PK ist `(page_id, user_email)` — zweites Gerät überschreibt Heartbeat des ersten. Konsequenz: Wenn derselbe User die App auf Laptop und Tablet öffnet und dieselbe Seite editiert, gibt es **keinen** UI-Hinweis. Stale-Write-Schutz greift erst beim Save (Konflikt-Banner), aber bis dahin können Minuten Tipparbeit am falschen Stand gelandet sein.

Ziel: jedes Gerät identifizierbar machen, Self-Sessions im Banner anzeigen, eigene aktuelle Session ausfiltern.

## Scope MVP

1. **DB-Migration 148**: `page_presence` umstrukturieren — neue Spalte `device_id TEXT NOT NULL`, PK auf `(page_id, user_email, device_id)`. Recreate-Pattern (FK-Drop, Tabelle umkopieren, Indexe neu). Existierende Rows verlieren ihren Heartbeat (`device_id = 'legacy'` als Übergangswert beim Copy, läuft nach 90s eh aus).
2. **`app_users_devices`** (neue Tabelle): `(device_id PK, user_email FK, label, user_agent, created_at, last_seen_at)` — Auto-Label aus UA beim ersten Ping; User kann später umbenennen (Out-of-Scope für MVP, aber Schema bereit).
3. **Backend**:
   - `db/page-presence.js`: `ping(pageId, userEmail, bookId, deviceId)` + Upsert auf erweiterten PK.
   - `db/app-users-devices.js` (neu): `upsertDevice(deviceId, userEmail, userAgent)` mit Auto-Label aus UA, `getDevice(deviceId)`, `listDevicesForUser(email)`.
   - `routes/content.js`:
     - `POST /content/pages/:page_id/presence` nimmt `device_id` aus Body, ruft `upsertDevice` + `ping` auf.
     - `DELETE /content/pages/:page_id/presence` nimmt `device_id` aus Body, ruft `leave(pageId, email, deviceId)`.
     - `GET /content/books/:book_id/presence`: Filter ändert sich — nicht mehr `email != self`, sondern `(email != self) OR (email == self AND device_id != selfDeviceId)`. Pro Row zusätzlich `device_label` + `is_self` aus JOIN auf `app_users_devices`.
4. **Frontend**:
   - `public/js/app/app-collab.js`: `_getOrCreateDeviceId()` aus `localStorage('sw_device_id')`, sonst `crypto.randomUUID()` schreiben. UA-Auto-Label-Hint im POST mitsenden (Server entscheidet).
   - Ping-Body um `device_id` ergänzen.
   - `presenceFor(pageId)`-Konsumenten kriegen jetzt ggf. eigene Sessions (mit `is_self: true`).
   - Render-Pattern: Avatar/Chip mit Label "Du auf {device_label}" für Self-Sessions, anders gefärbt als Fremde (z.B. `--card-accent-info` statt `--card-accent-warn`).
5. **CSS**: Erweiterung `public/css/components/presence-chip.css` (sofern existiert) oder neue Datei. Modifier `.presence-chip--self`.
6. **i18n**: `presence.self.label`, `presence.device.unknown`, `presence.device.thisDevice`. DE+EN.
7. **squash-regen** + ERD-Update Pflicht.

## Out-of-Scope

- Device-Verwaltung im UI (Umbenennen, Löschen) — kommt in Folge-PR, Schema vorbereitet.
- Cross-Browser-Cookie-Sync (verschiedene Browser = verschiedene Geräte, by design).
- Active-Cursor-Position oder Co-Editing-Highlights.
- Lock-Mechanismus.

## Done when

- Zwei Browser-Profile mit demselben User-Login zeigen sich gegenseitig im Presence-Banner mit lesbarem Device-Label.
- Eigener aktiver Tab erscheint **nicht** in der Liste (sonst Selbst-Spam).
- Auto-Label generiert plausible Werte ("Safari · macOS", "Chrome · Android", "Firefox · Windows").
- Migration 148 idempotent, `npm run squash:regen` ausgeführt, ERD aktualisiert.
- Unit-Tests: UA-Parser, Device-Upsert-Idempotenz, Filter-Logic.

## Hard-Rule-Audit

- **Editor-Spezifikation**: Touchet keinen Editor-Body — nur Heartbeat-Pfad. Alle 3 Editoren rufen denselben Heartbeat aus `app-collab.js` auf.
- **DESIGN.md Patterns**: Presence-Chip-Pattern existiert; nur Modifier-Klasse für Self-Variant. Falls Chip noch nicht im Pattern-Katalog: ergänzen.
- **Prompts**: n/a.
- **KI-Calls via Job-Queue**: n/a.
- **`callAI`-JSON-Only**: n/a.
- **Styles nur in `public/css/`**: ja, Modifier in bestehender/neuer Datei. `SHELL_CACHE` bumpen.
- **UI-Strings i18n**: alle Keys DE+EN. `presence.device.thisDevice` als Fallback im Self-Banner.
- **Content-Store-Facade**: n/a.
- **HTML→Text-Normalisierung**: n/a.
- **Job-Ergebnisse Staleness**: n/a.
- **401-Handling**: zentral, n/a.
- **Logging-Context `book`**: ja, `setContext({ book })` in den Presence-Routes (existiert bereits via `aclParamGuard`-Pfad — prüfen).
- **`x-html`**: nicht verwendet.
- **A11y**: Chip ist informativ, kein interaktives Element. `aria-label` mit Volltext.
- **Card-Animationen nur CSS**: n/a.
- **`SHELL_CACHE` bumpen**: ja.
- **`sortableTable`-Pflicht**: n/a.
- **Combobox statt `<select>`**: n/a.
- **`numInput`**: n/a.
- **File-Limits**: `db/app-users-devices.js` ~80 LOC, `routes/content.js`-Diff klein.
- **State explizit**: `_deviceId` als Konstante im Modul-Scope von `app-collab.js`, nicht lazy.
- **DB-Timestamps ISO+Z**: ja, `NOW_ISO_SQL`, Default `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`.
- **Frontend-Datums-Display via `tzOpts()`**: `last_ping_at`-Render im Chip via `tzOpts()`.

## Abhängigkeiten

- `lib/log-context.js`, `lib/acl.js`.
- UA-Parsing: leichter eigener Helper (`lib/ua-label.js`) statt npm-Dependency. Reicht: Regex auf Browser-Familie + Plattform-Wort. Bewusst minimalistisch.

## Backend

**Migration 148** ([db/migrations.js](../../db/migrations.js)) — Recreate-Pattern:

1. `foreign_keys = OFF`
2. CREATE `app_users_devices` mit FK auf `app_users(email)` ON DELETE CASCADE + Index auf `user_email`.
3. CREATE `page_presence_new` mit erweitertem PK `(page_id, user_email, device_id)` + FKs auf `pages`, `app_users`, `app_users_devices`, `books`.
4. Alte Rows skippen (90s-Drift akzeptabel) → DROP `page_presence` → RENAME `page_presence_new` → `page_presence`.
5. Indexe neu: `idx_pp_book`, `idx_pp_page`.
6. `foreign_keys = ON` + `foreign_key_check` Pflicht.
7. `schema_version = 148`.

**`db/app-users-devices.js`** (neu):
- `upsertDevice(deviceId, userEmail, userAgent)` — INSERT OR IGNORE + UPDATE `last_seen_at`; bei INSERT Auto-Label aus `uaLabel(userAgent)`.
- `getDevice(deviceId)` → `{ device_id, user_email, label, last_seen_at }` oder `null`.
- `listDevicesForUser(email)` für künftige Settings-UI.

**`lib/ua-label.js`** (neu, ~40 LOC):
- Pure Function `uaLabel(uaString) → string`.
- Mapping: Browser (Edge/Chrome/Safari/Firefox/Other) + OS (Windows/macOS/Linux/iOS/Android/Other).
- Output-Format: `"Chrome · macOS"`. Bei Unparseable: `"Unbekanntes Gerät"`.

**`db/page-presence.js`**:
- Signatur `ping(pageId, userEmail, bookId, deviceId)`.
- `listForBook`/`listForPage` joinen jetzt `app_users_devices` für `device_label`.
- `leave(pageId, userEmail, deviceId)` — Per-Device-Cleanup.

**`routes/content.js`**:
- POST/DELETE-Presence nehmen `device_id` aus Body. Validierung: UUID-Format (36 Zeichen, Bindestriche). Bei Format-Verstoss 400.
- POST ruft erst `upsertDevice(deviceId, userEmail, req.get('User-Agent'))`, dann `ping`.
- GET-Filter — Pseudocode:
  - Query-Param `?device_id=...` als Self-ID auslesen.
  - Filter: Row drop wenn `user_email === self && device_id === selfDeviceId`.
  - Map ergänzt `is_self`-Flag pro Row.

## Frontend

**`public/js/app/app-collab.js`**:
- Konstante `_deviceId` einmalig beim Modul-Load aus `localStorage('sw_device_id')`; falls leer, `crypto.randomUUID()` schreiben.
- `_sendPresencePing(pageId)` POST-Body um `{ device_id: _deviceId }` erweitern.
- `_sendPresenceLeave(pageId)` DELETE-Body um `{ device_id: _deviceId }` erweitern.
- `_collabFetchPresence(bookId)` Query-Param `?device_id=${_deviceId}` anhängen.
- `livePresenceByPage` enthält jetzt ggf. Self-Sessions auf anderen Geräten. `presenceFor(pageId)` unverändert (Server filtert eigenes Device).

**Render-Stelle** ([public/js/book/tree.js](../../public/js/book/tree.js) oder Editor-Toolbar — TBD):
- Chip pro Presence-Row. Bei `is_self: true` Modifier `.presence-chip--self` + Label aus `t('presence.self.label', { device: row.device_label })`. Sonst bisheriger fremde-User-Pfad.

## CSS

- Bestehende Presence-Chip-Datei (falls vorhanden) — sonst neue `public/css/components/presence-chip.css`.
- Modifier `.presence-chip--self { background: var(--card-accent-info); color: var(--text-on-accent); }`.
- Eintrag in DESIGN.md unter „Presence-Chip" (sofern noch nicht dokumentiert).

## i18n

- `presence.self.label` = "Du auf {device}" / "You on {device}"
- `presence.device.unknown` = "Unbekanntes Gerät" / "Unknown device"
- `presence.device.thisDevice` = "Dieses Gerät" / "This device"

## DB

Migration 148 + neue Tabelle `app_users_devices` + restrukturierter PK auf `page_presence`. Squash-regen + ERD-Update Pflicht.

## Security

- `device_id` ist clientseitig generiert → kein Trust-Anchor. Server akzeptiert beliebige UUID-formatige IDs vom authentifizierten User. Worst Case: User spooft fremde Device-ID seiner eigenen Email → sieht nur sich selbst, kein Cross-User-Risiko (FK auf `user_email`).
- UA-String wird gespeichert — als persönliches Datum zu betrachten. Gehört in Datenschutz-Hinweis, falls vorhanden.

## Telemetrie

- Keine zusätzlichen Metriken nötig. Bestehende `/metrics`-Endpoints (`page_presence_active`) profitieren automatisch von feinerer Granularität.

## Reversibilität

- Migration 148 nicht trivial rückwärts (PK-Restructuring + neue Tabelle). Rollback erfordert Schema-Reset auf 147 + Squashed-Rerun.
- Frontend-Flag `feature.presenceMultiDevice` als Notbremse (Default an).

## Tests

- **Unit**: `tests/unit/ua-label.test.mjs` — Mapping-Stichproben (Chrome/Safari/Firefox auf 3 OS).
- **Unit**: `tests/unit/page-presence-multi-device.test.mjs` — Insert 2 Devices same User same Page → 2 Rows, `leave` nimmt nur 1, `listForBook` liefert beide.
- **Integration**: Smoke gegen `/content/.../presence` mit 2 verschiedenen `device_id` für selben User. Self-Filter prüfen.

## Edge-Cases

- localStorage geleert → neue Device-ID, alte bleibt in `app_users_devices` (last_seen_at zeigt Drift). Akzeptabel — kein Auto-Cleanup nötig (ggf. später Cron `> 90 Tage` löschen).
- User loggt sich aus, anderer User loggt sich im selben Browser ein → derselbe `device_id`, aber FK auf neuer Email. Device-Tabelle hat dann zwei Rows mit verschiedener User-Email für dieselbe `device_id`?? — **NEIN**, PK ist `device_id`. Konflikt: zweiter User würde existierende Row überschreiben.
  - **Lösung**: PK = `device_id` bleibt, aber `user_email`-FK kann updaten → Last-Owner-Wins. Heartbeat von altem User auf anderen Tab läuft eh aus.
  - Alternative: PK = `(device_id, user_email)`. Schöner, aber Browser-User-Wechsel ist Edge — nehmen wir den Single-PK-Pfad mit Last-Owner-Wins.
- Mehrere Tabs im selben Browser → derselbe `device_id` aus localStorage → derselbe Presence-Row, mehrfache Pings → idempotent, kein Spam.

## Kritische Dateien

**Modify:**
- [db/migrations.js](../../db/migrations.js) (Migration 148)
- [db/page-presence.js](../../db/page-presence.js)
- [db/squashed-schema.js](../../db/squashed-schema.js) (regen)
- [routes/content.js](../../routes/content.js) (Presence-Endpunkte)
- [public/js/app/app-collab.js](../../public/js/app/app-collab.js)
- [public/js/app/app-state.js](../../public/js/app/app-state.js) (Device-ID-Slot)
- [public/js/i18n/de.json](../../public/js/i18n/de.json), [en.json](../../public/js/i18n/en.json)
- [public/sw.js](../../public/sw.js) (`SHELL_CACHE` bump)
- [public/index.html](../../public/index.html) (CSS-Link falls neue Datei)
- [docs/erd.md](../../docs/erd.md)
- [DESIGN.md](../../DESIGN.md) (Presence-Chip-Pattern)

**Create:**
- `db/app-users-devices.js`
- `lib/ua-label.js`
- ggf. `public/css/components/presence-chip.css`
- `tests/unit/ua-label.test.mjs`
- `tests/unit/page-presence-multi-device.test.mjs`

## Offene Fragen

— (alle geklärt; Status Ready)
