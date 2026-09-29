'use strict';
// Quellen: Quellentyp `newspaper` (Zeitungs-/Magazinartikel) und das genaue
// Erscheinungsdatum `issued_date`.
//
// Zwei Aenderungen, eine Migration, weil beide denselben Tabellen-Umbau
// brauchen wuerden: der CHECK auf `csl_type` laesst sich in SQLite nur ueber
// das Recreate-Pattern erweitern.
//
// Warum ein eigener Typ statt `article` mit Datum: die Zitierstile setzen das
// volle Datum bei Zeitungs-/Magazin- und Web-Artikeln, beim Fachzeitschriften-
// Aufsatz aber nur das Jahr. Zotero & Co. exportieren fuer JEDEN Aufsatz ein
// Datum mit — haengte die Formatierung am blossen Vorhandensein des Datums,
// stuende nach einem RIS-Import bei jedem Fachaufsatz „(2015, 27. Mai)".
//
// `issued_date` ist ISO-partiell (`YYYY`, `YYYY-MM` oder `YYYY-MM-DD`). `year`
// bleibt die Spalte fuer Sortierung, Kurzbeleg und Jahres-Buchstaben; ist ein
// Datum gesetzt, leitet der Schreibpfad das Jahr daraus ab (db/sources/shared.js).
//
// `id` wird uebernommen: Quellen-Marker im Seiten-HTML tragen sie als `data-src`,
// und source_citations/book_source_links/source_tags/source_semantic_chunks
// zeigen darauf. Deren FKs nennen die Tabelle beim Namen und greifen nach dem
// RENAME wieder.

const COLS = [
  'id', 'owner_email', 'csl_type', 'citekey', 'authors', 'editors', 'title',
  'container_title', 'publisher', 'place', 'year', 'edition', 'volume', 'issue',
  'pages', 'doi', 'isbn', 'issn', 'url', 'accessed_at', 'note', 'archived',
  'created_at', 'updated_at',
  'doc', 'doc_mime', 'doc_name', 'doc_text', 'doc_pages', 'doc_content_hash',
  'doc_indexed_at', 'doc_chars',
  'oton_role', 'oton_channel', 'oton_date', 'oton_auth',
].join(', ');

module.exports = {
  version: 294,
  fkOff: true,
  up(db) {
    db.exec('DROP TABLE IF EXISTS sources_new');
    db.exec(`CREATE TABLE sources_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_email      TEXT    NOT NULL,
        csl_type         TEXT    NOT NULL DEFAULT 'book'
                           CHECK(csl_type IN ('book','chapter','article','newspaper','website','thesis',
                                              'report','legal','interview','film','dataset','other')),
        citekey          TEXT,
        authors          TEXT    NOT NULL DEFAULT '[]',
        editors          TEXT    NOT NULL DEFAULT '[]',
        title            TEXT,
        container_title  TEXT,
        publisher        TEXT,
        place            TEXT,
        year             TEXT,
        issued_date      TEXT,
        edition          TEXT,
        volume           TEXT,
        issue            TEXT,
        pages            TEXT,
        doi              TEXT,
        isbn             TEXT,
        issn             TEXT,
        url              TEXT,
        accessed_at      TEXT,
        note             TEXT,
        archived         INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        doc              BLOB,
        doc_mime         TEXT,
        doc_name         TEXT,
        doc_text         TEXT,
        doc_pages        INTEGER,
        doc_content_hash TEXT,
        doc_indexed_at   TEXT,
        doc_chars        INTEGER,
        oton_role        TEXT,
        oton_channel     TEXT,
        oton_date        TEXT,
        oton_auth        TEXT
      )`);
    db.exec(`INSERT INTO sources_new (${COLS}) SELECT ${COLS} FROM sources`);
    db.exec('DROP TABLE sources');
    db.exec('ALTER TABLE sources_new RENAME TO sources');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_citekey ON sources(owner_email, citekey)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sources_owner ON sources(owner_email, archived)');
  },
};
