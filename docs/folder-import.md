# Folder-Import

Importiert Tagebuch-Archive mit Struktur `<YYYY>/<Monat>/<Tagesdatei>` aus ZIP. Erzeugt **ein Kapitel pro Jahr**, **eine Seite pro Tagesdatei** (Page-Name = ISO-Datum `YYYY-MM-DD`). Modi: `new-book` (Buch anlegen) oder `merge` (in bestehendes Buch importieren).

## Architektur

- **Route:** `POST /jobs/folder-import` ([routes/jobs/folder-import.js](../routes/jobs/folder-import.js)). Body = raw ZIP (`application/zip`, Limit 200 MB). Query: `mode`, `book_name` (new-book) / `book_id` (merge).
- **Buffer-Map:** ZIP landet in modulinterner `importBuffers`-Map (TTL 30 min), Worker konsumiert + cleart in `finally`.
- **Worker:** `runFolderImportJob` ist Job-Queue-konform (Pflicht: KI-Calls nur via Queue). Phasen via `updateJob({ statusText, statusParams })` als i18n-Keys (`job.folder-import.*`).
- **Parser:** [lib/import-parsers/](../lib/import-parsers/)
  - `docx.js` — `mammoth.convertToHtml`. Bilder droppen, Warnings sammeln.
  - `doc.js` — Legacy-Word (.doc, OLE) via `word-extractor`. Liefert Plain-Text → Absätze in `<p>` gewrappt. Formatting geht verloren (Trade-off für Pure-JS-Support).
  - `odt.js` — eigener Mini-Parser: ZIP-in-ZIP → `content.xml` via linkedom → Walker (h1-3, p, ul/ol, li, strong/em, br). Stil-Lookup via `office:automatic-styles` für fett/kursiv.
  - `abw.js` — AbiWord (.abw, reines XML). linkedom-Walker über `<section>/<p>/<c>`. Style-Lookup via `<styles>/<s>` für Heading-Level + Inline-Props (`font-weight:bold`, `font-style:italic`).
  - `dispatch.js` — Extension-Switch + `SUPPORTED_EXTS`-Set (`docx`, `doc`, `odt`, `abw`).
  - `date-detect.js` — Regel-basierte Datums-Heuristik. Zwei API-Layer:
    - `detectDate(filename, ctx)` — Filename + Pfad-Kontext (7 Patterns: `YYYY-MM-DD`, `DD-MM-YYYY`, `YYYYMMDD`, `DD-monthname`, `monthname-DD`, `DD-only`, `DD-anywhere`).
    - `detectDateInText(text, ctx)` — erste Text-Zeile des Dokuments. Eigene Regex-Tabelle ohne `_stripExt` (sonst frisst Extension-Strip das `.2024` am Ende einer Datumszeile). Verzichtet bewusst auf `DD-only`/`DD-anywhere` (eine einzelne Zahl in Text ist zu vieldeutig).
    - `firstLineFromHtml(html)` — erste nicht-leere Text-Zeile nach Tag-Strip.
    - `parseMonthToken(token)` — tokenize-tolerant: erkennt `November` in `November 2020`. Strikt: rein-numerische Strings → 1-12; gemischte Strings mit Zahlen → kein Monat (sonst Konflikt mit DD-anywhere-Pfad).
    - `scoreSample(samples)` für Filename-Confidence (Schwelle 80%).

### `DD-anywhere`-Fallback

Letzter Regel-Pfad bevor AI greift. Sucht im stripped Filename nach genau **einer** plausiblen Tageszahl (1-31). Aktiviert nur wenn `ctx.year` UND `ctx.month` aus dem Pfad-Kontext kommen.

Beispiele:
- `Tagebücher/2020/November 2020/Persönliches 16.docx` → `2020-11-16` ✓
- `Tagebücher/2020/November 2020/Datei 5 und 12.docx` → null (ambig: 5 oder 12?)
- `2020/November 2020/Notiz.docx` → null (keine Tageszahl)
- **AI-Fallback:** `buildDateDetectPrompt` ([public/js/prompts/import.js](../public/js/prompts/import.js)) wenn Filename-Confidence < 80%. Liefert ISO-Datum pro Datei, KI-Spend nur bei unklaren Formaten.

## Datums-Resolve-Reihenfolge (pro Datei)

1. **Filename** — `detectDate(filename, { year, month })` aus Pfad-Kontext
2. **Erste Dokumentzeile** — `detectDateInText(firstLineFromHtml(html))` (Parse passiert deshalb VOR der Datums-Sortierung, HTML wird zwischengespeichert)
3. **AI-Map** — falls Filename-Confidence < 80% war und AI-Pass aufgerufen wurde
4. **Skip** — `reason: 'NO_DATE'`

## Pflicht-Invarianten

- **Content-Store-Facade exklusiv** für Book/Chapter/Page-Create — HTML-Clean greift dort automatisch.
- **Job-Result `bookId`** für Frontend-Nav (lädt Buch + setzt Hash).
- **Kapitel-Cache by Year:** `chapterByYear`-Map verhindert Dubletten. Merge-Modus liest existierende Year-Chapters (Name = 4-stellige Zahl) und hängt an.
- **Sortierung chronologisch** vor Page-Create (sonst Position-Skew).
- **Duplikat-Daten:** Suffix `(2)` am Page-Name (z.B. zwei Files mit `2024-03-05`).
- **Datei-Limit 10 MB pro Datei**, ZIP-Limit 200 MB, Mac-Resource-Forks (`._*`, `__MACOSX/`, `.DS_Store`) gefiltert.

## Frontend

Karte [public/js/cards/folder-import-card.js](../public/js/cards/folder-import-card.js) + Partial [public/partials/folder-import.html](../public/partials/folder-import.html). Drop-Zone + File-Input. Job-Polling via `startPoll`. Hash-Permalink: `#import` (book-unabhängig, weil `new-book`-Modus kein Buch braucht).

## Skipped-Reasons

| Reason | Bedeutung |
|--------|-----------|
| `BAD_PATH` | Pfad matched nicht `YYYY/Monat/Datei` |
| `UNSUPPORTED_EXT` | Nicht `.docx` oder `.odt` |
| `NO_DATE` | Weder Regel noch AI konnten Datum ableiten |
| `FILE_TOO_LARGE` | > 10 MB pro Datei |
| `PARSE_FAILED` | mammoth/odt-Parser warf |
| `ZIP_READ_FAILED` | JSZip konnte Entry nicht entpacken |
| `CREATE_FAILED` | Content-Store-Page-Create warf |
