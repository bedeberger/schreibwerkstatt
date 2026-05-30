# Welt-Fakten / Weltregeln

- **Status:** Umgesetzt — Persistenz + Chat-Tool (Migration 161) **+ Browse-Karte** (`worldFactsCard`, read-only, Gruppierung nach Kategorie, Filter Suche/Kategorie).
- **Aufwand:** M
- **Severity:** high <!-- grösste inhaltliche Lücke im „Buch-Wissen", das die App abfragbar machen will -->

## Context

Die Komplettanalyse extrahiert pro Kapitel `fakten` (Magiesystem-Regeln, Geografie, Daten, etablierte Aussagen) — Schema `{ kategorie, subjekt, fakt, seite }` ([public/js/prompts/komplett/schemas.js:80](../../public/js/prompts/komplett/schemas.js#L80)). Diese Fakten werden in Phase 1 gebaut, im Checkpoint `p1_full_done` gehalten ([routes/jobs/komplett/phases.js:283](../../routes/jobs/komplett/phases.js#L283)), in Phase 8 dem Kontinuitäts-Check als Prompt-Input übergeben ([public/js/prompts/komplett/kontinuitaet.js:69](../../public/js/prompts/komplett/kontinuitaet.js#L69)) — und danach **weggeworfen**. Es gibt keine `world_facts`-Tabelle (Schema-Version aktuell 159).

Folge: Der Buch-Chat kann „welche Weltregeln/Fakten gelten in meinem Buch" nicht beantworten. Genau das deklarative „Buch-Wissen" (im Gegensatz zum narrativen Text), das die App abfragbar machen soll, ist nirgends persistiert. Figuren, Orte, Szenen, Ereignisse haben je eine Tabelle + Chat-Tool — Fakten als fünfte deklarative Entität fehlen.

Produkt-Bezug: passt exakt ins Leitbild „KI rückwärtsgewandt — Überwachung + Weltaufbau, nie generativ in den Text" ([[user_app_philosophy]]). Fakten sind reines Welt-Wissen, kein generierter Prosatext.

## Scope MVP

- **Tabelle `world_facts`** (book-scoped, user-scoped wie `locations`) + Bridge `world_fact_chapters` auf `chapters`.
- **Persistenz-Write im Komplettanalyse-Job**: `saveFaktenToDb(bookId, chapterFakten, userEmail, chNameToId)` nach Phase 1, analog `saveOrteToDb`. Vollständiger Replace pro `(book, user)` — Fakten sind regenerierter KI-Cache ohne stabile ID, kein Upsert (siehe Offene Fragen 1).
- **Buch-Chat-Tool `list_world_facts(input, ctx)`** — optionale Filter `kategorie` / `subjekt`, gibt `{ fakten: [{ kategorie, subjekt, fakt, kapitel }] }` zurück. Registriert in [routes/jobs/book-chat-tools/index.js](../../routes/jobs/book-chat-tools/index.js).
- **Tool-Doku** in [docs/buchchat-tools.md](../buchchat-tools.md) (Tool-Inventar +1).
- **Cache-Invalidierung**: keine — Fakten hängen am bestehenden `chapter_extract_cache`. Re-Run → Full-Replace.

## Out-of-Scope

- **Welt-Fakten-Browse-Karte** (read-only Card analog Orte/Szenen). Naheliegend (jede Entität hat eine Karte), aber MVP ist „abfragbar im Chat". Eigene Phase 2 — siehe Offene Fragen 4.
- **Manuelles Fakten-CRUD / Inline-Edit.** Fakten sind rein KI-getrieben; manuelle Pflege ist Edge-Case (konsistent mit Ereignisse-Plan). Kein `manually_edited`-Schutz im MVP.
- **Bridge Fakt → Figur** (`subjekt` ist oft ein Figurenname, aber Freitext, kein zuverlässiger FK). Kein `world_fact_figures` im MVP.
- **`seite` → `page_id`-Auflösung.** AI-`seite` ist unscharf (Label-String). Im MVP nur Kapitel-Bridge, keine Seiten-FK.
- **Fakten-Konsolidierung über Kapitel** (Dedup gleicher Aussage in mehreren Kapiteln). MVP speichert wie extrahiert.
- **Eigenes Fakten-Extraktions-Schema / Prompt-Änderung.** Schema existiert bereits — kein `PROMPTS_VERSION`-Bump.

## Done when

- Nach einer Komplettanalyse stehen die Fakten in `world_facts` (prüfbar via DB-Query + Integration-Test).
- `list_world_facts` liefert im Buch-Chat die Fakten zurück; Frage „welche Weltregeln gelten?" wird vom Agenten mit echten Daten beantwortet.
- Re-Run der Komplettanalyse ersetzt die Fakten vollständig (keine Dubletten-Akkumulation).
- Buch-Löschung / Kapitel-Löschung räumt Fakten + Bridge per CASCADE ab (FK-Test).
- `npm run squash:regen` + ERD aktualisiert, Drift-Tests grün.

## Hard-Rule-Audit

- **Editor-Spezifikation**: nicht betroffen (keine Editor-Änderung).
- **UI-Patterns aus DESIGN.md**: MVP ohne UI → n/a. (Browse-Karte Phase 2 würde Entitäts-Listen-Pattern wiederverwenden.)
- **Prompts nur unter `prompts/`**: keine Prompt-Änderung — Schema existiert. Kein `PROMPTS_VERSION`-Bump.
- **KI-Calls nur via Job-Queue**: kein neuer KI-Call. Persistenz läuft im bestehenden `komplett-analyse`-Job. `list_world_facts` ist ein reiner DB-Read im Chat-Job (kein KI-Call). ✓
- **`callAI` gibt nur JSON**: nicht betroffen (kein neuer Call).
- **Content-Store-Facade**: nicht betroffen — `world_facts` ist eigene Entität, kein `pages`/`chapters`/`books`-Content. Chapter-Namen-Lookup nutzt bestehende `chNameToId`-Map aus der Pipeline (kein Direkt-SQL auf `chapters` aus neuem Code). ✓
- **DB-Integrität**: `book_id` → `books(book_id)`, Bridge `fact_id` → `world_facts(id)` CASCADE, `chapter_id` → `chapters(chapter_id)` CASCADE. Index auf jede FK-Spalte. Keine Snapshot-Spalten (Kapitelname zur Lesezeit per JOIN). ✓
- **DB-Timestamps ISO+Z**: `updated_at` via `${NOW_ISO_SQL}` / Schema-Default `strftime('%Y-%m-%dT%H:%M:%fZ','now')` ([[feedback_db_timestamps_iso_z]]). ✓
- **Sentinel-frei**: kein Sentinel — Single-Pass-Fakten ohne echtes Kapitel bekommen schlicht keinen `world_fact_chapters`-Eintrag (book-level), kein `kapitel='__book__'`. ✓
- **Logging-Context `book`**: Persistenz im Job-Worker → `bookId` automatisch im ALS-Context. Chat-Tool läuft im book-scoped Chat-Job. ✓
- **x-html-Escape**: MVP rendert kein HTML. Tool-Result ist Daten an den Agenten. (Browse-Karte Phase 2: `x-text` / `escHtml`.) n/a für MVP.
- **i18n**: MVP ohne User-sichtbare Strings (Tool-Result = Daten). n/a. (Browse-Karte Phase 2: Keys nötig.)
- **SHELL_CACHE**: kein Frontend-Asset im MVP → kein Bump nötig. (Phase 2 mit Karte: bumpen.)

## Abhängigkeiten

- **Komplettanalyse-Pipeline** ([routes/jobs/komplett/phases.js](../../routes/jobs/komplett/phases.js)): Write-Hook nach Phase 1; nutzt `idMaps.chNameToId` (existiert bereits für `saveOrteToDb`).
- **Buch-Chat-Tool-Framework** ([routes/jobs/book-chat-tools/](../../routes/jobs/book-chat-tools/)): neues Tool im `TOOLS`-Registry, `ctx`-Vertrag `{ bookId, userEmail, ... }`.
- **Kontinuitäts-Check**: unverändert — liest weiterhin `chapterFakten` aus dem Checkpoint (kein Umbau auf DB-Read im MVP nötig; siehe Offene Fragen 3).

## Backend

**Persistenz** — neue Datei oder Ergänzung in [db/schema.js](../../db/schema.js) (wo `saveOrteToDb` lebt):

```js
// saveFaktenToDb(bookId, chapterFakten, userEmail, chNameToId)
// chapterFakten: [{ kapitel, fakten: [{ kategorie, subjekt, fakt, seite }] }]
// 1. DELETE FROM world_facts WHERE book_id=? AND user_email IS ?  (CASCADE räumt Bridge)
// 2. pro Fakt: INSERT world_facts(book_id, kategorie, subjekt, fakt, seite_label, sort_order, user_email, updated_at)
// 3. chapter_id via chNameToId[cf.kapitel]; wenn vorhanden → INSERT world_fact_chapters(fact_id, chapter_id)
//    (Single-Pass „Gesamtbuch" → kein Match → kein Bridge-Eintrag, book-level Fakt)
// Alles in einer Transaction.
```

Aufruf in [routes/jobs/komplett/phases.js](../../routes/jobs/komplett/phases.js) nach Verfügbarkeit von `chapterFakten` + `idMaps.chNameToId` (gleiche Stelle/Phase wie `saveOrteToDb`, ~Zeile 438).

**Chat-Tool** — [routes/jobs/book-chat-tools/tools-catalog.js](../../routes/jobs/book-chat-tools/tools-catalog.js):

```js
function tool_list_world_facts(input, ctx) {
  // WHERE wf.book_id=? AND wf.user_email IS ? [AND wf.kategorie=?] [AND wf.subjekt LIKE ?]
  // LEFT JOIN world_fact_chapters wfc + chapters c → kapitel-Name zur Lesezeit (kein Snapshot)
  // return { fakten: [{ kategorie, subjekt, fakt, kapitel }] }
}
```

Registrieren in [routes/jobs/book-chat-tools/index.js](../../routes/jobs/book-chat-tools/index.js) (`TOOLS.list_world_facts = catalog.tool_list_world_facts`) + Tool-Schema/Beschreibung im Tool-Inventar des Buch-Chat-Prompts ([public/js/prompts/chat.js](../../public/js/prompts/chat.js), `BOOK_CHAT_TOOLS`). Truncation greift automatisch über `_truncateResult`.

## Frontend

MVP: **n/a** (kein Frontend — reines Backend + Chat-Tool).

Phase 2 (Out-of-Scope): `worldFactsCard` analog `szenenCard` — read-only Liste gruppiert nach `kategorie`, Filter-Combobox, Card-Recipe-Schritte (Registry `FEATURES`/`EXCLUSIVE_CARDS`, `ALLOWED_KEYS` in [routes/usage.js](../../routes/usage.js), Hash-Router, `showWorldFactsCard`-Flag).

## CSS

MVP: **n/a**. (Phase 2 Karte: `public/css/entities/world-facts.css` + Eintrag in index.html + SHELL_CACHE-Bump + DESIGN.md.)

## i18n

MVP: **n/a** (Tool-Result ist Daten, kein User-String). Phase 2 Karte: `worldFacts.title`, `worldFacts.empty`, `worldFacts.kategorie.*`, Quick-Pill-Label — in `de` + `en`.

## DB

**Migration 160** ([db/migrations.js](../../db/migrations.js)):

```sql
CREATE TABLE IF NOT EXISTS world_facts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
  kategorie   TEXT,
  subjekt     TEXT,
  fakt        TEXT NOT NULL,
  seite_label TEXT,            -- unscharfer AI-Seiten-String, keine FK (MVP)
  sort_order  INTEGER DEFAULT 0,
  user_email  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_world_facts_book ON world_facts(book_id);

CREATE TABLE IF NOT EXISTS world_fact_chapters (
  fact_id    INTEGER NOT NULL REFERENCES world_facts(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
  PRIMARY KEY (fact_id, chapter_id)
);
CREATE INDEX IF NOT EXISTS idx_wfc_chapter ON world_fact_chapters(chapter_id);
```

Migration endet mit `foreign_key_check` + `UPDATE schema_version SET version = 160` (Pflicht-Pattern). Danach **`npm run squash:regen`** + [docs/erd.md](../erd.md) aktualisieren (Stand-Zeile v160 + Tabellen-Anzahl, 2 neue Blocks, FK-Kanten zu `books`/`chapters`, Caches-Sub-Diagramm). Drift-Tests ([tests/unit/squash-drift.test.mjs](../../tests/unit/squash-drift.test.mjs), [tests/unit/erd-drift.test.mjs](../../tests/unit/erd-drift.test.mjs)) gaten das.

ON-DELETE-Wahl: CASCADE überall — `world_facts` ist regenerierter Aggregat-Cache (analog `page_stats`, `figure_appearances`), keine user-kuratierten Daten.

## Security

- Tool läuft unter Auth-Guard im book-scoped Chat-Job; `ctx.bookId` + `ctx.userEmail` scopen den Read (ACL-Kontext kommt aus dem Job).
- Keine PII; Fakten sind Buchinhalt des Eigentümers.
- Kein neuer HTTP-Endpoint im MVP → keine zusätzliche Rate-Limit-/ACL-Fläche.
- Filter-Inputs (`kategorie`, `subjekt`) als Prepared-Statement-Parameter (kein SQL-Injection-Vektor).

## Telemetrie

MVP optional: `world_facts_total{book_id}` (Gauge) bei Komplettanalyse-Write. Tool-Call-Count läuft über bestehende Buch-Chat-Tool-Metrik (falls vorhanden). Sonst n/a.

## Reversibilität

- Additiv: zwei neue Tabellen, ein Write-Hook, ein Chat-Tool. Kein bestehender Pfad geändert.
- Ausbau: Tool aus `TOOLS` entfernen, `saveFaktenToDb`-Aufruf entfernen, Tabellen droppen. Kontinuitäts-Check bleibt unberührt (liest weiter Checkpoint).
- Kein Daten-Verlust für andere Entitäten (eigenständige Tabellen).
- Kein Feature-Flag nötig — Tool ohne Daten liefert leere Liste, degradiert sauber.

## Tests

- **Unit** [tests/unit/save-fakten.test.mjs](../../tests/unit/save-fakten.test.mjs) (neu): `saveFaktenToDb` — Full-Replace (zweiter Run ersetzt, keine Dubletten), Chapter-Bridge gesetzt bei Match, kein Bridge bei „Gesamtbuch"/unbekanntem Kapitel, leeres `chapterFakten` → 0 Rows.
- **Integration** [tests/integration/komplett.test.js](../../tests/integration/komplett.test.js) (erweitern): Pipeline gegen Mock-AI schreibt Fakten in `world_facts`; Re-Run idempotent.
- **Integration** [tests/integration/book-chat-tools.test.js](../../tests/integration/book-chat-tools.test.js) (neu oder erweitern): `list_world_facts` liefert Rows, Filter `kategorie`/`subjekt`, Kapitelname per JOIN.
- **FK/CASCADE**: Buch löschen → `world_facts` + `world_fact_chapters` leer; Kapitel löschen → nur Bridge weg, Fakt bleibt (book-level).

## Edge-Cases

- **Single-Pass-Extraktion** (`kapitel='Gesamtbuch'`) → `chNameToId`-Miss → Fakt ohne Chapter-Bridge (book-level). Tool liefert `kapitel: null`.
- **Fakt-Text leer / nur Whitespace** → skip beim Insert (`fakt` ist NOT NULL).
- **Identischer Fakt in mehreren Kapiteln** → mehrere Rows (kein Dedup im MVP, bewusst).
- **Sehr viele Fakten** (langes Buch) → Tool-Result-Truncation via `_truncateResult` greift; ggf. `kategorie`-Filter nötig (Agent steuert selbst).
- **Kapitel umbenannt zwischen zwei Analysen** → Full-Replace baut Bridge neu; kein Stale.
- **Re-Run bricht nach Phase 1 ab** → Fakten bereits geschrieben, konsistent (Write nach Phase-1-Abschluss, in eigener Transaction).
- **Kategorie-Drift** (KI liefert uneinheitliche `kategorie`-Strings) → keine Whitelist; Tool gibt roh zurück. Konsolidierung Out-of-Scope.

## Kritische Dateien

**Modify:**
- [db/migrations.js](../../db/migrations.js) (Migration 160)
- [db/squashed-schema.js](../../db/squashed-schema.js) (via `npm run squash:regen`)
- [docs/erd.md](../erd.md) (Stand-Zeile, Blocks, FK-Kanten)
- [db/schema.js](../../db/schema.js) (`saveFaktenToDb`)
- [routes/jobs/komplett/phases.js](../../routes/jobs/komplett/phases.js) (Write-Hook nach Phase 1)
- [routes/jobs/book-chat-tools/index.js](../../routes/jobs/book-chat-tools/index.js) (Tool-Registry)
- [routes/jobs/book-chat-tools/tools-catalog.js](../../routes/jobs/book-chat-tools/tools-catalog.js) (`tool_list_world_facts`)
- [public/js/prompts/chat.js](../../public/js/prompts/chat.js) (`BOOK_CHAT_TOOLS` — Tool-Beschreibung)
- [docs/buchchat-tools.md](../buchchat-tools.md) (Tool-Inventar +1)
- [tests/integration/komplett.test.js](../../tests/integration/komplett.test.js)

**Create:**
- [tests/unit/save-fakten.test.mjs](../../tests/unit/save-fakten.test.mjs)
- [tests/integration/book-chat-tools.test.js](../../tests/integration/book-chat-tools.test.js) (falls nicht vorhanden)

## Offene Fragen

> Alle Entscheidungen getroffen + umgesetzt: **1 = Full-Replace**, **2 = nur `list_world_facts`**, **3 = Standalone-Kontinuitätscheck nutzt persistierte Welt-Fakten** (`loadWorldFactsGrouped`, überspringt die Kapitel-Extraktion → N KI-Calls gespart; Pipeline-Phase-8 behält den frischen In-Memory-Stand), **4 = Browse-Karte umgesetzt** (`worldFactsCard`). Keine offenen Punkte mehr.

1. **Full-Replace vs. Delta-Persistenz.** Fakten haben keine stabile AI-ID (anders als `loc_id` bei Orten) → MVP macht Full-Replace pro `(book, user)`. Sauber, solange kein manuelles Edit existiert. Sobald manuelle Fakten kommen (Out-of-Scope), bräuchte es `manually_edited`-Schutz + Hash-Key für Dedup. **Empfehlung:** Full-Replace beibehalten, manuelle Edits bleiben Edge-Case (konsistent mit Ereignisse-Leitbild). → entscheidbar, neige zu Full-Replace.

2. **Ein Tool oder zwei?** Idee nannte `list_fakten` + `get_fakten`. `list_world_facts` mit `kategorie`/`subjekt`-Filter deckt beides ab — ein separates `get` wäre redundant, solange es keine Fakt-ID-Adressierung gibt. **Empfehlung:** nur `list_world_facts` im MVP.

3. **Kontinuitäts-Check auf DB-Read umstellen?** Aktuell liest Phase 8 `chapterFakten` aus dem Checkpoint. Mit persistierten Fakten *könnte* der Standalone-Kontinuitätscheck (`POST /jobs/kontinuitaet`) sie aus der DB lesen statt neu zu extrahieren → Token-Ersparnis. Out-of-Scope für MVP, aber Folge-Optimierung. Lohnt sich das, oder bleibt Checkpoint-Read einfacher?

4. **Browse-Karte (Phase 2) ja/nein?** Jede deklarative Entität (Figuren/Orte/Szenen/Ereignisse) hat eine Karte. Eine read-only Welt-Fakten-Karte wäre konsistent und macht das Wissen auch ausserhalb des Chats sichtbar. MVP fokussiert „abfragbar im Chat" — Karte als Phase 2. Direkt mitnehmen oder erst nach Chat-Validierung?
