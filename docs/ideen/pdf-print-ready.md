# Druckfertiger PDF-Export (klassische Druckerei)

- **Status:** Draft <!-- Draft → Ready erst wenn „Offene Fragen" leer -->
- **Aufwand:** XL <!-- 4 Phasen; MVP (Phase 1+2) = L -->
- **Severity:** high <!-- Self-Publishing ist erklärtes Produkt-Ziel des Owners -->

## Context

Der Owner will eigene Bücher publizieren und druckt bei einer **klassischen Druckerei** (nicht KDP/BoD-Print-on-Demand). Der bestehende Custom-PDF-Export ([lib/pdf-render.js](../../lib/pdf-render.js) + Submodule, Profile in [db/pdf-export.js](../../db/pdf-export.js), Card [public/js/cards/pdf-export-card.js](../../public/js/cards/pdf-export-card.js)) erzeugt ein **PDF/A-2B in sRGB** mit Vollbild-Cover als erster Innenseite. Das ist archiv-tauglich und für eBook/PDF-Distribution gut, aber **keine Druckvorstufen-Datei**.

Eine klassische Druckerei verlangt typischerweise:

- exaktes Endformat + **3 mm Beschnitt (Bleed) umlaufend + Schnittmarken**
- **PDF/X-1a:2003 oder PDF/X-3** (Druckvorstufen-Standard) statt PDF/A
- **CMYK + Output-Intent-ICC** (z. B. PSO Coated v3 / ISO Coated v2) statt sRGB
- Body-Text in reinem Schwarz (K-only, kein Rich Black), Overprint
- Bilder ≥ 300 dpi
- **separates Umschlag-PDF**: Rückseite + Buchrücken (Rückenbreite aus Seitenzahl × Papiervolumen) + Vorderseite, mit Beschnitt
- Innenteil **ohne** Umschlag, Einzelseiten

Zusätzlich fehlen für ein publikationsreifes Buch Standard-Bestandteile, die der Owner explizit nannte: **ISBN**, eine **Kontext-/Motto-Frontmatter-Seite** und eine **„Über den Autor"-Seite**. Das Impressum steht aktuell zudem konventionswidrig am Buchende statt im Frontmatter.

**Prinzip-Treue:** Reine Layout-/Druckvorstufen-Funktion. Kein KI-Call, kein generativer Text — passt zur App-Philosophie „KI nur rückwärtsgewandt".

## Scope MVP

MVP = **Phase 1 (Content) + Phase 2 (Innenteil druckfertig)**. Beide liefern eigenständigen Wert, sind route-/druckerei-unabhängig und nicht durch die offene Druckerei-Spec blockiert. Phase 3 (Farbe/Norm) und Phase 4 (Umschlag) sind im Plan vollständig ausgearbeitet, aber Spec-gegated (siehe Offene Fragen) und werden erst nach Vorliegen der Druckerei-Vorgaben umgesetzt.

**Phase 1 — Content & Frontmatter** (alle als Felder in `config.extras`, kein neuer Renderpfad-Umbau):

- **ISBN-Feld** (`extras.isbn`): rendert auf der Impressum-Seite; optional zusätzlich als Zeile auf der Titelseiten-Rückseite.
- **„Über den Autor"-Seite** (`extras.authorBio` Text + optionales **Autorfoto** als BLOB analog Cover): eigene Backmatter-Seite, Foto links/oben, Bio-Text darunter. Autorname kommt weiterhin aus `book.created_by.name`.
- **Frontmatter-/Motto-Seite** (`extras.frontMatter`): freie Prosa-Seite (Motto, Epigraph, kurzes Vorwort) — gerendert **nach** Titelseite, **vor** Widmung/TOC.
- **Impressum-Position** (`extras.imprintPosition: 'front' | 'back'`, Default `front`): Frontmatter (Rückseite Titelseite) statt nur Buchende. Default-Wechsel auf `front` = deutsche Buchkonvention.
- **Strukturierte Copyright-Zeile** (`extras.copyright`): optionaler Auto-Baustein „© {year} {author}. Alle Rechte vorbehalten." mit ISBN, eingespeist in die Impressum-Seite; bestehender Freitext `extras.imprint` bleibt darunter.

**Phase 2 — Innenteil druckfertig** (neuer `config.print`-Block in [lib/pdf-export-defaults.js](../../lib/pdf-export-defaults.js)):

- **Beschnitt (Bleed)**: `print.bleedMm` (Default 0 = aus; 3 typisch). Seitengröße wird intern um `2×bleed` vergrössert; Inhalt im Trim-Bereich zentriert; randabfallende Elemente (Cover-Bild, Vollbild) ziehen in den Anschnitt.
- **Schnittmarken (Crop Marks)** + **TrimBox/BleedBox**: `print.cropMarks` (bool). Marken in den Anschnitt gezeichnet; `TrimBox` (Endformat) und `BleedBox` (Endformat + Bleed) ins Page-Dictionary geschrieben.
- **Trim-Size-Presets**: häufige Buchformate als Auswahl zusätzlich zu A4/A5/A6/Letter/custom (z. B. 12.5×20, 13.5×21.5, 14.8×21). Mapping auf bestehende `customWidthMm/customHeightMm`.
- **300-dpi-Bildwarnung**: beim Render via sharp-Metadaten effektive Auflösung jedes Bildes prüfen; Unterschreitung als nicht-fataler Warnhinweis im Job-Result (Liste der betroffenen Bilder).
- **K-only-Body**: `print.blackTextKOnly` (bool) — Body-Text-Farbe `#1a1a1a`/`#000000` auf reines K (CMYK `0,0,0,100`) statt 4C-Komposit-Schwarz. Greift erst zusammen mit CMYK-Konvertierung (Phase 3), als Flag aber hier schon eingeführt.

## Out-of-Scope

**Phase 3 — Farbe & Norm** (im Plan ausgearbeitet, Umsetzung Spec-gegated):

- **PDF/X-Export** via Ghostscript-Post-Step (`gs -dPDFX` + PDFX-def + ICC), neuer `lib/pdfx-convert.js` nach dem Muster von [lib/pdfa-validate.js](../../lib/pdfa-validate.js) (externes CLI, env-gated, non-fatal).
- **CMYK-Konvertierung** mit gebündeltem Output-Intent-ICC (Profil-Wahl Spec-abhängig).
- **Norm-Toggle** im bisherigen PDF/A-Tab: `pdfa.standard: 'pdfa' | 'pdfx' | 'none'`.

**Phase 4 — Umschlag-PDF** (im Plan ausgearbeitet, Umsetzung Spec-gegated):

- Separates Cover-PDF (Rückseite + Rücken + Vorderseite als ein Bogen), Rückenbreite = Seitenzahl × Papiervolumen, Beschnitt + Schnittmarken, Klappentext/Barcode-Platz.
- Eigener Job-Target (`target: 'cover'`).

**Dauerhaft ausgeschlossen:**

- Vollwertiges Color-Management mehrerer ICC-Profile / Soft-Proofing — genau **ein** Druckerei-Profil wird gebündelt/konfiguriert.
- Ausschießen/Imposition (Bogenmontage) — macht die Druckerei.
- Hardcover-Schutzumschlag mit Klappen, Prägung, Sonderfarben (Pantone/HKS), Lack.
- EAN-13-Barcode-**Generierung** (Druckerei/ISBN-Agentur liefert die Barcode-Grafik; im Cover-PDF wird nur Platz reserviert).
- Automatische ISBN-Vergabe/-Registrierung.

## Done when

**MVP (Phase 1+2):**

- ISBN, Autoren-Bio (+ Foto), Frontmatter-/Motto-Seite sind im Profil konfigurierbar und erscheinen an der korrekten Position im PDF.
- Impressum erscheint standardmässig im Frontmatter (Rückseite Titelseite); Position auf „hinten" umstellbar; Verhalten überlebt Reload.
- Copyright-Zeile wird aus Autor/Jahr/ISBN gebaut und auf der Impressum-Seite ausgegeben.
- Bei `print.bleedMm > 0`: erzeugte PDF-Seiten haben Endformat + 2×Bleed als MediaBox, korrekte `TrimBox` (Endformat) und `BleedBox`; Cover-Bild läuft in den Anschnitt.
- Bei `print.cropMarks`: Schnittmarken an den vier Ecken im Anschnitt sichtbar, ausserhalb der TrimBox.
- Trim-Presets wählbar; Auswahl mappt auf korrekte mm-Masse.
- Bilder < 300 dpi → Warnliste im Job-Result; Render bricht **nicht** ab.
- Bestehende Profile ohne neue Keys rendern unverändert (Defaults = aus/leer).
- `npm test` grün (inkl. neuer Unit-Tests, squash-drift, erd-drift).

**Phase 3 (separat abnehmbar):**

- PDF/X-3-Export erzeugt validierbare Datei (CMYK + Output-Intent); fehlt Ghostscript → Fallback auf PDF/A oder unmarkiertes PDF + Warnung (non-fatal).

**Phase 4 (separat abnehmbar):**

- Umschlag-PDF mit korrekt berechneter Rückenbreite, Beschnitt, Schnittmarken; Innenteil-Export enthält dann kein Cover.

## Hard-Rule-Audit

- **Editor-Spezifikation:** unberührt — kein Editor-Pfad. Reines Export-Feature.
- **UI-Patterns aus DESIGN.md:** neue Felder leben in bestehenden Tabs der `pdfExportCard`. Neuer Tab „Autor" + „Druck" (Print) nach bestehendem Tab-Pattern. Kein neues Komponenten-Pattern; Foto-Upload reused das Cover-Upload-Pattern. Vor Bau prüfen, ob „Bild-Upload mit Vorschau + Entfernen" als Pattern in DESIGN.md steht — sonst dort ergänzen.
- **Styles nur in `public/css/`:** neue Tab-/Feld-Styles in bestehende `public/css/`-Datei des PDF-Export-Cards (kein Inline-`style`). Falls eigene Datei nötig → in [public/index.html](../../public/index.html) verlinken + `SHELL_CACHE` bumpen + DESIGN.md CSS-Inventar.
- **UI-Strings nur in i18n:** alle neuen Labels/Hints/Tab-Namen/Warntexte unter Prefix `pdfExport.*` in **beiden** Locale-Dateien ([public/js/i18n/de.json](../../public/js/i18n/de.json) + en.json). Job-Status (`job.phase.convertPdfx`, Warn-Texte) als Key + `statusParams`.
- **KI-Calls nur via Job-Queue / `callAI` JSON:** **n/a** — kein KI-Call. Render läuft bereits im bestehenden `pdf-export`-Job ([routes/jobs/pdf-export.js](../../routes/jobs/pdf-export.js)).
- **Content-Store-Facade:** Buchinhalte werden weiter via `loadContents` geladen (nutzt die Facade). Kein direkter SQL-Zugriff auf pages/chapters/books. Profil-/Foto-Persistenz läuft über [db/pdf-export.js](../../db/pdf-export.js) (Profil-Domäne, nicht Buchinhalt) — zulässig.
- **DB-Integrität / Timestamps:** Phase 1 fügt `author_image`/`author_image_mime` als BLOB-Spalten auf `pdf_export_profile` hinzu (additiv, kein FK nötig — Spalten auf bestehender Tabelle). Migration mit `foreign_key_check`, `UPDATE schema_version`, danach `npm run squash:regen` + [docs/erd.md](../erd.md) im selben Commit. **Hinweis:** Diese Tabelle speichert `created_at/updated_at` bereits als Epoch-ms-Integer (`Date.now()`), nicht ISO+Z — bestehende Abweichung; neue Spalten sind BLOBs ohne Timestamp, Regel `NOW_ISO_SQL` nicht berührt. ISBN/Bio-Text/Frontmatter/Impressum-Position/Copyright sind reine `config_json`-Felder → kein Schema-Change.
- **x-html-Escape:** neue Felder (ISBN, Bio, Frontmatter, Copyright) werden im PDF gerendert (kein DOM). In der Card via `x-model`/`x-text` — kein neuer `x-html`-Sink.
- **Combobox statt `<select>`:** Trim-Preset-Auswahl + Impressum-Position + Norm-Standard via `combobox`. ISBN/Jahr-Felder bleiben Text (ISBN ist keine reine Zahl → kein `numInput`). Bleed-mm via `numInput` (Zahl).
- **LanguageTool auf Prosatextfeldern:** Bio-Text + Frontmatter/Motto + Copyright-Freitext bekommen `data-spellcheck="spelling"`. ISBN-Feld: **Ausnahme** (technische ID, kein Prosa).
- **`numInput`:** Bleed-mm, Trim-custom-Masse, Papiervolumen (Phase 4) via `numInput` (Swiss-Locale-konform: `.`-Decimal, `’`-Tausender).
- **SHELL_CACHE bumpen:** bei JS/CSS-Änderung Konstante in [public/sw.js](../../public/sw.js) hoch.
- **Eckige Badges / Icons sparsam / Doppelpunkt-Separator:** Standard-Disziplin beim Bau (Badges eckig `--radius-sm`, Icons nur auf Wunsch).
- **Logging-Context:** Render-Job setzt `book` bereits ([routes/jobs/pdf-export.js](../../routes/jobs/pdf-export.js) `setContext`). Phase-3-CLI-Logs deutsch (Winston-Ausnahme).
- **Card-Animationen, Ein-Attribut-eine-Deklaration, Selektor-Unique, Mobile-Strategie:** beim Bau einhalten.

## Abhängigkeiten

- Bestehender PDF-Export: [lib/pdf-render.js](../../lib/pdf-render.js) + [lib/pdf-render/](../../lib/pdf-render/) (index/pages/chrome/layout/blocks/images), [lib/pdf-export-defaults.js](../../lib/pdf-export-defaults.js), [routes/jobs/pdf-export.js](../../routes/jobs/pdf-export.js), [routes/pdf-export.js](../../routes/pdf-export.js), [db/pdf-export.js](../../db/pdf-export.js), [public/js/cards/pdf-export-card.js](../../public/js/cards/pdf-export-card.js).
- `sharp` (Bild-Normalisierung; Autorfoto + CMYK-Bildkonvertierung) — bereits Pflicht-Dep, siehe [lib/cover-prepare.js](../../lib/cover-prepare.js).
- **Phase 3:** Ghostscript als neue Ops-Dependency (CLI, env-gated wie veraPDF). CMYK-Output-Intent-ICC (Lizenz/Profil siehe Offene Fragen).
- `Alpine.data('combobox')` / `Alpine.data('numInput')` — bestehend.
- LanguageTool-Dispatcher ([public/js/cards/editor-spellcheck/dispatch.js](../../public/js/cards/editor-spellcheck/dispatch.js)).

## Backend

**Phase 1 — Profil-Felder + Frontmatter-Render**

- [lib/pdf-export-defaults.js](../../lib/pdf-export-defaults.js): `extras` erweitern um `isbn` (str ≤ 20), `authorBio` (str ≤ 4000), `frontMatter` (str ≤ 4000), `imprintPosition` (enum `front`/`back`, Default `front`), `copyright` (str ≤ 500). Validatoren in `_validateExtras`. Font-Rollen `authorBio` + `frontMatter` (analog `dedication`/`imprint`) in `DEFAULT_CONFIG.font` + `_validateFont`.
- [lib/pdf-render/pages.js](../../lib/pdf-render/pages.js): neue Renderer `_renderFrontMatterPage(doc, config)` (nach Titelseite), `_renderAuthorPage(doc, config, authorImageBuf)` (Backmatter). `_renderImprintPage` um Copyright-Zeile + ISBN ergänzen.
- [lib/pdf-render/index.js](../../lib/pdf-render/index.js): Render-Reihenfolge anpassen — Cover → Titelseite → **Frontmatter** → **Impressum (wenn `front`)** → Widmung → TOC → Body → **Autor-Seite** → **Impressum (wenn `back`)**. Autorfoto-Buffer wie Cover-Buffer durchreichen.
- [db/pdf-export.js](../../db/pdf-export.js): `setAuthorImage`/`clearAuthorImage`/`getAuthorImage` + `has_author_image` in `_SELECT_COLS`/`_row`.
- [routes/pdf-export.js](../../routes/pdf-export.js): Endpunkte `POST/DELETE/GET /profiles/:id/author-image` analog zu `/cover` (raw body, `prepareCover`-Wiederverwendung bzw. `prepareAuthorPhoto`).
- [routes/jobs/pdf-export.js](../../routes/jobs/pdf-export.js): Autorfoto-Buffer laden (wie `coverBuf`) und an `renderPdfBuffer` übergeben.

**Phase 2 — Bleed/Crop/Trim**

- [lib/pdf-export-defaults.js](../../lib/pdf-export-defaults.js): neuer `print`-Block: `bleedMm` (num 0–10), `cropMarks` (bool), `trimPreset` (enum), `blackTextKOnly` (bool), `dpiWarnThreshold` (num, Default 300). Validator `_validatePrint`.
- [lib/pdf-render/layout.js](../../lib/pdf-render/layout.js): `_pageSize` liefert bei `bleedMm>0` Endformat + 2×Bleed; neue Helfer `trimBox()`/`bleedBox()` (pt-Rechtecke).
- [lib/pdf-render/index.js](../../lib/pdf-render/index.js): nach `addPage` `TrimBox`/`BleedBox` ins `doc.page.dictionary` schreiben; Crop-Marks-Pass im Anschnitt (eigener `_drawCropMarks`); Body-Origin um Bleed-Offset verschieben.
- [lib/pdf-render/images.js](../../lib/pdf-render/images.js): effektive dpi je Bild aus sharp-Metadaten + Render-Breite berechnen; Unterschreitungen in `renderCtx.dpiWarnings[]` sammeln. Job-Result um `dpiWarnings` ergänzen.

**Phase 3 — PDF/X + CMYK** (neu, Spec-gegated)

- `lib/pdfx-convert.js`: `convertToPdfX(buffer, { iccPath, flavour })` → ruft Ghostscript via `execFile` (kein Shell), Temp-Datei mit `.pdf`-Ext, PDFX-def-Datei, CMYK-Device, OutputIntent-ICC. env `GS_BIN`, `GS_DISABLED`. Bei fehlendem Binary `{ available:false }`, Job liefert PDF/A-Fallback + Warnung (non-fatal — exakt das Muster von [lib/pdfa-validate.js](../../lib/pdfa-validate.js)).
- [routes/jobs/pdf-export.js](../../routes/jobs/pdf-export.js): nach `renderPdfBuffer`, wenn `pdfa.standard==='pdfx'`, Post-Step `convertToPdfX`; Result-Metadaten um `pdfx`-Status.

**Phase 4 — Umschlag** (neu, Spec-gegated)

- `lib/pdf-cover-render.js`: rendert ein Bogen-PDF (Breite = 2×Front + Rücken + 2×Bleed). Rückenbreite aus `coverSpec.paperBulkMmPer1000 × pageCount/1000`. Eingangsbilder Front/Back via sharp.
- [routes/jobs/pdf-export.js](../../routes/jobs/pdf-export.js): `target: 'interior' | 'cover'` im POST-Body; bei `cover` → `pdf-cover-render`, Innenteil-Render unterdrückt dann das Cover.

## Frontend

`pdfExportCard` ([public/js/cards/pdf-export-card.js](../../public/js/cards/pdf-export-card.js)) — bestehende Tab-Struktur (Layout/Schrift/Kapitel/Cover/TOC/Extras/PDF-A).

- **Phase 1:** Tab „Extras" erweitern (ISBN, Frontmatter/Motto-Textarea, Copyright, Impressum-Position-Combobox) + neuer Tab **„Autor"** (Bio-Textarea + Foto-Upload/Vorschau/Entfernen, reused vom Cover-Upload-Flow). Prosa-Textareas mit `data-spellcheck="spelling"`.
- **Phase 2:** neuer Tab **„Druck"** (Bleed-`numInput`, Crop-Marks-Toggle, Trim-Preset-Combobox, K-only-Toggle, dpi-Warnschwelle). dpi-Warnungen aus Job-Result als nicht-blockierende Hinweis-Liste nach Render.
- **Phase 3:** PDF-A-Tab → „Norm"-Tab mit Standard-Combobox (PDF/A / PDF/X / kein); ICC-Hinweis.
- **Phase 4:** Cover-Tab um „Separates Umschlag-PDF" erweitern (Front/Back-Bilder, Papiervolumen-`numInput`, Render-Target-Schalter, Rückenbreiten-Anzeige live).

Keine neue Karte/kein neuer Hash-Router-Branch nötig — Feature lebt vollständig in der bestehenden `pdfExportCard`. Render-Trigger unverändert über `/jobs/pdf-export` (nur Body um `target` erweitert in Phase 4).

## CSS

Tab-Inhalte + Foto-Upload-Vorschau in der bestehenden PDF-Export-Card-CSS-Datei (kein Inline-`style`). Foto-Vorschau analog Cover-Vorschau. Falls Umfang eine eigene Datei rechtfertigt → Subfolder-Split nach File-Limit-Regel, `<link>` in index.html, `SHELL_CACHE` bump, DESIGN.md-Inventar. Akzentfarbe erbt `--card-accent` der PDF-Export-Karte; keine neuen Tokens.

## i18n

Neuer Key-Bereich unter `pdfExport.*` in [de.json](../../public/js/i18n/de.json) + [en.json](../../public/js/i18n/en.json):

- `pdfExport.extras.isbn`, `.frontMatter`, `.copyright`, `.imprintPosition` (+ `.front`/`.back`)
- `pdfExport.author.*` (Tab-Titel, Bio-Label, Foto-Upload/Entfernen/Vorschau)
- `pdfExport.print.*` (Tab-Titel, Bleed, cropMarks, trimPreset + Preset-Labels, blackTextKOnly, dpiWarn)
- `pdfExport.norm.*` (Standard-Labels PDF/A / PDF/X / kein) — Phase 3
- `pdfExport.cover.spine`, `.paperBulk`, `.renderTarget` — Phase 4
- Job-Phasen/Warnungen: `job.phase.convertPdfx`, `job.warn.lowDpi`, `job.warn.coverInInterior`

de = Fallback, en = Übersetzung, beide im selben Commit.

## DB

**Phase 1:** Migration `N` ([db/migrations.js](../../db/migrations.js)) — additiv:

```sql
ALTER TABLE pdf_export_profile ADD COLUMN author_image BLOB;
ALTER TABLE pdf_export_profile ADD COLUMN author_image_mime TEXT;
```

Kein FK (Spalten auf bestehender Tabelle), kein Index (BLOB). Migration endet mit `foreign_key_check` + `UPDATE schema_version SET version = N`. Danach **`npm run squash:regen`** + [docs/erd.md](../erd.md) Stand-Zeile + `pdf_export_profile`-Block aktualisieren (Drift-Tests [squash-drift](../../tests/unit/squash-drift.test.mjs) / [erd-drift](../../tests/unit/erd-drift.test.mjs)).

Alle übrigen neuen Felder (ISBN, Bio-Text, Frontmatter, Copyright, Impressum-Position, gesamter `print`-/`cover`-Spec-Block) leben in `config_json` → **kein** Schema-Change.

Phase 2–4: keine DB-Änderung.

## Security

- **Autorfoto-Upload:** identische Härtung wie Cover ([lib/cover-prepare.js](../../lib/cover-prepare.js)) — Magic-Bytes-Check, `sharp` mit `failOn:'error'`, Grössen-/Pixel-Limits, Re-Encode zu JPEG. Profil-Ownership-Guard (`_ownedOr404`) wie bei `/cover`.
- **Ghostscript-Shell-out (Phase 3):** `execFile` ohne Shell, nur env-konfiguriertes Binary, Buffer in Temp-Datei (kein stdin-Pfad-Injection), Cleanup im `finally`, Timeout. Kein User-String fliesst in die Kommandozeile. `GS_DISABLED`-Kill-Switch.
- **PII:** Bio + Foto sind User-Inhalt, bleiben in der Profil-BLOB/Config, gehen an keinen externen Dienst. Export bleibt `viewer`-Scope (bestehend).
- **PDF-Inhalt:** keine `x-html`-Sinks; Felder werden in pdfkit gezeichnet, nicht ins DOM interpoliert.

## Telemetrie

Optional, Phase 2+: leichter Counter `print_export_total{standard,bleed}` und (Phase 3) `pdfx_convert{result=ok|fallback|missing}` analog `merge_telemetry`, exponiert via [/metrics](../metrics-api.md). MVP: `n/a` (Job-Logs reichen zunächst).

## Reversibilität

- Alle neuen Config-Keys defaulten auf **aus/leer** (`validateConfig`-Defaults) → bestehende Profile + Default-Verhalten unverändert. Feature ist rein additiv-konfigurativ, kein globaler Flag nötig.
- Phase 3 Ghostscript-Step ist skip-fähig (`GS_DISABLED` / fehlendes Binary → PDF/A-Fallback, non-fatal) — exakt wie veraPDF heute.
- DB-Rückbau: BLOB-Spalten sind nullable und werden bei ausgeschalteter Autor-Seite ignoriert; ein Drop wäre über Recreate-Migration möglich, aber nicht nötig.
- Frontend-Rückbau: Tabs/Felder entfernen; Config-Keys bleiben tolerant (validateConfig verwirft Unbekanntes).

## Tests

- **Unit** [tests/unit/pdf-export-defaults.test.js](../../tests/unit/pdf-export-defaults.test.js): neue `extras`/`print`-Felder — Defaults, Clamps, Enum-Whitelisting, unbekannte Keys verworfen.
- **Unit** [tests/unit/pdf-render.test.mjs](../../tests/unit/pdf-render.test.mjs): Frontmatter-/Autor-/Impressum-Seite erscheinen an korrekter Position; ISBN/Copyright im Output; `imprintPosition=front` vs `back`. Bleed: MediaBox = Trim+2×Bleed, `TrimBox`/`BleedBox` im Page-Dict gesetzt; Crop-Marks vorhanden. dpi-Warnung bei kleinem Bild.
- **Unit** (Phase 3): `lib/pdfx-convert` mit gemocktem/fehlendem `gs` → Fallback-Pfad ohne Crash.
- **Unit:** [squash-drift](../../tests/unit/squash-drift.test.mjs) + [erd-drift](../../tests/unit/erd-drift.test.mjs) nach Migration grün.
- **E2E** [tests/e2e/pdf-export.spec.js](../../tests/e2e/pdf-export.spec.js): neue Tabs sichtbar, Autorfoto-Upload + Entfernen, Print-Tab-Felder persistieren über Profil-Save/Reload.
- `npm test` vor Commit (UI-/Export-Berührung).

## Edge-Cases

- **Bio/Frontmatter leer** → Seite wird übersprungen (wie heute Widmung/Impressum).
- **Cover aktiviert im Druck-Modus** → Hinweis: Innen-Cover gehört nicht in den druckfertigen Innenteil; in Phase 4 separates Umschlag-PDF nutzen. MVP: Warnung im Job-Result, Render trotzdem.
- **Bleed + Mirror-Margins + Recto-Frontmatter** → Bleed-Offset und Mirror-Spiegelung dürfen sich nicht doppeln; Bleed verschiebt MediaBox/Origin, Mirror tauscht nur Margins → orthogonal, aber Test-Abdeckung nötig.
- **Trim + Bleed über Max-Seitenmass** → `_num`-Clamp greift; sehr grosse custommasse + Bleed begrenzen.
- **Bild bereits CMYK** (Phase 3) → sharp-Konvertierung idempotent halten; keine Doppel-Konvertierung.
- **Ghostscript fehlt** (Phase 3) → non-fatal, PDF/A-Fallback + klare Warnung.
- **Rückenbreite ohne Papiervolumen** (Phase 4) → Pflichtfeld; ohne Wert kein Cover-Render, klare Fehlermeldung.
- **ISBN-Format** → siehe Offene Fragen (Prüfziffer-Validierung ja/nein).
- **Viele Bilder + dpi-Check** → Performance: dpi nur aus bereits geladenen sharp-Metadaten ableiten, kein zweiter Decode.

## Kritische Dateien

- **Modify:**
  - [lib/pdf-export-defaults.js](../../lib/pdf-export-defaults.js) (extras + print-Block + Font-Rollen + Validatoren)
  - [lib/pdf-render/index.js](../../lib/pdf-render/index.js) (Render-Reihenfolge, Bleed/Trim/Crop, Autorfoto-Durchreichung)
  - [lib/pdf-render/pages.js](../../lib/pdf-render/pages.js) (Frontmatter-, Autor-, erweiterte Impressum-Seite)
  - [lib/pdf-render/layout.js](../../lib/pdf-render/layout.js) (Bleed-Seitengrösse, Trim/Bleed-Box)
  - [lib/pdf-render/images.js](../../lib/pdf-render/images.js) (dpi-Check)
  - [lib/pdf-render/chrome.js](../../lib/pdf-render/chrome.js) (Header/Footer-Origin bei Bleed)
  - [db/pdf-export.js](../../db/pdf-export.js) (Autorfoto-CRUD + SELECT-Cols)
  - [db/migrations.js](../../db/migrations.js) + [db/squashed-schema.js](../../db/squashed-schema.js) (regen) + [docs/erd.md](../erd.md)
  - [routes/pdf-export.js](../../routes/pdf-export.js) (Autorfoto-Endpunkte)
  - [routes/jobs/pdf-export.js](../../routes/jobs/pdf-export.js) (Autorfoto laden, Phase-3-Post-Step, Phase-4-Target)
  - [public/js/cards/pdf-export-card.js](../../public/js/cards/pdf-export-card.js) (Tabs Autor/Druck/Norm, Felder)
  - [public/js/i18n/de.json](../../public/js/i18n/de.json) + [en.json](../../public/js/i18n/en.json)
  - PDF-Export-Card-CSS in [public/css/](../../public/css/) + [public/sw.js](../../public/sw.js) (SHELL_CACHE)
  - [tests/unit/pdf-export-defaults.test.js](../../tests/unit/pdf-export-defaults.test.js), [tests/unit/pdf-render.test.mjs](../../tests/unit/pdf-render.test.mjs), [tests/e2e/pdf-export.spec.js](../../tests/e2e/pdf-export.spec.js)
  - [lib/cover-prepare.js](../../lib/cover-prepare.js) (ggf. `prepareAuthorPhoto`-Variante / CMYK-Option)
- **Create:**
  - `lib/pdfx-convert.js` (Phase 3)
  - `lib/pdf-cover-render.js` (Phase 4)
  - Bundle: CMYK-Output-Intent-ICC + PDFX-def-Vorlage (Phase 3)
  - ggf. eigene CSS-Datei für Print-Tab (bei Überschreitung File-Limit)

## Offene Fragen

> Muss vor Status `Ready` leer sein. **Blocker für Phase 2–4 ist primär die Druckerei-Spec.**

1. **Druckerei-Spec einholen** (entscheidet Phase 2–4 direkt): Endformat + Beschnitt-mm (3 vs 5)? PDF/X-Version (X-1a CMYK-only vs X-3 RGB+ICC erlaubt)? Welches Output-Intent-Profil (ISO Coated v2 / PSO Coated v3 / FOGRA-Nr.)? Schnittmarken erwünscht oder störend? Umschlag separat oder als Spread? Wird das Papiervolumen für die Rückenbreite von der Druckerei vorgegeben?
2. **CMYK zwingend?** Falls die Druckerei PDF/X-3 mit RGB+Profil akzeptiert und selbst separiert, entfällt der CMYK-Konvertierungsteil von Phase 3 (deutlich kleiner). Klären.
3. **ICC-Lizenz:** Darf das gewählte Output-Intent-Profil mit der self-hosted-OSS-App gebündelt/redistribuiert werden? Falls nein → Profil per ENV/Pfad konfigurierbar, nicht im Repo.
4. **Ghostscript als Ops-Dependency** akzeptabel (Container-Grösse, Wartung)? Alternative: nur PDF/A liefern + Hinweis „Konvertierung extern".
5. **ISBN-Prüfziffer** validieren (ISBN-13-Checksum) oder Freitext belassen?
6. **Autorfoto für Druck** automatisch in Graustufen/CMYK wandeln, oder dem User überlassen?
7. **MVP-Schnitt bestätigen:** Phase 1+2 zuerst bauen (route-unabhängig), Phase 3+4 nach Spec — oder direkt auf eine konkrete Druckerei hin alles in einem Zug?
