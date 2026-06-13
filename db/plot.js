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

// ── Handlungsstränge (Swimlanes) ───────────────────────────────────────────
// Zweite Ordnungsachse neben den Akten: das Board wird ein Raster Akte × Stränge,
// ein Beat sitzt in der Zelle (act_id, thread_id). Strang optional an eine
// Katalog-Figur (figure_id → figures.id, INTEGER-FK) ODER Werkstatt-Figur
// (draft_figure_id → draft_figures.id) gebunden. Nach aussen wird für die
// Katalog-Bindung die TEXT-fig_id exponiert (Frontend-Identität, vgl. Beats);
// die Werkstatt-Bindung ist bereits die INTEGER-id (keine Indirektion).
const _THREAD_SELECT = `
  SELECT t.id, t.book_id, t.user_email, t.name, t.farbe,
         t.figure_id, f.fig_id AS fig_id, t.draft_figure_id,
         t.position, t.created_at, t.updated_at
    FROM plot_threads t
    LEFT JOIN figures f ON f.id = t.figure_id
`;
const _stmtListThreads = db.prepare(`${_THREAD_SELECT} WHERE t.book_id = ? AND t.user_email = ? ORDER BY t.position, t.id`);
const _stmtGetThread = db.prepare(`${_THREAD_SELECT} WHERE t.id = ?`);
const _stmtInsertThread = db.prepare(`
  INSERT INTO plot_threads (book_id, user_email, name, farbe, figure_id, draft_figure_id, position, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
const _stmtUpdateThread = db.prepare(`
  UPDATE plot_threads SET name = ?, farbe = ?, figure_id = ?, draft_figure_id = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);
const _stmtSetThreadPosition = db.prepare(`
  UPDATE plot_threads SET position = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ? AND book_id = ? AND user_email = ?
`);
const _stmtDeleteThread = db.prepare('DELETE FROM plot_threads WHERE id = ?');
const _stmtMaxThreadPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM plot_threads WHERE book_id = ? AND user_email = ?');

function listThreads(bookId, userEmail) {
  return _stmtListThreads.all(parseInt(bookId), userEmail);
}

function getThread(id) {
  return _stmtGetThread.get(parseInt(id)) || null;
}

// figureId/draftFigureId sind bereits INTEGER-IDs (in der Route via
// resolveFigureIds/resolveDraftFigureIds aufgelöst), oder null.
function createThread(bookId, userEmail, { name, farbe = null, figureId = null, draftFigureId = null, position = null }) {
  const pos = position != null ? parseInt(position) : (_stmtMaxThreadPos.get(parseInt(bookId), userEmail).m + 1);
  const info = _stmtInsertThread.run(
    parseInt(bookId), userEmail, name, farbe,
    figureId != null ? parseInt(figureId) : null,
    draftFigureId != null ? parseInt(draftFigureId) : null, pos
  );
  return getThread(info.lastInsertRowid);
}

function updateThread(id, { name, farbe = null, figureId = null, draftFigureId = null }) {
  _stmtUpdateThread.run(
    name, farbe,
    figureId != null ? parseInt(figureId) : null,
    draftFigureId != null ? parseInt(draftFigureId) : null, parseInt(id)
  );
  return getThread(id);
}

function deleteThread(id) {
  // plot_beats.thread_id hängt via ON DELETE SET NULL — die Beats bleiben und
  // fallen in die „ohne Strang"-Lane (kein Daten-Verlust).
  _stmtDeleteThread.run(parseInt(id));
}

// Strang-Reihenfolge neu setzen (Zeilen-Reorder). orderedIds in Zielreihenfolge.
const reorderThreads = db.transaction((bookId, userEmail, orderedIds) => {
  orderedIds.forEach((threadId, idx) => {
    _stmtSetThreadPosition.run(idx, parseInt(threadId), parseInt(bookId), userEmail);
  });
});

// threadId aufs (Buch, User)-Subset validieren; Fremd-/Unbekannt/leer → null.
// Verhindert, dass ein Beat einem fremden Strang zugeordnet wird.
function _validThreadId(bookId, userEmail, threadId) {
  if (!threadId) return null;
  const r = _stmtGetThread.get(parseInt(threadId));
  return (r && r.book_id === parseInt(bookId) && r.user_email === userEmail) ? r.id : null;
}

// ── Beats ──────────────────────────────────────────────────────────────────

const _BEAT_SELECT = `
  SELECT b.id, b.book_id, b.act_id, b.thread_id, b.user_email, b.titel, b.beschreibung,
         b.status, b.chapter_id, c.chapter_name, b.intensitaet, b.sort_order,
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
  INSERT INTO plot_beats (book_id, act_id, thread_id, user_email, titel, beschreibung, status, chapter_id, intensitaet, sort_order, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
const _stmtDeleteBeat = db.prepare('DELETE FROM plot_beats WHERE id = ?');
// sort_order ist pro ZELLE (act_id, thread_id) lückenlos. thread_id IS ? ist
// NULL-safe (gebundener NULL-Parameter → „ohne Strang"-Lane).
const _stmtMaxBeatOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM plot_beats WHERE act_id = ? AND thread_id IS ?');
const _stmtSetBeatSlot = db.prepare(`
  UPDATE plot_beats SET act_id = ?, thread_id = ?, sort_order = ?, updated_at = ${NOW_ISO_SQL}
   WHERE id = ? AND book_id = ? AND user_email = ?
`);

// Figuren-Links pro Beat. plot_beat_figures.figure_id ist INTEGER-FK auf
// figures.id; nach aussen wird aber die TEXT-fig_id exponiert bzw. erwartet —
// das ist die Figur-Identität, mit der das Frontend arbeitet ($app.figuren[].id
// === fig_id, vgl. routes/figures.js). resolveFigureIds übersetzt eingehende
// fig_ids → figures.id, die Lese-Aggregate liefern fig_id zurück.
const _stmtListFigsForBook = db.prepare(`
  SELECT pbf.beat_id, f.fig_id AS fig_id
    FROM plot_beat_figures pbf
    JOIN plot_beats b ON b.id = pbf.beat_id
    JOIN figures   f ON f.id = pbf.figure_id
   WHERE b.book_id = ? AND b.user_email = ?
`);
const _stmtDeleteFigsForBeat = db.prepare('DELETE FROM plot_beat_figures WHERE beat_id = ?');
const _stmtInsertFig = db.prepare('INSERT OR IGNORE INTO plot_beat_figures (beat_id, figure_id) VALUES (?, ?)');

// Werkstatt-Figuren (draft_figures) pro Beat. Anders als bei plot_beat_figures
// IST die draft_figures.id (INTEGER) bereits die Frontend-Identität — keine
// TEXT-fig_id-Indirektion. Lese-Aggregat liefert die INTEGER-id direkt zurück.
const _stmtListDraftFigsForBook = db.prepare(`
  SELECT pbdf.beat_id, pbdf.draft_figure_id AS draft_id
    FROM plot_beat_draft_figures pbdf
    JOIN plot_beats b ON b.id = pbdf.beat_id
   WHERE b.book_id = ? AND b.user_email = ?
`);
const _stmtDeleteDraftFigsForBeat = db.prepare('DELETE FROM plot_beat_draft_figures WHERE beat_id = ?');
const _stmtInsertDraftFig = db.prepare('INSERT OR IGNORE INTO plot_beat_draft_figures (beat_id, draft_figure_id) VALUES (?, ?)');

// TEXT-fig_id (Frontend-Identität) → INTEGER figures.id (FK-Target), gefiltert
// aufs Subset, das wirklich zu (Buch, User) gehört. Unbekannte/Fremd-fig_ids
// fallen still raus (kein Cross-Buch-Leak in die M:M-Tabelle).
function resolveFigureIds(bookId, userEmail, figIds) {
  if (!Array.isArray(figIds) || !figIds.length) return [];
  const wanted = figIds.map(x => String(x).trim()).filter(Boolean);
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => '?').join(',');
  return db.prepare(
    `SELECT id FROM figures WHERE book_id = ? AND user_email = ? AND fig_id IN (${placeholders})`
  ).all(parseInt(bookId), userEmail, ...wanted).map(r => r.id);
}

// Werkstatt-Figur-IDs (INTEGER draft_figures.id) aufs Subset filtern, das wirklich
// zu (Buch, User) gehört. Unbekannte/Fremd-IDs fallen still raus (kein Cross-Buch-
// Leak in die M:M-Tabelle). Eingang sind bereits INTEGER-IDs (Frontend-Identität).
function resolveDraftFigureIds(bookId, userEmail, draftIds) {
  if (!Array.isArray(draftIds) || !draftIds.length) return [];
  const wanted = draftIds.map(x => parseInt(x)).filter(n => Number.isInteger(n) && n > 0);
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => '?').join(',');
  return db.prepare(
    `SELECT id FROM draft_figures WHERE book_id = ? AND user_email = ? AND id IN (${placeholders})`
  ).all(parseInt(bookId), userEmail, ...wanted).map(r => r.id);
}

function _figMapForBook(bookId, userEmail) {
  const map = {};
  for (const r of _stmtListFigsForBook.all(parseInt(bookId), userEmail)) {
    (map[r.beat_id] = map[r.beat_id] || []).push(r.fig_id);
  }
  return map;
}

function _draftFigMapForBook(bookId, userEmail) {
  const map = {};
  for (const r of _stmtListDraftFigsForBook.all(parseInt(bookId), userEmail)) {
    (map[r.beat_id] = map[r.beat_id] || []).push(r.draft_id);
  }
  return map;
}

// figureIds = INTEGER figures.id (bereits via resolveFigureIds aufgelöst).
function _setBeatFigures(beatId, figureIds) {
  _stmtDeleteFigsForBeat.run(parseInt(beatId));
  for (const fid of (figureIds || [])) {
    if (Number.isInteger(fid) || /^\d+$/.test(String(fid))) _stmtInsertFig.run(parseInt(beatId), parseInt(fid));
  }
}

// draftFigureIds = INTEGER draft_figures.id (bereits via resolveDraftFigureIds aufgelöst).
function _setBeatDraftFigures(beatId, draftFigureIds) {
  _stmtDeleteDraftFigsForBeat.run(parseInt(beatId));
  for (const fid of (draftFigureIds || [])) {
    if (Number.isInteger(fid) || /^\d+$/.test(String(fid))) _stmtInsertDraftFig.run(parseInt(beatId), parseInt(fid));
  }
}

function _beatRow(beatId, figMap = null, draftFigMap = null) {
  const r = _stmtGetBeat.get(parseInt(beatId));
  if (!r) return null;
  const figs = figMap ? (figMap[r.id] || []) : _figMapForBook(r.book_id, r.user_email)[r.id] || [];
  const draftFigs = draftFigMap ? (draftFigMap[r.id] || []) : _draftFigMapForBook(r.book_id, r.user_email)[r.id] || [];
  return { ...r, fig_ids: figs, draft_fig_ids: draftFigs };
}

function listBeats(bookId, userEmail) {
  const figMap = _figMapForBook(bookId, userEmail);
  const draftFigMap = _draftFigMapForBook(bookId, userEmail);
  return _stmtListBeats.all(parseInt(bookId), userEmail)
    .map(r => ({ ...r, fig_ids: figMap[r.id] || [], draft_fig_ids: draftFigMap[r.id] || [] }));
}

const createBeat = db.transaction((bookId, actId, userEmail, { titel, beschreibung = null, status = 'geplant', chapterId = null, intensitaet = null, threadId = null, figureIds = [], draftFigureIds = [], sortOrder = null }) => {
  const tid = threadId != null ? parseInt(threadId) : null;
  const pos = sortOrder != null ? parseInt(sortOrder) : (_stmtMaxBeatOrder.get(parseInt(actId), tid).m + 1);
  const info = _stmtInsertBeat.run(
    parseInt(bookId), parseInt(actId), tid, userEmail, titel, beschreibung, status,
    chapterId != null ? parseInt(chapterId) : null,
    intensitaet != null ? parseInt(intensitaet) : null, pos
  );
  _setBeatFigures(info.lastInsertRowid, figureIds);
  _setBeatDraftFigures(info.lastInsertRowid, draftFigureIds);
  return _beatRow(info.lastInsertRowid);
});

// Partielles Update: nur übergebene Felder ändern. `fields` enthält bereits
// validierte Werte; `figureIds`/`draftFigureIds` (falls Array) ersetzen die
// jeweiligen Figuren-Links komplett.
const updateBeat = db.transaction((id, fields, figureIds, draftFigureIds) => {
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
  if (Array.isArray(draftFigureIds)) _setBeatDraftFigures(id, draftFigureIds);
  return _beatRow(id);
});

function getBeat(id) {
  return _beatRow(id);
}

function deleteBeat(id) {
  _stmtDeleteBeat.run(parseInt(id));
}

// Beats neu einsortieren (Drag zwischen/innerhalb Zellen). order = [{ actId,
// threadId, beatIds: [...] }] — pro Zelle (Akt × Strang) die Beat-IDs in
// Zielreihenfolge. Setzt act_id + thread_id + sort_order in einem Rutsch.
// threadId fehlt/null → „ohne Strang"-Lane (Abwärtskompat zum flachen Board).
const reorderBeats = db.transaction((bookId, userEmail, order) => {
  for (const grp of order) {
    const actId = parseInt(grp.actId);
    const threadId = grp.threadId != null ? parseInt(grp.threadId) : null;
    (grp.beatIds || []).forEach((beatId, idx) => {
      _stmtSetBeatSlot.run(actId, threadId, idx, parseInt(beatId), parseInt(bookId), userEmail);
    });
  }
});

module.exports = {
  listActs, getAct, createAct, updateAct, deleteAct, reorderActs,
  listThreads, getThread, createThread, updateThread, deleteThread, reorderThreads, _validThreadId,
  listBeats, getBeat, createBeat, updateBeat, deleteBeat, reorderBeats,
  resolveFigureIds, resolveDraftFigureIds,
};
