'use strict';
// Beat-zu-Beat-Beziehungen (Facade: db/plot.js).

const { db } = require('../connection');
const { NOW_ISO_SQL } = require('../now');
const { _beatBelongs } = require('./beats');

// ── Beat-zu-Beat-Beziehungen (Kausalitaet + Setup/Payoff) ────────────────────
// Gerichtete Kante from_beat --typ--> to_beat. `typ` ist Freitext (kuratierte
// Vorschlaege im Frontend, analog figure_relations). Pro Buch + User skopiert.
// Read-Aggregat liefert die Beat-Titel via JOIN (kein Snapshot).
const _REL_SELECT = `
  SELECT r.id, r.book_id, r.user_email, r.from_beat_id, r.to_beat_id, r.typ,
         fb.titel AS from_titel, tb.titel AS to_titel,
         r.created_at, r.updated_at
    FROM plot_beat_relations r
    JOIN plot_beats fb ON fb.id = r.from_beat_id
    JOIN plot_beats tb ON tb.id = r.to_beat_id
`;
const _stmtListBeatRelations = db.prepare(`${_REL_SELECT} WHERE r.book_id = ? AND r.user_email = ? ORDER BY r.from_beat_id, r.id`);
const _stmtGetBeatRelation = db.prepare(`${_REL_SELECT} WHERE r.id = ?`);
const _stmtInsertBeatRelation = db.prepare(`
  INSERT OR IGNORE INTO plot_beat_relations (book_id, user_email, from_beat_id, to_beat_id, typ, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
const _stmtFindBeatRelation = db.prepare('SELECT id FROM plot_beat_relations WHERE from_beat_id = ? AND to_beat_id = ? AND typ = ?');
const _stmtDeleteBeatRelation = db.prepare('DELETE FROM plot_beat_relations WHERE id = ? AND user_email = ?');

function listBeatRelations(bookId, userEmail) {
  return _stmtListBeatRelations.all(parseInt(bookId), userEmail);
}

function getBeatRelation(id) {
  return _stmtGetBeatRelation.get(parseInt(id)) || null;
}

// Kante anlegen. Beide Beats muessen zu (Buch, User) gehoeren; keine Selbst-Kante.
// Bei bestehender identischer Kante (UNIQUE) wird die vorhandene zurueckgegeben
// (idempotent). Wirft mit .code fuer die Route.
function createBeatRelation(bookId, userEmail, { fromBeatId, toBeatId, typ }) {
  const fid = parseInt(fromBeatId);
  const tid = parseInt(toBeatId);
  if (!Number.isInteger(fid) || !Number.isInteger(tid)) { const e = new Error('BEAT_REQUIRED'); e.code = 'BEAT_REQUIRED'; throw e; }
  if (fid === tid) { const e = new Error('SELF_RELATION'); e.code = 'SELF_RELATION'; throw e; }
  if (!_beatBelongs(bookId, userEmail, fid) || !_beatBelongs(bookId, userEmail, tid)) {
    const e = new Error('BEAT_MISMATCH'); e.code = 'BEAT_MISMATCH'; throw e;
  }
  const cleanTyp = String(typ || '').trim().slice(0, 40);
  if (!cleanTyp) { const e = new Error('TYP_REQUIRED'); e.code = 'TYP_REQUIRED'; throw e; }
  const info = _stmtInsertBeatRelation.run(parseInt(bookId), userEmail, fid, tid, cleanTyp);
  const id = info.changes ? info.lastInsertRowid : _stmtFindBeatRelation.get(fid, tid, cleanTyp)?.id;
  return id ? getBeatRelation(id) : null;
}

function deleteBeatRelation(id, userEmail) {
  return _stmtDeleteBeatRelation.run(parseInt(id), userEmail).changes;
}

module.exports = { listBeatRelations, getBeatRelation, createBeatRelation, deleteBeatRelation };
