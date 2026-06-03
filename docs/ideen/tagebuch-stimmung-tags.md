# Tagebuch: Per-Eintrag-Stimmung (Mood) + Tags/Themen

- **Status:** Draft
- **Aufwand:** M
- **Severity:** medium

## Context

Buchtyp `tagebuch` (in `prompt-config.json` definiert, de+en) hat datierte Einträge (`page_name` = `YYYY-MM-DD`), aber keine strukturierten Per-Eintrag-Metadaten. Tagebuchschreiben lebt von Stimmung und wiederkehrenden Themen — beides ist heute nur als Fliesstext im Body erfassbar und damit nicht auswertbar.

Dieses Feature ergänzt pro Tagebuch-Seite zwei leichte, **vom User selbst gesetzte** Metadaten:
- **Stimmung (Mood):** eine feste 5-stufige Skala (Emoji + i18n-Label).
- **Tags/Themen:** mehrfach, leichtgewichtig, frei wählbar (z.B. „Arbeit", „Familie", „Schlaf").

Es ist die Datengrundlage für spätere Auswertungen (Stimmungskurve, Themen-Häufung) — explizit für `tagebuch-jahresrueckblick-ki.md`. **App-Philosophie:** Mood/Tags sind reine User-Eingabe, kein KI-Generat (KI bleibt rückwärtsgewandt/auswertend).

## Scope MVP

- Pro Seite (nur Buchtyp `tagebuch`) eine Mood-Stufe 1–5 setzbar/änderbar/löschbar.
- Pro Seite beliebig viele Tags zuweisbar (hinzufügen/entfernen), Wiederverwendung bereits im Buch genutzter Tags per Vorschlag.
- Anzeige + Bearbeitung im Kopfbereich des **Notebook-Editors** (Einzelseiten-Edit-Modus), eingeblendet nur bei Tagebuch-Büchern.
- Persistenz in separater Tabelle, gelesen/geschrieben über eigene `/journal-meta`-Route (nicht über die Content-Store-Facade, Begründung unten).
- Mood-Skala mit festen i18n-Labels (de+en); Tags als Freitext-Token (klein normalisiert, getrimmt).

## Out-of-Scope

- Stimmungskurve / Themen-Diagramme / KI-Auswertung → eigene Pläne (`tagebuch-jahresrueckblick-ki.md`, `tagebuch-rueckblick.md`).
- Mood/Tags in anderen Buchtypen als `tagebuch`.
- Tags in Focus-Editor und Bucheditor (MVP nur Notebook-Editor).
- Tag-Hierarchien, Tag-Farben, Tag-Umbenennen-über-alle-Seiten (Phase 2).
- KI-Vorschlag für Mood/Tags aus dem Eintragstext.
- Export von Mood/Tags in PDF/EPUB/Migration-Bundle (Phase 2; Reversibilität beachten).

## Done when

- In einem `tagebuch`-Buch zeigt der Notebook-Editor-Kopf Mood-Auswahl + Tag-Leiste; in Nicht-Tagebuch-Büchern nicht.
- Mood setzen/ändern/entfernen persistiert über Reload hinweg.
- Tag hinzufügen/entfernen persistiert; bereits genutzte Tags werden beim Tippen vorgeschlagen.
- Löschen einer Seite entfernt deren Mood/Tag-Zuordnungen kaskadierend (kein FK-Verstoss; `foreign_key_check` grün).
- `npm run squash:regen` + `docs/erd.md` aktualisiert; squash-drift- und erd-drift-Tests grün.
- Alle neuen Strings in `de.json` + `en.json`.

## Hard-Rule-Audit

- **Editor-Spezifikation:** betroffen — ausschliesslich **Notebook-Editor** (`public/js/editor/notebook/`, Card `editor-notebook-card.js`). Focus-Editor + Bucheditor unberührt; im Diff sichtbar gemacht.
- **Content-Store-Facade als einziger Eintrittspunkt für Buchinhalte:** nicht verletzt — Mood/Tags sind **keine** Buchinhalte (kein Page-Body), liegen in separater Tabelle, Zugriff über eigene `/journal-meta`-Route. `pages` wird nicht direkt beschrieben.
- **DB-Integrität:** betroffen — neue Tabellen via FK auf `pages(page_id)` + `books(book_id)`, ON DELETE CASCADE, Index auf jede FK-Spalte, keine Snapshot-Spalten, Timestamps via `NOW_ISO_SQL`. Details unter DB.
- **KI-Calls nur via Job-Queue:** n/a — kein KI-Call.
- **UI-Strings nur in i18n:** betroffen — Mood-Labels + alle UI-Strings als Keys in beiden Locales.
- **Combobox statt `<select>`:** betroffen — Mood-Auswahl als `Alpine.data('combobox')` (compact), kein natives `<select>`.
- **LanguageTool auf Prosatextfeldern:** Tag-Eingabe ist ein **Token-/Filter-artiges** Eingabefeld (Schlagwort-Auswahl, kein Prosatext) → **kein** `data-spellcheck` (Ausnahme „Such-/Filter-Feld" gilt analog). Begründung als Edge-Case dokumentiert.
- **Eckige Badges / sparsame Icons:** Tags als eckige Badges (`var(--radius-sm)`); Mood-Emoji als Glyph (kein Lucide-Icon nötig); etwaige UI-Icons via `/icons.svg`.
- **`x-html`-Escape:** betroffen — Tag-Text ist User-Eingabe; Rendering ausschliesslich via `x-text` (kein `x-html`-Sink). Damit kein Escape-Risiko.
- **SHELL_CACHE bumpen:** betroffen — JS/CSS-Änderungen → `SHELL_CACHE` in `public/sw.js` hochzählen.
- **Logging-Context book-slot:** betroffen — neue Routen mit Buchscope setzen `book` im ALS-Context (`router.param('book_id', …)` bzw. `setContext` nach `toIntId`).

## Abhängigkeiten

- **Voraussetzung für** `tagebuch-jahresrueckblick-ki.md` (Stimmungskurve + Themen-Häufung lesen `journal_mood`/`journal_tags`) — dort als Dependency benennen.
- Geschwister-Pläne `tagebuch-heute-eintrag.md`, `tagebuch-rueckblick.md`, `tagebuch-erinnerung.md`, `tagebuch-fotos.md`: kein harter Konflikt; ggf. gemeinsame Tagebuch-Editor-Kopfzeile (Koordination).
- Buchtyp-Erkennung: `books`-Buchtyp / BookSettings (`routes/booksettings.js`) liefert das `tagebuch`-Flag fürs konditionale Einblenden.

## Backend

Eigene Route `routes/journal-meta.js` (gemountet in `server.js`), Zugriff via eigenes db-Modul `db/journal-meta.js`. **Warum nicht Content-Store:** die Facade kapselt Page-Body/Revisions/FTS/Tree-Overlay; Mood/Tags sind Eintrags-**Metadaten** ohne Body-Anteil und ohne Revisionierung. Sie über die Facade zu schleusen würde deren Vertrag (Page-Inhalt) aufweichen. Separate Tabelle + Route hält die Trennung sauber; FK auf `pages(page_id)` sichert die Integrität.

Endpunkte (alle Session-geschützt, ACL auf Buch wie übrige Buch-Routen):
- `GET /journal-meta/:page_id` → `{ mood: number|null, tags: string[] }`. Kurzvertrag: liest Mood-Stufe + zugeordnete Tags der Seite. 404 wenn Seite fremd/nicht vorhanden.
- `PUT /journal-meta/:page_id/mood` Body `{ mood: 1..5 | null }` → setzt/entfernt Mood (UPSERT bzw. DELETE bei `null`). Validierung: Integer 1–5.
- `PUT /journal-meta/:page_id/tags` Body `{ tags: string[] }` → ersetzt die Tag-Menge der Seite (diff-basiert intern). Normalisierung: trim, lowercase, dedupe, Längen-Cap, Anzahl-Cap.
- `GET /journal-meta/book/:book_id/tags` → distinkte Tags des Buchs (für Autovervollständigung/Vorschlag). Logging-Context via `router.param('book_id', bookParamHandler)`.

Alle Schreibrouten: ACL-Check (User darf Buch editieren), `setContext({ book })` nach Validierung. Kein KI-Call, daher keine Job-Queue.

## Frontend

Kein eigener Karten-Toggle — die Metadaten-UI lebt **im Notebook-Editor-Kopf**, sichtbar nur wenn `selectedBook.buchtyp === 'tagebuch'`.

- Neues Editor-Fachmodul `public/js/editor/notebook/journal-meta.js` → `journalMetaMethods` (Lade-/Speicher-/Tag-Add-/Tag-Remove-Logik), via Facade-Pattern in `editor-notebook-card.js` gemischt; Root-Zugriffe über `window.__app`.
- State im Notebook-Card-Scope: `journalMood` (number|null), `journalTags` (string[]), `journalTagSuggestions` (string[]).
- Mood-Auswahl: `Alpine.data('combobox')` (compact) mit 5 Optionen `{ value: 1..5, label: t('journal.mood.n') }` + Emoji im Label; leere Auswahl = entfernen.
- Tag-Eingabe: Text-Input → Enter/Komma fügt Token hinzu; bestehende Tags als eckige Badges mit Entfernen-Affordance; Vorschlagsliste aus `journalTagSuggestions`. **Kein** `data-spellcheck` (Filter-/Token-Feld).
- Persistenz: debounced PUT bei Mood-/Tag-Änderung (analog Autosave-Idee, aber eigene Route). Lädt `GET /journal-meta/:page_id` beim Öffnen einer Tagebuch-Seite; reagiert auf `book:changed`/`view:reset` (State leeren).
- Card-Recipe-Schritte (`FEATURES`/`EXCLUSIVE_CARDS`/Hash-Router/`ALLOWED_KEYS`): **n/a** — keine neue Hauptkarte, kein Toggle, kein eigener Hash-Branch.

## CSS

Neue Datei `public/css/editor/journal-meta.css` (Editor-Subfolder) für Mood-Combobox-Zeile + Tag-Badge-Leiste. `<link>` in `public/index.html` + `SHELL_CACHE` bump + DESIGN.md CSS-File-Inventar-Eintrag. Tag-Badges: eckig via `var(--radius-sm)`, bestehendes Badge/Tag-Pattern aus DESIGN.md wiederverwenden. Keine Inline-Styles. Mobile-Breakpoint (Tag-Leiste umbrechend) im selben File.

## i18n

Neue Key-Bereiche in `de.json` + `en.json`:
- `journal.mood.label`, `journal.mood.placeholder`, `journal.mood.1` … `journal.mood.5` (z.B. „sehr schlecht" … „sehr gut").
- `journal.tags.label`, `journal.tags.placeholder`, `journal.tags.add`, `journal.tags.remove`, `journal.tags.suggestions`.
- Fehler-/Status-Strings der Route, soweit user-sichtbar.

## DB

Migration `if (version < 174)` in `db/migrations.js` (nächste Nummer; aktuelle Version 173). Zwei neue Tabellen (relationale Tag-Bridge statt TEXT-Liste — saubere Integrität, Distinct-Query fürs Buch trivial, kein Parse/Split):

```sql
-- 1:1 Mood pro Seite
CREATE TABLE IF NOT EXISTS journal_mood (
  page_id    INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
  mood       INTEGER NOT NULL CHECK(mood BETWEEN 1 AND 5),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- N:M Tags pro Seite (Bridge); Tag-Text als normalisiertes Label, book_id für Distinct-Query
CREATE TABLE IF NOT EXISTS journal_tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id    INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
  book_id    INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(page_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_journal_tags_page ON journal_tags(page_id);
CREATE INDEX IF NOT EXISTS idx_journal_tags_book ON journal_tags(book_id);
CREATE INDEX IF NOT EXISTS idx_journal_tags_book_tag ON journal_tags(book_id, tag);
```

- **Warum Bridge statt TEXT-Liste:** relationale Integrität (CLAUDE.md bevorzugt FK), distinkte Buch-Tags via simplem `SELECT DISTINCT tag … WHERE book_id=?`, kaskadierendes Aufräumen bei Seiten-/Buchlöschung ohne Parse-Logik. `book_id` ist **kein** Snapshot (es ist ein echter FK, redundant zur Page→Book-Kante, aber nötig für die Distinct-Query ohne JOIN-Hop) — falls als Drift gewertet: stattdessen JOIN über `pages.book_id` (offene Frage unten).
- **ON DELETE CASCADE** für beide Tabellen: reine Zusatz-/Eintragsdaten ohne eigenständigen kuratierten Wert über die Seite hinaus.
- `journal_mood` als PK auf `page_id` erzwingt 1:1 ohne Sentinel.
- Keine Snapshot-Spalten (`page_name`/`chapter_name` etc.).
- Code-Pfad-Timestamps (UPSERT/INSERT in `db/journal-meta.js`) via `${NOW_ISO_SQL}` aus `db/now.js`.
- Migration endet mit `foreign_key_check` + `UPDATE schema_version SET version = 174`.
- **Pflicht im selben Commit:** `npm run squash:regen` (regeneriert `db/squashed-schema.js`) + `docs/erd.md` aktualisieren (Stand-Zeile auf „Schema-Version 174, 92 Tabellen" + zwei neue Mermaid-Blöcke + FK-Kanten `journal_mood→pages`, `journal_tags→pages`, `journal_tags→books`).

## Security

- Auth: alle `/journal-meta/*`-Routen hinter dem Session-Guard; ACL-Check auf Buch-Edit-Recht vor jedem Schreiben (analog bestehender Buch-Routen).
- Escape: Tag-Text rein via `x-text` gerendert (kein `x-html`-Sink) → keine XSS-Fläche.
- Eingabe-Härtung: Mood Integer 1–5 (CHECK + Route-Validierung); Tag trim/lowercase/Längen-Cap (z.B. 40 Zeichen) + Anzahl-Cap pro Seite (z.B. 20) gegen Storage-Abuse.
- PII: Tags/Mood sind potenziell sensible Tagebuch-Metadaten — bleiben buch-/userscoped wie Page-Inhalte; self-hosted, kein externer Versand.

## Telemetrie

n/a — kein neuer `/metrics`-Counter im MVP. (Optional Phase 2: Anteil Tagebuch-Seiten mit Mood/Tags — dann Pflicht-Pflege in `lib/metrics-collector.js` + HA-Dateien.)

## Reversibilität

- Feature ist konditional an Buchtyp `tagebuch` gekoppelt — abschaltbar durch Ausblenden der Editor-Kopf-UI.
- Daten-Rückbau: `DROP TABLE journal_tags; DROP TABLE journal_mood;` in einer Folgemigration; keine Fremd-Tabelle referenziert sie, daher folgenlos.
- Kein Eingriff in `pages`/Content-Store → Buchinhalte bleiben bei Ausbau unverändert.

## Tests

- **Unit** (`tests/unit/`): Tag-Normalisierung (trim/lowercase/dedupe/Caps), Mood-Validierung (1–5, null=delete) als pure Helper.
- **Integration** (`tests/integration/`): `/journal-meta`-Routen gegen Test-DB — UPSERT-Mood, Tag-Replace-Diff, Distinct-Buch-Tags, CASCADE bei Seiten-Löschung (`foreign_key_check` grün).
- **Drift-Gates:** `tests/unit/squash-drift.test.mjs` + `tests/unit/erd-drift.test.mjs` müssen nach `squash:regen` + ERD-Update grün sein.
- **E2E/Smoke:** Notebook-Editor-Harness um Tagebuch-Fall erweitern (Mood setzen, Tag hinzufügen, Reload-Persistenz); Console-Guard fängt Alpine-Fehler.

## Edge-Cases

- **Nicht-Tagebuch-Buch:** Editor-Kopf-UI bleibt verborgen; Routen liefern bei Nicht-Tagebuch-Seiten trotzdem keinen 500 (leere Antwort), UI fragt aber nicht an.
- **Seite gelöscht während Edit:** PUT trifft fehlende `page_id` → 404, Client verwirft still.
- **Tag-Eingabe mit Sonderzeichen/Whitespace/Duplikat:** Normalisierung greift; leere Tags verworfen; `UNIQUE(page_id, tag)` verhindert Doppel.
- **Tag-Feld bewusst ohne Spellcheck:** Token-/Filter-Feld (User vergibt Schlagworte, kein Prosatext) — Selbst-Meckern unerwünscht (analog Such-/Find-Feld-Ausnahme).
- **Buchtyp-Wechsel weg von `tagebuch`:** Daten bleiben in der Tabelle (kein Verlust), UI nur ausgeblendet — bei Rückwechsel wieder sichtbar.
- **`book_id`-Redundanz:** falls erd-drift/Review die `book_id`-Spalte als Snapshot-nah moniert → Fallback JOIN über `pages.book_id` (siehe Offene Fragen).

## Kritische Dateien

- **Modify:**
  - `db/migrations.js` (Migration 174)
  - `db/squashed-schema.js` (regeneriert via `npm run squash:regen`)
  - `docs/erd.md` (Stand-Zeile + Blöcke + FK-Kanten)
  - `server.js` (Route-Mount `/journal-meta`)
  - `public/js/cards/editor-notebook-card.js` (State + `journalMetaMethods` einmischen)
  - `public/partials/` Notebook-Editor-Kopf-Partial (Mood-Combobox + Tag-Leiste)
  - `public/index.html` (`<link>` neue CSS)
  - `public/sw.js` (`SHELL_CACHE` bump)
  - `public/js/i18n/de.json`, `public/js/i18n/en.json`
  - `DESIGN.md` (CSS-File-Inventar)
- **Create:**
  - `routes/journal-meta.js`
  - `db/journal-meta.js`
  - `public/js/editor/notebook/journal-meta.js`
  - `public/css/editor/journal-meta.css`
  - Tests: `tests/unit/journal-meta.test.mjs`, `tests/integration/journal-meta.test.js`

## Offene Fragen

- `book_id`-Spalte in `journal_tags` behalten (Distinct-Query ohne JOIN) oder weglassen und über `pages.book_id` joinen? Entscheidung mit Blick auf erd-drift/Snapshot-Regel.
- Mood-Skala: 5-stufig Emoji (vorgeschlagen) vs. feinere Skala — Festlegung der konkreten Emoji + Labels mit dem User.
- Tag-Caps (Länge/Anzahl pro Seite) konkrete Werte bestätigen.
- Gemeinsame Tagebuch-Editor-Kopfzeile mit Geschwister-Plänen (`tagebuch-heute-eintrag.md`, `tagebuch-fotos.md`) koordinieren — eigenes Modul oder gemeinsamer Container?
