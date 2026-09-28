'use strict';
// Schlagworte an Quellen der persoenlichen Bibliothek („zhaw", „cas-aitpm").
// Sie ordnen die Bibliothek quer zu den Buechern: dieselbe Quelle liegt in
// mehreren Arbeiten, das Schlagwort sagt, zu welchem Themenkreis sie gehoert —
// Grundlage fuer den Picker-Filter und den Verzeichnis-Export.
//
// Kein eigener Tag-Stamm: ein Schlagwort existiert, solange eine Quelle es
// traegt. Die Liste der Schlagworte eines Users ist die DISTINCT-Menge ueber
// seine Quellen — damit gibt es keinen verwaisten Tag und keine zweite
// Besitz-Spalte neben `sources.owner_email`.
//
// `COLLATE NOCASE` im Primaerschluessel: „ZHAW" und „zhaw" sind dasselbe
// Schlagwort und duerfen nicht zweimal an derselben Quelle haengen.

module.exports = {
  version: 293,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS source_tags (
        source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        tag        TEXT    NOT NULL COLLATE NOCASE,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (source_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_source_tags_tag ON source_tags(tag);
    `);
  },
};
