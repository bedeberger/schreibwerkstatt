# KI-Jahres-/Monatsrückblick (Tagebuch)

- **Status:** Umgesetzt (MVP)
- **Aufwand:** L
- **Severity:** medium <!-- Differenzierungsmerkmal für Buchtyp `tagebuch`, aber kein Kern-Workflow -->

## Context

Für den Buchtyp `tagebuch` fehlt eine rückwärtsgewandte Verdichtung: Wer ein Jahr lang datierte Einträge schreibt, will am Jahres-/Monatsende eine KI-gestützte Zusammenfassung — häufige Themen, wiederkehrende Personen/Orte, Stimmungsverlauf, bemerkenswerte Tage. Das passt exakt zur App-Philosophie „KI rückwärtsgewandt, nie generativ": die Analyse beobachtet und verdichtet bereits Geschriebenes, sie schreibt **nie** in den Buchtext. Ergänzt die Tagebuch-Linie (`tagebuch-heute-eintrag`, `tagebuch-stimmung-tags`, `tagebuch-rueckblick`, `tagebuch-erinnerung`, `tagebuch-fotos`) um die aggregierende Auswertungs-Ebene.

## Scope MVP

- Neue Buchkarte „Rückblick" (nur sichtbar bei `buchtyp === 'tagebuch'`).
- Zeitraum-Auswahl: Monat (`YYYY-MM`) oder Jahr (`YYYY`) via Combobox; Default = letzter vollständiger Kalendermonat mit Einträgen.
- Einträge-Selektion: Tagebuch-Seiten, deren `page_name` als Kalenderdatum parsebar ist (`YYYY-MM-DD` bevorzugt, `parseDatum` aus [lib/datum-parse.js](../../lib/datum-parse.js) als Fallback), gefiltert auf den gewählten Zeitraum.
- KI-Job `runRueckblickJob` (Job-Queue), liefert strukturiertes JSON: `themen[]` (Label + Häufigkeit + Beleg-Datumsliste), `personen[]`/`orte[]` (Nennungs-Häufigkeit, verknüpft mit `figures`/`locations` wenn Komplettanalyse vorhanden), `bemerkenswerteTage[]` (Datum + Ein-Satz-Begründung), `zusammenfassung` (Fliesstext, 2–4 Absätze).
- Map-Reduce-Chunking über Monate, wenn Zeitraum > `SINGLE_PASS_LIMIT` (siehe Backend).
- Anzeige in der Karte: Zusammenfassungs-Text + Themen-/Personen-/Orte-Listen + bemerkenswerte Tage als anklickbare Links zur Seite (`gotoStelle`/`selectPage`).
- Halluzinations-Constraint im Prompt: nur belegte Aussagen, jedes Thema/jeder Tag mit Datums-Beleg; keine erfundenen Ereignisse.
- Cache pro `(book_id, user_email, zeitraum, provider, cacheVersion)` analog Review-Caches.

## Out-of-Scope

- **Stimmungskurve** (Chart.js) — Phase 2. Hängt an `tagebuch-stimmung-tags` (Mood-Daten existieren ohne dieses Feature nicht). MVP zeigt Themen/Personen/Orte/Tage ohne Kurve.
- Schreiben in den Buchtext oder Anlegen neuer Tagebuch-Seiten aus dem Rückblick — **dauerhaft ausgeschlossen** (App-Philosophie).
- Freie Datumsbereiche (von–bis quer über Monatsgrenzen) — Phase 2; MVP nur Monat/Jahr.
- Export des Rückblicks (PDF/Markdown) — Phase 2.
- In-Story-Zeitstrahl (`zeitstrahl_events`) — bewusst nicht Datenquelle (In-Story-Zeit ≠ Kalenderzeit eines Tagebuchs).

## Done when

- Karte erscheint nur bei `tagebuch`-Büchern, sonst nicht in Pills/Palette/Overview.
- Monat/Jahr wählbar; Job läuft, pollt, rendert Ergebnis ohne unbehandelten Fehler (Smoke-Guard grün).
- Ergebnis nennt nur belegte Themen/Personen/Orte/Tage mit Datums-Beleg; kein Buchtext wird verändert (verifizierbar: keine `content-store`-Write-Calls im Job-Pfad).
- Zweiter identischer Lauf trifft den Cache (kein KI-Call, Log „Cache-HIT").
- Ein-Jahr-Buch mit vielen Einträgen läuft über Map-Reduce ohne Token-Überlauf durch.

## Hard-Rule-Audit

- **KI-Calls nur via Job-Queue:** betroffen — neuer Job `routes/jobs/rueckblick.js` (`runRueckblickJob` + `router.post('/rueckblick')`), gemountet in `routes/jobs.js`. Kein synchroner Call.
- **Prompts nur unter `public/js/prompts/`:** betroffen — neuer Builder in neuem Submodul `prompts/tagebuch.js`, re-exportiert in `prompts.js`-Facade; Cache-Invalidierung automatisch über Content-Hash. Schema `SCHEMA_RUECKBLICK` ins `_promptsContentHash` aufnehmen.
- **`callAI` gibt nur JSON:** betroffen — Systemprompt via `JSON_ONLY`; nach jedem `aiCall` `truncated` vor `parseJSON` prüfen + werfen (durch `aiCall`-Helper gedeckt), Pflichtfeld `zusammenfassung` validieren, sonst `i18nError`.
- **Content-Store-Facade:** betroffen (nur lesend) — Einträge ausschliesslich via `loadOrderedBookContents`/`loadPageContents` (Loader nutzt Facade). Keine direkten SQL-Reads auf `pages`.
- **i18n:** betroffen — Karten-Strings + Job-`statusText`/`label`-Keys in beiden Locales; Datums-Display via `tzOpts()`.
- **CSS:** betroffen — eigenes Card-CSS in `public/css/page/` oder `analysis/`, Akzentfarbe via `--card-accent-<key>`.
- **DB-Integrität:** betroffen — neue Cache-Tabelle mit FK auf `books(book_id)` + `provider` im PK; ERD-Update + `squash:regen`.
- **x-html-Escape:** betroffen — KI-Felder (Themen-Labels, Zusammenfassung) via `escHtml()` vor jedem `x-html`-Sink.
- **Combobox statt `<select>`:** betroffen — Zeitraum-Auswahl via `Alpine.data('combobox')`.
- **SHELL_CACHE bumpen:** betroffen — JS/CSS-Änderung → Konstante in [public/sw.js](../../public/sw.js) hochzählen.
- **Logging-Context book-slot:** betroffen — `setContext({ book: book_id })` nach `toIntId` im POST-Handler.
- **Eckige Badges / Lucide-Icons / data-tip:** betroffen — Themen-Häufigkeit als eckige Badges (`--radius-sm`), Icons via Sprite, Tooltips als `data-tip`.
- **numInput / LanguageTool:** nicht betroffen (keine Zahlen-/Prosa-Eingabefelder im MVP).
- **Editor-Spezifikation:** nicht betroffen (reine Buchkarte, kein Editor).
- **Job-Ergebnis-Staleness (`updatedAt`):** nicht betroffen — Ergebnis ist Aggregat ohne Positions-Findings, wird nicht in Seiten zurückgeschrieben; ein nach Analyse geänderter Eintrag verfälscht höchstens die Aggregat-Anzeige, keine Datenkorruption. `n/a` begründet.

## Abhängigkeiten

- **`tagebuch-stimmung-tags`** (Mood-Daten) — harte Voraussetzung für die Stimmungskurve (Phase 2). MVP ohne diese Daten lauffähig.
- **Buchtyp `tagebuch`** — existiert in [prompt-config.json](../../prompt-config.json) (de + en). Karte gated auf diesen Typ.
- **Komplettanalyse** (`figures`/`locations`, siehe [docs/komplett.md](../komplett.md)) — optional: ohne sie nur Roh-Personen-/Orts-Nennungen aus dem Text, keine Verknüpfung zu kuratierten Entitäten.
- Shared-Job-Infrastruktur `routes/jobs/shared/` (Queue, AI-Helper, Loader, `chunkLimitsFor`, `findActiveJobId`).

## Backend

- **Job:** `routes/jobs/rueckblick.js` — `runRueckblickJob(jobId, bookId, userEmail, userToken, zeitraum)`.
  - `effectiveProvider = resolveProvider({ userEmail })` einmal am Job-Start.
  - `loadOrderedBookContents` + `loadPageContents`, dann clientseitig auf `zeitraum` filtern (Datum aus `page_name` via `parseDatum`).
  - Single-Pass wenn `totalChars <= SINGLE_PASS_LIMIT`: ein `aiCall` über alle gefilterten Einträge.
  - Multi-Pass (Map-Reduce) sonst: pro Monat ein Teil-Analyse-Call (Themen/Personen/Orte/Tage je Monat) → Reduce-Call konsolidiert zur Jahres-Zusammenfassung. `PER_CHUNK_LIMIT` aus `chunkLimitsFor`.
  - `cacheVersion = ${_modelName(effectiveProvider)}:${PROMPTS_VERSION}`; Cache-Key inkl. `zeitraum` + `pages_sig` (page_id:updated_at sortiert) → Load/Save in neuer Cache-Tabelle.
  - Schema-Validierung nach jedem Call; `truncated` vor `parseJSON`.
  - `updateJob` mit i18n-`statusText` + `statusParams`; `completeJob` mit `{ rueckblick, zeitraum, entryCount, tokensIn, tokensOut }`.
- **Endpoint:** `POST /jobs/rueckblick` — Body `{ book_id, zeitraum }`. Kurzvertrag: `toIntId(book_id)` → 400 wenn fehlt; `setContext({ book })`; `requireBookAccess(req, book_id, 'editor')`; Dedup via `findActiveJobId('rueckblick', book_id, userEmail)` (dabei `zeitraum` in den Job-Key mischen, damit Monat ≠ Jahr nicht dedupt); `createJob` mit Label `{ key: 'job.label.rueckblick', params: { zeitraum } }`; `enqueueJob`.
- Mount in [routes/jobs.js](../../routes/jobs.js).

## Frontend

- **Karte:** `public/js/cards/tagebuch-rueckblick-card.js` → `Alpine.data('tagebuchRueckblickCard', …)`, `registerTagebuchRueckblickCard()` in [app.js](../../public/js/app.js).
- **Fachmodul:** `public/js/book/tagebuch-rueckblick.js` (Methods-Export), Root-Zugriffe via `window.__app`/`$app`.
- **Partial:** `public/partials/tagebuch-rueckblick.html` mit `x-data="tagebuchRueckblickCard"` am `.card`.
- **State:** in [app-state.js](../../public/js/app/app-state.js) `cardsState.showTagebuchRueckblickCard`; Karten-State (`zeitraum`, `rueckblickResult`, `loading`) als Initial-Felder.
- **Card-Recipe:** `FEATURES` + `EXCLUSIVE_CARDS` in [feature-registry.js](../../public/js/cards/feature-registry.js) (`{ key: 'tagebuchRueckblick', flag: 'showTagebuchRueckblickCard' }`, gated via `buchtyp === 'tagebuch'`); `ALLOWED_KEYS` in [routes/usage.js](../../routes/usage.js); Hash-Router-Branch in [app-hash-router.js](../../public/js/app/app-hash-router.js); `toggleTagebuchRueckblickCard()` in [app-view.js](../../public/js/app/app-view.js) (Flag-Toggle + `_closeOtherMainCards`).
- **Zeitraum-Auswahl:** Combobox (`Alpine.data('combobox')`), Optionen aus den vorhandenen Eintrags-Datümern berechnet (Monate + Jahre).
- **Job-Polling:** via `startPoll` aus [job-helpers.js](../../public/js/cards/job-helpers.js) bzw. `createCardJobFeature`. `onDone` rendert Ergebnis; `book:changed`/`view:reset` resetten State; `job:reconnect` übernimmt laufenden Job.
- **Rendering:** KI-Felder via `escHtml()`; bemerkenswerte Tage als `.internal-link` zu `selectPage`.

## CSS

Neue Datei `public/css/page/tagebuch-rueckblick.css` (Card-Layout: Zusammenfassungs-Block, Themen-/Personen-/Orte-Badge-Listen, Tage-Liste). Akzentfarbe: Hue `--card-accent-tagebuchRueckblick` in [tokens/colors.css](../../public/css/tokens/colors.css) (Light + Dark) + Mapping in [card-accents.css](../../public/css/card-accents.css). `<link>` in [index.html](../../public/index.html) + `SHELL_CACHE`-Bump. Mobile-Breakpoints im selben File. DESIGN.md „CSS-File-Inventar"-Eintrag.

## i18n

Neuer Key-Bereich `rueckblick.*` (Karten-Titel, Zeitraum-Label, Monat/Jahr-Toggle, Leerzustand „keine Einträge im Zeitraum", Listen-Headings Themen/Personen/Orte/Tage, Button „Analysieren") + `tile.tagebuchRueckblick` + `tile.tagebuchRueckblick.desc`. Job-Keys: `job.label.rueckblick`, `job.phase.rueckblick*` (loadingEntries, analyzingMonth, consolidating), `job.error.rueckblickEmpty`. Alle in `de.json` **und** `en.json`.

## DB

Neue Cache-Tabelle (Migration `N`):

```sql
CREATE TABLE IF NOT EXISTS tagebuch_rueckblick_cache (
  book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
  user_email  TEXT NOT NULL,
  zeitraum    TEXT NOT NULL,          -- 'YYYY' oder 'YYYY-MM'
  provider    TEXT NOT NULL,
  pages_sig   TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (book_id, user_email, zeitraum, provider)
);
CREATE INDEX idx_tagebuch_rueckblick_book ON tagebuch_rueckblick_cache(book_id);
```

`provider` im PK gegen Cross-Provider-Bleeding (Muster bestehender Caches). Migration endet mit `foreign_key_check` + `UPDATE schema_version`. Danach `npm run squash:regen` + [docs/erd.md](../erd.md) bumpen (Cache-Block + FK-Kante in Section 1, thematisches Sub-Diagramm Caches).

## Security

Auth via Session-Guard (Standard). ACL: `requireBookAccess(req, book_id, 'editor')` im POST-Handler. KI-Output XSS-escaped via `escHtml()` vor `x-html`. PII: Tagebuch-Inhalt ist hochsensibel — Cache enthält Aggregat-JSON pro `user_email`, CASCADE-Delete mit dem Buch; kein Cross-User-Read (Cache-Key trägt `user_email`). Kein neues Rate-Limit (Job-Queue serialisiert ohnehin). Self-hosted: Datenschutz beim Betreiber.

## Telemetrie

`n/a` — keine neue `/metrics`-Kennzahl im MVP. Usage-Recency läuft über bestehendes `/usage/track` (Karten-Key in `ALLOWED_KEYS`). Phase 2 ggf. Counter „Rückblicke generiert".

## Reversibilität

Karte über `FEATURES`/`EXCLUSIVE_CARDS`-Eintrag entfernbar (verschwindet aus Pills/Palette/Overview). Job-Router-Mount aus `routes/jobs.js` ziehen. Cache-Tabelle bleibt (orphan, schadlos) oder via additiver Migration `DROP`. Kein Eingriff in Buchinhalte → kein Daten-Rückbau am Manuskript nötig.

## Tests

- **Unit:** `parseDatum`-Filterung (page_name → Zeitraum-Zuordnung, Grenzfälle Monats-/Jahresgrenze); Schema-Validierung `SCHEMA_RUECKBLICK`; Prompt-Build (JSON-Only-Marker, Halluzinations-Constraint vorhanden).
- **Integration:** `runRueckblickJob` gegen Mock-AI — Single-Pass + Multi-Pass (Map-Reduce über Monate), Cache-HIT beim zweiten Lauf, Pflichtfeld-fehlt → Fehler, kein content-store-Write.
- **E2E:** Karten-Harness — Zeitraum wählen, Job, Ergebnis-Render, Leerzustand bei leerem Zeitraum.
- **Smoke:** Karte registry-getrieben automatisch abgedeckt (öffnet ohne Alpine-Fehler).

## Edge-Cases

- **Keine parsebaren Datümer** (Seiten ohne `YYYY-MM-DD`-Namen): Karte zeigt Leerzustand „keine datierten Einträge"; Job startet nicht bzw. liefert `empty`.
- **Zeitraum ohne Einträge:** `completeJob({ empty: true })`, Frontend Leerzustand.
- **Ein-Jahr-Buch, sehr viele Einträge:** Map-Reduce über Monate verhindert Token-Überlauf; Monats-Teilanalysen einzeln cachebar (Delta) — offene Frage zur Granularität siehe unten.
- **Einträge nach Analyse geändert:** Cache-Miss beim nächsten Lauf (pages_sig ändert sich); angezeigtes altes Aggregat veraltet, aber unschädlich.
- **Buchtyp wird von `tagebuch` weggeändert:** Karte verschwindet; Cache bleibt orphan.
- **Mehrere Einträge am selben Tag:** alle demselben Datum zugeordnet, im Beleg als ein Tag geführt.

## Kritische Dateien

- **Modify:**
  - [routes/jobs.js](../../routes/jobs.js) (Router-Mount)
  - [public/js/prompts.js](../../public/js/prompts.js) (Facade-Re-Export + `_promptsContentHash`)
  - [public/js/cards/feature-registry.js](../../public/js/cards/feature-registry.js) (`FEATURES` + `EXCLUSIVE_CARDS`)
  - [routes/usage.js](../../routes/usage.js) (`ALLOWED_KEYS`)
  - [public/js/app/app-state.js](../../public/js/app/app-state.js) (`cardsState`-Flag)
  - [public/js/app/app-view.js](../../public/js/app/app-view.js) (Toggle)
  - [public/js/app/app-hash-router.js](../../public/js/app/app-hash-router.js) (Branch + Flag-Liste)
  - [public/js/app.js](../../public/js/app.js) (`registerTagebuchRueckblickCard()`)
  - [public/index.html](../../public/index.html) (Partial-Placeholder + CSS-`<link>`)
  - [public/sw.js](../../public/sw.js) (`SHELL_CACHE`-Bump)
  - [public/js/i18n/de.json](../../public/js/i18n/de.json), [public/js/i18n/en.json](../../public/js/i18n/en.json)
  - [public/css/tokens/colors.css](../../public/css/tokens/colors.css), [public/css/card-accents.css](../../public/css/card-accents.css)
  - [db/migrations.js](../../db/migrations.js), [db/squashed-schema.js](../../db/squashed-schema.js) (via `squash:regen`)
  - [docs/erd.md](../erd.md), [DESIGN.md](../../DESIGN.md)
- **Create:**
  - `routes/jobs/rueckblick.js`
  - `public/js/prompts/tagebuch.js`
  - `public/js/cards/tagebuch-rueckblick-card.js`
  - `public/js/book/tagebuch-rueckblick.js`
  - `public/partials/tagebuch-rueckblick.html`
  - `public/css/page/tagebuch-rueckblick.css`
  - `db/schema`-Cache-Helper (`loadTagebuchRueckblickCache`/`saveTagebuchRueckblickCache`)
  - Tests: `tests/unit/rueckblick-*.test.mjs`, `tests/integration/rueckblick.test.js`, `tests/e2e/tagebuch-rueckblick.spec.js`

## Offene Fragen

Alle für den MVP geklärt:

- **Cache-Granularität:** nur Endergebnis pro `zeitraum` (Tabelle `tagebuch_rueckblick_cache`, PK inkl. `zeitraum`+`provider`). Kein Monats-Delta — Multi-Pass chunkt intern trotzdem nach Monat. Delta-Cache bleibt potenzielles Phase-2-Thema.
- **Stimmungskurve:** out-of-scope (Phase 2, hängt an `tagebuch-stimmung-tags`).
- **Cache pro User vs. buch-weit:** pro User (Cache-Key trägt `user_email`; Tagebuch ist persönlich).
- **Output-Sprache:** Buch-Locale (via `getBookPrompts` → `SYSTEM_RUECKBLICK_BLOCKS`), konsistent mit Review/Komplettanalyse.
