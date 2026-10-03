'use strict';
// Befunde des Recherche-Abgleichs (Job `research-crosscheck`,
// docs/recherche-board.md): eine Stelle im Manuskript widerspricht einem
// gesammelten Fakt oder gibt ein gesammeltes Zitat abweichend wieder.
//
// Am Fundstueck, nicht am User: das Board ist buchweit geteilt, und „Kapitel 3
// widerspricht dem Fakt X" ist eine Aussage ueber Buch und Material, nicht ueber
// den, der den Abgleich angestossen hat. Jeder Lauf ersetzt die Befunde der
// geprueften Fundstuecke (abgeleiteter Index, kein Edit-Pfad).
//
// page_id CASCADE: ein Befund ohne seine Seite hat keine Stelle mehr, auf die er
// zeigen koennte (gleiche Wahl wie bei ideen.page_id).

module.exports = {
  version: 301,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_item_findings (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id     INTEGER NOT NULL REFERENCES research_items(id) ON DELETE CASCADE,
        book_id     INTEGER NOT NULL REFERENCES books(book_id)     ON DELETE CASCADE,
        page_id     INTEGER NOT NULL REFERENCES pages(page_id)     ON DELETE CASCADE,
        typ         TEXT    NOT NULL CHECK(typ IN ('widerspruch','zitat')),
        stelle      TEXT    NOT NULL,
        erklaerung  TEXT,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_research_item_findings_item ON research_item_findings(item_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_research_item_findings_book ON research_item_findings(book_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_research_item_findings_page ON research_item_findings(page_id)`);
  },
};
