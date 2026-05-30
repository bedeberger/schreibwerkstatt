# Buch-Migration (Export/Import `.swbook`)

- **Status:** Ready
- **Aufwand:** M
- **Severity:** medium

## Context

User will ein Buch von einer App-Instanz auf eine andere zügeln (z. B. Dev → Prod, oder zwischen self-hosted Deployments). Die bestehenden Export-Formate (PDF/HTML/MD/EPUB/DOCX/TXT) sind menschen-lesbare Einweg-Artefakte — kein verlustfreier Round-Trip, keine Kapitel-Hierarchie + Reihenfolge garantiert reimportierbar. Es fehlt ein App-eigenes Austauschformat, das genau das, was die App als Buch versteht, ablegt und auf einer Fremdinstanz 1:1 als neues Buch wiederherstellt.

Scope-Entscheid (mit User abgestimmt): **nur Inhalt** — Pages + Kapitelstruktur + authored Buch-Konfig. Keine Analyse-Entities (Figuren/Orte/Szenen/Zeitstrahl/Ideen/Drafts), keine Caches, keine Integrationen. Format: **JSON-Bundle im ZIP** (`.swbook`). Owner nach Import: **der importierende User**.

## Scope MVP

- **Export:** Sync-Download eines Buchs als `.swbook` (ZIP). Enthält `manifest.json` + `book.json` (Buch-Meta + authored `book_settings` + voll-rekursiver Tree aus Kapiteln/Seiten mit inline-HTML, in exakter `book_order`-Reihenfolge).
- **Import:** Job (mirror `folder-import`): `.swbook` hochladen → Manifest validieren → neues Buch anlegen (Owner = Importer) → Kapitel/Seiten rekursiv in Tree-Reihenfolge via Content-Store-Facade → Owner-Grant → Stats-Sync + Vortags-Baseline → `bookId` im Job-Result.
- **Kapitel-Hierarchie** (bis Tiefe 3) wird über Nesting im Tree abgebildet; `parent_chapter_id` ergibt sich beim Import aus dem rekursiven Anlegen.
- **Reihenfolge** wird durch Array-Order im Tree + sequentielles Anlegen bewahrt (keine expliziten Positions-IDs nötig).
- **Buch-Konfig:** `book_settings` (language, region, buchtyp, buch_kontext, erzaehlperspektive, erzaehlzeit, daily_goal_chars, orte_real, schauplatz_land, is_finished, entities_enabled) wird mitgenommen — authored, klein, verlustfrei. `allow_lektor_book_chat` wird zurückgesetzt (ACL-relevant, instanzspezifisch).
- **Frontend:** Export-Button in Export-Card (Migration-Sektion). Import-Tab in `folder-import`-Card (zweiter Modus „Schreibwerkstatt-Buch").

## Out-of-Scope

- Analyse-Entities (Figuren, Orte, Szenen, Ereignisse, Zeitstrahl, World-Facts, Songs, Ideen, Werkstatt-Drafts/Runs) — auf Zielinstanz via Komplettanalyse neu erzeugen.
- Caches/Derived (page_stats, Reviews, LanguageTool, LLM-Caches, Revisionshistorie).
- Integrationen (Blog/HubSpot) — Creds AES-verschlüsselt mit Server-Key, nicht portierbar.
- ACL/Sharing (book_access weiterer User, share_links, invites) — instanzspezifisch.
- Merge-in-bestehendes-Buch beim Import (immer neues Buch). Phase 2 ggf.
- BLOB-Cover des Buchs (`books.cover_image`) — Phase 2 (base64 im Bundle möglich, MVP lässt es weg).

## Done when

- Buch A auf Instanz 1 exportieren → `.swbook` lädt herunter.
- Datei auf Instanz 2 importieren → neues Buch erscheint, Owner = Importer, identische Kapitel-Hierarchie + Seiten-Reihenfolge + Seiten-HTML + Buch-Konfig.
- Re-Import auf derselben Instanz erzeugt ein zweites unabhängiges Buch (keine ID-Kollision, kein Überschreiben).
- Leeres/kaputtes/fremdes ZIP → saubere i18n-Fehlermeldung, kein Crash.
- Round-Trip-Unit-Test: export(bundle) → import → Tree-Struktur + HTML deep-equal.

## Hard-Rule-Audit

- **Editor-Spezifikation:** n/a — kein Editor berührt.
- **Content-Store-Facade:** ✅ Export liest via `bookTree`/`loadPagesBatch`; Import schreibt ausschliesslich via `createBook`/`createChapter`/`createPage`. Kein direktes SQL auf pages/chapters/books. (`book_settings` via bestehende `db/schema.js`-Getter/Setter — keine Buchinhalts-Tabelle.)
- **KI-Calls nur via Job-Queue:** n/a — keine KI. Import ist trotzdem Job (lange Write-Op, Progress, Dedup) analog folder-import; Export ist Sync-Route analog `routes/export.js` (kein KI, schnell).
- **i18n:** ✅ neue Keys in de+en (Job-Status, Fehler, Card-Labels). Job-`statusText` als Key + `statusParams`.
- **Logging-Context book:** ✅ Export setzt `setContext({ book })` nach Load; Import-Job-Worker zieht `bookId` automatisch (createJob), nach Buchanlage `setContext({ book: effBookId })`.
- **x-html-Escape:** n/a — keine neuen x-html-Sinks (Card nutzt x-text + Datei-Input).
- **CSS:** minimal, in bestehende `book/export.css` + `folder-import`-CSS; keine neue Datei → kein SHELL_CACHE-Pflichtbump durch CSS, aber JS-Änderung → **SHELL_CACHE bumpen**.
- **DB:** n/a — keine Migration, keine neue Tabelle.
- **DESIGN.md:** Datei-Upload + Tab-Pattern aus folder-import-Card wiederverwenden; Download-Button-Pattern aus Export-Card. Kein neues UI-Pattern.
- **ACL:** Export `requireBookAccess(viewer)`; Import nur Auth (legt eigenes Buch an).

## Abhängigkeiten

- `lib/content-store` (Facade), `db/book-order` (Tree), `db/schema.js` (`getBookSettings`/`saveBookSettings`), `routes/jobs/shared` (Job-Lifecycle), `jszip` (vorhanden), `routes/sync.js#syncBook`.

## Backend

- **`GET /book-migration/:bookId`** (sync, `routes/book-migration.js`): ACL viewer → `bookTree` + `loadPagesBatch` → Tree-JSON bauen → `getBookSettings` → JSZip `manifest.json`+`book.json` → `generateAsync('nodebuffer')` → Stream `application/zip`, `Content-Disposition: attachment; filename="<slug>.swbook"`. Fehler: `BOOK_EMPTY`/`NOT_FOUND` → 400/404.
- **`POST /jobs/book-import`** (`routes/jobs/book-import.js`, mirror folder-import): `express.raw` ZIP (Limit 200 MB) → Buffer in `importBuffers`-Map → Job `book-import` (bookId 0) → `enqueueJob`. Dedup-Key `swbook:<hash-or-name>`.
  - Worker `runBookImportJob`: JSZip.loadAsync → `manifest.json` parsen + validieren (`format === 'schreibwerkstatt-book'`, `version <= SUPPORTED`) → `book.json` parsen → `createBook({ name, description, owner_email })` → Owner-Grant (`db UPDATE owner_email` + `bookAccess.grantAccess`) → `saveBookSettings(...)` aus Bundle → rekursiv Tree anlegen (`createChapter` mit `parent_chapter_id`, `createPage` mit `html`) → `syncBook` + Vortags-Baseline → `completeJob({ bookId, pagesCreated, chaptersCreated })`.
- **Mount:** `routes/jobs.js` → `bookImportRouter`. `routes/book-migration.js` in `server.js` mounten (Auth-geschützt).

### Bundle-Format (`version: 1`)

```
<slug>.swbook            ZIP
├── manifest.json        { format:'schreibwerkstatt-book', version:1, exportedAt, sourceBookId, appVersion }
└── book.json            { book:{ name, description, settings:{…} }, tree:[ node… ] }
```
`node` = `{ type:'chapter', name, description, children:[node…] }` | `{ type:'page', name, html }`. Reihenfolge = Array-Order. Hierarchie = Nesting (max Tiefe 3, wie chapters).

## Frontend

- **Export-Card** (`public/js/book/export.js` + `partials/export.html`): Migration-Sektion mit Button „Buch zügeln (.swbook)" → `bookExport('swbook')`-Variante, die `/book-migration/<bookId>` statt `/export/...` zieht (gleicher Blob-Download-Code). Nur scope=book.
- **folder-import-Card** (`public/js/cards/folder-import-card.js` + `partials/folder-import.html`): zweiter Modus/Tab „Schreibwerkstatt-Buch (.swbook)" — File-Input → `POST /jobs/book-import` (raw ZIP) → Job-Polling (vorhandene Job-Helper) → bei Done: Toast + Navigation zum neuen `bookId`.
- Keine neue Karte → keine Registry-/Hash-Router-/Exklusivitäts-Einträge nötig.

## CSS

Minimal — bestehende `book/export.css` (Button) + `folder-import`-Styles (Tab). `n/a` für neue Dateien.

## i18n

Neuer Bereich `migration.*` + Job-Keys: `book.export.swbook`, `book.export.swbookHint`, `migration.import.title/hint/pick`, `job.label.bookImport`, `job.book-import.unpacking/validating/creatingBook/creatingPages`, `job.error.badManifest/unsupportedVersion/swbookEmpty`. de + en.

## DB

n/a — keine Migration, keine Tabelle, kein ERD-Update.

## Security

- Export: ACL viewer Pflicht.
- Import: nur authentifiziert; legt eigenes Buch an, kein Fremd-Buch-Zugriff. `owner_email`/alle User-Refs = Importer (keine fremden E-Mails aus Bundle übernommen — Bundle enthält gar keine).
- HTML der Seiten läuft beim `createPage` durch `_cleanHtmlSafe` (Sanitization-Chokepoint) → kein XSS-Import.
- ZIP-Bomb: Size-Limit 200 MB + Per-File via JSZip; book.json ist eine Datei, kein Path-Traversal (Pfade werden nicht aufs FS geschrieben).
- Manifest-Validierung vor jeder Verarbeitung (format+version), sonst `badManifest`.

## Telemetrie

n/a (MVP). Job-Runs landen ohnehin in `job_runs`.

## Reversibilität

Reiner Additiv-Feature: Route + Job-Router + 2 Card-Erweiterungen. Ausbau = Route/Job entfernen + Card-Sektionen zurückbauen. Keine DB-Spuren ausser regulär erzeugten Büchern. Kein Feature-Flag nötig (kein Risiko für Bestehendes).

## Tests

- **Unit** (`tests/unit/book-migration.test.mjs`): pure Bundle-Builder (Tree→JSON) + Bundle-Parser (JSON→Anlege-Plan) Round-Trip; Manifest-Validierung (gut/falsches format/zu hohe version); Hierarchie-Tiefe + Reihenfolge erhalten.
- **Integration** (`tests/integration/book-import.test.js`): Buch seeden → exportieren (Builder) → Import-Job gegen In-Memory-DB → Tree + HTML + settings deep-equal; Re-Import → 2. unabhängiges Buch.
- Kein E2E im MVP (Datei-Upload-Flow manuell verifizieren).

## Edge-Cases

- **Leeres Buch:** Export → `BOOK_EMPTY` 400 (analog bestehende Export-Route).
- **Fremdes/kaputtes ZIP:** `badManifest`/`swbookEmpty`-Fehler, Job → error.
- **Zukünftige Bundle-Version:** `unsupportedVersion` (forward-incompatible bewusst).
- **Kapitel ohne Seiten:** Export behält leere Kapitel im Tree (Struktur ist Inhalt); Import legt sie an.
- **Tiefe > 3:** kann nicht entstehen (Quelle ist selbst auf 3 begrenzt); Defensive: tieferes Nesting beim Import auf Parent kappen + Audit-Warn.
- **Doppelter Buchname auf Ziel:** erlaubt (Bücher sind nicht namens-unique); kein Konflikt.
- **Sehr grosses Buch:** book.json inline-HTML kann mehrere MB sein → ZIP komprimiert; 200 MB Limit deckt ab.

## Kritische Dateien

- **Modify:**
  - `routes/jobs.js` (Mount `bookImportRouter`)
  - `server.js` (Mount `/book-migration`)
  - `public/js/book/export.js` + `public/partials/export.html` (Export-Button)
  - `public/js/cards/folder-import-card.js` + `public/partials/folder-import.html` (Import-Tab)
  - `public/js/i18n/de.json` + `en.json`
  - `public/sw.js` (SHELL_CACHE bump)
- **Create:**
  - `routes/book-migration.js` (Export-Sync-Route)
  - `routes/jobs/book-import.js` (Import-Job)
  - `lib/book-bundle.js` (pure Builder/Parser/Validator — testbar ohne Express/DB)
  - `tests/unit/book-migration.test.mjs`
  - `tests/integration/book-import.test.js`

## Offene Fragen

_(leer)_
