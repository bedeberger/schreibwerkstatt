'use strict';
// Papierkorb fuer geloeschte Seiten: `page_deletions` traegt den Inhalt der
// Seite zum Loeschzeitpunkt, damit sie sich wiederherstellen laesst. Die Seite
// selbst ist hart geloescht (pages-Row weg, page_revisions + page_images per
// CASCADE mit) — ohne diese Spalten bliebe nur der Name.
//
// - `body_html`: Seiteninhalt beim Loeschen. NULL = nicht wiederherstellbar
//   (Alt-Eintraege vor dieser Migration, Wipe beim Fassungs-Restore, der seine
//   eigene Auto-Sicherung schreibt).
// - `chapter_id`: Kapitel beim Loeschen; SET NULL, falls das Kapitel spaeter
//   faellt → Wiederherstellung landet dann auf Buch-Ebene.
// - `images_json`: im HTML referenzierte Manuskript-Bilder als base64
//   (Format von db/page-images.js#collectReferencedImages).
// - `restored_at`: gesetzt, sobald die Seite wiederhergestellt wurde; die Zeile
//   bleibt fuer den Delta-Sync der nativen Clients stehen.

module.exports = {
  version: 299,
  up(db) {
    db.exec(`ALTER TABLE page_deletions ADD COLUMN body_html TEXT`);
    db.exec(`ALTER TABLE page_deletions ADD COLUMN chapter_id INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL`);
    db.exec(`ALTER TABLE page_deletions ADD COLUMN images_json TEXT`);
    db.exec(`ALTER TABLE page_deletions ADD COLUMN restored_at TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_page_deletions_chapter_id ON page_deletions(chapter_id)`);
  },
};
