---
description: Neue DB-Migration anlegen (if-version-Block + FK-Integrität + squash:regen + erd.md)
argument-hint: "[kurze Beschreibung der Schema-Änderung]"
allowed-tools: Read, Edit, Grep, Bash(npm run squash:regen), Bash(node tools/regen-squashed.js), Bash(FORCE_LEGACY_MIGRATIONS=1 npm run squash:regen), Bash(npm run test:unit), Bash(git status:*), Bash(git diff:*)
---

Du legst eine neue DB-Migration an. Schema-Änderung laut User: **$ARGUMENTS**

Der Workflow folgt der CLAUDE.md-Sektion „Migration hinzufügen" + „Relationale Integrität (Pflicht)". Migrationen sind **`if (version < N)`-Blöcke in [db/migrations.js](db/migrations.js)** (KEINE nummerierten Dateien).

## 1. Vorbereitung

1. [db/migrations.js](db/migrations.js) lesen. Die höchste vorhandene `if (version < N)`-Nummer finden → neue Migration ist **N = höchste + 1**.
2. Vor neuen Tabellen/Kanten [docs/erd.md](docs/erd.md) prüfen: gibt es ein wiederverwendbares Bridge-Pattern / eine FK-Konvention / ON-DELETE-Strategie? Nicht parallel neu erfinden.
3. Wenn unklar, welche Tabellen/Spalten/FKs gemeint sind: **nachfragen, nicht raten.**

## 2. Migration schreiben

Neuen `if (version < N)`-Block ans Ende der Migrationskette in `runMigrations()` einfügen. Pflicht-Invarianten:

- **Jede neue Tabelle als `CREATE TABLE IF NOT EXISTS`** mit echten FKs — lose `*_id`-Spalten ohne `REFERENCES` sind verboten. Refs auf `books(book_id)`, `pages(page_id)`, `chapters(chapter_id)`, `figures(id)` etc. (siehe „Relationale Integrität").
- **Index auf jede neue FK-Spalte** (`CREATE INDEX idx_xx_yy ON …`).
- **ON DELETE bewusst wählen:** `CASCADE` für Caches/Aggregationen, `SET NULL` für user-kuratierte Daten.
- **Keine Snapshot-Spalten** (`page_name`, `chapter_name`, `book_name`, …) — Display-Werte zur Lesezeit per JOIN. Ausnahme nur bei nullbarem FK, wenn KI keine ID liefern konnte.
- **Timestamp-Defaults:** `TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`. **Niemals** `datetime('now')` in Defaults oder INSERT/UPDATE.
- **Sentinel-frei:** Diskriminator via `kind TEXT NOT NULL CHECK(...)` + NULL-Refs + CHECK, nicht `page_id=0`.

**Block-Ende ist Pflicht:**
```js
const fkErrors = db.pragma('foreign_key_check');
if (fkErrors.length) throw new Error(`Migration N: foreign_key_check meldet ${fkErrors.length} Verstoesse.`);
db.prepare('UPDATE schema_version SET version = N').run();
```

**FK auf bestehende Tabelle nachrüsten?** SQLite kann kein `ALTER TABLE ADD CONSTRAINT` → Recreate-Pattern (foreign_keys OFF → Pre-Cleanup Orphans → `xxx_new` mit finalen FKs+Indexen → `INSERT SELECT` → DROP/RENAME → Indexe neu → foreign_keys ON → check). Details in CLAUDE.md.

## 3. Squashed-Schema regenerieren (Pflicht)

- Normale Migration: `npm run squash:regen`
- Enthält die Migration ein **Recreate-Pattern**: `FORCE_LEGACY_MIGRATIONS=1 npm run squash:regen`

Das aktualisiert [db/squashed-schema.js](db/squashed-schema.js) (inkl. `SQUASHED_VERSION`). Ohne das wird `squash-drift.test` in CI rot.

## 4. docs/erd.md aktualisieren (Pflicht, selber Commit)

- Stand-Zeile bumpen: **Schema-Version + Tabellen-Anzahl**.
- Neue Tabelle → Mermaid-Block + FK-Kanten in Section 1 (Übersicht) + passendes thematisches Sub-Diagramm.
- Neue FK-Kante auf bestehende Tabelle → Kante in Section 1 nachziehen.
- Geänderte Spalten/Typen → Block-Definition anpassen.

Ohne das wird `erd-drift.test` rot (prüft Stand-Zeile + Set-Gleichheit der Blocks gegen `sqlite_master`).

## 5. Verifizieren

`npm run test:unit` laufen lassen — deckt `squash-drift` + `erd-drift` + `loc-limits` ab. Grün = fertig.

## Abschluss

Knapp melden: neue Version N, angelegte Tabelle(n)/Spalte(n)/FK(s), ON-DELETE-Wahl, ob squash:regen (ggf. mit FORCE_LEGACY) lief, erd.md-Stand, Testergebnis. Bei Fehlschlag eines Schritts **stoppen** und Stand berichten. **Nicht** committen (überlasse das dem User bzw. `/release`).
