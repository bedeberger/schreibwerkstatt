# Konfigurierbarer EPUB-Export + geteilte Publikations-Metadaten

- **Status:** Ready
- **Aufwand:** L
- **Severity:** medium <!-- Self-Publishing ist erklärtes Produkt-Ziel; EPUB ist der eBook-Standard neben PDF -->

## Context

Der EPUB-Export ([lib/export-builders/epub.js](../../lib/export-builders/epub.js)) ist heute ein Schnellpfad ohne Konfiguration: kein Cover, kein Impressum, keine Widmung, keine ISBN, keine Autoren-Bio. Zudem hat er **echte Bugs**:

- **Autor immer leer** — [epub.js](../../lib/export-builders/epub.js) liest `book.created_by?.name || book.owned_by?.name`, aber das Domain-Shape ([lib/content-mapper.js](../../lib/content-mapper.js) `mapBook`) liefert weder Feld; `localdb`-Backend lädt nicht mal `owner_email` durch. → `dc:creator` immer leer (gilt auch für [docx.js](../../lib/export-builders/docx.js)).
- **`lang` hardcoded `'de'`** — die Route reicht `{ lang: 'de' }` ([routes/export.js](../../routes/export.js)), aber `buildEpub` ignoriert das Arg und setzt `lang: 'de'` fest. `book_settings.language` (de/en/…) existiert. → `dc:language` + Reader-Silbentrennung falsch.
- **`tocTitle: 'Inhalt'` hardcoded** — auch in en-Büchern.
- **Bilder still verloren** — `ignoreFailedDownloads: true` schluckt fehlgeschlagene `<img>`-Einbettungen ohne Warnung.

Parallel hat der Custom-PDF-Export ([lib/pdf-render.js](../../lib/pdf-render.js), Profil [db/pdf-export.js](../../db/pdf-export.js), Card [public/js/cards/pdf-export-card.js](../../public/js/cards/pdf-export-card.js)) ein reiches Publikations-Profil: Cover-BLOB, Autor-Bio + Foto-BLOB, ISBN, EAN-Barcode, Widmung, Impressum, Copyright, Frontmatter/Motto, Subtitle, Jahr. Diese Daten sind aber **render-profil-gebunden** und damit für EPUB unzugänglich. Tell: `books.cover_image` BLOB existiert bereits, ist aber **ungenutzt** — Cover ist konzeptionell buch-eigen, nicht profil-eigen.

**Entscheidung (Architektur):** Publikations-Metadaten wandern auf **Buch-Ebene** (geteilt). Beide Exporter (PDF + EPUB) lesen daraus. Die Format-Profile bleiben dünn: PDF = Layout/Print/Fonts, EPUB = wenige reflow-spezifische Toggles. Damit wird ISBN/Cover/Bio **einmal** erfasst statt pro Format. Konsequenz: die neue UI ist faktisch eine **„Publikation"-Karte** (buch-weit), nicht nur eine „EPUB-Karte"; der EPUB-Export ist ein Download-Button mit wenigen Zusatz-Toggles.

**Prinzip-Treue:** Reine Layout-/Metadaten-Funktion. Kein KI-Call. Der konfigurierte EPUB-Export läuft als **Job** (mirror zum Custom-PDF-Export) — Progress-Feedback + robust bei grossen Büchern mit vielen Remote-Bildern. Die generische Sync-Route `/export/:scope/:id/epub` bleibt als Schnellpfad bestehen (liest jetzt ebenfalls `book_publication`).

## Scope MVP

**Block A — Geteilte Publikations-Metadaten (Buch-Ebene)**

- Neue Tabelle `book_publication` (1:1 zu `books`, PK = `book_id` FK ON DELETE CASCADE): `cover_image`/`cover_mime`, `author_image`/`author_image_mime` (BLOBs), `isbn`, `subtitle`, `year`, `dedication`, `imprint`, `copyright`, `frontmatter`, `author_bio` (Textfelder). Sprache bleibt SSoT in `book_settings.language` (kein Duplikat).
- Shared-Validator-Modul [lib/publication-meta.js](../../lib/publication-meta.js): `defaultMeta()` + `validateMeta(src)` (strict, Längen-Clamps, ISBN-13-Checksum non-blocking) — von beiden Exportern + der Card konsumiert.
- **PDF-Render zieht Metadaten + Cover/Autorfoto aus `book_publication`** statt aus `pdf_export_profile.config.extras`/`cover_image`/`author_image`. `pdf_export_profile` behält nur Layout/Print/Fonts/TOC/Chapter.
- **Datenmigration**: bestehende `pdf_export_profile`-Metadaten (`config.extras.{isbn,dedication,imprint,copyright,frontMatter,authorBio,subtitle,year}` + `cover_image` + `author_image`) → `book_publication`. Regel: pro Buch gewinnt das `is_default`-Profil; fehlt eins, das zuletzt aktualisierte. (Siehe Edge-Cases.)

**Block B — EPUB konsumiert Metadaten**

- `buildEpub` liest `book_publication`: Cover via epub-gen-memory `cover`-Option (Buffer), Titelseite/Impressum/Widmung/Frontmatter als vorangestellte XHTML-Entries, Autor-Bio als Backmatter-Entry. EPUB-Kapitel sind beliebiges XHTML → Frontmatter ist billig (kein pdfkit-Zeichnen).
- **Bugfixes** (auch ohne Card wertvoll): Autor aus `book_publication`/Owner auflösen; `lang` aus `book_settings.language`; `tocTitle` lokalisiert (`t`-äquivalent serverseitig bzw. Default je Sprache); Bild-Einbettungsfehler in eine nicht-fatale Warnliste sammeln statt still schlucken.
- EPUB-spezifische Toggles in `book_publication` (kein eigenes Profil-Table): `epub_css_style` (serif/sans), `epub_justify` (Blocksatz an/aus), optional `epub_toc_title`-Override.
- **Inline-Body-Bilder = Remote-URLs (status quo)**: epub-gen-memory fetcht `http(s)`-`<img src>` genau wie der PDF-Renderer ([lib/pdf-render/images.js](../../lib/pdf-render/images.js)). Kein Upload-Store, kein data-URI. Fetch-Fehler landen in der Warnliste (nicht still verworfen). Cover + Autorfoto sind davon unberührt (BLOB).

**Block C — „Publikation"-Karte (Frontend)**

- Neue Buchkarte `publicationCard`: Metadaten-Felder (Cover-Upload/Vorschau/Entfernen reused vom PDF-Cover-Flow, Autorfoto dito, ISBN, Subtitle, Jahr, Widmung, Impressum, Copyright, Frontmatter, Bio) + EPUB-Toggles + EPUB-Download-Button.
- PDF-Export-Card: Metadaten-/Cover-/Foto-Tabs entfernen (jetzt in Publikation-Karte); verlinkt dorthin. Layout/Schrift/Kapitel/TOC/Druck/Norm bleiben.

## Out-of-Scope

- **Eigenes `epub_export_profile`-Table / Mehrfach-Profile pro Buch für EPUB** — EPUB hat zu wenige Knöpfe; Toggles leben in `book_publication`. (PDF behält seine Mehrfach-Profile, weil Layout legitim variiert.)
- **Font-Einbettung ins EPUB** — Reader-Default ist für reflowable eBooks gewünscht.
- **EPUB3 Fixed-Layout, Media-Overlays, Pop-up-Footnotes** — reflowable Belletristik only.
- **Mehr als 2 Outline-Ebenen** — NavMap bleibt bei 2 (bestehende Limitierung, Sub-Sub flach).
- **`books.cover_image`-Spalte** wird durch `book_publication.cover_image` abgelöst; Drop der alten (ungenutzten) Spalte optional in separater Cleanup-Migration, nicht MVP-blockierend.

## Done when

- `book_publication` existiert; Metadaten + Cover + Autorfoto werden buch-weit gepflegt und überleben Reload.
- PDF-Export rendert Cover/ISBN/Bio/Widmung/Impressum/Frontmatter/Copyright weiterhin korrekt — jetzt aus `book_publication` (bestehende E2E grün, ohne dass der User Daten neu eingeben muss → Migration hat sie übernommen).
- EPUB-Export enthält: eingebettetes Cover, korrekten `dc:creator` (Autor nicht mehr leer), korrekte `dc:language` aus Buchsprache, lokalisierten TOC-Titel, Titelseite/Impressum/Widmung/Frontmatter/Bio an korrekter Position.
- EPUB validiert gegen `epubcheck` ohne Fehler (Cover-Manifest, NCX/Nav, OPF-Metadaten).
- Bild-Einbettungsfehler erscheinen als nicht-fatale Warnung (nicht still verworfen).
- `npm test` grün inkl. squash-drift + erd-drift nach Migration.

## Hard-Rule-Audit

- **Editor-Spezifikation:** n/a — kein Editor-Pfad.
- **UI-Patterns aus DESIGN.md:** neue Karte nach Card-Recipe; Bild-Upload-mit-Vorschau-Pattern (vom PDF-Cover) wiederverwenden — prüfen ob als Pattern in DESIGN.md steht, sonst ergänzen. Eckige Badges, Icons sparsam, Doppelpunkt-Separator.
- **i18n:** neuer Bereich `publication.*` (+ EPUB-Toggles) in **beiden** Locale-Dateien. Serverseitiger TOC-Titel-Default via `lib/i18n-server.js` bzw. `__i18n:`-Marker-Konvention prüfen.
- **CSS:** Card-Styles in `public/css/`; Foto-Vorschau analog Cover. `--card-accent-<key>` in tokens/colors.css + Mapping in card-accents.css. SHELL_CACHE bumpen.
- **Content-Store-Facade:** Buchinhalte weiter via `loadContents` (Facade). `book_publication` ist Publikations-Domäne (kein Buchinhalt) → eigenes db-Modul zulässig, analog `db/pdf-export.js`.
- **DB-Integrität / Timestamps:** `book_publication.book_id` FK auf `books(book_id)` ON DELETE CASCADE, PK = book_id (1:1). `*_at`-Spalten via `NOW_ISO_SQL`. Migration mit `foreign_key_check` + `UPDATE schema_version`, danach `npm run squash:regen` + [docs/erd.md](../erd.md) im selben Commit.
- **Job-Queue / `callAI`:** kein KI-Call, aber konfigurierter EPUB-Export läuft als Job-Typ (`epub-export`) nach dem Muster von [routes/jobs/pdf-export.js](../../routes/jobs/pdf-export.js) — Dedup-Check via `findActiveJobId`, Buffer in TTL-Map, `/jobs/epub-export/:id/file`-Stream. Generische Sync-`/export`-Route bleibt zusätzlich (Schnellpfad, kein KI → zulässig wie LanguageTool/Geocode).
- **x-html-Escape:** Metadaten werden serverseitig in XHTML/PDF gezeichnet (`escXml`); in der Card via `x-model`/`x-text`, kein neuer `x-html`-Sink.
- **Combobox/numInput/LanguageTool:** EPUB-Stil-Auswahl via `combobox`; **Jahr als Text-Feld** (4-stellig, kein `numInput` — Tausender-Grouping würde „2026" zu „2’026" rendern); ISBN bleibt Text (technische ID, **keine** Spellcheck — Ausnahme). Prosa-Felder (Bio, Widmung, Frontmatter, Impressum, Copyright) bekommen `data-spellcheck="spelling"`.
- **SHELL_CACHE / Card-Animationen / Ein-Attribut / Selektor-Unique / Mobile:** beim Bau einhalten.
- **Logging-Context:** EPUB-Route + Metadaten-Routen setzen `book`-Slot (`setContext` nach `toIntId`).

## Abhängigkeiten

- `epub-gen-memory` (bestehend) — `cover`-Option, beliebige XHTML-Kapitel.
- `sharp` via [lib/cover-prepare.js](../../lib/cover-prepare.js) — Cover + Autorfoto-Härtung (bereits Pflicht-Dep).
- Bestehender PDF-Export (wird umgebaut auf `book_publication`-Lesen): [lib/pdf-render/index.js](../../lib/pdf-render/index.js), [lib/pdf-render/pages.js](../../lib/pdf-render/pages.js), [db/pdf-export.js](../../db/pdf-export.js), [routes/pdf-export.js](../../routes/pdf-export.js), [public/js/cards/pdf-export-card.js](../../public/js/cards/pdf-export-card.js).
- `loadContents` ([lib/load-contents.js](../../lib/load-contents.js)) — format-agnostisch, unverändert.
- `epubcheck` (Test-/Ops-Dep, optional, für Validierung).

## Backend

- [lib/publication-meta.js](../../lib/publication-meta.js) **(neu)** — `defaultMeta()`, `validateMeta(src)`. ISBN-13-Checksum (non-blocking), Längen-Clamps, Strict-Whitelist.
- [db/book-publication.js](../../db/book-publication.js) **(neu)** — `getMeta(bookId)`, `upsertMeta(bookId, meta)`, `setCover/clearCover/getCover`, `setAuthorImage/clearAuthorImage/getAuthorImage`, `has_cover`/`has_author_image` Flags. Pattern analog [db/pdf-export.js](../../db/pdf-export.js).
- [routes/publication.js](../../routes/publication.js) **(neu)** — `GET/PUT /publication/:book_id` (Metadaten), `POST/DELETE/GET /publication/:book_id/cover`, `…/author-image` (raw body, `prepareCover`-Wiederverwendung). ACL `editor`-Scope für Schreiben, `viewer` für Lesen.
- [lib/content-mapper.js](../../lib/content-mapper.js) — `mapBook` um `owner_email`/Autor-Auflösung ergänzen (behebt den toten Autor-Pfad), bzw. Autor in `loadContents` aus `book_publication`/Owner anreichern.
- [lib/export-builders/epub.js](../../lib/export-builders/epub.js) — Signatur konsumiert `meta` aus `book_publication`; Cover-Buffer an `EPub`-`cover`; Frontmatter-Entries vorne, Bio hinten; `lang`/`tocTitle` aus Buchsprache; Bild-Warnungen sammeln (`ignoreFailedDownloads` bleibt, aber Fehler werden geloggt/zurückgegeben).
- [lib/export-builders/docx.js](../../lib/export-builders/docx.js) — denselben Autor-Fix übernehmen (toter Pfad).
- [lib/load-contents.js](../../lib/load-contents.js) — `book_publication`-Meta + Cover/Foto-Buffer in das `bundle` ziehen (oder Builder lädt selbst; entscheiden).
- [routes/export.js](../../routes/export.js) — EPUB-Build mit echten `lang`/`meta` aufrufen (Sync-Schnellpfad).
- [routes/jobs/epub-export.js](../../routes/jobs/epub-export.js) **(neu)** — Job-Typ `epub-export`: `runEpubExportJob` baut via `buildEpub`, Buffer in TTL-Map; `POST /jobs/epub-export` (Dedup) + `GET /jobs/epub-export/:id/file` (Stream). In [routes/jobs.js](../../routes/jobs.js) mounten.
- PDF-Render-Pfad ([lib/pdf-render/index.js](../../lib/pdf-render/index.js), [pages.js](../../lib/pdf-render/pages.js)) + [routes/jobs/pdf-export.js](../../routes/jobs/pdf-export.js) — Metadaten/Cover/Foto aus `book_publication` statt Profil.

## Frontend

`publicationCard` ([public/js/cards/publication-card.js](../../public/js/cards/publication-card.js)) — neue Buchkarte nach Card-Recipe:

1. Fachmodul `publicationMethods` (Metadaten laden/speichern, Cover-/Foto-Upload, EPUB-Export via `POST /jobs/epub-export` + Job-Poll + Download-Stream — `createCardJobFeature`/`startPoll` aus [job-helpers.js](../../public/js/cards/job-helpers.js)).
2. `Alpine.data('publicationCard', …)`, `registerPublicationCard()` in `app.js`.
3. Partial [public/partials/publication.html](../../public/partials/publication.html), `x-data="publicationCard"`.
4. `togglePublicationCard()` in app-view.js.
5. `showPublicationCard`-Flag in `app-state.js` cardsState.
6. `EXCLUSIVE_CARDS`-Eintrag in [feature-registry.js](../../public/js/cards/feature-registry.js).
7. `FEATURES`-Eintrag + Key in `ALLOWED_KEYS` ([routes/usage.js](../../routes/usage.js)).
8. Hash-Router-Branch in [app-hash-router.js](../../public/js/app/app-hash-router.js).

PDF-Export-Card: Metadaten-/Cover-/Autor-Tabs entfernen, Hinweis-Link auf Publikation-Karte. Layout/Schrift/Kapitel/TOC/Druck/Norm bleiben.

## CSS

Card-Styles + Foto-/Cover-Vorschau in eigener Datei in `public/css/` (oder bestehender Export-CSS), `<link>` in index.html, SHELL_CACHE bump, DESIGN.md-Inventar. Akzentfarbe `--card-accent-publication` (Light+Dark) in tokens/colors.css + Mapping in card-accents.css.

## i18n

Neuer Bereich `publication.*` (de + en, selber Commit): Karten-/Tab-Titel, Feld-Labels (ISBN, Subtitle, Jahr, Widmung, Impressum, Copyright, Frontmatter, Bio), Cover-/Foto-Upload/Entfernen/Vorschau, EPUB-Toggles (Stil, Blocksatz), EPUB-Download. Serverseitiger TOC-Default-Titel `publication.epub.tocDefault` (de „Inhalt", en „Contents") via i18n-server bzw. Default-je-Sprache im Builder.

## DB

Migration `N` ([db/migrations.js](../../db/migrations.js)):

```sql
CREATE TABLE IF NOT EXISTS book_publication (
  book_id            INTEGER PRIMARY KEY REFERENCES books(book_id) ON DELETE CASCADE,
  cover_image        BLOB,
  cover_mime         TEXT,
  author_image       BLOB,
  author_image_mime  TEXT,
  isbn               TEXT,
  subtitle           TEXT,
  year               TEXT,
  dedication         TEXT,
  imprint            TEXT,
  copyright          TEXT,
  frontmatter        TEXT,
  author_bio         TEXT,
  epub_css_style     TEXT NOT NULL DEFAULT 'serif',
  epub_justify       INTEGER NOT NULL DEFAULT 1,
  epub_toc_title     TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

Daten-Migration: pro Buch das Gewinner-PDF-Profil (is_default, sonst zuletzt aktualisiert) → `book_publication` (Metadaten aus `config_json.extras`, `cover_image`, `author_image`). Abschluss: `foreign_key_check`, `UPDATE schema_version SET version = N`. Danach `npm run squash:regen` + [docs/erd.md](../erd.md) (Stand-Zeile + neuer Block + FK-Kante `book_publication → books`).

Kein Index nötig (PK = book_id deckt Lookup; BLOBs nicht indexierbar).

## Security

- **Cover-/Autorfoto-Upload:** identische Härtung wie PDF-Cover ([lib/cover-prepare.js](../../lib/cover-prepare.js)) — Magic-Bytes, `sharp failOn:'error'`, Pixel-/Grössen-Limit, Re-Encode JPEG. ACL `editor`-Scope (Schreiben), `viewer` (Lesen/Export).
- **PII:** Bio/Foto/ISBN bleiben lokal, gehen an keinen externen Dienst.
- **XHTML-Injektion:** Metadaten via `escXml` ins EPUB-XHTML; kein roher User-String in OPF/NCX.

## Telemetrie

`n/a` (MVP). Optional später: `epub_export_total` Counter via [/metrics](../metrics-api.md).

## Reversibilität

- `book_publication` ist additiv; bei ausgeschaltetem Feature ignorieren die Builder leere Felder → Default-Verhalten.
- PDF-Umbau ist die einzige nicht-triviale Rückbau-Stelle: solange PDF aus `book_publication` liest, ist der alte profil-gebundene Pfad entfernt. Rückbau = Migration rückwärts (BLOBs/Meta zurück ins Default-Profil). Daher Migration sorgfältig + Test-gegated.
- Frontend-Rückbau: Karte + Flag entfernen; `book_publication` bleibt tolerant liegen.

## Tests

- **Unit** [tests/unit/publication-meta.test.mjs](../../tests/unit/publication-meta.test.mjs) **(neu)** — `validateMeta` Defaults/Clamps/ISBN-Checksum/unbekannte Keys verworfen.
- **Unit** EPUB-Builder — Cover im Manifest, `dc:creator`/`dc:language` korrekt, Frontmatter-Entries an Position, lokalisierter TOC-Titel, Bild-Warnliste statt Silent-Drop.
- **Unit** [pdf-render.test.mjs](../../tests/unit/pdf-render.test.mjs) — Metadaten weiterhin im PDF, jetzt aus `book_publication`-Quelle.
- **Unit** squash-drift + erd-drift nach Migration grün.
- **Integration/Validierung** — generiertes EPUB gegen `epubcheck` (env-gated, non-fatal wie veraPDF).
- **E2E** — Publikation-Karte: Cover-Upload+Entfernen, Felder persistieren über Reload; EPUB-Download liefert valide Datei.
- `npm test` vor Commit (Export-/UI-Berührung).

## Edge-Cases

- **Mehrere PDF-Profile pro Buch bei Migration** → Gewinner = is_default, sonst zuletzt aktualisiert. Verlierer-Profile verlieren ihre Cover-/Meta-Kopie (Metadaten sind jetzt buch-weit); ihre Layout/Print/Fonts bleiben. Migrations-Log listet, welches Profil pro Buch gewählt wurde.
- **`books.cover_image` hatte (theoretisch) Daten** → in Migration berücksichtigen: falls gesetzt und kein Profil-Cover, dieses übernehmen.
- **Leere Metadaten** → Frontmatter-/Bio-/Impressum-Seite wird übersprungen (wie heute Widmung im PDF).
- **Buchsprache nicht in {de,en}** → `dc:language` = roher Wert; TOC-Titel fällt auf de-Default zurück.
- **Bilder als data-URI vs. remote URL vs. relativer Pfad** → klären, welche Form das Page-HTML nutzt; `cover`-Buffer umgeht das für das Cover, aber Inline-`<img>` im Body braucht eine funktionierende Einbettungsstrategie (sonst Warnliste).
- **Sehr grosse Cover/Foto-BLOBs** → sharp-Resize-Cap wie PDF-Cover (max Längsseite).
- **Viele Remote-Bilder, langsame/tote URLs** → Job-Pfad (kein Sync-Timeout); Fetch-Fehler in Warnliste, Export bricht nicht ab.

## Kritische Dateien

- **Modify:**
  - [lib/export-builders/epub.js](../../lib/export-builders/epub.js) (Cover/Meta/Frontmatter/lang/tocTitle/Bild-Warnung)
  - [routes/jobs.js](../../routes/jobs.js) (epub-export-Router mounten)
  - [lib/export-builders/docx.js](../../lib/export-builders/docx.js) (Autor-Fix)
  - [lib/content-mapper.js](../../lib/content-mapper.js) (Autor/Owner im Domain-Shape)
  - [lib/load-contents.js](../../lib/load-contents.js) (Meta+Buffer ins bundle)
  - [routes/export.js](../../routes/export.js) (lang/meta an Builder)
  - [lib/pdf-render/index.js](../../lib/pdf-render/index.js) + [pages.js](../../lib/pdf-render/pages.js) (Meta/Cover/Foto aus book_publication)
  - [routes/jobs/pdf-export.js](../../routes/jobs/pdf-export.js), [routes/pdf-export.js](../../routes/pdf-export.js), [db/pdf-export.js](../../db/pdf-export.js) (Metadaten-Lesen umziehen)
  - [public/js/cards/pdf-export-card.js](../../public/js/cards/pdf-export-card.js) (Meta-Tabs raus)
  - [db/migrations.js](../../db/migrations.js) + [db/squashed-schema.js](../../db/squashed-schema.js) (regen) + [docs/erd.md](../erd.md)
  - [public/js/cards/feature-registry.js](../../public/js/cards/feature-registry.js), [routes/usage.js](../../routes/usage.js), [public/js/app/app-hash-router.js](../../public/js/app/app-hash-router.js), [public/js/app/app-state.js](../../public/js/app/app-state.js), [public/js/app/app-view.js](../../public/js/app/app-view.js)
  - [public/js/i18n/de.json](../../public/js/i18n/de.json) + [en.json](../../public/js/i18n/en.json), [public/index.html](../../public/index.html), [public/sw.js](../../public/sw.js), [DESIGN.md](../../DESIGN.md)
- **Create:**
  - [lib/publication-meta.js](../../lib/publication-meta.js)
  - [db/book-publication.js](../../db/book-publication.js)
  - [routes/publication.js](../../routes/publication.js)
  - [routes/jobs/epub-export.js](../../routes/jobs/epub-export.js)
  - [public/js/cards/publication-card.js](../../public/js/cards/publication-card.js) + [public/partials/publication.html](../../public/partials/publication.html)
  - Publikation-Card-CSS in [public/css/](../../public/css/)
  - [tests/unit/publication-meta.test.mjs](../../tests/unit/publication-meta.test.mjs)

## Offene Fragen

Leer — alle aufgelöst:

1. **Sync vs. Job für EPUB** → **Job** (`epub-export`, mirror PDF). Generische Sync-`/export`-Route bleibt als Schnellpfad.
2. **Inline-Body-Bilder** → **Remote-URLs (status quo)**, identisch zum PDF-Renderer; kein Upload-Store. Fetch-Fehler in Warnliste. Cover/Autorfoto = BLOB. (Ein separater BLOB-Attachment-Store für Body-Bilder ist ein eigenes, künftiges Feature.)
3. **PDF-Card-Umbau Timing** → **alles in einem PR**, damit Metadaten nie doppelt existieren.
4. **`year`-Feld** → **Text** (4-stellig, kein `numInput` wegen Tausender-Grouping).
