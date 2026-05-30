# Publikations-Metadaten & EPUB-Export

Buch-weite Publikations-Metadaten (Cover, Titelei, Autor-Bio) leben in **`book_publication`** (1:1 zu `books`) und sind die **Single Source of Truth** für PDF- *und* EPUB-Export. Sprache bleibt SSoT in `book_settings.language` (hier nicht geführt).

## Datenmodell

`book_publication` (PK = `book_id`, FK → `books` ON DELETE CASCADE, Migration 166):

- **BLOBs:** `cover_image`/`cover_mime`, `author_image`/`author_image_mime` (sharp-gehärtet via [lib/cover-prepare.js](../lib/cover-prepare.js)).
- **Titelei (Text):** `isbn`, `subtitle`, `year`, `dedication`, `imprint`, `copyright`, `frontmatter`, `author_bio`.
- **EPUB-Reflow-Toggles:** `epub_css_style` (`serif`|`sans`), `epub_justify` (0/1), `epub_toc_title` (Override; leer → Sprach-Default).

Validator + Defaults: [lib/publication-meta.js](../lib/publication-meta.js) (`defaultMeta`/`validateMeta`, strict; `isValidIsbn13` non-blocking). CRUD: [db/book-publication.js](../db/book-publication.js) (`getMeta`/`upsertMeta`/`set|clear|getCover`/`…AuthorImage`).

## Pflege (UI)

Tab **Publikation** in der BookSettings-Karte ([public/partials/book-settings.html](../public/partials/book-settings.html), Methoden in [public/js/book/book-settings.js](../public/js/book/book-settings.js)). Cover-/Foto-Upload nutzt das DESIGN.md-Pattern „Bild-Upload mit Vorschau" (`.pub-image-*`). Keine eigene Karte/Registry/Hash-Router — bewusst als Tab.

## Route

[routes/publication.js](../routes/publication.js), gemountet `/publication`, ACL via `aclParamGuard` (viewer lesen, editor schreiben), `/publication` in `NEVER_CACHE_PREFIXES` ([public/sw.js](../public/sw.js)):

- `GET/PUT /publication/:book_id` — Metadaten.
- `POST/DELETE/GET /publication/:book_id/cover` + `…/author-image` — BLOBs (raw body, `prepareCover`).

## EPUB-Export

Builder [lib/export-builders/epub.js](../lib/export-builders/epub.js) `buildEpub(bundle, opts)` mit `opts = { lang, author, meta, cover, authorImage, tocTitle }`:

- **Cover** via `new File([buf], …)` an epub-gen-memory (`cover` akzeptiert `string|File`).
- **Frontmatter** (Titelseite/Impressum/Widmung/Motto) als XHTML-Entries `beforeToc: true`, **Autor-Bio** als Backmatter (+ Foto als data-URI). Aus dem custom-NCX/Nav-TOC ausgeschlossen via `__toc: false` (beide TOC-Builder filtern darauf).
- `lang`/Autor: Sync-Route resolvt aus `book_settings` + Buch-Owner-Anzeigename; das Domain-Shape (`mapBook`) führt Autor nicht.
- Inline-`<img>`: nur Remote-`http(s)`-URLs (wie PDF); nicht-fetchbare werden geloggt, nicht still verworfen (`_countUnfetchableImages`).

Zwei Pfade, beide lesen `book_publication`:

- **Job** [routes/jobs/epub-export.js](../routes/jobs/epub-export.js) — `POST /jobs/epub-export` (Dedup, ACL viewer) + `GET /jobs/epub-export/:id/file` (Stream, TTL-Map). Vom Publikation-Tab getriggert (Poll + Download). Kein KI-Call.
- **Sync** [routes/export.js](../routes/export.js) `GET /export/:scope/:id/epub` — Schnellpfad, lädt `meta`/Cover/Foto lazy nur für `epub`.

## PDF-Export liest dieselbe Quelle

Der PDF-Job ([routes/jobs/pdf-export.js](../routes/jobs/pdf-export.js)) spiegelt bei `scope==='book'` die `book_publication`-Felder vor dem Render in `profile.config.extras` (`getBookPublication`-Alias von `getMeta`); Cover/Autorfoto kommen aus `book_publication`. `pages.js`/`index.js` lesen unverändert `config.extras` — kein Render-Code-Umbau.

**Aufteilung (drift-kritisch):**

- **Buch-weit (`book_publication`):** Cover, Autorfoto, ISBN, Subtitle, Jahr, Widmung, Impressum, Copyright, Frontmatter, Bio.
- **Profil-spezifisch (`pdf_export_profile.config`):** Layout/Print/Fonts/TOC + Render-Toggles `barcode`, `imprintPosition` + **Rückseiten-Bild** (`back_cover_image`, Umschlag-PDF).

Die PDF-Export-Card editiert die Titelei-/Cover-Felder **nicht** mehr (Hinweis auf den Publikation-Tab).

## Seed

Migration 166 seedet `book_publication` je Buch aus dem Gewinner-PDF-Profil (`is_default`, sonst zuletzt aktualisiert) — Metadaten aus `config.extras` + Cover/Autorfoto-BLOBs. Hält PDF + EPUB ab Einführung konsistent.

## Tests

- Unit: [tests/unit/publication-meta.test.mjs](../tests/unit/publication-meta.test.mjs) (Validator/ISBN-Checksum), [tests/unit/epub-export.test.mjs](../tests/unit/epub-export.test.mjs) (Meta-Resolver, Frontmatter/Backmatter, Bild-Zähler, genEpub-Smoke).
- E2E: [tests/e2e/publication.spec.js](../tests/e2e/publication.spec.js) (Tab, Speichern, Cover-Upload, EPUB-Download) — Harness [tests/fixtures/publication-harness.html](../tests/fixtures/publication-harness.html), Mocks in [tests/server.js](../tests/server.js).
