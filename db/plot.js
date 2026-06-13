'use strict';
// CRUD für die Plot-Werkstatt (Beat-Board). Pro Buch + User skopiert; der
// Owner-/ACL-Check geschieht im Route-Handler.
//
// Datenmodell:
//   plot_acts        — Spalten des Boards (Akte/Phasen), geordnet via position.
//   plot_beats       — Karten (Handlungspunkte) in einem Akt, geordnet via sort_order.
//   plot_beat_figures — M:M Beat ↔ Figur (welche Figuren im Beat vorkommen).
//
// status eines Beats: 'geplant' | 'entwurf' | 'im_buch' | 'verworfen' — erlaubt
// das Nachhalten „geplant vs. schon geschrieben". chapter_id (SET NULL) verknüpft
// den Beat mit dem Kapitel, in dem er im Manuskript landet.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

// ── Akte ─────────────────────────────────────────────────────────────────────

const _stmtListActs = db.prepare(`
  SELECT id, book_id, user_email, name, farbe, position, created_at, updated_at
    FROM plot_acts
   WHERE book_id = ? AND user_email = ?
   ORDER BY position, id
`);
const _stmtInsertAct = db.prepare(`
  INSERT INTO plot_acts (book_id, user_email, name, farbe, position, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
const _stmtGetAct = db.prepare('SELECT * FROM plot_acts WHERE id = ?');
const _stmtUpdateAct = db.prepare(`
  UPDATE plot_acts SET name = ?, farbe = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);
const _stmtSetActPosition = db.prepare(`
  UPDATE plot_acts SET position = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ? AND book_id = ? AND user_email = ?
`);
const _stmtDeleteAct = db.prepare('DELETE FROM plot_acts WHERE id = ?');
const _stmtMaxActPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM plot_acts WHERE book_id = ? AND user_email = ?');

function listActs(bookId, userEmail) {
  return _stmtListActs.all(parseInt(bookId), userEmail);
}

function getAct(id) {
  return _stmtGetAct.get(parseInt(id)) || null;
}

function createAct(bookId, userEmail, { name, farbe = null, position = null }) {
  const pos = position != null ? parseInt(position) : (_stmtMaxActPos.get(parseInt(bookId), userEmail).m + 1);
  const info = _stmtInsertAct.run(parseInt(bookId), userEmail, name, farbe, pos);
  return getAct(info.lastInsertRowid);
}

function updateAct(id, { name, farbe = null }) {
  _stmtUpdateAct.run(name, farbe, parseInt(id));
  return getAct(id);
}

function deleteAct(id) {
  // plot_beats hängen via ON DELETE CASCADE dran — sie verschwinden mit dem Akt.
  _stmtDeleteAct.run(parseInt(id));
}

// Akt-Reihenfolge neu setzen (Drag der Spalten). orderedIds = Akt-IDs in Zielreihenfolge.
const reorderActs = db.transaction((bookId, userEmail, orderedIds) => {
  orderedIds.forEach((actId, idx) => {
    _stmtSetActPosition.run(idx, parseInt(actId), parseInt(bookId), userEmail);
  });
});

// ── Beats ──────────────────────────────────────────────────────────────────

const _BEAT_SELECT = `
  SELECT b.id, b.book_id, b.act_id, b.user_email, b.titel, b.beschreibung,
         b.status, b.chapter_id, c.chapter_name, b.sort_order,
         b.created_at, b.updated_at
    FROM plot_beats b
    LEFT JOIN chapters c ON c.chapter_id = b.chapter_id
`;
const _stmtListBeats = db.prepare(`
  ${_BEAT_SELECT}
   WHERE b.book_id = ? AND b.user_email = ?
   ORDER BY b.act_id, b.sort_order, b.id
`);
const _stmtGetBeat = db.prepare(`${_BEAT_SELECT} WHERE b.id = ?`);
const _stmtInsertBeat = db.prepare(`
  INSERT INTO plot_beats (book_id, act_id, user_email, titel, beschreibung, status, chapter_id, sort_order, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
const _stmtDeleteBeat = db.prepare('DELETE FROM plot_beats WHERE id = ?');
const _stmtMaxBeatOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM plot_beats WHERE act_id = ?');
const _stmtSetBeatSlot = db.prepare(`
  UPDATE plot_beats SET act_id = ?, sort_order = ?, updated_at = ${NOW_ISO_SQL}
   WHERE id = ? AND book_id = ? AND user_email = ?
`);

// Figuren-Links pro Beat
const _stmtListFigsForBook = db.prepare(`
  SELECT pbf.beat_id, pbf.figure_id
    FROM plot_beat_figures pbf
    JOIN plot_beats b ON b.id = pbf.beat_id
   WHERE b.book_id = ? AND b.user_email = ?
`);
const _stmtDeleteFigsForBeat = db.prepare('DELETE FROM plot_beat_figures WHERE beat_id = ?');
const _stmtInsertFig = db.prepare('INSERT OR IGNORE INTO plot_beat_figures (beat_id, figure_id) VALUES (?, ?)');

function _figMapForBook(bookId, userEmail) {
  const map = {};
  for (const r of _stmtListFigsForBook.all(parseInt(bookId), userEmail)) {
    (map[r.beat_id] = map[r.beat_id] || []).push(r.figure_id);
  }
  return map;
}

function _setBeatFigures(beatId, figureIds) {
  _stmtDeleteFigsForBeat.run(parseInt(beatId));
  for (const fid of (figureIds || [])) {
    if (Number.isInteger(fid) || /^\d+$/.test(String(fid))) _stmtInsertFig.run(parseInt(beatId), parseInt(fid));
  }
}

function _beatRow(beatId, figMap = null) {
  const r = _stmtGetBeat.get(parseInt(beatId));
  if (!r) return null;
  const figs = figMap ? (figMap[r.id] || []) : _figMapForBook(r.book_id, r.user_email)[r.id] || [];
  return { ...r, fig_ids: figs };
}

function listBeats(bookId, userEmail) {
  const figMap = _figMapForBook(bookId, userEmail);
  return _stmtListBeats.all(parseInt(bookId), userEmail).map(r => ({ ...r, fig_ids: figMap[r.id] || [] }));
}

const createBeat = db.transaction((bookId, actId, userEmail, { titel, beschreibung = null, status = 'geplant', chapterId = null, figureIds = [], sortOrder = null }) => {
  const pos = sortOrder != null ? parseInt(sortOrder) : (_stmtMaxBeatOrder.get(parseInt(actId)).m + 1);
  const info = _stmtInsertBeat.run(
    parseInt(bookId), parseInt(actId), userEmail, titel, beschreibung, status,
    chapterId != null ? parseInt(chapterId) : null, pos
  );
  _setBeatFigures(info.lastInsertRowid, figureIds);
  return _beatRow(info.lastInsertRowid);
});

// Partielles Update: nur übergebene Felder ändern. `fields` enthält bereits
// validierte Werte; `figureIds` (falls Array) ersetzt die Figuren-Links komplett.
const updateBeat = db.transaction((id, fields, figureIds) => {
  const sets = [];
  const vals = [];
  for (const [col, val] of Object.entries(fields)) {
    sets.push(`${col} = ?`);
    vals.push(val);
  }
  if (sets.length) {
    sets.push(`updated_at = ${NOW_ISO_SQL}`);
    vals.push(parseInt(id));
    db.prepare(`UPDATE plot_beats SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  if (Array.isArray(figureIds)) _setBeatFigures(id, figureIds);
  return _beatRow(id);
});

function getBeat(id) {
  return _beatRow(id);
}

function deleteBeat(id) {
  _stmtDeleteBeat.run(parseInt(id));
}

// Beats neu einsortieren (Drag zwischen/innerhalb Spalten). order = [{ actId,
// beatIds: [...] }] — pro Akt die Beat-IDs in Zielreihenfolge. Setzt act_id +
// sort_order in einem Rutsch.
const reorderBeats = db.transaction((bookId, userEmail, order) => {
  for (const grp of order) {
    const actId = parseInt(grp.actId);
    (grp.beatIds || []).forEach((beatId, idx) => {
      _stmtSetBeatSlot.run(actId, idx, parseInt(beatId), parseInt(bookId), userEmail);
    });
  }
});

module.exports = {
  listActs, getAct, createAct, updateAct, deleteAct, reorderActs,
  listBeats, getBeat, createBeat, updateBeat, deleteBeat, reorderBeats,
};
