'use strict';
// CRUD für draft_figures (Figuren-Werkstatt). Mindmap-Baum lebt als
// jsMind-JSON in mindmap_json; keine separate Knoten-Tabelle. Per-User-,
// per-Buch-skopiert; Owner-Check geschieht im Route-Handler.
//
// source_figure_id: optionale Referenz auf figures.id, wenn der Draft via
// Import aus dem Figuren-Katalog erzeugt wurde. ON DELETE SET NULL — die
// Mindmap-Arbeit überlebt das Verschwinden der Quell-Figur. Werkstatt-Jobs
// (Brainstorm + Consistency) nutzen den Wert, um die Quell-Figur aus dem
// Buch-Kontext auszublenden, sonst würde die Figur gegen sich selbst geprüft.

const { db } = require('./connection');

// Inkl. JOIN auf figures für source_figure_name — Frontend braucht den Namen
// fürs „Aus: <name>"-Badge, ohne den figuren-Katalog separat laden zu müssen.
// LEFT JOIN: source_figure_id kann NULL sein (frei angelegter Draft) oder die
// Quell-Figur kann via ON DELETE SET NULL verschwunden sein.
const _SELECT_SQL = `
  SELECT d.id, d.book_id, d.user_email, d.name, d.archetype, d.mindmap_json,
         d.notes, d.source_figure_id, d.created_at, d.updated_at,
         f.name AS source_figure_name
    FROM draft_figures d
    LEFT JOIN figures f ON f.id = d.source_figure_id
`;

const _stmtList = db.prepare(
  `${_SELECT_SQL}
    WHERE d.book_id = ? AND d.user_email = ?
    ORDER BY d.updated_at DESC, d.id DESC`
);
const _stmtGet = db.prepare(`${_SELECT_SQL} WHERE d.id = ?`);
const _stmtFindBySource = db.prepare(
  `${_SELECT_SQL}
    WHERE d.book_id = ? AND d.user_email = ? AND d.source_figure_id = ?`
);
const _stmtInsert = db.prepare(
  `INSERT INTO draft_figures (book_id, user_email, name, archetype, mindmap_json, notes, source_figure_id, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const _stmtUpdate = db.prepare(
  `UPDATE draft_figures SET name = ?, archetype = ?, mindmap_json = ?, notes = ?, updated_at = ? WHERE id = ?`
);
const _stmtDelete = db.prepare(`DELETE FROM draft_figures WHERE id = ?`);

function _row(r) {
  if (!r) return null;
  let mindmap = null;
  try { mindmap = JSON.parse(r.mindmap_json); } catch { mindmap = null; }
  return {
    id: r.id,
    book_id: r.book_id,
    user_email: r.user_email,
    name: r.name,
    archetype: r.archetype || null,
    mindmap,
    notes: r.notes || null,
    source_figure_id: r.source_figure_id || null,
    source_figure_name: r.source_figure_name || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function listDraftFigures(bookId, userEmail) {
  return _stmtList.all(parseInt(bookId), userEmail).map(_row);
}

function getDraftFigure(id) {
  return _row(_stmtGet.get(parseInt(id)));
}

function getDraftFigureBySource(bookId, userEmail, sourceFigureId) {
  return _row(_stmtFindBySource.get(parseInt(bookId), userEmail, parseInt(sourceFigureId)));
}

function createDraftFigure(bookId, userEmail, { name, archetype = null, mindmap, notes = null, sourceFigureId = null }) {
  const now = new Date().toISOString();
  const info = _stmtInsert.run(
    parseInt(bookId), userEmail, name, archetype,
    JSON.stringify(mindmap), notes,
    sourceFigureId != null ? parseInt(sourceFigureId) : null,
    now, now
  );
  return getDraftFigure(info.lastInsertRowid);
}

function updateDraftFigure(id, { name, archetype = null, mindmap, notes = null }) {
  const now = new Date().toISOString();
  _stmtUpdate.run(name, archetype, JSON.stringify(mindmap), notes, now, parseInt(id));
  return getDraftFigure(id);
}

function deleteDraftFigure(id) {
  _stmtDelete.run(parseInt(id));
}

// ── werkstatt_runs (Brainstorm + Consistency History) ───────────────────────
// Persistierte KI-Läufe pro Draft. Insert beim Job-Complete in routes/jobs/
// figur-werkstatt.js; List/Get/Delete via /draft-figures/:id/runs Routes.
// Liste ohne result_json (Spaltenbreite spart bei vielen Einträgen); Detail
// liefert vollen JSON.

const _stmtInsertRun = db.prepare(`
  INSERT INTO werkstatt_runs (draft_id, book_id, user_email, kind, created_at, knoten_id, knoten_pfad, result_json, model)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const _stmtListRuns = db.prepare(`
  SELECT id, kind, created_at, knoten_id, knoten_pfad, model
    FROM werkstatt_runs
   WHERE draft_id = ? AND user_email = ?
   ORDER BY created_at DESC, id DESC
`);
const _stmtGetRun = db.prepare(`
  SELECT id, draft_id, book_id, user_email, kind, created_at, knoten_id, knoten_pfad, result_json, model
    FROM werkstatt_runs
   WHERE id = ?
`);
const _stmtDeleteRun = db.prepare(`DELETE FROM werkstatt_runs WHERE id = ? AND user_email = ?`);

function insertWerkstattRun({ draftId, bookId, userEmail, kind, knotenId = null, knotenPfad = null, result, model = null }) {
  const now = new Date().toISOString();
  const info = _stmtInsertRun.run(
    parseInt(draftId), parseInt(bookId), userEmail, kind, now,
    knotenId, knotenPfad, JSON.stringify(result), model
  );
  return info.lastInsertRowid;
}

function listWerkstattRuns(draftId, userEmail) {
  return _stmtListRuns.all(parseInt(draftId), userEmail);
}

function getWerkstattRun(id) {
  const r = _stmtGetRun.get(parseInt(id));
  if (!r) return null;
  let result = null;
  try { result = JSON.parse(r.result_json); } catch { result = null; }
  return {
    id: r.id, draft_id: r.draft_id, book_id: r.book_id, user_email: r.user_email,
    kind: r.kind, created_at: r.created_at,
    knoten_id: r.knoten_id, knoten_pfad: r.knoten_pfad,
    result, model: r.model,
  };
}

function deleteWerkstattRun(id, userEmail) {
  return _stmtDeleteRun.run(parseInt(id), userEmail).changes;
}

module.exports = {
  listDraftFigures, getDraftFigure, getDraftFigureBySource,
  createDraftFigure, updateDraftFigure, deleteDraftFigure,
  insertWerkstattRun, listWerkstattRuns, getWerkstattRun, deleteWerkstattRun,
};
