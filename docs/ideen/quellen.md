# Quellen pro Seite/Kapitel/Buch

- **Status:** Ready <!-- Draft → Ready erst wenn „Offene Fragen" leer -->
- **Aufwand:** L
- **Severity:** medium <!-- wie kritisch für Produkt-Strategie -->

## Context

Beim Erarbeiten einer Seite sammeln Autor:innen Recherchematerial: ein PDF (Sachtext, Interview-Transkript), einen Link (Wikipedia-Artikel, Quelle), ein Foto (Schauplatz-Referenz, Personen-Vorlage). Heute gibt es dafür **keinen Ort** — solches Material landet ausserhalb der App oder wird unstrukturiert in eine Idee getextet.

Quellen sind konzeptionell **„bessere Ideen"**: dasselbe Recherche-/Erarbeitungs-Material pro Seite, aber mit **Anhängen** (PDF/Link/Foto) statt reinem Freitext. Sie spiegeln daher die `ideen`-Architektur (Side-Panel im Editor-Slot, Scope-Modell, User-Isolation), unterscheiden sich aber im Storage-Profil grundlegend (Binary/URL statt TEXT) — deshalb eine **eigene Tabelle + eigenes Panel**, kein Aufbohren von `ideen`.

Passt zur Produkt-Philosophie „KI rückwärtsgewandt" ([user_app_philosophy]): Quellen sind reine **Autoren-Inputs**, kein KI-Material. Im MVP **kein** `callAI` auf Quellen (PDF-Volltext → Weltaufbau-Kontext wäre eine spätere, bewusst separate Phase).

Bezug zum bestehenden Code: das Schwester-Feature `ideen` (`routes/ideen.js`, `public/js/cards/ideen-card.js`, Side-Panel im `editor-chat-wrap`-Mutex-Slot) liefert das 1:1-Vorbild für Scope, Toggle, User-Isolation und Panel-Layout. Die BLOB-/Upload-/sharp-Härtungs-Bausteine kommen aus `lib/cover-prepare.js` und dem Plan `tagebuch-fotos.md`.

## Scope MVP

- Neues Side-Panel **„Quellen"** im Editor-Slot (Mutex mit Chat/Ideen — gleiches Layout-Muster wie `ideen`), getoggelt per **Toolbar-Button im Notebook-Editor** und per Kapitel-Aktion (analog `toggleIdeenCard`/`toggleChapterIdeenCard`).
- **Scope-UX kontextgetrieben (Variante S1, wie Ideen):** kein Scope-Button im Header. Aus der Seiten-Toolbar geöffnet → Seiten-Scope; aus einer Kapitel-Aktion → Kapitel-Scope. Header zeigt den Scope per Titel/Subline. **Buch-weiter Scope ist im MVP gesperrt** (kein UI-Einstieg, API lehnt ab) — aber **DB-technisch vorbereitet** (Schema erlaubt beide Refs NULL).
- **Drei Quellen-Typen, angelegt über EIN Menü (Variante A2):** ein `[+ Quelle ▾]`-Button klappt Link/PDF/Foto auf (niedriger Button-Count im Header).
  - `link` — URL + Titel + optionale Notiz. Öffnet in neuem Tab.
  - `pdf` — Datei-Upload, persistiert als BLOB. **Download** via `GET /quellen/:id/file` (`Content-Disposition: attachment`).
  - `image` — Foto-Upload, via `sharp` gehärtet (sRGB, kein Alpha, EXIF/GPS-Strip, Resize), BLOB. Thumbnail im Panel + Lightbox.
- **CRUD** komplett: anlegen, Titel/Notiz editieren, löschen. User-isoliert (`user_email`), wie `ideen`.
- **Konfigurierbare Upload-Grösse:** App-Setting `quellen.max_bytes`, pflegbar im Admin-Settings-Tab (`numInput`). Default 10 MB. Darüber → `400 QUELLE_TOO_LARGE`.
- **Suche:** Quellen-**Titel** fliessen in den FTS5-Index (`lib/search.js`, neuer `kind = 'quelle'`) → auffindbar in der Volltextsuche **und** in der Command-Palette über eine **eigene Kategorie/Prefix** (Anhänge).
- **Counts** pro Seite/Kapitel im Toolbar-Button-Badge (analog `ideenCounts`).
- i18n (de+en), Styles in `public/css/`, `SHELL_CACHE`-Bump.

## Out-of-Scope

- **Focus-Editor und Bucheditor** — Toolbar-Button nur im **Notebook-Editor** (Editor-Spezifikation, harte Regel).
- **Buch-weite Quellen anlegen/anzeigen** — im MVP **gesperrt** (kein Einstieg, API `400`). Bewusst nur DB-vorbereitet, damit die spätere Freigabe rein additiv ist (kein Migrations-Bedarf, nur API/UI freischalten).
- **KI-Zugriff auf Quellen** — dauerhaft ausgeschlossen für MVP. Kein PDF-Volltext-Parsing, keine Einspeisung in Chat/Komplettanalyse/Weltaufbau. Spätere Phase, bewusst separat (Philosophie-konform nur als *Überwachungs-/Weltaufbau-Input*, nie generativ).
- **PDF-Volltext-Suche (FTS5)** — Phase 2. MVP indiziert nur Titel/Notiz im normalen Such-Index (optional, siehe Offene Fragen).
- **PDF-Thumbnail-Render** — MVP zeigt generisches PDF-Icon, kein erste-Seite-Rendering.
- **Drag&Drop / Paste-Upload** — Phase 2. MVP: expliziter Datei-Dialog (wie Cover-Upload).
- **Quellen-Einbettung in den Buchtext** (`<img>`/Link ins `body_html`) — das ist explizit das Feature `tagebuch-fotos.md` (Bild *im* Eintrag). Quellen sind **daneben**, kein Editor-Content, fliessen **nicht** in Export/`.swbook`-Buchinhalt.
- **Versionierung/Revisions** von Quellen — keine. Anders als Page-Body.
- **Mehrfach-Upload pro Aktion** — Phase 2. MVP: eine Datei pro Upload.
- **Bild-Editing (Crop/Rotate im Browser)** — Phase 2. MVP rotiert nur via EXIF-Orientation serverseitig.

## Done when

- Im Notebook-Editor öffnet ein Toolbar-Button das Quellen-Panel der aktuellen Seite; ein Kapitel-Einstieg öffnet das Panel im Kapitel-Scope. Kein Scope-Button im Header.
- `[+ Quelle ▾]`-Menü legt `link`, `pdf` und `image` an; alle drei erscheinen im Panel, bleiben nach Reload erhalten.
- PDF/Foto werden als BLOB persistiert; `GET /quellen/:id/file` liefert sie nur an Auth + Buch-ACL-Berechtigte (`viewer`); ohne ACL → 403/404. PDF lädt als `attachment` herunter.
- Foto-BLOB enthält **kein** EXIF/GPS mehr (im Test verifiziert); SVG-Upload abgelehnt (400).
- Upload > konfiguriertem Cap (`quellen.max_bytes`) → `400 QUELLE_TOO_LARGE`, UI zeigt i18n-Fehler. Cap im Admin-Tab änderbar.
- **Buch-weite Quelle anlegen** (`page_id` + `chapter_id` beide leer) → API `400` (im MVP gesperrt); DB-Schema würde die Row aber akzeptieren (Vorbereitung verifiziert per DB-Layer-Test).
- Quelle löschen entfernt Row + BLOB; Page-/Kapitel-Löschung setzt Refs auf NULL, Buch-/User-Löschung räumt via CASCADE ab.
- Quellen-Titel sind in der Volltextsuche + Command-Palette (eigene Kategorie) auffindbar.
- Quellen erscheinen **nicht** im Export/PDF/EPUB/`.swbook`-Buchinhalt (sie sind kein Body-Content).
- `npm test` grün; neue Unit-Tests (Foto-Härtung/EXIF-Strip, `quellen`-DB-Layer inkl. Scope-CHECK + CASCADE/SET-NULL + Buch-weit-DB-erlaubt-aber-API-gesperrt) + E2E (Panel-Flow im Notebook-Harness).

## Hard-Rule-Audit

- **Editor-Spezifikation** — BETROFFEN. Toolbar-Button nur **Notebook-Editor** (`public/js/editor/notebook/`). Focus + Bucheditor out-of-scope, im Plan benannt.
- **KI-Calls nur via Job-Queue** — NICHT betroffen. Quellen-CRUD + Upload sind synchron, kein KI-Call. Upload-Endpunkt analog `/pdf-export/.../back-cover` (express.raw, kein Job) — KEINE neue Job-Datei.
- **Content-Store-Facade als einziger Eintrittspunkt** — NICHT verletzt. Quellen sind **kein** Buchinhalt (keine Page/Chapter/Book-Row, kein `body_html`) → eigener `db/quellen.js`-Layer, analog `db/pdf-export.js`/`db/fonts.js`, die ebenfalls neben der Facade existieren. Page/Chapter/Book werden weiterhin nur via Facade geschrieben.
- **DB-Integrität** — BETROFFEN. Neue Tabelle `quellen` mit FK `book_id→books` CASCADE, `page_id→pages` SET NULL, `chapter_id→chapters` SET NULL, `user_email→app_users` CASCADE. Index auf jede FK-Spalte. Scope-CHECK + Typ-CHECK (sentinel-frei). Snapshot-Spalten verboten (Titel ist User-kuratiert, kein Fremd-Snapshot → ok). Migration + `foreign_key_check` + `squash:regen` + `erd.md`.
- **DB-Timestamps ISO+Z** — BETROFFEN. `created_at`/`updated_at` via `${NOW_ISO_SQL}`, Schema-Default `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`.
- **Styles nur in `public/css/`** — BETROFFEN. Neue Datei `public/css/entities/quellen.css` (neben `entities/ideen.css`). Keine Inline-Styles; Thumbnail-Grösse via CSS. Mobile-Breakpoint im selben File.
- **UI-Strings nur in i18n** — BETROFFEN. Neuer Bereich `quellen.*` in `de.json`+`en.json`. Server-Fehler-Keys (`error.quelle.tooLarge`, `error.quelle.unsupported`) ebenfalls beide Locales.
- **x-html nur escaped** — BETROFFEN. Titel/Notiz/URL fliessen via `x-text`/`escHtml()`, nie roh in `x-html`. URL für `href` zusätzlich Schema-validieren (nur http/https).
- **Combobox/numInput/LanguageTool** — Typ-Wahl als `combobox` (kein `<select>`). Titel + Notiz sind Prosatextfelder → `data-spellcheck="spelling"` (harte Regel). URL-Feld bekommt **kein** Spellcheck (Ausnahme: technisches Feld). Size-Cap-Setting im Admin via `numInput`.
- **Eckige Badges** — Typ-Badge (Link/PDF/Foto) + Count-Badge eckig (`var(--radius-sm)`), [feedback_eckige_badges].
- **Icons (Lucide)** — Toolbar-Button + Typ-Icons aus `/icons.svg` (`link`, `file-text`, `image`). Keine Unicode-Glyphen.
- **data-tip statt title** — Toolbar-Button-Tooltip via `data-tip`.
- **Karten-Akzentfarbe** — eigener `--card-accent-quellen` Hue in `tokens/colors.css` (Light+Dark) + Mapping `.card--quellen` in `card-accents.css`. Panel nutzt `var(--card-accent)`.
- **Logging-Context book-slot** — BETROFFEN. Alle `/quellen/*`-Routes setzen `book` im ALS-Ctx (`setContext({ book })` nach ID-Auflösung, analog `routes/ideen.js`).
- **SHELL_CACHE bumpen** — BETROFFEN (JS + CSS). `public/sw.js` hochzählen.
- **Mobile-Breakpoints** — Panel-Layout im selben CSS-File mobil ([feedback_mobile_breakpoints]).
- **Self-hosted OSS** — Size-Quota/Storage-Limits sind Betreiber-Sache ([project_self_hosted_oss]); App bietet nur Default-Cap als App-Setting.

## Abhängigkeiten

- `routes/ideen.js` + `public/js/cards/ideen-card.js` + `public/js/book/ideen.js` — Vorbild für Scope-Modell, Toggle (`toggleIdeenCard`/`toggleChapterIdeenCard` in `app-view.js`), User-Isolation, Panel-Mutex im Editor-Slot, Counts.
- `lib/cover-prepare.js` — sharp-Härtung (Magic-Bytes, sRGB, kein Alpha, Resize); Vorlage/geteilter Baustein für Foto-Verarbeitung (`prepareInlinePhoto` aus `tagebuch-fotos.md` wiederverwendbar, falls dort schon gebaut).
- `lib/acl.js` — `requireBookAccess(editor)` für Schreiben, `(viewer)` für File-Auslieferung.
- `lib/app-settings.js` — neues Setting `quellen.max_bytes`.
- `db/pdf-export.js` — Vorlage für BLOB-CRUD-Layer.
- `public/js/editor/notebook/toolbar.js` (bzw. `partials/editor-notebook.html`) — neuer Toolbar-Button neben Ideen/Chat.
- `tagebuch-fotos.md` — Schwester-Plan; teilt Foto-Härtungs-/BLOB-Bausteine, ist aber funktional disjunkt (Bild *im* Text vs. Quelle *daneben*).

## Backend

Neuer Router `routes/quellen.js` (Vorbild `routes/ideen.js`), in `server.js` gemountet, hinter Auth-Guard. Synchron, kein Job.

- **`GET /quellen?page_id=` / `?chapter_id=`** — Liste der Quellen im jeweiligen Scope, user-isoliert. JOIN auf `pages`/`chapters` für Display-Namen (kein Snapshot). ACL `viewer`. (`?book_id=` ohne page/chapter ist im MVP **gesperrt** → `400`; Route-Stub vorhanden für spätere Freigabe.)
- **`POST /quellen`** (`express.json`) — legt `link`-Quelle an: Body `{ book_id, page_id?|chapter_id?, typ:'link', title, url, note? }`. URL-Schema-Validierung (http/https). **MVP-Scope-Gate:** genau eine von `page_id`/`chapter_id` muss gesetzt sein; beide leer (buch-weit) → `400 QUELLE_SCOPE_NOT_ALLOWED`. ACL `editor`.
- **`POST /quellen/upload`** (`express.raw({ type:['application/pdf','image/*'], limit: max_bytes })`) — legt `pdf`/`image` an. Scope + Titel via Query/Header, gleiches Scope-Gate. PDF: Magic-Bytes-Check (`%PDF`), BLOB direkt. Image: `sharp`-Härtung (→ JPEG/sRGB, kein Alpha, **EXIF/GPS-Strip**, Resize ≤ 2048 px). SVG/unbekannt → `400 QUELLE_UNSUPPORTED`. > Cap → `400 QUELLE_TOO_LARGE`. ACL `editor`. Antwort `{ id, typ, mime, bytes, title }`.
- **`PATCH /quellen/:id`** — Titel/Notiz/URL editieren (kein BLOB-Replace im MVP). ACL `editor` + Owner. Titel-Änderung re-indiziert FTS.
- **`DELETE /quellen/:id`** — löscht Row + BLOB + FTS-Eintrag. ACL `editor` + Owner.
- **`GET /quellen/:id/file`** — streamt BLOB mit `Content-Type` aus DB-`mime`, `X-Content-Type-Options: nosniff`. **PDF: `Content-Disposition: attachment`** (Download, entschieden), Bild: `inline` (Lightbox). `Cache-Control: private, max-age=…` (BLOB immutable). ACL `viewer` über JOIN auf das Buch (page/chapter → `book_id`). `404` ohne Zugriff.

Neuer DB-Layer `db/quellen.js`: `insertQuelle`, `getQuelle`, `getQuelleFile` (BLOB+mime), `listQuellen(scope)`, `updateQuelle`, `deleteQuelle`, `countQuellenForPages([])`/`countQuellenForChapters([])` (für Badges).

**Such-Index:** Schreibpfade rufen die FTS-Hooks aus `lib/search.js` (analog `routes/ideen.js`, das `searchIndex` importiert) — Insert/Update/Delete halten den `quelle`-Eintrag (Titel) synchron. Neuer `kind = 'quelle'` im Index + `_runFulltextHit`-Branch in `public/js/cards/palette-providers.js`.

Foto-Härtung: `prepareInlinePhoto(buffer)` aus neuer `lib/photo-prepare.js` (geteilt mit `tagebuch-fotos.md`; falls jener Plan sie schon angelegt hat → wiederverwenden, sonst hier neu) — EXIF-Strip via `.withMetadata({ icc: 'srgb' })`, kein Portrait-Crop.

**Speicher: BLOB-in-SQLite + konfigurierbarer Size-Cap (entschieden).** Konsistent mit `pdf_export_profile.cover_image`; FK-CASCADE/SET-NULL räumt automatisch ab; ein-File-Backup. Kosten offen benannt: DB wächst (PDFs sind grösser als Fotos) → konfigurierbarer Cap + kein Original-Behalt; FS-Migration ist Phase-2-Pfad bei absehbar grossen Beständen.

## Frontend

**Kein `EXCLUSIVE_CARDS`-Eintrag** — Quellen ist (wie `ideen`) ein Side-Panel im Mutex-Slot neben dem Editor, kein exklusives Main-Card. Daher abweichend vom Standard-Karten-Rezept:

- **Sub-Komponente** `public/js/cards/quellen-card.js` → `Alpine.data('quellenCard', …)` mit `quellenMethods` aus `public/js/book/quellen.js`. State: `quellen[]`, `quellenScope ('page'|'chapter')`, `quellenChapterId`, `quellenCounts`, `addMenuOpen` (für A2-Menü), `uploadBusy`. Vorbild `ideen-card.js` (gleicher `showFlag`-/`loadXxx`-Lifecycle). (`'book'` als Scope-Wert ist im State-Typ schon vorgesehen, aber im MVP nie gesetzt — DB/State-Vorbereitung.)
- **Root-State** (`app-state.js`): `showQuellenCard:false`, `quellenScope:'page'`, `quellenChapterId:null`, `quellenCounts:{}`.
- **Toggle** (`app-view.js`): `toggleQuellenCard()` / `toggleChapterQuellenCard(chapterId)` analog `toggleIdeenCard`/`toggleChapterIdeenCard` — Mutex im Editor-Slot (schliesst Chat/Ideen, `editor-chat-wrap`-Split). In `_resetBookScopedState`/`resetView`/`selectPage` mit-nullen (wie `showIdeenCard` an den ~5 Stellen in `app-view.js`).
- **Scope-UX (S1, kontextgetrieben):** **kein** Scope-Control im Header. `toggleQuellenCard()` setzt `quellenScope='page'`, `toggleChapterQuellenCard()` setzt `'chapter'` — analog Ideen. Header-Titel/Subline via `x-text` aus `quellenScope` (`quellen.title` / `quellen.titleChapter`).
- **Add-UX (A2, ein Menü):** ein `[+ Quelle ▾]`-Button toggelt `addMenuOpen`; das Menü listet Link/PDF/Foto (Lucide-Icons `link`/`file-text`/`image`). Link → Inline-Eingabezeile (Titel+URL); PDF/Foto → versteckter `<input type="file">` (Cover-Upload-Muster). Menü nutzt das bestehende Dropdown-/`@click.outside`-Muster aus DESIGN.md, kein neues Pattern.
- **Partial** `public/partials/quellen.html` (`<div class="card card--quellen" x-data="quellenCard" x-show="$app.showQuellenCard" x-cloak>`), via `_loadPartials` geladen + in `editor-chat-wrap`-Slot eingehängt (parallel zu `ideen.html`/`chat.html`).
- **Toolbar-Button** in `partials/editor-notebook.html` neben dem Ideen-Button (`@click="toggleQuellenCard()" :class="{ primary: showQuellenCard }" :data-tip="t('quellen.title')"`) mit Count-Badge.
- Foto: Thumbnail + Lightbox; PDF: Icon + Download-Link; Link: externer Open (`target="_blank" rel="noopener"`), Schema-gegated.
- **Command-Palette — eigene Kategorie „Anhänge":** neuer Provider in `public/js/cards/palette-providers.js` mit eigenem Prefix (Vorschlag `&`, da `> # ! @ $ % ?` belegt sind) + Legende-Eintrag in `palette-card.js` (`{ prefix: '&', labelKey: 'palette.legend.quellen' }`). Item `run(root)`: Link → öffnen; PDF/Foto → `GET /quellen/:id/file`. Zusätzlich erscheinen Quellen-Titel über den **bestehenden** `?`-Fulltext-Provider (neuer `kind='quelle'`-Branch in `_runFulltextHit`).
- **Hash-Router:** Side-Panels sind nicht deep-linkbar wie Main-Cards — `ideen` ist auch nicht im `app-hash-router`-Flag-Set. Quellen analog **nicht** in den Hash-Router aufnehmen (konsistent).
- **Usage-Tracking:** Side-Panels tracken nicht via `ALLOWED_KEYS` (ideen tut's auch nicht). Kein `routes/usage.js`-Eintrag nötig.

## CSS

Neue Datei `public/css/entities/quellen.css` (neben `entities/ideen.css`). Panel-Layout, Quellen-Liste, Typ-Badge (eckig), Foto-Thumbnail-Grid, PDF-Icon-Zeile, `[+ Quelle ▾]`-Dropdown-Menü (A2), Upload-Button-Busy-State, Lightbox. Akzentfarbe: `--card-accent-quellen` in `tokens/colors.css` (Light+Dark) + `.card--quellen { --card-accent: var(--card-accent-quellen); }` in `card-accents.css`. Mobile-Breakpoint im selben File. `<link>` in `index.html` (Cascade-Order nach `ideen.css`), `SHELL_CACHE`-Bump, DESIGN.md CSS-Inventar. Dropdown-Menü wiederverwendet bestehendes DESIGN.md-Pattern — falls keins passt, dort dokumentieren vor Verwendung.

## i18n

Neuer Bereich `quellen.*` in beiden Locales:
- `quellen.title`, `quellen.titleChapter`, `quellen.subline`, `quellen.sublineChapter`, `quellen.empty`, `quellen.emptyChapter`, `quellen.addButton` (`+ Quelle`), `quellen.addLink`, `quellen.addPdf`, `quellen.addPhoto`, `quellen.titleLabel`, `quellen.urlLabel`, `quellen.noteLabel`, `quellen.typeLink`, `quellen.typePdf`, `quellen.typeImage`, `quellen.uploading`, `quellen.delete`, `quellen.deleteConfirm`, `quellen.openExternal`, `quellen.download`.
- Palette: `palette.legend.quellen`.
- Admin-Setting: `admin.settings.quellenMaxBytes` (Label + Hilfetext).
- Server-Fehler: `error.quelle.tooLarge`, `error.quelle.unsupported`, `error.quelle.badUrl`, `error.quelle.scopeNotAllowed`.

## DB

Migration **174** (aktuell 173) in `db/migrations.js`:

```sql
CREATE TABLE IF NOT EXISTS quellen (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(book_id)       ON DELETE CASCADE,
  page_id     INTEGER          REFERENCES pages(page_id)       ON DELETE SET NULL,
  chapter_id  INTEGER          REFERENCES chapters(chapter_id) ON DELETE SET NULL,
  user_email  TEXT    NOT NULL REFERENCES app_users(email)     ON DELETE CASCADE,
  typ         TEXT    NOT NULL CHECK(typ IN ('link','pdf','image')),
  title       TEXT    NOT NULL,
  note        TEXT,
  url         TEXT,
  data        BLOB,
  mime        TEXT,
  size_bytes  INTEGER,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Scope: höchstens eine von page/chapter gesetzt (beide NULL = buch-weit)
  CHECK (NOT (page_id IS NOT NULL AND chapter_id IS NOT NULL)),
  -- Typ-Storage-XOR: link hat url+keine BLOB; pdf/image hat BLOB+keine url
  CHECK ((typ = 'link'  AND url IS NOT NULL AND data IS NULL)
      OR (typ IN ('pdf','image') AND data IS NOT NULL AND url IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_quellen_book_id    ON quellen(book_id);
CREATE INDEX IF NOT EXISTS idx_quellen_page_id    ON quellen(page_id);
CREATE INDEX IF NOT EXISTS idx_quellen_chapter_id ON quellen(chapter_id);
CREATE INDEX IF NOT EXISTS idx_quellen_user_email ON quellen(user_email);
```

- Scope-Modell erweitert `ideen` (das page XOR chapter erzwingt) um **buch-weit** (beide NULL). `book_id` immer gesetzt. **Der CHECK erlaubt buch-weit bewusst auf DB-Ebene** (Vorbereitung), die **API sperrt es im MVP** (`QUELLE_SCOPE_NOT_ALLOWED`) — spätere Freigabe ohne Migration.
- `page_id`/`chapter_id` SET NULL (user-kuratierte Daten überleben Seiten-/Kapitel-Löschung als buch-weite Quelle), `book_id` CASCADE, `user_email` CASCADE.
- Display-Namen (Seite/Kapitel) per JOIN zur Lesezeit — keine Snapshot-Spalten.
- INSERT liefert `created_at`/`updated_at` explizit via `${NOW_ISO_SQL}`.
- Migration endet mit `foreign_key_check` + `UPDATE schema_version SET version = 174`.
- Danach **Pflicht:** `npm run squash:regen` (rein additiv → Fast-Path-Regen reicht) + `docs/erd.md` Stand-Zeile (Version 174, 91 Tabellen) + `quellen`-Block + FK-Kanten zu `books`/`pages`/`chapters`/`app_users`.

## Security

- **Auth:** alle `/quellen/*` hinter Session-Guard; 401 zentral.
- **ACL:** Schreiben (`POST`/`PATCH`/`DELETE`/`upload`) → `requireBookAccess(editor)`; File-Auslieferung (`GET /:id/file`, `GET` Liste) → `requireBookAccess(viewer)` über JOIN auf das Buch. Owner-Check (`user_email`) zusätzlich bei PATCH/DELETE (user-isoliert wie `ideen`).
- **MIME/Magic-Bytes:** PDF via `%PDF`-Header, Bilder via sharp-`detectMime`. **SVG strikt abgelehnt** (XSS). Foto wird zu JPEG normalisiert → fixer Content-Type.
- **EXIF/GPS-Strip Pflicht** bei Fotos (Privacy — Schauplatz-Fotos können GPS enthalten): nur ICC durchreichen.
- **URL-Validierung** (`link`): nur `http(s)://`-Schema; `javascript:`/`data:` abgelehnt (`400 QUELLE_BAD_URL`). Im Template `href` zusätzlich gegen erlaubte Schemata gegatet.
- **Content-Type beim Ausliefern:** fix aus DB-`mime`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`. PDF inline ist ok (Browser-Viewer, kein HTML-Render-Kontext). Kein user-gesteuerter Content-Type.
- **Size-Cap:** konfigurierbares App-Setting `quellen.max_bytes` (Default 10 MB), pflegbar im Admin-Settings-Tab via `numInput`; `express.raw`-`limit` wird aus dem Setting gespeist.
- **Scope-Gate:** API erzwingt page XOR chapter (buch-weit gesperrt) — verhindert versehentliches Anlegen unsichtbarer (kein UI-Einstieg) buch-weiter Quellen.
- **Kein `x-html`-Sink:** Titel/Notiz/URL via `x-text`/`escHtml`.

## Telemetrie

`n/a` für MVP. Optional Phase 2: Counter `quellen_total` + `quellen_bytes_total` in `lib/metrics-collector.js` — dann **Pflicht** HA-Config/Dashboard/README mitziehen (harte Regel).

## Reversibilität

- **Kill-Switch:** App-Setting `quellen.enabled` (analog `stt.enabled`) — aus → Toolbar-Button + Buch-weit-Einstieg verschwinden, Routes liefern `403`. Bestehende Quellen bleiben in der DB.
- **Daten-Rückbau:** `quellen`-Tabelle via Migration droppbar; da Quellen **nicht** im `body_html` referenziert sind (kein Editor-Content), entstehen **keine** Broken-Links im Buchtext beim Ausbau — sauberer Rückbau als bei `tagebuch-fotos`.
- BLOB-Storage auf FS migrierbar (Phase 2), URL-Schema `/quellen/:id/file` bleibt stabil.

## Tests

- **Unit:**
  - `quellen`-DB-Layer: insert/get/update/delete; Scope-CHECK (page+chapter gleichzeitig → reject); **buch-weit (beide NULL) auf DB-Ebene erlaubt** (Vorbereitung verifiziert); Typ-CHECK (link ohne url → reject, pdf ohne BLOB → reject); CASCADE bei Buch-/User-Delete; SET NULL bei Page-/Kapitel-Delete.
  - Foto-Härtung: EXIF/GPS gestrippt (Fixture mit GPS → Output ohne), SVG abgelehnt, Alpha geflattet, Resize greift.
  - URL-Validierung: `javascript:`/`data:` abgelehnt, `https:` ok.
  - FTS: Quellen-Titel landet im Index (insert), verschwindet bei delete, ändert sich bei PATCH.
- **Integration:** `/quellen`-CRUD + `/upload` + `/:id/file` gegen Mock-ACL (editor schreibt, viewer liest, none → 403); **buch-weit-POST → 400 `QUELLE_SCOPE_NOT_ALLOWED`** (API-Gate trotz DB-Erlaubnis); Cap-Überschreitung → 400; PDF-Magic-Bytes-Reject bei Fake-PDF; PDF-`GET` liefert `Content-Disposition: attachment`.
- **E2E (Notebook-Harness):** Toolbar-Button öffnet Panel; `[+ Quelle ▾]`-Menü öffnet, Link anlegen → erscheint; Foto-Upload → Thumbnail; Löschen entfernt Eintrag; Console-Guard grün.
- **Smoke:** Quellen ist kein `EXCLUSIVE_CARDS`-Eintrag → nicht automatisch im Karten-Smoke; Notebook-Editor-Pfad (der im Smoke geöffnet wird) zeigt den Button — manuell verifizieren.

## Edge-Cases

- **Page/Kapitel gelöscht, Quelle bleibt** → SET NULL: Refs werden NULL → Quelle ist DB-seitig buch-weit. Da der Buch-Scope im MVP **kein UI** hat, wird sie unsichtbar (aber nicht gelöscht). Bewusst akzeptiert: Material geht nicht verloren, wird bei späterer Buch-Scope-Freigabe sichtbar. **Hinweis im Code** (Kommentar), damit das nicht als Bug gelesen wird.
- **Buch/User gelöscht** → CASCADE räumt Quellen + BLOBs ab.
- **Sehr grosses PDF** → konfigurierter Cap + `express.raw`-`limit` fangen ab; klare i18n-Fehlermeldung.
- **Korruptes Bild** → sharp `failOn:'error'` → `400 QUELLE_UNSUPPORTED`.
- **Link mit Tracking-/sehr langer URL** → kein Limit-Problem (TEXT), aber URL-Schema-Gate greift.
- **Gleiches PDF mehrfach hochgeladen** → keine Dedup (MVP), jede Quelle eigene Row. Akzeptiert.
- **Quelle im Share-Link** → Quellen sind privat (Recherche), erscheinen **nicht** in der öffentlichen Reader-View. Kein token-Pfad nötig (anders als `tagebuch-fotos`).
- **Palette-Treffer auf buch-weite (verwaiste) Quelle** → FTS-Hit auf Titel ohne page/chapter → `run()` öffnet die Datei direkt (kein Navigations-Ziel). Defensiv behandeln.

## Kritische Dateien

- **Modify:**
  - `server.js` — `routes/quellen.js` mounten.
  - `db/migrations.js` — Migration 174 (`quellen`).
  - `db/squashed-schema.js` — via `npm run squash:regen`.
  - `docs/erd.md` — Stand-Zeile + `quellen`-Block + FK-Kanten.
  - `lib/photo-prepare.js` — Foto-Härtung mit EXIF-Strip (neu **oder** geteilt mit `tagebuch-fotos.md`, falls dort schon angelegt → wiederverwenden statt duplizieren).
  - `lib/app-settings.js` — Setting `quellen.max_bytes` + `quellen.enabled`.
  - `lib/search.js` — `kind='quelle'`-Index-Hooks (insert/update/delete).
  - `routes/admin/settings.js` (bzw. der Admin-Settings-Router) — `quellen.max_bytes`-Feld.
  - `public/js/app/app-state.js` — `showQuellenCard`, `quellenScope`, `quellenChapterId`, `quellenCounts`.
  - `public/js/app/app-view.js` — `toggleQuellenCard`/`toggleChapterQuellenCard` + Reset/`selectPage`-Null-Stellen.
  - `public/js/cards/palette-providers.js` — Quellen-Provider + `_runFulltextHit`-`quelle`-Branch.
  - `public/js/cards/palette-card.js` — Legende-Eintrag `&`/`palette.legend.quellen` + Prefix-Routing.
  - `public/partials/editor-notebook.html` — Toolbar-Button + Count-Badge.
  - `public/index.html` — Partial-Placeholder `quellen` im Editor-Slot + CSS-`<link>`.
  - `public/sw.js` — `SHELL_CACHE`-Bump.
  - `public/css/tokens/colors.css` — `--card-accent-quellen` (Light+Dark).
  - `public/css/card-accents.css` — `.card--quellen`-Mapping.
  - `public/js/i18n/de.json`, `public/js/i18n/en.json` — `quellen.*` + `palette.legend.quellen` + `admin.settings.quellenMaxBytes` + `error.quelle.*`.
  - `DESIGN.md` — CSS-Inventar + ggf. neues Quellen-Panel-Pattern.
- **Create:**
  - `routes/quellen.js` — CRUD + Upload + File-Auslieferung.
  - `db/quellen.js` — BLOB-CRUD + Counts.
  - `public/js/book/quellen.js` — `quellenMethods` (Fach-Logik).
  - `public/js/cards/quellen-card.js` — Alpine-Sub-Komponente.
  - `public/partials/quellen.html` — Panel-Markup.
  - `public/css/entities/quellen.css` — Panel-Styles + Mobile.
  - `tests/unit/quellen-db.test.mjs`, `tests/unit/photo-prepare.test.mjs` (falls noch nicht aus `tagebuch-fotos` da).
  - `tests/integration/quellen.test.js`.
  - `tests/e2e/quellen.spec.js`.

## Offene Fragen

_Keine offenen Fragen — alle Forks entschieden (siehe Entscheidungs-Log unten). Status `Ready`._

**Entscheidungs-Log:**
- **Buch-weiter Scope:** im MVP gesperrt (API `400`), DB-Schema vorbereitet. Spätere Freigabe additiv (UI-Einstieg + API-Gate öffnen, keine Migration).
- **Scope-UX:** S1 kontextgetrieben (kein Header-Button, wie Ideen).
- **Add-UX:** A2 ein `[+ Quelle ▾]`-Menü.
- **Such-Index:** Titel **ja** (FTS5 + Palette-Kategorie „Anhänge", Prefix `&`); Notiz nein.
- **PDF-Auslieferung:** Download (`Content-Disposition: attachment`).
- **Max-Bytes:** konfigurierbar via App-Setting `quellen.max_bytes` (Admin-Tab), Default 10 MB, ein Wert für alle Typen (nicht typ-spezifisch).
- **Foto-Härtung:** `lib/photo-prepare.js`, geteilt mit `tagebuch-fotos.md` falls dort schon vorhanden.

**Minor (Implementierungs-Detail, kein Blocker):** finaler Palette-Prefix-Char (`&` vorgeschlagen) — falls `&` in einer Locale-Eingabe stört, Alternative `~`.
