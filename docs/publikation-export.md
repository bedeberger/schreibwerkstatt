# Publikations-Metadaten & EPUB-Export

Buch-weite Publikations-Metadaten (Cover, Titelei, Autor-Bio) leben in **`book_publication`** (1:1 zu `books`) und sind die **Single Source of Truth** für PDF- *und* EPUB-Export. Sprache bleibt SSoT in `book_settings.language` (hier nicht geführt).

## Datenmodell

`book_publication` (PK = `book_id`, FK → `books` ON DELETE CASCADE, Migration 166):

- **BLOBs:** `cover_image`/`cover_mime`, `author_image`/`author_image_mime` (sharp-gehärtet via [lib/cover-prepare.js](../lib/cover-prepare.js)).
- **Titelei (Text):** `author_name` (Publikations-/Autorname, Pseudonym — Migration 169; übersteuert in **beiden** Exporten den Account-/Owner-Anzeigenamen), `isbn`, `subtitle`, `year`, `dedication`, `imprint`, `copyright`, `frontmatter`, `author_bio`.
- **Buchhandels-Metadaten (Text, Migration 167, fliessen in EPUB-OPF):** `description` (Klappentext), `publisher`, `series` + `series_index`, `keywords` (kommagetrennt). `description` faellt im EPUB-Builder auf `books.description` zurueck, wenn leer.
- **EPUB-Reflow-Toggles:** `epub_css_style` (Schriftfamilie: `serif`|`sans`|`georgia`|`palatino`|`garamond`|`times`|`baskerville`|`helvetica`|`verdana` — CSS-Stack, kein Embedding), `epub_justify` (0/1), `epub_toc_title` (Override; leer → Sprach-Default).
- **EPUB-Typografie (Migration 168):** `epub_font_size` (`small`|`normal`|`large`), `epub_line_height` (`tight`|`normal`|`relaxed`), `epub_paragraph_style` (`indent` Belletristik | `spaced` Sachbuch), `epub_indent_size` (`small`|`medium`|`large`, nur bei `indent`), `epub_hyphenation` (0/1), `epub_drop_caps` (0/1, Initiale am Kapitelanfang).
- **EPUB-Struktur (Migration 168):** `epub_chapter_pagebreak` (0/1, `.epub-chapter-head` → `page-break-before`), `epub_nest_pages_in_toc` (0/1, Seiten eines Mehrseiten-Kapitels im TOC/NavMap), `epub_scene_separator` (`line`|`asterism`|`stars`|`blank`|`fleuron` — klassenlose `<hr>` werden in `_applyBreaks` ersetzt), `epub_titlepage_mode` (`generated`|`cover`|`none`).
- **EPUB-Kapitelnumerierung (Migration 171):** `epub_chapter_numbering` (`none`|`arabic`|`roman`|`word`) + `epub_chapter_numbering_mode` (`flat`|`nested`) — Pendant zur PDF-Option (`pdf_export_profile.config.chapter.numbering`). Das Label (`_chapterLabelNested` aus `lib/pdf-render/layout.js`, geteilt mit dem PDF-Renderer) wird dem Kapiteltitel im Inhaltsverzeichnis (NavMap + nav.xhtml) **und** der generierten Kapitelüberschrift vorangestellt (`1. Kapitelname`). Nur echte Kapitel zählen; Solo-Seiten ohne Kapitel bleiben unnumeriert. Eigenes Kapitel-Intro (`description_html`) ersetzt die generierte Überschrift — dort steuert der Autor das Markup, der Counter läuft trotzdem mit.
- **EPUB-OPF-Metadaten (nur EPUB, Migration 168):** `epub_rights` (`dc:rights`), `epub_pubdate` (`dc:date`, übersteuert das Freitext-`year`), `epub_translator`/`epub_illustrator`/`epub_editor_name` (`dc:contributor` + MARC-Relator `trl`/`ill`/`edt`), `epub_uuid` (OPF-`id`/Identifier; leer → Lib-Auto-UUID). Aufgebaut in `_buildOpfExtraMeta`.

Validator + Defaults: [lib/publication-meta.js](../lib/publication-meta.js) (`defaultMeta`/`validateMeta`, strict; `isValidIsbn13` non-blocking). CRUD: [db/book-publication.js](../db/book-publication.js) (`getMeta`/`upsertMeta`/`set|clear|getCover`/`…AuthorImage`).

## Pflege (UI)

Tab **Publikation** in der BookSettings-Karte ([public/partials/book-settings.html](../public/partials/book-settings.html), Methoden in [public/js/book/book-settings.js](../public/js/book/book-settings.js)). Cover-/Foto-Upload nutzt das DESIGN.md-Pattern „Bild-Upload mit Vorschau" (`.pub-image-*`). Keine eigene Karte/Registry/Hash-Router — bewusst als Tab.

## Route

[routes/publication.js](../routes/publication.js), gemountet `/publication`, ACL via `aclParamGuard` (viewer lesen, editor schreiben), `/publication` in `NEVER_CACHE_PREFIXES` ([public/sw.js](../public/sw.js)):

- `GET/PUT /publication/:book_id` — Metadaten.
- `POST/DELETE/GET /publication/:book_id/cover` + `…/author-image` — BLOBs (raw body, `prepareCover`).

**Invariante (drift-kritisch): PUT ist ein Voll-Replace, kein Merge.** `upsertMeta` → `validateMeta` startet bei `defaultMeta()` und überlagert nur gesendete Keys — jedes **fehlende** Feld fällt auf seinen Default zurück. Beide schreibenden Frontends (BookSettings-Publikation-Tab **und** EPUB-Export-Card) editieren nur einen Ausschnitt der Felder, müssen aber die **volle geladene Meta** zurückschicken, sonst löscht ein Tab die Felder des anderen (Tab editiert Titelei → würde `epub_*` killen; Card editiert Reflow → würde `author_name` killen). Mechanismus: beide spreaden die GET-Antwort (`body: { ...p }`); `validateMeta` whitelistet serverseitig, Extra-Keys (`has_cover`, `created_at`, …) werden ignoriert. Kein Hand-Listen einzelner Felder im Body — driftet bei jeder neuen Spalte.

## EPUB-Export

Builder [lib/export-builders/epub.js](../lib/export-builders/epub.js) `buildEpub(bundle, opts)` mit `opts = { lang, author, meta, cover, authorImage, tocTitle }`:

- **Cover** via `new File([buf], …)` an epub-gen-memory (`cover` akzeptiert `string|File`).
- **Frontmatter** (Titelseite/Impressum/Widmung/Motto) als XHTML-Entries `beforeToc: true`, **Autor-Bio** als Backmatter (+ Foto als data-URI). Aus dem custom-NCX/Nav-TOC ausgeschlossen via `__toc: false` (beide TOC-Builder filtern darauf).
- **OPF-Metadaten** aus `book_publication`: `description` (Fallback `books.description`) + `publisher` + `date` (aus `year`) als native epub-gen-memory-Optionen; `keywords` → `<dc:subject>` (eins pro kommagetrenntem Term), `series`/`series_index` → EPUB3-`belongs-to-collection` + calibre-Legacy-Meta und **`isbn` → zusätzlicher `<dc:identifier>urn:isbn:…</dc:identifier>`** (Bindestriche gestrippt, `identifier-type`-Refine onix:codelist5 `15`=ISBN-13/`02`=ISBN-10; der Package-`unique-identifier` bleibt die UUID, ISBN tritt als weiterer Identifier hinzu — vom Buchhandel/Distributoren erkannt) via **Custom-`contentOPF`** (`_buildContentOPF` injiziert Extra-Zeilen vor `</metadata>` ins zur Laufzeit gezogene Lib-Template — driftfest, kein Copy). `date` nur setzen wenn vorhanden (Lib wirft sonst bei `new Date(undefined)`).
- **Barrierefreiheits-Metadaten** (`_buildAccessibilityMeta`, EPUB Accessibility 1.1 / schema.org) werden **immer** ins OPF injiziert — Discovery-Pflicht für den EU-Vertrieb (European Accessibility Act, seit 06/2025): `schema:accessMode` (`textual`, plus `visual` nur wenn Cover/Autorfoto/Inline-`<img>` vorhanden), `accessModeSufficient`, `accessibilityFeature` (`tableOfContents`/`readingOrder`/`structuralNavigation`), `accessibilityHazard none`, `accessibilitySummary` (sprachabhängig) + `dcterms:conformsTo`-Link (WCAG 2.0 AA). Auto-generiert, keine UI-Toggles — beschreibt den strukturell sauberen reflowbaren Text faktisch; EPUBCheck validiert die Struktur separat.
- **Landmarks-nav** (`_buildLandmarksNav`): versteckter EPUB3-`<nav epub:type="landmarks">` im nav.xhtml (an `_buildTocXhtmlBody` angehängt) mit `toc` → Lib-`toc.xhtml` und `bodymatter` → erste echte Inhalts-Datei (`epubChapters[0].filename`). Kein Cover-Landmark — das Cover ist bei epub-gen-memory nur ein Bild-Item ohne XHTML-Seite.
- **Stylesheet:** `_buildCss(meta)` baut das komplette `css`-Feld aus `EPUB_CSS_BASE` + den Reflow-/Typografie-Optionen (Schriftfamilie via `FONT_STACKS`, `font-size`/`line-height`, Einzug- vs. Absatzstil, Blocksatz, Silbentrennung, Drop-Caps, `.epub-chapter-head`-Umbruch). Ein eigenes `css`-Feld ersetzt das Lib-Default-Stylesheet komplett — darum die Lib-Defaults (Author/TOC/hr) in `EPUB_CSS_BASE` mitgeführt.
- `lang`/Autor: Autor = `book_publication.author_name` (wenn gesetzt), sonst Buch-Owner-Anzeigename — beide Pfade (Job `_resolveAuthor`, Sync). `lang` aus `book_settings.language`. Das Domain-Shape (`mapBook`) führt Autor nicht; `_resolveEpubMeta` faellt zusaetzlich auf `book.created_by`/`owned_by` zurueck.
- Inline-`<img>`: einbettbar sind `http(s)`-URLs **und** `data:`-URIs (Letzteres trägt das Autorfoto-Backmatter); alles andere wird geloggt, nicht still verworfen (`_countUnfetchableImages`).

Zwei Pfade, beide lesen `book_publication`:

- **Job** [routes/jobs/epub-export.js](../routes/jobs/epub-export.js) — `POST /jobs/epub-export` (Dedup, ACL viewer, `scope` book/chapter/page + `include_subchapters`) + `GET /jobs/epub-export/:id/file` (Stream, TTL-Map). Von der **EPUB-Export-Card** getriggert (Poll + Download). Kein KI-Call. Nach dem Render läuft **EPUBCheck** ([lib/epubcheck-validate.js](../lib/epubcheck-validate.js), W3C-Referenzvalidator) — **non-fatal**, exakt das veraPDF-Muster: fehlt das Binary, wird übersprungen (`{ available:false }`); meldet es Fehler, wird das EPUB trotzdem geliefert und das Job-Result trägt `epubcheck: { validatorAvailable, passed, errors, warnings, fatals, reason }`. Die Card zeigt bei `validatorAvailable && !passed` `epubExport.checkWarning` (8 s statt 3.5 s). Konfiguration: `EPUBCHECK_BIN` (ENV, Default `epubcheck` im PATH), `epub.validate.disabled` (app_settings → überspringt komplett).
- **Sync** [routes/export.js](../routes/export.js) `GET /export/:scope/:id/epub` — Schnellpfad, lädt `meta`/Cover/Foto lazy nur für `epub`. (Nicht mehr aus dem generischen Export-Dialog verlinkt — der reicht via `_handoffToEpubCustom()` an die Card durch.)

### EPUB-Export-Card

Eigene Karte analog Custom-PDF: [public/js/cards/epub-export-card.js](../public/js/cards/epub-export-card.js) (`Alpine.data('epubExportCard')`, registriert via `registerEpubExportCard`), Partial [public/partials/epub-export.html](../public/partials/epub-export.html), CSS [public/css/book/epub-export.css](../public/css/book/epub-export.css), Akzent `--card-accent-epubexport`. Registry-Eintrag `epubExport` in [feature-registry.js](../public/js/cards/feature-registry.js) (FEATURES + EXCLUSIVE_CARDS), Hash-View `epub`, Usage-Key `epubExport` in [routes/usage.js](../routes/usage.js).

Inhalt: Scope-Picker (Buch/Kapitel/Seite, inkl. Subkapitel-Toggle) + die **EPUB-Reflow-Toggles** (`epub_css_style`/`epub_justify`/`epub_toc_title`) live editierbar über denselben `PUT /publication/:book_id` wie der Publikation-Tab — daher wird die volle Meta geladen und vollständig zurückgeschrieben (sonst setzt der strikte Upsert isbn/subtitle/… auf Defaults). Cover/Titelei/Autor-Bio bleiben buch-weit im Publikation-Tab (Karte verlinkt dorthin). Der frühere EPUB-Export-Button im Publikation-Tab entfällt — EPUB läuft nur noch über die Card.

Handoff aus dem generischen Export-Dialog ([public/js/book/export.js](../public/js/book/export.js)#`_handoffToEpubCustom`): Event `export:epub:preset` (+ `window.__app.__epubExportPreset` als Cold-Open-Fallback) trägt den gewählten Scope rüber.

## PDF-Export liest dieselbe Quelle

Der PDF-Job ([routes/jobs/pdf-export.js](../routes/jobs/pdf-export.js)) spiegelt bei `scope==='book'` die `book_publication`-Felder vor dem Render in `profile.config.extras` (`getBookPublication`-Alias von `getMeta`); Cover/Autorfoto kommen aus `book_publication`. `pages.js`/`index.js` lesen unverändert `config.extras` — kein Render-Code-Umbau.

**Aufteilung (drift-kritisch):**

- **Buch-weit (`book_publication`):** Cover, Autorfoto, Autorname (`author_name` → PDF spiegelt ihn als `extras.authorName`, EPUB nutzt ihn als Autor — von **beiden** gelesen), ISBN, Subtitle, Jahr, Widmung, Impressum, Copyright, Frontmatter, Bio + Buchhandels-Metadaten (Description/Publisher/Series/Keywords) + **alle `epub_*`-Optionen** (Typografie/Struktur/OPF-Metadaten). **Sämtliche `epub_*`-Felder sowie Description/Publisher/Series/Keywords liest ausschliesslich der EPUB-Builder — PDF ignoriert sie bewusst** (EPUB ist reflowbar, PDF hat sein eigenes Profil-Layout in `pdf_export_profile.config`).
- **Profil-spezifisch (`pdf_export_profile.config`):** Layout/Print/Fonts/TOC + Render-Toggles `barcode`, `imprintPosition` + **Rückseiten-Bild** (`back_cover_image`, Umschlag-PDF).

Die PDF-Export-Card editiert die Titelei-/Cover-Felder **nicht** mehr (Hinweis auf den Publikation-Tab).

## Seed

Migration 166 seedet `book_publication` je Buch aus dem Gewinner-PDF-Profil (`is_default`, sonst zuletzt aktualisiert) — Metadaten aus `config.extras` + Cover/Autorfoto-BLOBs. Hält PDF + EPUB ab Einführung konsistent.

## Tests

- Unit: [tests/unit/publication-meta.test.mjs](../tests/unit/publication-meta.test.mjs) (Validator/ISBN-Checksum), [tests/unit/epub-export.test.mjs](../tests/unit/epub-export.test.mjs) (Meta-Resolver, Frontmatter/Backmatter, Bild-Zähler, ISBN-`dc:identifier`, Accessibility-Meta, Landmarks-nav, genEpub-Smoke).
- E2E: [tests/e2e/publication.spec.js](../tests/e2e/publication.spec.js) (Tab, Speichern, Cover-Upload, EPUB-Download) — Harness [tests/fixtures/publication-harness.html](../tests/fixtures/publication-harness.html), Mocks in [tests/server.js](../tests/server.js).
