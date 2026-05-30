# Buch-Migration (`.swbook`)

Verlustfreier Round-Trip eines ganzen Buchs zwischen App-Instanzen (Dev → Prod, zwischen self-hosted Deployments). Scope: **nur Inhalt** — Pages + Kapitelstruktur + authored `book_settings`. Keine Analyse-Entities (Figuren/Orte/Szenen/Zeitstrahl/Ideen/Drafts), Caches, Integrationen, ACL. Owner nach Import = importierender User.

Die menschen-lesbaren Export-Formate (PDF/HTML/MD/EPUB/TXT) sind Einweg-Artefakte; `.swbook` ist das App-eigene Austauschformat für 1:1-Wiederherstellung.

## Bundle-Format (`version: 1`)

ZIP mit Endung `.swbook`:

```
<slug>.swbook            ZIP
├── manifest.json        { format:'schreibwerkstatt-book', version:1, exportedAt, sourceBookId, appVersion }
└── book.json            { book:{ name, description, settings:{…} }, tree:[ node… ] }
```

- `node` = `{ type:'chapter', name, description, children:[node…] }` | `{ type:'page', name, html }`.
- **Reihenfolge** = Array-Order. **Hierarchie** = Nesting (max Tiefe 3, wie chapters). Top-Level-Seiten ohne Kapitel werden vorangestellt (Interleaving zwischen Top-Pages und Top-Kapiteln geht verloren — für Migration unkritisch, Struktur + Inhalt bleiben vollständig).
- `settings` = authored Konfig (`language, region, buchtyp, buch_kontext, erzaehlperspektive, erzaehlzeit, is_finished, daily_goal_chars, orte_real, schauplatz_land, entities_enabled`). `allow_lektor_book_chat` wird beim Import auf 0 gesetzt (ACL-relevant, instanzspezifisch).

## Code

- **`lib/book-bundle.js`** — pure Builder/Parser/Validator (kein Express/DB, Round-Trip testbar): `buildManifest`, `treeToNodes`, `buildBookJson`, `validateManifest`, `validateBookJson`, `planFromNodes`. `planFromNodes` flacht den node-Tree in eine geordnete Op-Liste (`chapter`/`page` mit `tempId`/`parentTempId`); Tiefe > 3 wird gekappt (Pages hängen am letzten erlaubten Vorfahr, `cappedChapters` zählt das).
- **Export — `GET /book-migration/:bookId`** ([routes/book-migration.js](../routes/book-migration.js), sync, in `server.js` gemountet): ACL `viewer` → `bookTree` + Page-HTML via Content-Store → `treeToNodes` → `getBookSettings` → JSZip → Stream `application/zip` mit `Content-Disposition: attachment; filename="<slug>.swbook"`. Leeres Buch → 400, fehlend → 404.
- **Import — `POST /jobs/book-import`** ([routes/jobs/book-import.js](../routes/jobs/book-import.js), Job-Queue, spiegelt das Buffer-Map-Pattern von folder-import): raw ZIP (Limit 200 MB) → `importBuffers`-Map (TTL 30 min) → Job `book-import` (bookId 0). Dedup-Key `swbook:<bytelength>`. Worker `runBookImportJob`: `JSZip.loadAsync` → `validateManifest`/`validateBookJson` → `createBook` (Owner = Importer) + Owner-Grant → `saveBookSettings` → Ops in Reihenfolge via `createChapter`/`createPage` (Content-Store-Facade) → `syncBook` + Vortags-Baseline-Snapshot → `completeJob({ bookId, pagesCreated, chaptersCreated, cappedChapters })`.

Seiten-HTML läuft beim `createPage` durch den Sanitization-Chokepoint (`_cleanHtmlSafe`) → kein XSS-Import. Manifest-Validierung vor jeder Verarbeitung: falsches `format`/fehlend → `job.error.badManifest`, Version > 1 → `job.error.unsupportedVersion`, leeres `book.json`/leerer Tree → `job.error.swbookEmpty`.

## Frontend

- **Export-Card** ([public/js/book/export.js](../public/js/book/export.js) + [partials/export.html](../public/partials/export.html)): Migration-Button zieht `/book-migration/<bookId>` (gleicher Blob-Download wie reguläre Exporte). Nur scope=book.
- **folder-import-Card** ([public/js/cards/folder-import-card.js](../public/js/cards/folder-import-card.js) + [partials/folder-import.html](../public/partials/folder-import.html)): zweiter Modus „Schreibwerkstatt-Buch (.swbook)" — File-Input → `POST /jobs/book-import` → Job-Polling → bei Done Navigation zum neuen `bookId`.

## Tests

- [tests/unit/book-migration.test.mjs](../tests/unit/book-migration.test.mjs) — Bundle-Builder/Parser Round-Trip, Manifest-Validierung, Hierarchie-Tiefe + Reihenfolge.
- [tests/integration/book-import.test.js](../tests/integration/book-import.test.js) — Seed → Export → Import-Job → Tree/HTML/settings deep-equal; Re-Import → 2. unabhängiges Buch.
