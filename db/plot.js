'use strict';
// CRUD für die Plot-Werkstatt (Beat-Board). Pro Buch + User skopiert; der
// Owner-/ACL-Check geschieht im Route-Handler.
//
// Datenmodell:
//   plot_acts        — Spalten des Boards (Akte/Phasen), geordnet via position.
//   plot_beats       — Karten (Handlungspunkte) in einem Akt, geordnet via sort_order.
//   plot_beat_figures — M:M Beat ↔ Figur (welche Figuren im Beat vorkommen).
//
// status eines Beats: 'geplant' | 'im_buch' — binäre Realisierungsachse („Idee vs.
// eingearbeitet"). verworfen (0/1) ist eine orthogonale Verwerfen-Achse (bleibt bei
// Status-Wechsel erhalten). chapter_id (SET NULL) verknüpft den Beat mit dem
// Kapitel, in dem er im Manuskript landet.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

// ── Akte ─────────────────────────────────────────────────────────────────────

// thread_id NULL = geteilter Akt (Default, flaches Board + Stränge ohne eigene
// Akte); thread_id = T = Akt gehört nur Strang T (Hybrid-Akte, Migration 193).
const _stmtListActs = db.prepare(`
  SELECT id, book_id, user_email, name, farbe, thread_id, position, created_at, updated_at
    FROM plot_acts
   WHERE book_id = ? AND user_email = ?
   ORDER BY position, id
`);
const _stmtInsertAct = db.prepare(`
  INSERT INTO plot_acts (book_id, user_email, name, farbe, thread_id, position, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
const _stmtGetAct = db.prepare('SELECT * FROM plot_acts WHERE id = ?');
const _stmtUpdateAct = db.prepare(`
  UPDATE plot_acts SET name = ?, farbe = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);
const _stmtSetActPosition = db.prepare(`
  UPDATE plot_acts SET position = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ? AND book_id = ? AND user_email = ?
`);
const _stmtDeleteAct = db.prepare('DELETE FROM plot_acts WHERE id = ?');
// position ist PRO SCOPE (thread_id IS ?) lückenlos: geteilte Akte und die Akte
// jedes Strangs bilden je eine eigene 0..n-Sequenz. thread_id IS ? ist NULL-safe.
const _stmtMaxActPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM plot_acts WHERE book_id = ? AND user_email = ? AND thread_id IS ?');

function listActs(bookId, userEmail) {
  return _stmtListActs.all(parseInt(bookId), userEmail);
}

function getAct(id) {
  return _stmtGetAct.get(parseInt(id)) || null;
}

function createAct(bookId, userEmail, { name, farbe = null, threadId = null, position = null }) {
  const tid = threadId != null ? parseInt(threadId) : null;
  const pos = position != null ? parseInt(position) : (_stmtMaxActPos.get(parseInt(bookId), userEmail, tid).m + 1);
  const info = _stmtInsertAct.run(parseInt(bookId), userEmail, name, farbe, tid, pos);
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
// chapter_id (SET NULL) bindet optional ein Zielkapitel an den Strang; die Beats
// der Lane erben es live (Anzeige + KI-Kontext, nie auf den Beat geschrieben).
// chapter_name via JOIN als Anzeige-Wert zur Lesezeit (kein Snapshot).
const _THREAD_SELECT = `
  SELECT t.id, t.book_id, t.user_email, t.name, t.farbe,
         t.figure_id, f.fig_id AS fig_id, t.draft_figure_id,
         t.chapter_id, c.chapter_name AS chapter_name,
         t.position, t.created_at, t.updated_at
    FROM plot_threads t
    LEFT JOIN figures f ON f.id = t.figure_id
    LEFT JOIN chapters c ON c.chapter_id = t.chapter_id
`;
const _stmtListThreads = db.prepare(`${_THREAD_SELECT} WHERE t.book_id = ? AND t.user_email = ? ORDER BY t.position, t.id`);
const _stmtGetThread = db.prepare(`${_THREAD_SELECT} WHERE t.id = ?`);
const _stmtInsertThread = db.prepare(`
  INSERT INTO plot_threads (book_id, user_email, name, farbe, figure_id, draft_figure_id, chapter_id, position, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
const _stmtUpdateThread = db.prepare(`
  UPDATE plot_threads SET name = ?, farbe = ?, figure_id = ?, draft_figure_id = ?, chapter_id = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?
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
// resolveFigureIds/resolveDraftFigureIds aufgelöst), oder null. chapterId ist
// bereits via _validChapterId aufs Buch validiert, oder null.
function createThread(bookId, userEmail, { name, farbe = null, figureId = null, draftFigureId = null, chapterId = null, position = null }) {
  const pos = position != null ? parseInt(position) : (_stmtMaxThreadPos.get(parseInt(bookId), userEmail).m + 1);
  const info = _stmtInsertThread.run(
    parseInt(bookId), userEmail, name, farbe,
    figureId != null ? parseInt(figureId) : null,
    draftFigureId != null ? parseInt(draftFigureId) : null,
    chapterId != null ? parseInt(chapterId) : null, pos
  );
  return getThread(info.lastInsertRowid);
}

function updateThread(id, { name, farbe = null, figureId = null, draftFigureId = null, chapterId = null }) {
  _stmtUpdateThread.run(
    name, farbe,
    figureId != null ? parseInt(figureId) : null,
    draftFigureId != null ? parseInt(draftFigureId) : null,
    chapterId != null ? parseInt(chapterId) : null, parseInt(id)
  );
  return getThread(id);
}

// Strang löschen. plot_beats.thread_id hängt via SET NULL — die Beats bleiben und
// fallen in die „ohne Strang"-Lane. ABER: hat der Strang eigene Akte (Hybrid),
// hingen diese via plot_acts.thread_id-CASCADE am Strang und würden ihre Beats
// mit-kaskadieren. Darum VOR dem Löschen die Beats eigener Akte auf geteilte Akte
// umhängen (oder die eigenen Akte zu geteilten befördern, falls keine geteilten
// existieren) — Invariante „Strang löschen ≠ Beats löschen".
const deleteThread = db.transaction((id) => {
  const t = _stmtGetThread.get(parseInt(id));
  if (t) _landThreadBeatsOnSharedActs(t.book_id, t.user_email, t.id);
  _stmtDeleteThread.run(parseInt(id));
});

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
         b.status, b.verworfen, b.chapter_id, c.chapter_name, b.intensitaet, b.sort_order,
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
  INSERT INTO plot_beats (book_id, act_id, thread_id, user_email, titel, beschreibung, status, verworfen, chapter_id, intensitaet, sort_order, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
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

const createBeat = db.transaction((bookId, actId, userEmail, { titel, beschreibung = null, status = 'geplant', verworfen = 0, chapterId = null, intensitaet = null, threadId = null, figureIds = [], draftFigureIds = [], sortOrder = null }) => {
  const tid = threadId != null ? parseInt(threadId) : null;
  const pos = sortOrder != null ? parseInt(sortOrder) : (_stmtMaxBeatOrder.get(parseInt(actId), tid).m + 1);
  const info = _stmtInsertBeat.run(
    parseInt(bookId), parseInt(actId), tid, userEmail, titel, beschreibung, status, verworfen ? 1 : 0,
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

// Map page_id → Anzahl nicht-verworfener Beats, die mit dem Kapitel der Seite
// verknüpft sind. Beats hängen über chapter_id am Kapitel (kein page_id), darum
// wird der Kapitel-Count auf jede Seite des Kapitels projiziert. Speist den
// Plot-Verknüpfungs-Indikator im Notebook-Editor (analog /research/page-counts).
function pageBeatCounts(bookId, userEmail) {
  const rows = db.prepare(`
    SELECT p.page_id AS page_id, COUNT(*) AS n
      FROM plot_beats b
      JOIN pages p ON p.chapter_id = b.chapter_id
     WHERE b.book_id = ? AND b.user_email = ? AND b.verworfen = 0
       AND b.chapter_id IS NOT NULL
     GROUP BY p.page_id
  `).all(parseInt(bookId), userEmail);
  const map = {};
  for (const r of rows) map[r.page_id] = r.n;
  return map;
}

// Map chapter_id → Anzahl nicht-verworfener Beats im Kapitel. Speist den
// Plot-Verknüpfungs-Indikator in der Kapitelansicht (analog zur Page-Variante,
// aber ohne Projektion — Beats hängen direkt am Kapitel).
function chapterBeatCounts(bookId, userEmail) {
  const rows = db.prepare(`
    SELECT chapter_id, COUNT(*) AS n
      FROM plot_beats
     WHERE book_id = ? AND user_email = ? AND verworfen = 0
       AND chapter_id IS NOT NULL
     GROUP BY chapter_id
  `).all(parseInt(bookId), userEmail);
  const map = {};
  for (const r of rows) map[r.chapter_id] = r.n;
  return map;
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

// ── Hybrid-Akte: eigene Aktstruktur pro Strang ──────────────────────────────
// Ein Strang nutzt standardmässig die geteilten Akte (thread_id IS NULL). Er kann
// optional eine EIGENE Aktstruktur bekommen (Klon der geteilten Akte, thread_id = T)
// und später wieder auf die geteilten zurückfallen. „Eigene Akte" wird allein aus
// der Existenz strang-eigener Akte abgeleitet (kein Flag).
const _stmtSharedActsFull = db.prepare(`
  SELECT id, name, farbe, position FROM plot_acts
   WHERE book_id = ? AND user_email = ? AND thread_id IS NULL ORDER BY position, id
`);
const _stmtThreadActs = db.prepare(`
  SELECT id, position FROM plot_acts
   WHERE book_id = ? AND user_email = ? AND thread_id = ? ORDER BY position, id
`);
// Beats eines Strangs, die auf einem bestimmten Akt sitzen, auf einen anderen Akt
// umhängen. thread_id IS ? ist NULL-safe (für Fork/Unfork ist T nie NULL).
const _stmtRemapBeatAct = db.prepare(`
  UPDATE plot_beats SET act_id = ?, updated_at = ${NOW_ISO_SQL}
   WHERE book_id = ? AND user_email = ? AND thread_id IS ? AND act_id = ?
`);
const _stmtPromoteThreadActs = db.prepare(`
  UPDATE plot_acts SET thread_id = NULL, updated_at = ${NOW_ISO_SQL}
   WHERE book_id = ? AND user_email = ? AND thread_id = ?
`);
const _stmtDeleteThreadActs = db.prepare(`
  DELETE FROM plot_acts WHERE book_id = ? AND user_email = ? AND thread_id = ?
`);
const _stmtBeatsInCell = db.prepare(`
  SELECT id FROM plot_beats
   WHERE book_id = ? AND user_email = ? AND act_id = ? AND thread_id IS ? ORDER BY sort_order, id
`);
const _stmtSetBeatSortOnly = db.prepare(`
  UPDATE plot_beats SET sort_order = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);

function threadHasOwnActs(bookId, userEmail, threadId) {
  return _stmtThreadActs.all(parseInt(bookId), userEmail, parseInt(threadId)).length > 0;
}

// Beats eines Strangs von seinen EIGENEN Akten zurück auf die GETEILTEN Akte
// umhängen (positionsweise; Überzahl → letzte geteilte Spalte, dann neu nummeriert)
// und die eigenen Akte löschen. Gibt es keine geteilten Akte, werden die eigenen
// stattdessen zu geteilten befördert (Beats bleiben dran). Plain Function (kein
// eigenes Transaction-Wrapping) — läuft innerhalb der aufrufenden Transaktion.
function _landThreadBeatsOnSharedActs(bookId, userEmail, threadId) {
  const bid = parseInt(bookId);
  const tid = parseInt(threadId);
  const ownActs = _stmtThreadActs.all(bid, userEmail, tid);
  if (!ownActs.length) return; // Strang nutzt bereits geteilte Akte — nichts zu tun.
  const shared = _stmtSharedActsFull.all(bid, userEmail);
  if (!shared.length) {
    // Keine geteilten Akte: eigene Akte zu geteilten befördern (Beats bleiben).
    _stmtPromoteThreadActs.run(bid, userEmail, tid);
    return;
  }
  const targets = new Set();
  ownActs.forEach((own, idx) => {
    const target = shared[Math.min(idx, shared.length - 1)];
    _stmtRemapBeatAct.run(target.id, bid, userEmail, tid, own.id);
    targets.add(target.id);
  });
  // Ziel-Zellen (geteilter Akt × Strang) neu durchnummerieren — mehrere eigene
  // Akte können in dieselbe geteilte Spalte zusammenfallen (sort_order-Kollision).
  for (const targetActId of targets) {
    _stmtBeatsInCell.all(bid, userEmail, targetActId, tid)
      .forEach((b, i) => _stmtSetBeatSortOnly.run(i, b.id));
  }
  _stmtDeleteThreadActs.run(bid, userEmail, tid); // eigene Akte sind jetzt beat-frei.
}

// Strang T bekommt eine eigene Aktstruktur: die geteilten Akte 1:1 klonen
// (thread_id = T) und Ts Beats von den geteilten auf die geklonten Akte umhängen.
// Idempotent (hat T schon eigene Akte → no-op). Wirft NO_SHARED_ACTS, wenn es
// keine geteilten Akte zu klonen gibt (Route deckelt zusätzlich).
const forkThreadActs = db.transaction((bookId, userEmail, threadId) => {
  const bid = parseInt(bookId);
  const tid = parseInt(threadId);
  if (_stmtThreadActs.all(bid, userEmail, tid).length) return; // schon geforkt.
  const shared = _stmtSharedActsFull.all(bid, userEmail);
  if (!shared.length) { const e = new Error('NO_SHARED_ACTS'); e.code = 'NO_SHARED_ACTS'; throw e; }
  for (const a of shared) {
    const info = _stmtInsertAct.run(bid, userEmail, a.name, a.farbe, tid, a.position);
    _stmtRemapBeatAct.run(info.lastInsertRowid, bid, userEmail, tid, a.id);
  }
});

// Strang T zurück auf die geteilten Akte (eigene Aktstruktur auflösen).
const unforkThreadActs = db.transaction((bookId, userEmail, threadId) => {
  _landThreadBeatsOnSharedActs(bookId, userEmail, threadId);
});

// ── Konsistenz-Prüfungs-Historie ────────────────────────────────────────────
// Persistierte Plot-Consistency-Läufe pro (Buch, User). Insert beim Job-Complete
// in routes/jobs/plot.js; List/Get/Delete via /plot/consistency-runs Routes. Die
// Liste kommt ohne result_json (Spaltensparsamkeit bei vielen Einträgen) —
// konflikt_count ist denormalisiert fürs Listen-Rendering; Detail liefert vollen JSON.

const _stmtInsertConsistencyRun = db.prepare(`
  INSERT INTO plot_consistency_runs (book_id, user_email, created_at, konflikt_count, result_json, model)
  VALUES (?, ?, ?, ?, ?, ?)
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
  const now = new Date().toISOString();
  const info = _stmtInsertConsistencyRun.run(
    parseInt(bookId), userEmail, now, parseInt(konfliktCount) || 0, JSON.stringify(result), model
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
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
  const now = new Date().toISOString();
  const info = _stmtInsertBrainstormRun.run(
    parseInt(bookId), userEmail,
    actId != null ? parseInt(actId) : null,
    threadId != null ? parseInt(threadId) : null,
    now, parseInt(vorschlagCount) || 0, JSON.stringify(result), model
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
  listActs, getAct, createAct, updateAct, deleteAct, reorderActs,
  threadHasOwnActs, forkThreadActs, unforkThreadActs,
  listThreads, getThread, createThread, updateThread, deleteThread, reorderThreads, _validThreadId,
  listBeats, getBeat, createBeat, updateBeat, deleteBeat, reorderBeats, pageBeatCounts, chapterBeatCounts,
  resolveFigureIds, resolveDraftFigureIds,
  insertPlotConsistencyRun, listPlotConsistencyRuns, getPlotConsistencyRun, deletePlotConsistencyRun,
  insertPlotBrainstormRun, listPlotBrainstormRuns, getPlotBrainstormRun, deletePlotBrainstormRun,
};
