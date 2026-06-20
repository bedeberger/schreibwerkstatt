# Fassungen (Manuskript-Meilensteine)

Ganze-Buch-Schnappschüsse: der User friert den aktuellen Stand des **gesamten** Buchs per Knopfdruck als „Fassung 1/2/3…" ein, vergleicht zwei Fassungen miteinander und kann das Buch auf eine Fassung **zurücksetzen** (Restore). Pro Buch skopiert, user-initiiert, kein Pruning (Gegenstück zu `page_revisions`, die seitenweise + automatisch entstehen). Route: `#book/:bookId/fassungen`.

## Datenmodell

Eine Zeile pro Fassung in `book_snapshots` ([db/book-snapshots.js](../db/book-snapshots.js), Schema in [db/migrations.js](../db/migrations.js) / [db/squashed-schema.js](../db/squashed-schema.js), ERD in [docs/erd.md](erd.md)):

- `id` (PK), `book_id` (FK → `books(book_id)` ON DELETE CASCADE)
- `seq` — fortlaufende Fassungsnummer pro Buch (1-basiert, **monoton**; Löschungen recyceln keine Nummer, damit „Fassung 3" stabil bleibt). `_nextSeq` = `MAX(seq)+1`.
- `label`, `description` — optionaler Name + Notiz (geclippt auf 120 / 1000 Zeichen).
- `content_json` (NOT NULL) — **selbsttragende** Momentaufnahme im `buildBookJson`-Format `{ book: { name, description, settings }, tree: [node…] }` mit Seiten-HTML **inline**. Spiegelt den swbook-Export ([routes/book-migration.js](../routes/book-migration.js)), nur als DB-Zeile statt ZIP. Bleibt gültig, auch wenn Seiten später gelöscht werden. Jede Page trägt ihre `srcId` (alte page_id) mit — Diff matcht darüber.
- `extras_json` — `collectExtras(bookId, { analysis, lektorat })` (reiner DB-Read, kein KI-Call). Wird gespeichert, aber **nicht** an den Client geliefert und beim Restore aktuell **nicht** wiederhergestellt (best-effort für später).
- `chars` / `words` / `pages` / `chapters` — Kennzahlen, berechnet beim Erstellen aus dem inline-HTML (gleiche Normalisierung wie `page_stats` via `htmlToPlainText`). Kein retroaktives Update.
- `user_email`, `created_at` (ISO+Z).
- Index: `idx_book_snapshots_book (book_id, created_at DESC)`.

## Routen ([routes/snapshots.js](../routes/snapshots.js))

Alle book-scoped (`setContext({ book })`), ACL via `requireBookAccess`. Synchroner Pfad (reiner DB-Read/-Write, kein KI-/Netz-Call) — bewusste Ausnahme zur Job-Queue-Regel, analog zum Capture.

- `GET /snapshots/:bookId` (viewer) — Meta-Liste **ohne** `content_json`/`extras_json` (können MB groß sein), `has_extras` als Flag, DESC nach `created_at`.
- `GET /snapshots/:bookId/:id` (viewer) — Vollzeile inkl. geparstem `content` (ohne `extras_json`). Quelle für den Diff.
- `POST /snapshots/:bookId` (editor) — „Fassung speichern". Baut Payload via `_buildSnapshotPayload` (geteilt mit dem Restore-Backup) und legt eine Zeile an. `BOOK_EMPTY` → 400.
- `POST /snapshots/:bookId/:id/restore` (editor) — **destruktiv**, setzt das Buch auf die Ziel-Fassung zurück (siehe unten).
- `DELETE /snapshots/:bookId/:id` (editor).

## Restore-Pipeline

`POST /snapshots/:bookId/:id/restore` ersetzt den **gesamten** aktuellen Buchinhalt durch den Stand der Ziel-Fassung. Reihenfolge (Pflicht):

1. **Ziel planen** — `content_json` parsen → `validateBookJson` → `planFromNodes(tree)` (gleiche Op-Liste wie der Buch-Import). Defekt/leer → 422 `CORRUPT_SNAPSHOT`, bevor irgendetwas angefasst wird.
2. **Auto-Sicherung** — der aktuelle Stand wird via `_buildSnapshotPayload` als neue Fassung mit Label `__i18n:snapshots.autoBackupLabel__` abgelegt → **Restore ist umkehrbar**. `BOOK_EMPTY` (nichts zu sichern) ist ok; jeder andere Fehler → 500 `BACKUP_FAILED` **ohne** Wipe.
3. **Wipe** — alle Seiten **und** alle Kapitel explizit löschen, dann `bookOrder.clearOrder(bookId)`. **Warum explizit:** `pages.chapter_id` und `chapters.parent_chapter_id` sind `ON DELETE SET NULL` — ein gelöschtes Kapitel entfernt weder seine Seiten noch Sub-Kapitel. Das Order-Overlay muss weg, sonst zeigt es auf gelöschte IDs.
4. **Neu anlegen** — `plan.ops` über die Content-Store-Facade (`createChapter`/`createPage`) in Op-Reihenfolge; `tempId → echte chapter_id`-Map wie beim Buch-Import. Danach baut `ensureTree` die Reihenfolge frisch aus `position`/`priority` der neu angelegten Knoten (`buildFromCurrentState`).
5. **Settings** der Fassung übernehmen (best-effort, `saveBookSettings` + ggf. `setBookEntitiesEnabled`; `allow_lektor_book_chat` bleibt 0 — ACL-relevant, nicht Teil der Inhalts-Fassung).
6. **Stats-Sync** (`syncBook`).

**Invarianten / Konsequenzen:**
- Restore = „Buch-Import in dasselbe Buch" — teilt bewusst die geprüfte Pipeline aus [lib/book-bundle.js](../lib/book-bundle.js) ([routes/jobs/book-import.js](../routes/jobs/book-import.js)).
- Seiten bekommen **neue** `page_id`s → `page_revisions`, Seiten-Chats, `page_stats` der ersetzten Seiten kaskadieren weg. Inhärent bei einem Voll-Restore; die Auto-Sicherung fängt versehentliche Restores auf, nicht die Historie der ersetzten Seiten.
- Nicht-transaktional (wie der Buch-Import); Einzel-`createXxx`-Fehler werden geloggt, nicht geworfen. Die Auto-Sicherung ist die Absicherung gegen einen abgebrochenen Lauf.
- Interleaving (Top-Page zwischen zwei Top-Kapiteln) geht verloren — `treeToNodes` stellt Top-Pages voran. Dokumentierte Grenze des Bundle-Formats, für Fassungen unkritisch (Struktur + Inhalt bleiben vollständig).

## Frontend

[public/js/cards/snapshots-card.js](../public/js/cards/snapshots-card.js) (`Alpine.data('snapshotsCard')`) + [public/partials/snapshots.html](../public/partials/snapshots.html). `showSnapshotsCard` bleibt im Root (Hash-Router + Exklusivität), fachlicher State in der Sub-Komponente. Registry-Eintrag in [feature-registry.js](../public/js/cards/feature-registry.js) (`key: 'snapshots'`, `minRole: 'editor'`, `requiresPages: true`).

- **Speichern** — Name + Notiz (optional, `data-spellcheck`) → `captureSnapshot`.
- **Liste** — `entity-grid-table` (Standard-Tabellenklasse, sortierbar via `sortableTable`, `persistKey: 'book.snapshots'`). Numerik-Spalten rechtsbündig über `.snapshots-table .snapshots-num` (schlägt die linksbündige `entity-grid-table`-Default-Regel per Specificity). Autor-Chip nur bei geteilten Büchern.
- **Wiederherstellen** — `restoreSnapshot` mit `confirm`-Dialog; nach Erfolg `app.loadPages()` + Liste neu laden (Auto-Sicherung erscheint dort). `restoringId` sperrt die Zeile.
- **Löschen** — `deleteSnapshot` mit Bestätigung.
- **Vergleich** — zwei Comboboxen (Default: zweitneueste vs. neueste), Buch-Level-Diff via [book-snapshot-diff.js](../public/js/book-snapshot-diff.js) (`diffSnapshots`): Summen-Badges (hinzugefügt/entfernt/geändert/umbenannt/verschoben) + Zeichen-Delta, pro geänderter Seite lazy ein Wort-genauer Side-by-Side-Diff via [page-revision-diff.js](../public/js/page-revision-diff.js)#`renderSideBySide`.
- `__i18n:`-Label-Marker (z.B. Auto-Sicherung) werden in `fassungLabel` via `_resolveLabel` in der Locale des Betrachters aufgelöst.

CSS: [public/css/components/snapshots.css](../public/css/components/snapshots.css) (nur snapshot-spezifische Tweaks; Tabelle nutzt `entity-grid-table`, Diff-Zellen `revision-diff-*` aus `page/page-revision-viewer.css`). i18n-Keys: `snapshots.*` in [de.json](../public/js/i18n/de.json) / [en.json](../public/js/i18n/en.json).
