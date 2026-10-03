'use strict';
// Plot-Werkstatt: eigener Zeitstempel fuer die ANKER-RELEVANTEN Beat-Felder
// (titel, beschreibung, status, verworfen — docs/plot.md „Beat-Verankerung").
//
// Die Stale-Heuristik der Beat-Verankerung verglich bisher `updated_at` mit dem
// letzten Lauf. `updated_at` stempeln aber auch Drag & Drop, Fork/Unfork und
// Kapitel-/Intensitaets-/Figuren-Aenderungen — nichts davon aendert die Anker-
// Query oder die Frage, ob ein Beat verankert wird. `content_updated_at` stempelt
// nur db/plot/beats.js (createBeat + updateBeat bei geaenderter Inhaltsspalte).
//
// Backfill aus `updated_at`: konservativ — ein Bestands-Beat gilt hoechstens so
// frisch, wie er zuletzt angefasst wurde.

module.exports = {
  version: 302,
  up(db) {
    db.exec(`ALTER TABLE plot_beats ADD COLUMN content_updated_at TEXT`);
    db.exec(`UPDATE plot_beats SET content_updated_at = updated_at`);
  },
};
