'use strict';
// Recherche-Board, zwei additive Ergaenzungen (docs/recherche-board.md):
//
// 1) Wer hat den Einarbeitungs-Status zuletzt gesetzt und wann. Das Board ist
//    buchweit GETEILT — ohne diese Angabe sieht ein Mitarbeiter nur „eingearbeitet",
//    nicht von wem. Letzter Stand genuegt (kein Verlauf): die Frage auf der Karte
//    ist „wer war das", nicht „wie oft hin und her". `status_by` zeigt auf das
//    Konto (SET NULL: der Status bleibt, die Zuschreibung faellt mit dem Konto).
//
// 2) Link-Pruefung je URL eines Fundstuecks (Job `research-link-check`):
//    `check_ok` 1/0 bzw. NULL = nie geprueft, `check_code` der HTTP-Status
//    (NULL bei Netz-/DNS-/Timeout-Fehler, dann steht der Grund in `check_error`).

module.exports = {
  version: 300,
  up(db) {
    db.exec(`ALTER TABLE research_items ADD COLUMN status_at TEXT`);
    db.exec(`ALTER TABLE research_items ADD COLUMN status_by TEXT REFERENCES app_users(email) ON DELETE SET NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_research_items_status_by ON research_items(status_by)`);

    db.exec(`ALTER TABLE research_item_urls ADD COLUMN checked_at TEXT`);
    db.exec(`ALTER TABLE research_item_urls ADD COLUMN check_ok INTEGER CHECK (check_ok IN (0, 1))`);
    db.exec(`ALTER TABLE research_item_urls ADD COLUMN check_code INTEGER`);
    db.exec(`ALTER TABLE research_item_urls ADD COLUMN check_error TEXT`);
  },
};
