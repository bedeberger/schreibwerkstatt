# Fotos im Tagebuch-Eintrag

- **Status:** Draft <!-- Draft → Ready erst wenn „Offene Fragen" leer -->
- **Aufwand:** XL
- **Severity:** high <!-- wie kritisch für Produkt-Strategie -->

## Context

Tagebücher leben von Fotos. Buchtyp `tagebuch` ist aktuell rein textbasiert — ein Eintrag ohne Bild ist für viele Tagebuch-Autor:innen wertlos. Das Feature schliesst die grösste inhaltliche Lücke des Buchtyps: User laden Fotos hoch und betten sie in den Eintrag ein.

Es ist gleichzeitig das **architektonisch quergeschnittene und heikelste** Feature der Tagebuch-Serie: es berührt Editor (Notebook), Storage (neue Persistenz für Binärdaten), Sanitization-Chokepoint (`lib/html-clean.js`), Buch-Migration (`.swbook`), alle Export-Builder, die öffentliche Reader-View und Datenschutz (EXIF/GPS-Strip). Fehler hier sind teuer: data-URLs blähen jeden Save auf, EXIF-Leaks sind ein Privacy-GAU, verwaiste BLOBs lassen die DB unkontrolliert wachsen.

Heute existiert **kein** Upload-Endpunkt. Bilder werden höchstens als `<img src=…>`-HTML durchgereicht — `<img>` ist in `_STRUCTURAL_LEAF` (`lib/html-clean.js` Z. 12) whitelisted und überlebt die Sanitization. Es gibt aber keinen Pfad, ein lokales Foto hochzuladen.

## Scope MVP

- **Upload** eines Fotos im **Notebook-Editor** (Toolbar-Button + Datei-Dialog) auf der aktuellen Seite eines `tagebuch`-Buchs.
- Server verarbeitet via **sharp** (Magic-Bytes-Check, → JPEG/sRGB, kein Alpha, Resize auf max. Längsseite, **EXIF/GPS-Strip**), persistiert als **BLOB** in neuer Tabelle `page_media` (FK auf `pages`).
- Bild wird als **referenzierte URL** `/media/:id` ins `body_html` eingebettet (`<figure data-bid=…><img src="/media/123" alt="…"></figure>`), **niemals** als `data:`-URL.
- **Auslieferung** via `GET /media/:id` mit korrektem Content-Type + Cache-Header, hinter Auth-Guard + Buch-ACL (mind. `viewer`).
- **Alt-Text** pro Bild (Pflichtfeld leer erlaubt, aber UI fragt) — a11y + Export.
- Bild im **Notebook-Editor** sichtbar (inline gerendert), Löschen über normalen Editor-Pfad (Block entfernen → HTML-Save ohne `<img>`).
- **EPUB/HTML/PDF-Export**: `/media/:id`-Referenzen werden beim Export aufgelöst und das BLOB eingebettet (PDF: pdfkit; EPUB: als Manifest-Item; HTML: data-URL oder mitgeliefertes Asset).
- **Buch-Migration** (`.swbook`): Bilder fahren im Bundle mit (ZIP-Asset + Manifest-Eintrag), Import remappt die `/media/:id`-URLs.
- **Orphan-GC**: beim Page-Save werden `page_media`-Rows, deren `id` nicht mehr im `body_html` referenziert ist, gelöscht (CASCADE deckt nur Page-Löschung ab).
- Feature nur bei Buchtyp `tagebuch` sichtbar (Toolbar-Button conditional).

## Out-of-Scope

- **Focus-Editor und Bucheditor** — explizit ausgeschlossen. Dieses Feature betrifft **ausschliesslich den Notebook-Editor** (`public/js/editor/notebook/`). Toolbar-Button erscheint nur dort. (Editor-Spezifikation, harte Regel.)
- **KI-Bildgenerierung** — dauerhaft ausgeschlossen. App-Philosophie: KI ist rückwärtsgewandt (Überwachung + Weltaufbau), schreibt nie generativ in den Buchtext, generiert keine Bilder. Fotos sind reiner User-Content.
- **Bild-Editing** (Crop/Filter/Rotate im Browser) — Phase 2. MVP rotiert nur via EXIF-Orientation serverseitig.
- **SVG-Upload** — dauerhaft ausgeschlossen (XSS-Vektor). Nur JPEG/PNG/WebP via Magic-Bytes.
- **Bild-Galerie / Mehrfach-Upload pro Aktion** — Phase 2. MVP: ein Bild pro Upload-Aktion.
- **Drag & Drop / Paste-Image** — Phase 2 (Paste-Image würde sonst data-URLs erzeugen; bewusst erst nach stabilem Upload-Pfad).
- **Bilder in anderen Buchtypen** — MVP nur `tagebuch`. Spätere Freigabe ist additiv.
- **Thumbnail-/Responsive-Varianten** (srcset) — Phase 2.

## Done when

- Im Notebook-Editor eines `tagebuch`-Buchs lädt ein User ein JPEG/PNG/WebP hoch, es erscheint inline und ist nach Reload weiterhin sichtbar.
- Das gespeicherte `body_html` enthält `<img src="/media/:id">`, **keine** `data:`-URL.
- `GET /media/:id` liefert das Bild nur an Auth + Buch-ACL-berechtigte User; ohne ACL → 403/404.
- EXIF/GPS-Metadaten sind im gespeicherten BLOB **nicht** mehr vorhanden (verifiziert im Test).
- SVG-Upload wird abgelehnt (400).
- Bild erscheint in PDF-Export und EPUB-Export.
- `.swbook`-Round-Trip (Export → Import in andere Instanz) bringt das Bild mit, neue `/media/:id`-URL ist korrekt remappt.
- Eintrag-Löschung (Page) entfernt zugehörige `page_media`-Rows (CASCADE). Bild aus HTML entfernt + Save → Row wird per Orphan-GC gelöscht.
- `npm test` grün; neue Unit-Tests für EXIF-Strip + Orphan-GC.

## Hard-Rule-Audit

- **Editor-Spezifikation** — BETROFFEN. Nur **Notebook-Editor**. Focus + Bucheditor explizit out-of-scope, im Plan benannt. Toolbar-Button-Code in `public/js/editor/notebook/toolbar.js`.
- **Content-Store-Facade als einziger Eintrittspunkt** — BETROFFEN. Page-Body-Schreibungen weiterhin nur via Facade. Die `page_media`-BLOBs sind **kein** Page-Inhalt im Facade-Sinn (kein `body_html`), sondern Anhang → eigener `db/page-media.js`-Layer; aber der HTML-Save, der die `<img>`-Referenz einbettet, läuft über die Facade. Orphan-GC hängt am Write-Chokepoint (siehe DB).
- **Block-IDs (`data-bid`) Write-Path-Invariante** — BETROFFEN. `<figure>` ist in `_BID_BLOCK_SEL` (Z. 299) → bekommt automatisch `data-bid`. `<img>` ist Inline-Leaf, kein `data-bid`. Einbetten als `<figure><img></figure>` ist daher die richtige Form. `ensureBlockIds` läuft idempotent, kein Eingriff nötig.
- **HTML-Sanitization single chokepoint** — BETROFFEN. `<img>` bleibt erhalten (whitelisted). **Neuer Eingriff in `lib/html-clean.js`**: `<img src>` muss auf erlaubte Schemata beschränkt werden (nur relative `/media/…`, optional http(s); `data:`/`javascript:` strippen). Orphan-GC läuft am Write-Chokepoint `lib/content-store/backends/localdb.js#_cleanHtmlSafe` bzw. unmittelbar danach (braucht `page_id`-Kontext → eher in der Facade-Update-Methode, nicht in der puren `_cleanHtmlSafe`-Funktion).
- **KI-Calls nur via Job-Queue** — NICHT betroffen. Upload ist kein KI-Call. Synchroner Upload-Endpunkt analog zum bestehenden `/pdf-export/.../back-cover` (express.raw, kein Job).
- **Styles nur in `public/css/`** — BETROFFEN. Neue Datei `public/css/editor/notebook-media.css` (oder Erweiterung bestehender Notebook-Editor-CSS). Inline-`style` für Bildgrösse verboten — Grösse via CSS-Klasse/`max-width:100%`.
- **UI-Strings nur in i18n** — BETROFFEN. Toolbar-Button, Upload-Dialog, Alt-Text-Prompt, Fehlertexte → beide `de.json`/`en.json`.
- **x-html nur escaped** — BETROFFEN. Alt-Text fliesst in `<img alt>` — vor Einbettung via `escHtml()`. Keine neuen `x-html`-Sinks; Bild wird als echtes DOM-Element gerendert, nicht via `x-html`-String.
- **Combobox/numInput/LanguageTool** — Alt-Text-Feld ist ein Prosatextfeld → `data-spellcheck="spelling"` (harte Regel). Keine `<select>`/`number`-Felder.
- **DB-Integrität** — BETROFFEN. Neue Tabelle `page_media` mit FK auf `pages(page_id)` ON DELETE CASCADE + Index. Timestamps via `NOW_ISO_SQL`. Migration + `foreign_key_check` + `squash:regen` + `erd.md`. Snapshot-Spalten verboten.
- **DB-Timestamps ISO+Z** — BETROFFEN. `created_at` via `${NOW_ISO_SQL}`, Schema-Default `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`.
- **Logging-Context book-slot** — BETROFFEN. Upload-/Media-Route mit Buchscope → `setContext({ book: bookId })` nach ACL-Auflösung.
- **SHELL_CACHE bumpen** — BETROFFEN (JS + CSS-Änderung). `public/sw.js` hochzählen.
- **Icons sparsam (Lucide)** — Toolbar-Button: ein Lucide-Icon (`image`) aus `/icons.svg`.
- **Eckige Badges / Swiss decimals / data-tip** — Tooltip am Toolbar-Button via `data-tip`.

## Abhängigkeiten

- `lib/cover-prepare.js` (sharp-Härtung) — als Vorlage und ggf. geteilter Baustein für die Bildverarbeitung.
- `lib/html-clean.js` — `<img>`-src-Whitelist-Erweiterung.
- `lib/content-store/backends/localdb.js` — Orphan-GC-Hook beim Page-Update.
- `lib/book-bundle.js` + `routes/book-migration.js` + `routes/jobs/book-import.js` — Bilder in `.swbook`-Bundle.
- `lib/export-builders/{epub,html,md,txt}.js` + `lib/pdf-render/html-walker.js` — `/media/:id`-Auflösung beim Export.
- `lib/acl.js` — `requireBookAccess` für Upload (editor) und Media-Auslieferung (viewer).
- Buchtyp `tagebuch` (Geschwister-Pläne `tagebuch-heute-eintrag.md`, `tagebuch-stimmung-tags.md` etc.) — Feature ist conditional auf diesen Typ.

## Backend

Neuer Router `routes/media.js`, in `server.js` gemountet, hinter Auth-Guard. Synchroner Upload (kein Job — analog `/pdf-export/.../back-cover`, express.raw).

- **`POST /media`** — Body: `express.raw({ type: ['image/*'], limit: MAX_INPUT_BYTES })`; Query/Header: `page_id`. Vertrag: ACL `editor` auf das Buch der Page; sharp-Härtung (Magic-Bytes → JPEG/sRGB/kein-Alpha/Resize/**EXIF-Strip via `withMetadata({})` ohne durchreichen**); persistiert BLOB in `page_media`; Antwort `{ id, url: '/media/:id', mime, width, height, bytes }`. SVG/unbekannt → `400 MEDIA_UNSUPPORTED_FORMAT`. Zu gross → `400 MEDIA_TOO_LARGE`.
- **`GET /media/:id`** — ACL `viewer` auf das Buch der zugehörigen Page (JOIN `page_media → pages → book_id`). Liefert BLOB mit `Content-Type: image/jpeg`, `Cache-Control: private, max-age=…` (BLOB ist immutable nach Upload → langer Cache ok; bei `private, no-store` wie Cover wäre Reader-View langsam — bewusst `private, immutable` wählen). `404` wenn nicht existent/kein Zugriff.
- **`DELETE /media/:id`** — optional im MVP; Löschung passiert primär via Orphan-GC. ACL `editor`.

Neuer DB-Layer `db/page-media.js`: `insertPageMedia`, `getPageMedia`, `getPageMediaMeta`, `deletePageMedia`, `listMediaIdsForPage`, `deleteOrphanMediaForPage(pageId, referencedIds[])`.

Bildverarbeitung: neue `prepareInlinePhoto(buffer)` in `lib/cover-prepare.js` (oder neue `lib/photo-prepare.js`) — wie `prepareCover`, aber **ohne** Portrait-Crop, mit explizitem **EXIF/GPS-Strip** (`.withMetadata({ icc: 'srgb' })` behält nur ICC, kein EXIF/GPS) und höherem Pixel-Limit für Vollbild-Fotos (z.B. 2048 px).

**Speicher-Entscheidung: BLOB-in-SQLite (Empfehlung).** Begründung gegen Filesystem: (1) Buch-Migration (`.swbook`) und Backup bleiben **ein File** — FS-Storage würde einen zweiten, separat zu sichernden/migrierenden Pfad einführen, der bei jedem `.swbook`-Round-Trip und jedem DB-Backup mitgedacht werden müsste (Drift-Risiko). (2) Präzedenz existiert bereits: PDF-Cover liegt als BLOB (`pdf_export_profile.cover_image`), Bausteine (sharp, express.raw, BLOB-CRUD) sind erprobt. (3) FK-CASCADE räumt Bilder bei Page-Löschung automatisch ab — bei FS müsste ein separater File-GC laufen. **Kosten/Risiko offen benannt:** SQLite-DB wächst spürbar (Tagebuch mit hunderten Fotos → mehrere hundert MB). Mitigation: aggressives Resize (max 2048 px, JPEG q88 ≈ 200–600 KB/Bild), Grössenlimit, kein Original-Behalt. Bei absehbar sehr grossen Tagebüchern ist FS-Migration ein Phase-2-Thema (dann mit explizitem File-GC + Bundle-Anpassung). Für MVP: BLOB.

**Gegen `data:`-URLs (klar):** data-URLs im `body_html` würden (1) jeden Page-Save um die Base64-Bildgrösse aufblähen (Stale-Write-Diffs, Revision-Tabelle, Sync-Payloads explodieren), (2) den FTS5-Index mit Base64-Müll füllen, (3) jeden html-clean-Durchlauf (linkedom-Parse) verlangsamen. Referenzierte `/media/:id`-URLs halten `body_html` schlank. **Entscheidung: referenzierte URLs.**

## Frontend

**Nur Notebook-Editor.** Kein neuer `Alpine.data`-Karten-Scope nötig — Toolbar-Erweiterung im bestehenden Notebook-Editor-Scope.

- `public/js/editor/notebook/toolbar.js` — neuer Toolbar-Button (Lucide `image`, conditional auf Buchtyp `tagebuch`), öffnet versteckten `<input type="file" accept="image/jpeg,image/png,image/webp">`.
- Upload-Handler (neues Modul `public/js/editor/notebook/media-upload.js`): liest Datei → `POST /media` (raw Body) → erhält `{ id, url }` → fragt Alt-Text (kleiner Inline-Prompt/Popover mit `data-spellcheck`) → fügt `<figure data-bid=… (von Server vergeben beim Save)><img src="/media/:id" alt="…"></figure>` an Cursor-Position ein → normaler Notebook-Save-Pfad (`public/js/editor/shared/`).
- Bild rendert inline über bestehende Editor-Rendering-Pipeline (echtes `<img>`-DOM, kein x-html).
- Kein neuer Eintrag in `feature-registry.js`/`EXCLUSIVE_CARDS` (keine eigene Hauptkarte).
- Loading-/Fehler-Feedback via bestehendes Toast/Job-Toast-Muster (Upload ist sync → einfacher Inline-Spinner am Button).

## CSS

Neue Datei `public/css/editor/notebook-media.css` (Notebook-Editor-Subfolder). Regeln: `figure`-Block im Notebook-Editor (Margin, Zentrierung), `img { max-width: 100%; height: auto; }`, Upload-Button-Spinner-State, Alt-Text-Popover. Mobile-Breakpoint im selben File. Link in `index.html` ergänzen (Cascade-Order nach bestehenden Notebook-Editor-Files), `SHELL_CACHE` bumpen, DESIGN.md CSS-Inventar ergänzen. Keine neue Akzentfarbe nötig (kein Karten-Scope).

## i18n

Neuer Key-Bereich `editor.media` in beiden Locales:
- `editor.media.uploadButton`, `editor.media.uploadTooltip`, `editor.media.altLabel`, `editor.media.altPlaceholder`, `editor.media.uploading`, `editor.media.errorTooLarge`, `editor.media.errorFormat`, `editor.media.errorGeneric`.
- Server-Fehler-Keys (falls user-sichtbar): `error.media.unsupported`, `error.media.tooLarge`.

## DB

Migration **174** (aktuell 173) in `db/migrations.js`:

```sql
CREATE TABLE IF NOT EXISTS page_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  data BLOB NOT NULL,
  alt TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_page_media_page_id ON page_media(page_id);
```

- FK `page_id → pages(page_id)` ON DELETE CASCADE (Bild gehört zur Seite; Seite weg → Bild weg). `book_id` **nicht** redundant gespeichert — über JOIN `pages.book_id` ableitbar (Snapshot-Verbot).
- `alt` ist User-kuratierter Text, kein Snapshot von Fremd-Tabellen — ok.
- INSERT liefert `created_at` explizit via `${NOW_ISO_SQL}`.
- Migration endet mit `foreign_key_check` + `UPDATE schema_version SET version = 174`.
- Danach **Pflicht:** `npm run squash:regen` (Migration ist rein additiv → Fast-Path-Regen reicht, kein `FORCE_LEGACY_MIGRATIONS`) + `docs/erd.md` Stand-Zeile (Version 174, +1 Tabelle) + `page_media`-Block + FK-Kante zu `pages`.

## Security

- **Auth:** beide Routen hinter Session-Guard (global). 401 zentral.
- **ACL:** `POST/DELETE /media` → `requireBookAccess(editor)`; `GET /media/:id` → `requireBookAccess(viewer)` (über JOIN auf `pages.book_id`). **Wichtig für Share-Link:** öffentliche Reader-View (`docs/share-link.md`) ist nicht session-authentifiziert → Bilder einer geteilten Seite müssen über einen **eigenen, token-gebundenen Media-Pfad** ausgeliefert werden (z.B. `/share/:token/media/:id` mit Token-Validierung + Honeypot/Rate-Limit wie der bestehende Share-Pfad), NICHT über `/media/:id`. Sonst entweder broken images im Share oder ACL-Bypass. → siehe Offene Fragen.
- **MIME/Magic-Bytes:** nur JPEG/PNG/WebP via `detectMime` (sharp-Vorstufe). **SVG strikt abgelehnt** (XSS).
- **EXIF/GPS-Strip Pflicht** (Privacy — Tagebuch ist privat, GPS-Koordinaten im Foto sind ein Leak): sharp gibt per Default keine EXIF weiter; explizit sicherstellen, dass nur ICC durchgereicht wird (`withMetadata({ icc: 'srgb' })`, kein `withMetadata()` ohne Argument das EXIF behält).
- **Grössenlimit:** `MAX_INPUT_BYTES` (20 MB Input wie Cover) + express.raw `limit`.
- **html-clean src-Whitelist:** `<img src>` nur relative `/media/…` (+ optional http(s)); `data:`/`javascript:`/sonstige Schemata strippen — verhindert XSS via gespeicherte fremde data-URL und data-URL-Bloat.
- **Content-Type beim Ausliefern:** fix aus DB-`mime` (immer `image/jpeg` nach Härtung), kein User-gesteuerter Header → kein Content-Type-Sniffing-Angriff. `X-Content-Type-Options: nosniff` setzen.

## Telemetrie

`n/a` für MVP. Optional Phase 2: Counter `media_upload_total` + `media_bytes_total` in `lib/metrics-collector.js` (dann Pflicht: HA-Config/Dashboard/README mitziehen — harte Regel).

## Reversibilität

- Feature-Flag: Toolbar-Button conditional auf Buchtyp `tagebuch` + (optional) `app_settings`-Kill-Switch `media.enabled` analog STT (`stt.enabled`). Aus → kein Upload-Button, bestehende `/media/:id` liefern weiter aus (sonst broken images in alten Einträgen).
- Daten-Rückbau: `page_media`-Tabelle kann via Migration gedroppt werden; verbleibende `<img src="/media/:id">` im HTML werden dann broken → bei vollständigem Ausbau zusätzlich `<figure>`-mit-`/media/`-Blöcke aus dem HTML strippen (eigene Daten-Migration). Im MVP-Scope nicht nötig; Flag-Aus reicht für Abschaltung.
- BLOB-Storage ist reversibel auf FS migrierbar (Phase-2-Pfad), URL-Schema `/media/:id` bleibt stabil.

## Tests

- **Unit:**
  - `photo-prepare`/`prepareInlinePhoto`: EXIF/GPS wird gestrippt (Fixture mit GPS-EXIF → Output ohne), SVG abgelehnt, Alpha geflattet, Resize greift.
  - `html-clean`: `<img src="data:…">` und `<img src="javascript:…">` werden gestrippt, `<img src="/media/1">` bleibt; `<figure>` bekommt `data-bid`.
  - `page-media`-DB-Layer: insert/get/delete, Orphan-GC (`deleteOrphanMediaForPage` löscht nur nicht-referenzierte IDs), CASCADE bei Page-Delete.
- **Integration:** Upload-Route gegen Mock-ACL (editor erlaubt, viewer/none verboten); `GET /media/:id` ACL-Gate; Export-Builder (EPUB/PDF) lösen `/media/:id` auf und betten BLOB ein.
- **E2E (Notebook-Editor-Harness):** Upload-Button erscheint nur bei `tagebuch`, Upload fügt `<figure><img>` ein, nach Save bleibt `/media/:id`-Referenz (kein `data:`). Console-Guard grün.
- **Smoke:** kein neuer Karten-Eintrag → automatisch abgedeckt; manuell Notebook-Editor-Pfad prüfen.

## Edge-Cases

- **Bild aus HTML entfernt, aber Row bleibt** → Orphan-GC beim Save (Diff referenzierter IDs gegen `page_media` der Page). Geplant.
- **Page gelöscht** → CASCADE räumt `page_media` ab.
- **Buch gelöscht** → CASCADE über `pages` → `page_media`.
- **`.swbook`-Import** → neue `page_id`/`media.id` → URL-Remap im Import-Job nötig (alte `/media/:alt` → neue `/media/:neu`). Risiko: vergessenes Remap = broken images. Test im Bundle-Round-Trip.
- **Sehr grosses Foto / 50 MP** → Resize-Limit + express.raw-Limit fangen ab; sharp `failOn: 'error'` bei korruptem File.
- **Gleiches Bild in zwei Einträgen** → nicht dedupliziert (MVP); jeder Upload = eigene Row. Akzeptiert.
- **Stale-Write / Block-Merge** (`FEATURE_BLOCK_MERGE`): `<figure>` hat `data-bid` → Block-Merge behandelt es wie jeden Block. `<img>`-Inline ohne ID ist Teil des Figure-Block-Inhalts → ok.
- **Share-Link-Bilder** → eigener token-gebundener Pfad (siehe Security/Offene Fragen), sonst broken oder ACL-Leak.
- **DB-Wachstum** → Grössenlimit + Resize; bei Tausenden Fotos Performance/Backup-Grösse beobachten (Risiko offen benannt).
- **Export ohne aufgelöste Bilder** (EPUB zählt heute `<img>` mit nicht-einbettbarer src und warnt — `lib/export-builders/epub.js` Z. 39ff) → `/media/:id` muss als einbettbar erkannt + BLOB beigefügt werden, sonst Reader zeigt nichts.

## Kritische Dateien

- **Modify:**
  - `lib/html-clean.js` — `<img src>`-Schema-Whitelist (nur `/media/…`/http(s); `data:` strippen).
  - `lib/content-store/backends/localdb.js` (oder Facade-Update-Methode) — Orphan-GC-Hook nach Page-HTML-Save.
  - `lib/book-bundle.js`, `routes/book-migration.js`, `routes/jobs/book-import.js` — Bilder in `.swbook`-Bundle + URL-Remap beim Import.
  - `lib/export-builders/epub.js`, `lib/export-builders/html.js`, `lib/export-builders/md.js`, `lib/pdf-render/html-walker.js` — `/media/:id`-Auflösung/Einbettung.
  - `db/migrations.js` — Migration 174 (`page_media`).
  - `db/squashed-schema.js` — via `npm run squash:regen`.
  - `docs/erd.md` — Stand-Zeile + `page_media`-Block + FK-Kante.
  - `server.js` — `routes/media.js` mounten.
  - `public/js/editor/notebook/toolbar.js` — Upload-Button (conditional `tagebuch`).
  - `public/index.html` — CSS-Link.
  - `public/sw.js` — `SHELL_CACHE` bump.
  - `public/js/i18n/de.json`, `public/js/i18n/en.json` — neue Keys.
  - `DESIGN.md` — CSS-Inventar + ggf. neues Bild-im-Editor-Pattern.
  - `lib/cover-prepare.js` — ggf. `prepareInlinePhoto` ergänzen (oder neue Datei).
- **Create:**
  - `routes/media.js` — Upload-/Auslieferungs-Router.
  - `db/page-media.js` — BLOB-CRUD + Orphan-GC.
  - `lib/photo-prepare.js` — sharp-Härtung mit EXIF-Strip (falls nicht in `cover-prepare.js`).
  - `public/js/editor/notebook/media-upload.js` — Upload-Flow + HTML-Einbettung.
  - `public/css/editor/notebook-media.css` — Bild-Styles im Notebook-Editor.
  - `tests/unit/photo-prepare.test.mjs`, `tests/unit/page-media.test.mjs`, `tests/unit/html-clean-img-src.test.mjs`.
  - `tests/e2e/notebook-media.spec.js`.

## Offene Fragen

- **Share-Link-Bildauslieferung:** Eigener Pfad `/share/:token/media/:id` (token-validiert, Rate-Limit/Honeypot wie bestehender Share-Pfad) — oder Bilder im Share bewusst ausblenden? Empfehlung: token-gebundener Pfad, da Tagebuch-Share ohne Fotos sinnentleert ist. Architektur-Detail (wie löst die SSR-Reader-View `/media/:id` → token-Pfad um?) klären, bevor `Ready`.
- **Cache-Header-Strategie:** `private, immutable, max-age` (BLOB ist nach Upload unveränderlich) vs. `private, no-store` (Cover-Präzedenz). Für Inline-Fotos in der Reader-/Editor-View ist Caching wünschenswert → Tendenz `immutable`. Endgültig festlegen.
- **DB-Wachstums-Schwelle:** Ab welcher Buch-/Foto-Anzahl wird FS-Migration ausgelöst? Brauchen wir im MVP schon ein Quota pro Buch/User? (Self-hosted → Betreiber-Sache, aber UX-Hinweis sinnvoll.)
- **`prepareInlinePhoto` in `cover-prepare.js` oder eigene `photo-prepare.js`?** — Trennung sauberer (Cover hat PDF/A-Constraints, Inline-Foto nicht), aber Code-Duplikat der Magic-Bytes-Logik. Entscheiden.
- **Buchtyp-Gate-Mechanik:** Wie liest die Notebook-Toolbar zuverlässig den aktuellen Buchtyp (`$app.selectedBook?.typ`)? Existierender Getter prüfen.
