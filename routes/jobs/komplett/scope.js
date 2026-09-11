'use strict';
// Teil-Lauf: Ersatz-Lesepfade für abgewählte Katalog-Schritte.
//
// Ein abgewählter Schritt heisst „nicht neu berechnen", nicht „gibt es nicht".
// Die nachfolgenden Phasen brauchen die Namens→Handle-Karten trotzdem: ohne sie
// verlöre eine gespeicherte Szene ihre Ortszuordnung, obwohl der Ort im Katalog
// unverändert steht. Darum liest ein abgewählter Schritt seinen Stand aus der DB,
// statt mit leeren Karten weiterzulaufen.
//
// Der Katalog der abwählbaren Schritte liegt in lib/komplett-scope.js.
const { db } = require('../../../db/schema');

/**
 * Orte-Karten aus dem bestehenden Katalog (Schritt «Orte» abgewählt).
 * Gleiche Form wie der Rückgabewert von runPhase3: `id` ist das loc_id-Handle,
 * das remapSzenen über locIdToDbId auf die DB-Zeile auflöst.
 * `stale = 0`: ein Ort, den ein früherer Lauf als verschwunden markiert hat, ist
 * kein gültiges Zuordnungsziel mehr.
 */
function loadOrteFromDb(bookIdInt, email) {
  const rows = db.prepare(
    'SELECT loc_id, name FROM locations WHERE book_id = ? AND user_email = ? AND stale = 0 ORDER BY sort_order'
  ).all(bookIdInt, email);
  const ortNameToId = {}, ortNameToIdLower = {};
  for (const r of rows) {
    ortNameToId[r.name] = r.loc_id;
    ortNameToIdLower[r.name.toLowerCase()] = r.loc_id;
  }
  return { orte: rows.map(r => ({ id: r.loc_id, name: r.name })), ortNameToId, ortNameToIdLower };
}

/** Song-Bestand (Schritt «Songs» abgewählt) — nur für die Kennzahl im Job-Result. */
function countSongsInDb(bookIdInt, email) {
  return db.prepare(
    'SELECT COUNT(*) AS c FROM songs WHERE book_id = ? AND user_email IS ?'
  ).get(bookIdInt, email).c;
}

/** Szenen-Bestand (Schritt «Szenen» abgewählt) — nur für die Kennzahl im Job-Result. */
function countSzenenInDb(bookIdInt, email) {
  return db.prepare(
    'SELECT COUNT(*) AS c FROM figure_scenes WHERE book_id = ? AND user_email IS ? AND stale = 0'
  ).get(bookIdInt, email).c;
}

module.exports = { loadOrteFromDb, countSongsInDb, countSzenenInDb };
