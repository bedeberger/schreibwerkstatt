# Tägliche Schreib-Erinnerung (E-Mail-Nudge)

- **Status:** Draft <!-- Draft → Ready erst wenn „Offene Fragen" leer -->
- **Aufwand:** M
- **Severity:** low

## Context

Tagebücher (`buchtyp='tagebuch'`) leben von Regelmässigkeit — ein verpasster Tag wird selten nachgeholt. Die App hat heute keinen Engagement-/Retention-Mechanismus: nichts erinnert den Schreibenden ans Tagebuch. Dieses Feature schickt optional eine tägliche E-Mail „Heute schon ins Tagebuch geschrieben?" zur vom User gewählten Uhrzeit — aber nur, wenn für heute noch kein Eintrag existiert. Es passt zur App-Philosophie (KI bleibt aussen vor, der Reminder ist ein statischer Nudge ohne Generierung) und nutzt die vorhandene Mailing-Infrastruktur (`lib/mailer.js` / `lib/notify.js`).

## Scope MVP

- Pro User ein Opt-in „Tägliche Schreib-Erinnerung" in den User-Settings (default **OFF**).
- User wählt eine Wunschzeit (Stunde, z.B. `20:00`) via `combobox`.
- User wählt **ein** Tagebuch, das überwacht wird (Combobox über seine `tagebuch`-Bücher mit ACL-Zugriff).
- Neuer stündlicher Cron-Tick in `server.js`: ermittelt fällige Reminder (Wunschstunde == aktuelle lokale Stunde in `app.timezone`) und versendet pro User max. eine Mail.
- „Heute schon geschrieben?"-Check: existiert im überwachten Buch eine Page mit `page_name == localIsoDate()` (heutiges lokales ISO-Datum) → **kein** Versand.
- Doppelversand-Schutz: persistenter `last_sent_date`-Marker pro (User, Buch); pro Tag höchstens eine Mail (Cron läuft stündlich).
- Mail-Sprache = User-Locale (`app_users.language`), Versand via bestehendem `mailer.send`-Template.
- SMTP nicht konfiguriert (`mailer.getStatus().ready === false`) → Feature still aus, kein Crash, kein Versand.
- Globaler Kill-Switch-Setting (`mail.reminder.enabled`, default OFF) für den Betreiber.

## Out-of-Scope

- **Web-Push / Browser-Notifications** — bewusst Phase 2. Kein Service-Worker-Push-Code vorhanden (`public/sw.js` ohne Push), kein VAPID, kein Subscription-Lifecycle. Wäre eigenes Feature.
- Per-User-Zeitzone (Single-Tenant self-hosted → eine `app.timezone` reicht).
- Minuten-genaue Wunschzeit (stündliches Raster genügt; Cron läuft stündlich).
- Mehrere Reminder pro Tag, Streak-Statistiken, „Wochenrückblick"-Mails.
- SMS / Push-Provider / externe Notification-Dienste.
- KI-generierte Reminder-Texte (Philosophie: kein generativer KI-Call).

## Done when

- User aktiviert Reminder + setzt Wunschzeit + Buch → bei Cron-Lauf zur Wunschstunde **ohne** heutigen Eintrag kommt genau eine Mail; **mit** heutigem Eintrag keine Mail.
- Zweiter Cron-Lauf in derselben Stunde/am selben Tag versendet **nicht** erneut (Marker greift).
- Opt-out (Toggle aus) → kein Versand mehr.
- SMTP nicht konfiguriert → Feature inert, `npm test` grün, keine Fehler im Log.
- `npm run squash:regen` + `docs/erd.md` aktualisiert, `tests/unit/squash-drift.test.mjs` + `tests/unit/erd-drift.test.mjs` grün.

## Hard-Rule-Audit

- **Editor-Spezifikation:** n/a — kein Editor berührt.
- **KI-Calls nur via Job-Queue:** n/a — kein KI-Call. Reiner Cron-Versand, analog `notify.js` (fire-and-forget, kein Job-Typ nötig).
- **Content-Store-Facade:** betroffen. „Heute-Eintrag"-Check liest Pages ausschliesslich via `require('lib/content-store').listPages(bookId, ctx)` (oder dedizierten Lookup), keine direkte SQL auf `pages`.
- **i18n:** betroffen. Mail-Subject/Body + Settings-UI-Strings in `de.json` + `en.json`; Mail-Locale = User-`language`. Mail-Templates folgen dem `_t(locale, key, params)`-Muster aus `mailer-templates.js`.
- **DB-Integrität:** betroffen. Neue Reminder-Settings/Marker als FK auf `app_users(email)` + `books(book_id)`, Index auf FK, Timestamps via `NOW_ISO_SQL`, Schema-Default `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, Migration mit `foreign_key_check` + `UPDATE schema_version`.
- **Combobox statt `<select>`:** betroffen. Wunschstunde + Buchwahl via `Alpine.data('combobox')`.
- **numInput:** n/a — Stunde als Combobox-Auswahl, nicht als Freitext-Zahl.
- **LanguageTool / x-html-Escape:** Settings-Felder sind keine Prosa (Toggle + Comboboxen) → kein `data-spellcheck`. Mail-HTML escaped User-/Dynamik-Felder via `_esc()` (wie bestehende Templates).
- **CSS / Styles nur in `public/css/`:** Settings-UI nutzt bestehende Toggle-/Form-Patterns aus DESIGN.md; keine neue Datei nötig (n/a, sofern kein neues Pattern).
- **SHELL_CACHE bumpen:** betroffen — `user-settings`-JS/Partial ändert sich → `public/sw.js` hochzählen.
- **DB-Timestamps ISO+Z:** betroffen — Marker-Spalten via `NOW_ISO_SQL`.
- **Logging-Context book-slot:** Cron-Worker läuft unter `{ job: 'cron', user: 'system' }`; pro versendeten Reminder optional `setContext({ user, book })` für filterbare Spur.

## Abhängigkeiten

- `lib/mailer.js` (SMTP-Transport, `getStatus`), `lib/mailer-templates.js` (Template-Registry `TEMPLATES`, `_t`, `_esc`).
- `lib/notify.js` als Muster für fire-and-forget-Versand + Throttle/Dedup (hier persistenter Tages-Marker statt In-Memory-Map).
- `lib/local-date.js#localIsoDate` / `currentTz` (lokales Datum + TZ aus `app.timezone`).
- `lib/content-store` (Page-Lookup für „Heute-Eintrag").
- `db/app-users.js` (User-Settings, `getUser`, `updateUserSettings`), `db/book-access.js` (ACL — welche Tagebücher der User sehen darf), `db/book-settings`/`book_settings` (`buchtyp='tagebuch'`-Filter).
- `lib/app-settings.js` (Kill-Switch + ggf. ENV-Bootstrap).
- node-cron in `server.js`.

## Backend

- **`lib/reminder.js`** (neu, Muster `lib/notify.js`): `sendDueReminders(nowDate)` — iteriert User mit aktiviertem Reminder, prüft Wunschstunde == aktuelle lokale Stunde (`currentTz`), Tages-Marker (kein Versand wenn `last_sent_date == localIsoDate`), „Heute-Eintrag"-Check via Content-Store, dann `mailer.send({ to, template:'diary-reminder', ctx, locale })`. Swallowt Fehler in den Logger. Vorab-Guard: `mailer.getStatus().ready` und `appSettings.get('mail.reminder.enabled')`.
- **`server.js`:** neuer Cron `cron.schedule('0 * * * *', …)` (stündlich, `timezone: cronTz`) → `runWithContext({ job:'cron', user:'system' }, () => reminder.sendDueReminders())`. Catch-up nicht nötig (verpasste Stunde = verpasster Nudge, akzeptabel).
- **`routes/usersettings.js`** (Pfad `/me`-Cluster): `PATCH /settings` um Reminder-Felder erweitern (`reminder_enabled`, `reminder_hour`, `reminder_book_id`) — Validierung: Stunde 0–23, `reminder_book_id` muss ein `tagebuch`-Buch mit ACL-Zugriff des Users sein. `GET /settings` gibt die Felder zurück. Neuer Read-Endpoint `GET /me/diary-books` → Liste der `tagebuch`-Bücher des Users (für die Buch-Combobox) via `book-access` + `book_settings`-Filter.
- **`db/app-users.js`:** `updateUserSettings` (oder neue Funktion `setReminderSettings`) um die drei Spalten ergänzen; `setReminderSent(email, bookId, dateIso)` + Query für fällige Reminder.

## Frontend

- **`public/js/cards/user-settings-card.js`** + zugehöriges Partial: neuer Abschnitt „Tägliche Schreib-Erinnerung" mit:
  - Toggle `reminder_enabled` (bestehendes Toggle-Pattern aus DESIGN.md).
  - Combobox Wunschstunde (`00:00`–`23:00`, Wert = Stunde).
  - Combobox Buchwahl (Optionen aus `GET /me/diary-books`, `x-effect`-Inline-Expression; leer/disabled wenn der User kein Tagebuch hat).
  - Hinweis-Zeile „SMTP nicht konfiguriert — Erinnerung inaktiv", wenn `mailer.getStatus().ready === false` (Status kommt via `/config` oder `/me/settings`).
- Keine neue Karte/Registry-Eintrag (lebt in der bestehenden User-Settings-Karte) → kein `EXCLUSIVE_CARDS`/`FEATURES`/Hash-Router-Eintrag nötig.
- State: drei Felder im `userSettingsCard`-Initial-State, persistiert via `PATCH /me/settings`.

## CSS

n/a — wiederverwendet Toggle- + Form-Row-Patterns + Combobox-Styles aus DESIGN.md. Falls die Settings-Karte einen neuen Hinweis-/Info-Block braucht, bestehendes `.form-hint`/Info-Pattern nutzen; nur bei echtem neuen Pattern eine Datei in `public/css/page/` ergänzen + DESIGN.md-Inventar + `index.html`-Link + `SHELL_CACHE`-Bump.

## i18n

Neue Keys in `de.json` + `en.json`:
- `settings.reminder.title`, `settings.reminder.toggle`, `settings.reminder.hour`, `settings.reminder.book`, `settings.reminder.noDiaryBook`, `settings.reminder.smtpOff`, `settings.reminder.hint`.
- `mail.subject.diaryReminder`, `mail.body.diaryReminder.intro`, `mail.body.diaryReminder.cta`, `mail.body.diaryReminder.footer` (Param `{appName}`, `{bookName}`, `{url}` für Deep-Link ins Buch/heutigen Eintrag).

## DB

Migration **174** (nächste fortlaufende Nummer; aktuell `schema_version = 173`).

Variante A (bevorzugt, MVP — ein Reminder pro User, ein Buch):
- `ALTER TABLE app_users ADD COLUMN reminder_enabled INTEGER NOT NULL DEFAULT 0`
- `ALTER TABLE app_users ADD COLUMN reminder_hour INTEGER` (0–23, nullable)
- `ALTER TABLE app_users ADD COLUMN reminder_book_id INTEGER REFERENCES books(book_id) ON DELETE SET NULL`
- `ALTER TABLE app_users ADD COLUMN reminder_last_sent_date TEXT` (lokales ISO-Datum des letzten Versands, Dedup-Marker)
- FK auf `books(book_id)` erfordert **Recreate-Pattern** (SQLite kann FK nicht via `ALTER ADD CONSTRAINT`). Falls Recreate für `app_users` zu invasiv: `reminder_book_id` separat in eigener Bridge-Tabelle (Variante B) modellieren.

Variante B (falls mehrere Tagebücher pro User überwacht werden sollen — siehe Offene Fragen): neue Tabelle
```
diary_reminder (
  user_email TEXT NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
  hour INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_sent_date TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_email, book_id)
)
```
+ `CREATE INDEX idx_diary_reminder_book ON diary_reminder(book_id)`.

Pflicht-Abschluss jeder Variante:
```js
const fkErrors = db.pragma('foreign_key_check');
if (fkErrors.length) throw new Error(`Migration 174: foreign_key_check meldet ${fkErrors.length} Verstoesse.`);
db.prepare('UPDATE schema_version SET version = 174').run();
```
Danach `npm run squash:regen` + `docs/erd.md` (Stand-Zeile + `app_users`-Block bzw. neuer `diary_reminder`-Block + FK-Kanten) aktualisieren.

`app_users` PK ist `id` (INTEGER), `email` ist UNIQUE — FK-Refs auf `app_users(email)` zielen auf das UNIQUE-Target (wie bestehende Begleittabellen `user_activity`, `user_sessions_audit`).

## Security

- Auth: alle Settings-Routen laufen im Session-Guard (`/me`-Cluster). User ändert nur eigene Reminder-Settings (Email aus Session, nicht aus Body).
- ACL: `reminder_book_id` wird gegen `book-access` validiert — User kann nur eigene/zugängliche `tagebuch`-Bücher wählen. Cron prüft ACL ebenfalls vor Versand (Buch könnte zwischenzeitlich entzogen worden sein).
- PII: Mail enthält nur Buchname + Deep-Link, keine Inhalte. E-Mail-Adresse = bestätigte User-Identität.
- Escape: Mail-HTML schleust `{bookName}`/`{url}` via `_esc()`.
- Rate-Limit/Versand-Politik: Betreiber-Sache (self-hosted) — App liefert nur Tages-Dedup + Kill-Switch.

## Telemetrie

n/a für MVP. Optional später: Counter „reminder_sent_total" in `lib/metrics-collector.js` → dann Pflicht-Eintrag in `docs/homeassistant/*` (REST-Sensor + Dashboard + README). Für MVP nur Winston-Log pro Versand.

## Reversibilität

- Opt-in default **OFF** + globaler Kill-Switch `mail.reminder.enabled` (default OFF) → Feature standardmässig inert.
- SMTP nicht konfiguriert → automatisch aus.
- Vollständiger Ausbau: Cron-Block + `lib/reminder.js` + Mail-Template + Settings-UI entfernen; Migration zum Spalten-/Tabellen-Drop (additive Spalten können auch einfach ignoriert bleiben). Keine KI-Caches, kein Daten-Rückbau nötig.

## Tests

- **Unit** (`tests/unit/reminder.test.mjs`): „Heute-Eintrag"-Erkennung (Page mit `page_name == localIsoDate` → kein Versand; ohne → Versand), Wunschstunden-Match gegen `currentTz`, Tages-Dedup-Marker (zweiter Lauf kein Versand), Kill-Switch + SMTP-aus → inert. Reminder-Logik als pure Funktion mit injizierten Deps (mailer-Stub, fixe `nowDate`, Mock-Page-Liste) testen.
- **Unit** Drift-Gates: `squash-drift.test.mjs` + `erd-drift.test.mjs` müssen nach Migration + `squash:regen` grün sein.
- **Integration**: optional — `routes/usersettings.js`-PATCH/GET mit Validierung (ungültige Stunde, fremdes/Nicht-Tagebuch als `reminder_book_id` → 400).
- **E2E/Smoke**: User-Settings-Karte rendert den neuen Abschnitt ohne Alpine-Fehler (Smoke deckt die Karte bereits ab, sofern in der Settings-Karte gerendert).

## Edge-Cases

- **Mehrere Tagebücher:** MVP überwacht genau eines (`reminder_book_id`). Falls global/alle gewünscht → Variante B. Siehe Offene Fragen.
- **User hat kein Tagebuch:** Buch-Combobox leer/disabled, Toggle ohne Wirkung; Cron überspringt (kein `reminder_book_id`).
- **Server zur Wunschstunde aus:** verpasster Nudge wird nicht nachgeholt (akzeptabel — kein Catch-up).
- **DST-Umstellung:** `currentTz` + `localIsoDate` sind DST-sicher (Mittag-Anker in `local-date.js`); Wunschstunde gilt in lokaler Wanduhr.
- **Buch zwischen Aktivierung und Cron entzogen/gelöscht:** `ON DELETE SET NULL`/`CASCADE` + ACL-Recheck im Cron → kein Versand.
- **User-Locale fehlt:** Fallback `'de'` (wie `notify.js`).
- **Eintrag wird nach Versand am selben Tag erstellt:** irrelevant — Dedup verhindert zweiten Versand ohnehin.
- **Page mit `page_name` ungleich ISO-Datum (frei umbenannt):** zählt nicht als „heutiger Eintrag" — Konvention ist `YYYY-MM-DD` (vgl. `diary-calendar.js`).

## Kritische Dateien

- **Modify:**
  - `server.js` — stündlicher Cron-Tick + Registrierungs-Log.
  - `routes/usersettings.js` — Reminder-Felder in `GET`/`PATCH /settings` + neuer `GET /me/diary-books`.
  - `db/app-users.js` — Settings-Persistenz + `setReminderSent` + Fällig-Query (Variante A) bzw. `db/diary-reminder.js` neu (Variante B).
  - `db/migrations.js` — Migration 174.
  - `db/squashed-schema.js` — via `npm run squash:regen`.
  - `db/schema.js` — falls Initial-/Helper-Statements betroffen.
  - `lib/mailer-templates.js` — neues `diary-reminder`-Template in `TEMPLATES`.
  - `public/js/cards/user-settings-card.js` + zugehöriges Partial — Settings-Abschnitt.
  - `public/js/i18n/de.json` + `public/js/i18n/en.json` — neue Keys.
  - `public/sw.js` — `SHELL_CACHE`-Bump.
  - `docs/erd.md` — Schema-Update.
- **Create:**
  - `lib/reminder.js` — Fällig-Ermittlung + Versand.
  - `tests/unit/reminder.test.mjs` — Reminder-Logik.
  - ggf. `db/diary-reminder.js` (nur Variante B).

## Offene Fragen

- **Ein Tagebuch oder alle?** MVP modelliert genau ein überwachtes Buch (Variante A). Soll der Reminder über alle `tagebuch`-Bücher des Users greifen (z.B. „in einem davon fehlt heute ein Eintrag") → Variante B (Bridge-Tabelle). Entscheidung nötig vor `Ready`.
- **Wunschzeit-Granularität:** Stunde reicht (Cron stündlich) — oder ist Minuten-genau gewünscht (dann Cron feiner + Marker auf Minute)?
- **Deep-Link-Ziel der Mail:** Buch-Root, Diary-Kalender oder direkt „heute anlegen"-Aktion? Hängt am vorhandenen Hash-Routing für Tagebücher.
