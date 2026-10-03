'use strict';
// Lauf-Historien der Plot-KI (Facade: db/plot.js).

const { db } = require('../connection');
const { NOW_ISO_SQL } = require('../now');

// ── Konsistenz-Prüfungs-Historie ────────────────────────────────────────────
// Persistierte Plot-Consistency-Läufe pro (Buch, User). Insert beim Job-Complete
// in routes/jobs/plot.js; List/Get/Delete via /plot/consistency-runs Routes. Die
// Liste kommt ohne result_json (Spaltensparsamkeit bei vielen Einträgen) —
// konflikt_count ist denormalisiert fürs Listen-Rendering; Detail liefert vollen JSON.

const _stmtInsertConsistencyRun = db.prepare(`
  INSERT INTO plot_consistency_runs (book_id, user_email, created_at, konflikt_count, result_json, model)
  VALUES (?, ?, ${NOW_ISO_SQL}, ?, ?, ?)
`);
const _stmtListConsistencyRuns = db.prepare(`
  SELECT id, book_id, created_at, konflikt_count, model
    FROM plot_consistency_runs
   WHERE book_id = ? AND user_email = ?
   ORDER BY created_at DESC, id DESC
`);
const _stmtGetConsistencyRun = db.prepare(`
  SELECT id, book_id, user_email, created_at, konflikt_count, result_json, model
    FROM plot_consistency_runs
   WHERE id = ?
`);
const _stmtDeleteConsistencyRun = db.prepare('DELETE FROM plot_consistency_runs WHERE id = ? AND user_email = ?');

function insertPlotConsistencyRun({ bookId, userEmail, konfliktCount = 0, result, model = null }) {
  const info = _stmtInsertConsistencyRun.run(
    parseInt(bookId), userEmail, parseInt(konfliktCount) || 0, JSON.stringify(result), model
  );
  return info.lastInsertRowid;
}

function listPlotConsistencyRuns(bookId, userEmail) {
  return _stmtListConsistencyRuns.all(parseInt(bookId), userEmail);
}

function getPlotConsistencyRun(id) {
  const r = _stmtGetConsistencyRun.get(parseInt(id));
  if (!r) return null;
  let result = null;
  try { result = JSON.parse(r.result_json); } catch { result = null; }
  return {
    id: r.id, book_id: r.book_id, user_email: r.user_email,
    created_at: r.created_at, konflikt_count: r.konflikt_count,
    result, model: r.model,
  };
}

function deletePlotConsistencyRun(id, userEmail) {
  return _stmtDeleteConsistencyRun.run(parseInt(id), userEmail).changes;
}

// ── Brainstorm-Lauf-Historie ─────────────────────────────────────────────────
// Persistierte Plot-Brainstorm-Läufe pro (Buch, User), zusätzlich pro Akt/Strang.
// Insert beim Job-Complete in routes/jobs/plot.js; List/Get/Delete via
// /plot/brainstorm-runs Routes. act_name/thread_name kommen via JOIN zur Lesezeit
// (kein Snapshot) — ein gelöschter Akt/Strang macht act_id/thread_id NULL, der
// Name fällt dann auf null (Frontend zeigt einen generischen Fallback). Die Liste
// kommt ohne result_json (Spaltensparsamkeit); Detail liefert die Vorschläge.

const _stmtInsertBrainstormRun = db.prepare(`
  INSERT INTO plot_brainstorm_runs (book_id, user_email, act_id, thread_id, created_at, vorschlag_count, result_json, model)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL}, ?, ?, ?)
`);
const _stmtListBrainstormRuns = db.prepare(`
  SELECT r.id, r.book_id, r.act_id, r.thread_id, r.created_at, r.vorschlag_count, r.model,
         a.name AS act_name, t.name AS thread_name
    FROM plot_brainstorm_runs r
    LEFT JOIN plot_acts    a ON a.id = r.act_id
    LEFT JOIN plot_threads t ON t.id = r.thread_id
   WHERE r.book_id = ? AND r.user_email = ?
   ORDER BY r.created_at DESC, r.id DESC
`);
const _stmtGetBrainstormRun = db.prepare(`
  SELECT r.id, r.book_id, r.user_email, r.act_id, r.thread_id, r.created_at, r.vorschlag_count, r.result_json, r.model,
         a.name AS act_name, t.name AS thread_name
    FROM plot_brainstorm_runs r
    LEFT JOIN plot_acts    a ON a.id = r.act_id
    LEFT JOIN plot_threads t ON t.id = r.thread_id
   WHERE r.id = ?
`);
const _stmtDeleteBrainstormRun = db.prepare('DELETE FROM plot_brainstorm_runs WHERE id = ? AND user_email = ?');

function insertPlotBrainstormRun({ bookId, userEmail, actId = null, threadId = null, vorschlagCount = 0, result, model = null }) {
  const info = _stmtInsertBrainstormRun.run(
    parseInt(bookId), userEmail,
    actId != null ? parseInt(actId) : null,
    threadId != null ? parseInt(threadId) : null,
    parseInt(vorschlagCount) || 0, JSON.stringify(result), model
  );
  return info.lastInsertRowid;
}

function listPlotBrainstormRuns(bookId, userEmail) {
  return _stmtListBrainstormRuns.all(parseInt(bookId), userEmail);
}

function getPlotBrainstormRun(id) {
  const r = _stmtGetBrainstormRun.get(parseInt(id));
  if (!r) return null;
  let result = null;
  try { result = JSON.parse(r.result_json); } catch { result = null; }
  return {
    id: r.id, book_id: r.book_id, user_email: r.user_email,
    act_id: r.act_id, thread_id: r.thread_id, act_name: r.act_name, thread_name: r.thread_name,
    created_at: r.created_at, vorschlag_count: r.vorschlag_count,
    result, model: r.model,
  };
}

function deletePlotBrainstormRun(id, userEmail) {
  return _stmtDeleteBrainstormRun.run(parseInt(id), userEmail).changes;
}

module.exports = {
  insertPlotConsistencyRun, listPlotConsistencyRuns, getPlotConsistencyRun, deletePlotConsistencyRun,
  insertPlotBrainstormRun, listPlotBrainstormRuns, getPlotBrainstormRun, deletePlotBrainstormRun,
};
