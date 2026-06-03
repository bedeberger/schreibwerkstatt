# „An diesem Tag" — Vorjahres-Rückblick (non-KI)

<!-- Nicht verwechseln mit dem bereits umgesetzten KI-Monats/Jahresrückblick (`routes/jobs/rueckblick.js`, Karte `tagebuch-rueckblick-card.js`). Dieser Plan ist das rein clientseitige, KI-freie „vor einem Jahr heute"-Resurfacing. -->


- **Status:** Draft <!-- Draft → Ready erst wenn „Offene Fragen" leer -->
- **Aufwand:** S
- **Severity:** medium <!-- Kern-Mehrwert für den Buchtyp tagebuch; tragend für die Tagebuch-Linie -->

## Context

Tagebuchschreiben lebt vom Wiederbegegnen: „Was habe ich heute vor einem Jahr gedacht?" Genau dieses emotionale Resurfacing fehlt der App. Bei Buchtyp `tagebuch` steckt das Datum bereits strukturiert im `page_name` (`YYYY-MM-DD`, siehe [diary-calendar.js](../../public/js/book/diary-calendar.js):57); der bestehende Kalender-Modus aggregiert die Seiten schon zu `diaryCalendarPagesMap()` (Map<'YYYY-MM-DD', page>, gecacht). Daraus lässt sich „selber Kalendertag, frühere Jahre" rein clientseitig und **ohne KI-Call** ableiten.

Das Feature passt strikt zur App-Philosophie (KI rückwärtsgewandt, nie generativ in den Buchtext): es ist rein lesend, schreibt nichts, ruft kein Modell. Es nutzt ausschliesslich bereits geladene Daten und einen vorhandenen Cache.

Dieser Plan ist die **einzige Heimat** des nicht-KI-Rückblicks „vor einem Jahr heute". Die ursprünglich im Overview-Plan skizzierte „An diesem Tag"-Kachel wurde bewusst hierher konsolidiert (eine Resurfacing-Logik, ein Surface) — siehe [tagebuch-overview-kacheln.md](tagebuch-overview-kacheln.md), das Lücken & Konsistenz, Wochentag-Rhythmus + Rückblick-Heatmap enthält.

Geschwister-Pläne der Tagebuch-Linie: [tagebuch-heute-eintrag.md](tagebuch-heute-eintrag.md), [tagebuch-overview-kacheln.md](tagebuch-overview-kacheln.md), [tagebuch-stimmung-tags.md](tagebuch-stimmung-tags.md), [tagebuch-erinnerung.md](tagebuch-erinnerung.md). Der KI-Monats/Jahresrückblick ist bereits **umgesetzt** (`routes/jobs/rueckblick.js`).

## Scope MVP

- **Rückblick-Panel im Kalender-Header** (nicht als eigene Hauptkarte): wenn `sidebarMode === 'calendar'` und der aktuell betrachtete Kalendermonat den heutigen Tag enthält (bzw. permanent: Bezug auf „heute"), zeigt ein kompaktes Panel die Einträge zum selben `MM-DD` aus früheren Jahren.
- **Bezugstag = heute** via `localIsoDate()` (TZ-aware über `app.timezone`), nicht Browser-TZ. Optional umschaltbar auf den im Kalender selektierten Tag (siehe Offene Fragen).
- **Quelle:** `diaryCalendarPagesMap()` wiederverwenden — alle Keys mit gleichem `MM-DD` und kleinerem `YYYY` filtern, absteigend nach Jahr sortiert.
- **Pro Treffer:** Jahr + „vor N Jahren"-Label, Wochentag des damaligen Datums (`tzOpts()`), kurze Preview, Klick → `selectPage(page)`.
- **Leerer Zustand:** dezenter Hinweis „Heute vor einem Jahr noch nichts geschrieben" wenn keine Treffer.
- **Zeitraum-Suche (Teil des MVP):** im Kalender-Modus ein „Von/Bis"-Datumsfilter (zwei Datumsfelder), der die Seitenliste auf `page_name`-Datum im Bereich filtert — rein clientseitiges Parsing über die vorhandene Map, kein FTS-/Schema-Eingriff. Ergebnis als kompakte Liste mit Sprung via `selectPage`.

## Out-of-Scope

- Jede KI-Auswertung (Zusammenfassung, Stimmungsverlauf, „Jahresrückblick") — der KI-Monats/Jahresrückblick ist bereits umgesetzt (`routes/jobs/rueckblick.js`), dieses Feature ist bewusst KI-frei.
- Push/E-Mail-Benachrichtigung „dein Rückblick ist da" — separat in [tagebuch-erinnerung.md](tagebuch-erinnerung.md).
- Volltext-Datumsfilter im FTS5-Index (`lib/search.js` bleibt unberührt — sein `query()` hat bewusst keinen Datumsparameter).
- Rückblick für Nicht-Tagebuch-Bücher (kein `YYYY-MM-DD`-Namensvertrag).
- Eigene Hauptkarte mit Hash-Route (bewusst leichteres Panel, siehe Frontend-Begründung).

## Done when

- Bei einem Tagebuch mit Einträgen am gleichen `MM-DD` in Vorjahren erscheint im Kalender-Modus das Rückblick-Panel mit korrekt sortierten Jahren und „vor N Jahren"-Labels.
- Klick auf einen Rückblick-Treffer öffnet die jeweilige Seite via `selectPage`.
- Ohne Vorjahres-Treffer erscheint der Leer-Zustand statt eines leeren Panels.
- Zeitraum-Suche filtert die Seitenliste korrekt auf den Datumsbereich (inkl. Grenztage), Sprung funktioniert.
- 29.02. wird korrekt behandelt (siehe Edge-Cases), kein Crash in Nicht-Schaltjahren.
- Kein Netz-/KI-Call beim Öffnen des Panels; keine zusätzliche DB-Abfrage, solange `preview_text` nicht benötigt wird (siehe Backend).
- `npm test` grün; neuer Unit-Test für die Datums-Match-Logik.

## Hard-Rule-Audit

- **Editor-Spezifikation:** nicht betroffen — Feature lebt in der Sidebar/Kalender, kein Editor-Eingriff.
- **UI-Patterns aus DESIGN.md:** betroffen — Panel nutzt vorhandene Listen-/Badge-Patterns; falls klappbar, nur `.collapsible-toggle` + `.history-chevron`. Vor Bau Katalog prüfen, kein neues Pattern erfinden.
- **i18n:** betroffen — alle Labels (Titel, „vor N Jahren", Leer-Zustand, Von/Bis) als Keys in `de.json` + `en.json`.
- **CSS nur in `public/css/`:** betroffen — Styles in eine Datei unter `public/css/page/` (Diary-Nähe), keine Inline-Styles. Eckige Badges (`var(--radius-sm)`).
- **Content-Store-Facade:** betroffen nur falls `preview_text` serverseitig nachgereicht wird — dann ausschliesslich über die Facade/`listPages`-Erweiterung, kein direktes SQL im Route-/Card-Code.
- **DB-Integrität:** nicht betroffen — keine neue Tabelle/Spalte (Datum lebt im `page_name`).
- **Job-Queue / KI-Calls:** nicht betroffen — rein lesend, kein KI-Call, kein Job.
- **x-html-Escape:** betroffen — Preview-Text und `page_name` vor jeder `x-html`-Interpolation durch `escHtml()`; bevorzugt `x-text` (kein Escape nötig).
- **Combobox/numInput/LanguageTool:** Datumsfelder der Zeitraum-Suche sind Such-/Filterfelder → kein `data-spellcheck` (Ausnahme „Suchfelder/Filter"); keine `<select>` nötig.
- **Datums-Display via `tzOpts()`:** betroffen — Wochentag/Datum nur über `tzOpts()`; „heute" über `localIsoDate()`.
- **SHELL_CACHE bumpen:** betroffen — JS/CSS-Änderung → Konstante in [public/sw.js](../../public/sw.js) hochzählen.
- **Lucide-Icons sparsam, `data-tip`-Tooltips:** betroffen — höchstens ein Icon (z.B. Verlauf), Tooltips via `data-tip`.

## Abhängigkeiten

- Bestehender Diary-Kalender: [public/js/book/diary-calendar.js](../../public/js/book/diary-calendar.js) (`diaryCalendarMethods`, `diaryCalendarPagesMap`), `sidebarMode`/`diaryCalendarYearMonth`-State in [app-state.js](../../public/js/app/app-state.js).
- Buchtyp-Erkennung `tagebuch` (Kalender ist nur dort sichtbar) — Feature erbt dieselbe Sichtbarkeitsbedingung.
- Root-Methode `selectPage(page)` für Navigation.
- `localIsoDate()` / `tzOpts()` / `escHtml()` aus [public/js/utils.js](../../public/js/utils.js).

## Backend

Grundfall: **kein neuer Endpoint**. Alles läuft clientseitig aus der bereits geladenen `pages`-Liste / `diaryCalendarPagesMap`.

Einzige mögliche Backend-Berührung — **Preview-Text**: `listPages` ([lib/content-store/backends/localdb.js](../../lib/content-store/backends/localdb.js):229) liefert aktuell **kein** `preview_text` (das Feld existiert als Spalte auf `pages`, wird per Sync-Cron lazy befüllt — [routes/sync.js](../../routes/sync.js):150). Optionen:

- **A (empfohlen):** `p.preview_text` additiv in den `SELECT` von `listPages` aufnehmen → die Frontend-`pages`-Objekte tragen Preview ohne Extra-Call. Minimaler, additiver Eingriff, kein neuer Route-Handler. Über die Facade exponiert (`_pageMetaRow` ergänzen).
- **B:** kleiner lesender Endpoint `GET /content/books/:book_id/diary/anniversary?day=MM-DD` der die Treffer + Preview serverseitig zusammenstellt. Mehr Code, nur sinnvoll falls A unerwünscht ist.

Empfehlung: **A**. `preview_text` kann `NULL` sein (noch nicht vom Cron befüllt) → Frontend fällt dann auf reines Datum/Titel zurück, lädt **nicht** den Body nach.

Kein Job, kein KI-Call, keine Mutation.

## Frontend

**Empfehlung: Panel im Kalender-Header, keine eigene Hauptkarte.**

Begründung gegen eigene Karte: Eine Hauptkarte triggert die volle Card-Recipe (Registry `FEATURES`/`EXCLUSIVE_CARDS`, `ALLOWED_KEYS` in [routes/usage.js](../../routes/usage.js), `cardsState`, Hash-Router-Branch, Partial, Toggle, Exklusivität, Scroll-to). Das ist viel Oberfläche für ein kontextgebundenes, rein lesendes Mini-Feature, das nur im `calendar`-Sidebar-Modus sinnvoll ist. Ein Panel im Kalender-Header ist drift-arm und ortsnah.

Umsetzung als Erweiterung von `diaryCalendarMethods`:

- Neue Methoden (gleiches Cache-Muster wie `diaryCalendarMonths`):
  - `diaryAnniversaryToday()` → `localIsoDate()` → `MM-DD` ableiten.
  - `diaryAnniversaryEntries()` → über `diaryCalendarPagesMap()` alle Keys mit gleichem `MM-DD` und Jahr < aktuelles Jahr; Rückgabe `[{ year, yearsAgo, weekday, page, preview }]`, absteigend nach Jahr. Memoisiert (Cache an `pagesRef` + Bezugstag gekoppelt).
  - `diaryRangeEntries()` → für Zeitraum-Suche: Keys im `[von, bis]`-Bereich (String-Vergleich auf `YYYY-MM-DD` reicht, ISO-sortierbar), Rückgabe Liste + Sprung.
- State (Initial-Felder im Diary-Scope bzw. `app-state.js`, nicht lazy): `diaryRangeFrom`, `diaryRangeTo` (Strings, Default `''`), `diaryAnniversaryOpen` (bool, Default `true`).
- Template: Panel-Block im Kalender-Partial (`x-show` an `sidebarMode === 'calendar'`). Treffer als Liste; `@click="$app.selectPage(entry.page)"`. Preview via `x-text` (kein Escape-Risiko); falls `x-html` nötig → `escHtml()`.
- Zeitraum-Suche: zwei `<input type="date">` (native Picker bewusst gewünscht für Datumsauswahl — Begründung im Diff) gebunden an `diaryRangeFrom/To`, plus Ergebnis-Liste.

Events: keine neuen Events nötig; läuft im Diary-Scope, reagiert auf vorhandene `book:changed`-Cache-Invalidierung (Cache an `pagesRef` gekoppelt).

## CSS

Neue Datei [public/css/page/diary-anniversary.css](../../public/css/page/diary-anniversary.css) (oder Anbau an die bestehende Diary-Kalender-CSS-Datei, falls vorhanden — prüfen, eine Datei pro Komponente). Mobile-Regeln im selben File (Container-Query bevorzugt, da Sidebar variabler Slot). Eckige Badges (`var(--radius-sm)`) für „vor N Jahren". `<link>` in [public/index.html](../../public/index.html) ergänzen, DESIGN.md „CSS-File-Inventar" nachziehen, `SHELL_CACHE` bumpen.

## i18n

Neuer Key-Bereich `diary.anniversary.*` (de + en), u.a.:
- `diary.anniversary.title` — „Vor einem Jahr heute" / „On this day"
- `diary.anniversary.yearsAgo` — „vor {n} Jahren" / „{n} years ago" (Singular/Plural beachten: `oneYearAgo`)
- `diary.anniversary.empty` — Leer-Zustand
- `diary.range.title`, `diary.range.from`, `diary.range.to`, `diary.range.empty` — Zeitraum-Suche

Alle Keys sofort in **beiden** Locale-Dateien.

## DB

**n/a.** Bewusst kein DB-Eingriff — das ist die zentrale Stärke des Features: Der Kalendertag lebt strukturiert im `page_name` (`YYYY-MM-DD`), es gibt keine separate Datums-Spalte (`pages.created_at` ist Anlage-Zeit, nicht Tagebuch-Tag). „Selber Tag, andere Jahre" und „Datumsbereich" sind reine String-/Regex-Operationen auf bereits geladenen Namen. Keine Migration, keine neue Tabelle/Spalte, kein FTS-Umbau, keine ERD-Änderung.

(Falls Backend-Option A gewählt wird, ist `preview_text` eine **bereits existierende** Spalte — nur additiv in den `listPages`-SELECT aufgenommen, ebenfalls keine Migration.)

## Security

- Auth-/ACL-Scope unverändert: Feature liest nur Seiten des aktuell geladenen Buchs, das bereits über die normalen Guards/ACL geladen wurde.
- Escape: `page_name`/Preview vor `x-html` durch `escHtml()`; `x-text` bevorzugt.
- Keine PII über das hinaus, was die Seitenliste ohnehin enthält. Kein Rate-Limit nötig (keine teure Operation, kein externer Call).

## Telemetrie

`n/a` für MVP. Optional später: leichter Usage-Counter „Rückblick-Treffer geklickt" — bewusst aus MVP heraus, um keinen `/metrics`+HA-Doku-Pflichtdurchgang auszulösen.

## Reversibilität

Vollständig additiv und rein lesend. Rückbau = Panel-Markup + Methoden + CSS-Datei + i18n-Keys entfernen; optional `preview_text` wieder aus dem `listPages`-SELECT nehmen. Kein Daten-Rückbau nötig (nichts persistiert). Abschaltung im Zweifel über die ohnehin vorhandene `tagebuch`-Sichtbarkeitsbedingung des Kalenders. Kein dedizierter Feature-Flag nötig (Aufwand S, isoliert).

## Tests

- **Unit (neu):** Datums-Match-Logik gegen `diaryCalendarPagesMap`-artige Map: gleicher `MM-DD` anderer Jahre korrekt selektiert + nach Jahr sortiert; `yearsAgo` korrekt; Zeitraum-Filter inkl. Grenztage; 29.02.-Verhalten. Reine pure Funktion (`_computeAnniversary(map, todayMMDD, todayYear)` / `_computeRange(map, from, to)`), testbar ohne Alpine — analog Memo-Pattern.
- **Unit (bestehend mitziehen):** falls Backend-Option A, sicherstellen dass `listPages` weiterhin den erwarteten Shape liefert (vorhandene Content-Store-Tests).
- **E2E/Smoke:** Smoke deckt Kalender-Sidebar bereits indirekt ab; optional ein E2E-Harness-Check, dass das Panel bei vorhandenen Vorjahres-Einträgen rendert und der Sprung `selectPage` auslöst. Console-Guard-konform.
- `npm test` vor Commit (UI-nahe Änderung).

## Edge-Cases

- **Nie geschrieben am Tag:** keine Map-Treffer → Leer-Zustand `diary.anniversary.empty`, kein leeres Panel.
- **29.02. (Schaltjahr):** Heute = 29.02. existiert nur in Schaltjahren; Vorjahre ohne 29.02. liefern keinen exakten Match. MVP: exaktes `MM-DD`-Matching (am 29.02. nur echte 29.02.-Einträge). Fallback „28.02. anzeigen, wenn kein 29.02." als Offene Frage markiert. In Nicht-Schaltjahren ist `MM-DD = '02-29'` als Bezugstag unmöglich → tritt nur am realen 29.02. auf, kein Crash.
- **Mehrere Einträge am selben Tag/Jahr:** `diaryCalendarPagesMap` behält bewusst den ersten Treffer pro `YYYY-MM-DD` (`if (!m.has(key))`). Rückblick zeigt damit pro Vorjahr einen Eintrag — konsistent mit Kalenderverhalten; weitere Einträge desselben Tags out-of-scope.
- **`preview_text` = NULL** (Cron noch nicht gelaufen): Treffer zeigt Titel/Datum ohne Preview, lädt **nicht** den Body nach.
- **Buch ohne `YYYY-MM-DD`-Namen / Nicht-Tagebuch:** Kalender-Modus nicht aktiv → Panel erst gar nicht sichtbar.
- **Zeitraum von > bis:** leeres Ergebnis bzw. Felder tauschen — als Offene Frage.
- **Zeitzonen-Tageswechsel:** „heute" strikt über `localIsoDate()` (app.timezone), nie `new Date().getDate()` (Browser-TZ).

## Kritische Dateien

- **Modify:**
  - [public/js/book/diary-calendar.js](../../public/js/book/diary-calendar.js) — neue Rückblick-/Zeitraum-Methoden + pure Compute-Helfer.
  - [public/js/app/app-state.js](../../public/js/app/app-state.js) — State-Felder `diaryRangeFrom/To`, `diaryAnniversaryOpen`.
  - Diary-Kalender-Partial in `public/partials/` — Panel-Markup + Zeitraum-Felder.
  - [public/index.html](../../public/index.html) — `<link>` für neue CSS-Datei.
  - [public/sw.js](../../public/sw.js) — `SHELL_CACHE` bumpen.
  - [public/js/i18n/de.json](../../public/js/i18n/de.json), [public/js/i18n/en.json](../../public/js/i18n/en.json) — neue Keys.
  - [DESIGN.md](../../DESIGN.md) — CSS-File-Inventar (falls neue CSS-Datei).
  - *(nur bei Backend-Option A)* [lib/content-store/backends/localdb.js](../../lib/content-store/backends/localdb.js) — `preview_text` additiv in `listPages`-SELECT + `_pageMetaRow`.
- **Create:**
  - [public/css/page/diary-anniversary.css](../../public/css/page/diary-anniversary.css) — Panel-/Listen-Styles (falls nicht an bestehende Diary-CSS angebaut).
  - [tests/unit/diary-anniversary.test.mjs](../../tests/unit/diary-anniversary.test.mjs) — Match-/Range-Logik.

## Offene Fragen

- Bezugstag fix „heute" oder umschaltbar auf den im Kalender selektierten Tag? (Empfehlung: MVP fix „heute", selektierter Tag als Phase 2.)
- 29.02.-Fallback: in Nicht-Schaltjahren auf 28.02. zurückfallen, oder strikt nur echte 29.02.-Matches? (Empfehlung: strikt im MVP.)
- Wie viele Vorjahre maximal anzeigen — alle, oder Limit (z.B. 5) mit „mehr"-Aufklappen? (Empfehlung: alle, da Tagebücher selten >10 Jahre.)
- Zeitraum-Suche: Teil dieses Plans oder in eigenen Plan auslagern? (Aktuell als MVP-Bestandteil geplant, da gleiche Datenquelle.)
- Backend-Preview: Option A (`listPages` erweitern) freigegeben, oder Preview im MVP ganz weglassen (nur Titel/Datum)?
- Verhalten bei `von > bis` in der Zeitraum-Suche: Felder tauschen oder leeres Ergebnis?
