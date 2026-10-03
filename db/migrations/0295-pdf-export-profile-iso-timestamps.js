'use strict';
// pdf_export_profile: created_at/updated_at von Epoch-Millisekunden (INTEGER)
// auf ISO-8601 mit Z-Suffix (TEXT) — wie jede andere `*_at`-Spalte (db/CLAUDE.md,
// „DB-Timestamps: ISO+Z via NOW_ISO_SQL").
//
// Recreate-Pattern, weil SQLite den Spaltentyp nicht per ALTER aendert. Bestand
// wird konvertiert: Ganzzahlen gelten als Millisekunden seit Epoch; ein schon
// textueller Wert bleibt unveraendert (defensiv, falls ein Schreibpfad bereits
// ISO lieferte). `id` wird uebernommen.

const COLS = [
  'id', 'book_id', 'kind', 'user_email', 'name', 'config_json',
  'cover_image', 'cover_mime', 'is_default',
  'author_image', 'author_image_mime', 'back_cover_image', 'back_cover_image_mime',
  'spine_image', 'spine_image_mime',
].join(', ');

const toIso = (col) => `CASE
      WHEN typeof(${col}) IN ('integer','real') THEN strftime('%Y-%m-%dT%H:%M:%fZ', ${col} / 1000.0, 'unixepoch')
      WHEN ${col} IS NULL OR ${col} = '' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ELSE ${col}
    END`;

module.exports = {
  version: 295,
  fkOff: true,
  up(db) {
    db.exec('DROP TABLE IF EXISTS pdf_export_profile_new');
    db.exec(`CREATE TABLE pdf_export_profile_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER REFERENCES books(book_id) ON DELETE CASCADE,
        kind        TEXT    NOT NULL DEFAULT 'book' CHECK(kind IN ('book','user_default')),
        user_email  TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        config_json TEXT    NOT NULL,
        cover_image BLOB,
        cover_mime  TEXT,
        is_default  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        author_image          BLOB,
        author_image_mime     TEXT,
        back_cover_image      BLOB,
        back_cover_image_mime TEXT,
        spine_image           BLOB,
        spine_image_mime      TEXT,
        CHECK ((kind = 'book' AND book_id IS NOT NULL)
            OR (kind = 'user_default' AND book_id IS NULL)),
        FOREIGN KEY (user_email) REFERENCES app_users(email) ON DELETE CASCADE
      )`);
    db.exec(`INSERT INTO pdf_export_profile_new (${COLS}, created_at, updated_at)
             SELECT ${COLS}, ${toIso('created_at')}, ${toIso('updated_at')} FROM pdf_export_profile`);
    db.exec('DROP TABLE pdf_export_profile');
    db.exec('ALTER TABLE pdf_export_profile_new RENAME TO pdf_export_profile');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pdf_export_profile_user_email ON pdf_export_profile(user_email)');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_profile_book_name ON pdf_export_profile(book_id, user_email, name) WHERE kind = 'book'`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_pdf_profile_book_user ON pdf_export_profile(book_id, user_email)');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_profile_userdefault_name ON pdf_export_profile(user_email, name) WHERE kind = 'user_default'`);
  },
};
