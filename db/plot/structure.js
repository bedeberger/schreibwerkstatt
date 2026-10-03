'use strict';
// Board-Struktur der Plot-Werkstatt (Facade: db/plot.js): Akte (Spalten),
// Handlungsstränge (Swimlanes), Hybrid-Akte (eigene Aktstruktur pro Strang) und
// die Lückenlos-Nummerierung von Akt-Scopes und Beat-Zellen.

const { db } = require('../connection');
const { NOW_ISO_SQL } = require('../now');
const { _codedError, _posInt } = require('./shared');

// ── Akte ─────────────────────────────────────────────────────────────────────

// thread_id NULL = geteilter Akt (Default, flaches Board + Stränge ohne eigene
// Akte); thread_id = T = Akt gehört nur Strang T (Hybrid-Akte, Migration 193).
const _stmtListActs = db.prepare(`
  SELECT id, book_id, user_email, name, farbe, thread_id, archiviert, position, created_at, updated_at
    FROM plot_acts
   WHERE book_id = ? AND user_email = ?
   ORDER BY position, id
`);
const _stmtInsertAct = db.prepare(`
  INSERT INTO plot_acts (book_id, user_email, name, farbe, thread_id, archiviert, position, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
const _stmtGetAct = db.prepare('SELECT * FROM plot_acts WHERE id = ?');
const _stmtUpdateAct = db.prepare(`
  UPDATE plot_acts SET name = ?, farbe = ?, archiviert = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?
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

// threadId gesetzt → strang-eigener Akt. Die Route lässt das nur für Stränge zu,
// die schon eigene Akte haben (THREAD_NOT_FORKED) — sonst entstünde ein Strang
// mit genau einem eigenen Akt, dessen übrige Beats auf geteilten Akten säßen.
function createAct(bookId, userEmail, { name, farbe = null, threadId = null, archiviert = 0, position = null }) {
  const tid = threadId != null ? parseInt(threadId) : null;
  const pos = position != null ? parseInt(position) : (_stmtMaxActPos.get(parseInt(bookId), userEmail, tid).m + 1);
  const info = _stmtInsertAct.run(parseInt(bookId), userEmail, name, farbe, tid, archiviert ? 1 : 0, pos);
  return getAct(info.lastInsertRowid);
}

// archiviert wird wie name/farbe als Vollwert übergeben (der Route-Handler füllt
// nicht übergebene Felder aus dem geladenen Akt auf) — ein Teil-UPDATE mit
// dynamischem SET-Fragment lohnt bei drei Spalten nicht.
function updateAct(id, { name, farbe = null, archiviert = 0 }) {
  _stmtUpdateAct.run(name, farbe, archiviert ? 1 : 0, parseInt(id));
  return getAct(id);
}

const _stmtActsInScope = db.prepare(`
  SELECT id, position FROM plot_acts
   WHERE book_id = ? AND user_email = ? AND thread_id IS ? ORDER BY position, id
`);
const _stmtSetActPosOnly = db.prepare(`UPDATE plot_acts SET position = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?`);

// Akt-Scope (geteilt = thread_id NULL, sonst die Akte EINES Strangs) lückenlos
// 0..n durchnummerieren. `firstIds` (optional) kommen in genau dieser Reihenfolge
// zuerst, der Rest des Scopes folgt in seiner bisherigen Ordnung. Schreibt nur
// Zeilen, deren Position sich ändert.
function _renumberActScope(bookId, userEmail, threadId, firstIds = []) {
  const rows = _stmtActsInScope.all(parseInt(bookId), userEmail, threadId != null ? parseInt(threadId) : null);
  const byId = new Map(rows.map(r => [r.id, r]));
  const head = firstIds.filter(id => byId.has(id));
  const headSet = new Set(head);
  const ordered = [...head.map(id => byId.get(id)), ...rows.filter(r => !headSet.has(r.id))];
  ordered.forEach((r, i) => { if (r.position !== i) _stmtSetActPosOnly.run(i, r.id); });
}

// Akt löschen. plot_beats hängen via ON DELETE CASCADE dran — sie verschwinden mit
// dem Akt. Danach den Scope des Akts neu nummerieren (Position bleibt lückenlos).
const deleteAct = db.transaction((id) => {
  const act = _stmtGetAct.get(parseInt(id));
  _stmtDeleteAct.run(parseInt(id));
  if (act) _renumberActScope(act.book_id, act.user_email, act.thread_id);
});

// Akt-Reihenfolge neu setzen (Pfeil-Buttons, Undo). orderedIds = Akt-IDs EINES
// Scopes in Zielreihenfolge. Alle IDs müssen zu (Buch, User) gehören (sonst
// ACT_MISMATCH) und denselben Scope teilen (sonst ACT_SCOPE_MIXED) — eine
// Position ist nur innerhalb eines Scopes definiert. Nicht genannte Akte des
// Scopes rücken lückenlos dahinter. Wirft → nichts geschrieben.
const reorderActs = db.transaction((bookId, userEmail, orderedIds) => {
  if (!Array.isArray(orderedIds)) throw _codedError('ORDER_INVALID');
  const ids = orderedIds.map(_posInt);
  if (ids.some(id => id == null) || new Set(ids).size !== ids.length) throw _codedError('ORDER_INVALID');
  if (!ids.length) return;
  let scope;
  for (const id of ids) {
    const act = _stmtGetAct.get(id);
    if (!act || act.book_id !== parseInt(bookId) || act.user_email !== userEmail) throw _codedError('ACT_MISMATCH');
    const s = act.thread_id ?? null;
    if (scope === undefined) scope = s;
    else if (s !== scope) throw _codedError('ACT_SCOPE_MIXED');
  }
  _renumberActScope(bookId, userEmail, scope, ids);
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
// Nach dem Löschen fallen die Beats via SET NULL in die „ohne Strang"-Zellen
// derselben Akte; ihre sort_order kollidierte dort mit den vorhandenen Beats.
// Darum je betroffenem Akt die Ziel-Reihenfolge vorab festhalten (bestehende
// „ohne Strang"-Beats zuerst, die Strang-Beats dahinter) und nach dem Delete
// lückenlos schreiben.
const _stmtThreadBeatActs = db.prepare(`
  SELECT DISTINCT act_id FROM plot_beats WHERE book_id = ? AND user_email = ? AND thread_id = ?
`);
const deleteThread = db.transaction((id) => {
  const t = _stmtGetThread.get(parseInt(id));
  const plan = [];
  if (t) {
    _landThreadBeatsOnSharedActs(t.book_id, t.user_email, t.id);
    for (const { act_id } of _stmtThreadBeatActs.all(t.book_id, t.user_email, t.id)) {
      const ids = [
        ..._stmtBeatsInCell.all(t.book_id, t.user_email, act_id, null).map(b => b.id),
        ..._stmtBeatsInCell.all(t.book_id, t.user_email, act_id, t.id).map(b => b.id),
      ];
      plan.push(ids);
    }
  }
  _stmtDeleteThread.run(parseInt(id));
  for (const ids of plan) ids.forEach((beatId, i) => _stmtSetBeatSortOnly.run(i, beatId));
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

// Hybrid-Invariante: passt ein Akt zu einem Strang (bzw. zur „ohne Strang"-Lane)?
//   - „ohne Strang" (threadId null): nur geteilte Akte.
//   - Strang MIT eigenen Akten (abgeleitet: ∃ Akt mit thread_id = T): NUR dessen
//     eigene Akte — ein geforkter Strang zeigt die geteilten Spalten nicht mehr,
//     ein Beat dort wäre unsichtbar.
//   - Strang OHNE eigene Akte: nur geteilte Akte.
// Erwartet einen bereits aufs (Buch, User) geprüften Akt und eine validierte threadId.
function actFitsThread(act, threadId) {
  if (!act) return false;
  const tid = threadId != null ? parseInt(threadId) : null;
  if (tid == null) return act.thread_id == null;
  if (threadHasOwnActs(act.book_id, act.user_email, tid)) return act.thread_id === tid;
  return act.thread_id == null;
}

// ── Hybrid-Akte: eigene Aktstruktur pro Strang ──────────────────────────────
// Ein Strang nutzt standardmässig die geteilten Akte (thread_id IS NULL). Er kann
// optional eine EIGENE Aktstruktur bekommen (Klon der geteilten Akte, thread_id = T)
// und später wieder auf die geteilten zurückfallen. „Eigene Akte" wird allein aus
// der Existenz strang-eigener Akte abgeleitet (kein Flag).
const _stmtSharedActsFull = db.prepare(`
  SELECT id, name, farbe, archiviert, position FROM plot_acts
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
  SELECT id, sort_order FROM plot_beats
   WHERE book_id = ? AND user_email = ? AND act_id = ? AND thread_id IS ? ORDER BY sort_order, id
`);
const _stmtSetBeatSortOnly = db.prepare(`
  UPDATE plot_beats SET sort_order = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);

// Zelle (act_id, thread_id) lückenlos 0..n durchnummerieren. `firstIds`
// (optional) kommen in genau dieser Reihenfolge zuerst, der Rest der Zelle folgt
// in seiner bisherigen Ordnung. Schreibt nur Zeilen, deren sort_order sich
// ändert. Plain Function — läuft in der Transaktion des Aufrufers.
function _renumberCell(bookId, userEmail, actId, threadId, firstIds = []) {
  const rows = _stmtBeatsInCell.all(parseInt(bookId), userEmail, parseInt(actId), threadId != null ? parseInt(threadId) : null);
  const byId = new Map(rows.map(r => [r.id, r]));
  const head = firstIds.filter(id => byId.has(id));
  const headSet = new Set(head);
  const ordered = [...head.map(id => byId.get(id)), ...rows.filter(r => !headSet.has(r.id))];
  ordered.forEach((r, i) => { if (r.sort_order !== i) _stmtSetBeatSortOnly.run(i, r.id); });
}

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
    // Der Klon erbt archiviert — sonst tauchte ein abgeschlossener Akt beim
    // Fork im Strang wieder als offene Spalte auf.
    const info = _stmtInsertAct.run(bid, userEmail, a.name, a.farbe, tid, a.archiviert ? 1 : 0, a.position);
    _stmtRemapBeatAct.run(info.lastInsertRowid, bid, userEmail, tid, a.id);
  }
});

// Strang T zurück auf die geteilten Akte (eigene Aktstruktur auflösen).
const unforkThreadActs = db.transaction((bookId, userEmail, threadId) => {
  _landThreadBeatsOnSharedActs(bookId, userEmail, threadId);
});

module.exports = {
  listActs, getAct, createAct, updateAct, deleteAct, reorderActs,
  threadHasOwnActs, forkThreadActs, unforkThreadActs,
  listThreads, getThread, createThread, updateThread, deleteThread, reorderThreads,
  _validThreadId, actFitsThread, _renumberCell,
};
