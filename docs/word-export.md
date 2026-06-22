# Custom-Word-Export (DOCX)

Profilbasierter Word-Export als **Manuskript** — Use-Case: Einreichen bei Lektorat, Agentur oder Verlag. Pendant zum Custom-PDF, aber schlanker (Word ist reflowbar, kein Druck/Cover/PDF-A). Ersetzt den früheren einfachen Word-Export; die Normseiten-Variante bleibt als Ein-Klick-Schnellpfad im generischen Export-Dialog.

## Bibliothek

Programmatische [`docx`](https://docx.js.org/)-Lib (dolanmiu), **nicht** html-to-docx. Gewählt wegen dreier Manuskript-Pflichtfeatures, die html-to-docx nicht kann: laufende **Kopfzeile mit Seitenzahl** (`Nachname / Titel / Seite`, Standard-Manuscript-/Shunn-Format), echtes **Word-Inhaltsverzeichnis-Feld** (`TableOfContents` + `features.updateFields` → aktualisiert sich in Word), benannte **Heading-Styles** (Heading1/2/3, vom Lektor umformatierbar).

## Datenmodell

- **`docx_export_profile`** (Migration 214, user-scoped wie `pdf_export_profile`): `(kind, book_id)`-Scope (`book` / `user_default`), `config_json`, `is_default`. Kein Cover-BLOB. FK auf `books(book_id)` ON DELETE CASCADE + `app_users(email)` ON DELETE CASCADE. CRUD: [db/docx-export.js](../db/docx-export.js).
- **Config-Schema** ([lib/docx-export-defaults.js](../lib/docx-export-defaults.js), `defaultConfig`/`validateConfig`, strict): `page` (size/margins), `font` (family aus Whitelist `FONT_FAMILIES`/sizePt/lineSpacing/paragraphStyle/indent/justify), `header` (mode none|title|manuscript · pageNumber none|footer|headerRight · skipFirstPage), `title` (mode generated|none · wordCount), `frontmatter` (Inklusions-Toggles dedication/imprint/copyright/frontMatter/authorBio + imprintPosition), `toc` (mode none|field|static · depth 1–3), `chapter` (numbering none|arabic|roman|word · numberingMode flat|nested · unnumberedChapterIds · pageBreakBefore · pageStructure flatten|nested · sceneSeparator).
- **Titelei-Texte** (Titel/Untertitel/Autor/Widmung/Impressum/Copyright/Frontmatter/Bio/Jahr/ISBN) kommen buch-weit aus **`book_publication`** (SSoT, geteilt mit PDF + EPUB, im BookSettings → Publikation-Tab gepflegt). Das Profil hält nur, **welche** Bausteine eingebunden werden — die Inhalte werden nicht dupliziert. Kapitelnummerierung nutzt `_chapterLabelNested` aus [lib/pdf-render/layout.js](../lib/pdf-render/layout.js) (geteilt mit PDF/EPUB).

## Builder

[lib/export-builders/docx.js](../lib/export-builders/docx.js) `buildDocxProfile(bundle, { author, lang, meta, config })`:

- Seiten-HTML wird über **denselben Walker wie der PDF-Renderer** ([lib/pdf-render/html-walker.js](../lib/pdf-render/html-walker.js) `parseHtmlToBlocks`) in eine flache Block-Liste übersetzt und block-weise in `docx`-Paragraphen gemappt (Heading/Paragraph/List/Blockquote/Poem/Pre/hr). Tabellen → Fliesstext-Fallback, Bilder werden (wie beim PDF-Manuskript) nicht übernommen.
- Aufbau: optionale generierte Titelseite (+ Wortzahl) → Frontmatter (Widmung/Frontmatter/Impressum vorne) → TOC (Word-Feld oder statische Titel-Liste) → Kapitel-Body (Heading-Styles + Kapitel-Counter) → Backmatter (Impressum hinten / Autoren-Bio).
- `buildDocx`/`buildDocxNormseite` sind dünne Wrapper auf zwei Built-in-Presets (`reading` / `manuscript`) für die Sync-/Snapshot-Pfade ([routes/export.js](../routes/export.js), [routes/snapshots.js](../routes/snapshots.js)) — kein Profil aus der DB.

## Routen

- **Profil-CRUD:** [routes/docx-export.js](../routes/docx-export.js), gemountet `/docx-export` (`GET/POST/PUT/DELETE /profiles`, `POST /profiles/:id/default`, `GET /fonts`). Analog `routes/pdf-export.js`, ohne Cover-/Font-Fetch-Endpunkte.
- **Render-Job:** [routes/jobs/docx-export.js](../routes/jobs/docx-export.js), `POST /jobs/docx-export` (Dedup, ACL viewer, scope book/chapter/page + `include_subchapters`) + `GET /jobs/docx-export/:id/file` (Stream, TTL-Map). Kein KI-Call, kein Validator (DOCX hat keine veraPDF/EPUBCheck-Entsprechung).

## Frontend

Eigene Karte analog Custom-PDF: [public/js/cards/docx-export-card.js](../public/js/cards/docx-export-card.js) (`docxExportCard`), Partial [public/partials/docx-export.html](../public/partials/docx-export.html), CSS [public/css/book/docx-export.css](../public/css/book/docx-export.css), Akzent `--card-accent-docxexport`. Registry-Eintrag `docxExport` ([feature-registry.js](../public/js/cards/feature-registry.js): FEATURES + EXCLUSIVE_CARDS), Hash-View `docx`, Usage-Key `docxExport` ([routes/usage.js](../routes/usage.js)). Profil-Leiste (Auswahl/neu/Standard/löschen) + Config-Tabs (Layout/Struktur/Titelei) + Scope-Picker. Beim ersten Öffnen wird automatisch ein Standard-Profil „Manuskript" angelegt. Handoff aus dem generischen Export-Dialog via `_handoffToDocxCustom()` (Event `export:docx:preset`).

## Tests

[tests/unit/docx-export.test.mjs](../tests/unit/docx-export.test.mjs) (Validator + Builder-Smoke: TOC-Feld, Manuskript-Kopfzeile, Fusszeilen-Seitenzahl, Kapitelnummerierung). Builder-ZIP-Magic zusätzlich in [tests/unit/export-builders/builders.test.mjs](../tests/unit/export-builders/builders.test.mjs). Die Karte läuft registry-getrieben automatisch im Smoke-Test.
