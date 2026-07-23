'use strict';
// CRUD für die Motiv-Werkstatt (Themen & Motive als Konstellation). Pro Buch +
// User skopiert; der Owner-/ACL-Check geschieht im Route-Handler.
//
// Datenmodell:
//   themes            — abstrakte Cluster (Schuld & Vergebung …), geordnet via position.
//   motifs            — die zentrale Nabe; theme_id (SET NULL) ordnet sie einem Thema zu.
//   motif_relations   — gerichtete Motiv-↔-Motiv-Kanten (typ Freitext).
//   motif_{figures,beats,chapters,pages} — Soll-Brücken (wo ein Motiv laut Plan trägt).
//   motif_occurrences — Ist-Index: wo die KI-Motiverkennung das Motiv real fand.
//
// Figuren werden nach aussen als TEXT-fig_id exponiert (Frontend-Identität, vgl.
// plot_beat_figures); intern liegt der INTEGER-FK figures.id. Die Route löst um.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

// ── Themen ─────────────────────────────────────────────────────────────────

const _stmtListThemes = db.prepare(`
  SELECT id, book_id, user_email, name, beschreibung, farbe, position, created_at, updated_at
    FROM themes
   WHERE book_id = ? AND user_email = ?
   ORDER BY position, id
`);
const _stmtGetTheme = db.prepare('SELECT * FROM themes WHERE id = ?');
const _stmtInsertTheme = db.prepare(`
  INSERT INTO themes (book_id, user_email, name, beschreibung, farbe, position, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
const _stmtUpdateTheme = db.prepare(`
  UPDATE themes SET name = ?, beschreibung = ?, farbe = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);
const _stmtSetThemePos = db.prepare(`
  UPDATE themes SET position = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ? AND book_id = ? AND user_email = ?
`);
const _stmtDeleteTheme = db.prepare('DELETE FROM themes WHERE id = ?');
const _stmtMaxThemePos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM themes WHERE book_id = ? AND user_email = ?');

function listThemes(bookId, userEmail) {
  return _stmtListThemes.all(parseInt(bookId), userEmail);
}
function getTheme(id) {
  return _stmtGetTheme.get(parseInt(id)) || null;
}
function createTheme(bookId, userEmail, { name, beschreibung = null, farbe = null, position = null }) {
  const pos = position != null ? parseInt(position) : (_stmtMaxThemePos.get(parseInt(bookId), userEmail).m + 1);
  const info = _stmtInsertTheme.run(parseInt(bookId), userEmail, name, beschreibung, farbe, pos);
  return getTheme(info.lastInsertRowid);
}
function updateTheme(id, { name, beschreibung = null, farbe = null }) {
  _stmtUpdateTheme.run(name, beschreibung, farbe, parseInt(id));
  return getTheme(id);
}
function deleteTheme(id) {
  // motifs.theme_id hängt via ON DELETE SET NULL dran — Motive bleiben (ohne Thema).
  _stmtDeleteTheme.run(parseInt(id));
}
const reorderThemes = db.transaction((bookId, userEmail, orderedIds) => {
  orderedIds.forEach((tid, idx) => _stmtSetThemePos.run(idx, parseInt(tid), parseInt(bookId), userEmail));
});

// ── Motive ───────────────────────────────────────────────────────────────

const _stmtListMotifs = db.prepare(`
  SELECT id, book_id, user_email, theme_id, name, beschreibung, trigger_terms, farbe, position, created_at, updated_at
    FROM motifs
   WHERE book_id = ? AND user_email = ?
   ORDER BY position, id
`);
const _stmtGetMotif = db.prepare('SELECT * FROM motifs WHERE id = ?');
const _stmtInsertMotif = db.prepare(`
  INSERT INTO motifs (book_id, user_email, theme_id, name, beschreibung, trigger_terms, farbe, position, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
const _stmtUpdateMotif = db.prepare(`
  UPDATE motifs SET theme_id = ?, name = ?, beschreibung = ?, trigger_terms = ?, farbe = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);
const _stmtSetMotifPos = db.prepare(`
  UPDATE motifs SET position = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ? AND book_id = ? AND user_email = ?
`);
const _stmtDeleteMotif = db.prepare('DELETE FROM motifs WHERE id = ?');
const _stmtMaxMotifPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM motifs WHERE book_id = ? AND user_email = ?');

// trigger_terms wird als JSON-Array persistiert. Nach aussen immer als Array.
function _parseTerms(raw) {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()) : []; }
  catch { return []; }
}
function _serializeTerms(terms) {
  if (!Array.isArray(terms)) return null;
  const clean = terms.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
  return clean.length ? JSON.stringify(clean) : null;
}
function _hydrateMotif(row) {
  if (!row) return null;
  return { ...row, trigger_terms: _parseTerms(row.trigger_terms) };
}

function listMotifs(bookId, userEmail) {
  return _stmtListMotifs.all(parseInt(bookId), userEmail).map(_hydrateMotif);
}
function getMotif(id) {
  return _hydrateMotif(_stmtGetMotif.get(parseInt(id)) || null);
}
function createMotif(bookId, userEmail, { themeId = null, name, beschreibung = null, triggerTerms = null, farbe = null, position = null }) {
  const pos = position != null ? parseInt(position) : (_stmtMaxMotifPos.get(parseInt(bookId), userEmail).m + 1);
  const info = _stmtInsertMotif.run(
    parseInt(bookId), userEmail,
    themeId != null ? parseInt(themeId) : null,
    name, beschreibung, _serializeTerms(triggerTerms), farbe, pos,
  );
  return getMotif(info.lastInsertRowid);
}
function updateMotif(id, { themeId = null, name, beschreibung = null, triggerTerms = null, farbe = null }) {
  _stmtUpdateMotif.run(
    themeId != null ? parseInt(themeId) : null,
    name, beschreibung, _serializeTerms(triggerTerms), farbe, parseInt(id),
  );
  return getMotif(id);
}
function deleteMotif(id) {
  // motif_relations / Bridges / motif_occurrences hängen via CASCADE dran.
  _stmtDeleteMotif.run(parseInt(id));
}
const reorderMotifs = db.transaction((bookId, userEmail, orderedIds) => {
  orderedIds.forEach((mid, idx) => _stmtSetMotifPos.run(idx, parseInt(mid), parseInt(bookId), userEmail));
});

// ── Motiv-Beziehungen (Motiv ↔ Motiv) ──────────────────────────────────────

const _stmtListRelations = db.prepare(`
  SELECT r.id, r.from_motif_id, r.to_motif_id, r.typ, r.created_at
    FROM motif_relations r
    JOIN motifs mf ON mf.id = r.from_motif_id
   WHERE mf.book_id = ? AND mf.user_email = ?
   ORDER BY r.id
`);
const _stmtInsertRelation = db.prepare(`
  INSERT OR IGNORE INTO motif_relations (from_motif_id, to_motif_id, typ, created_at)
  VALUES (?, ?, ?, ${NOW_ISO_SQL})
`);
const _stmtDeleteRelation = db.prepare('DELETE FROM motif_relations WHERE id = ?');

function listRelations(bookId, userEmail) {
  return _stmtListRelations.all(parseInt(bookId), userEmail);
}
// Owner/Buch der Beziehung über das Quell-Motiv (für den ACL-Check beim Löschen).
const _stmtRelationOwner = db.prepare(`
  SELECT m.book_id, m.user_email
    FROM motif_relations r JOIN motifs m ON m.id = r.from_motif_id
   WHERE r.id = ?
`);
function getRelationOwner(id) {
  return _stmtRelationOwner.get(parseInt(id)) || null;
}
function createRelation(fromMotifId, toMotifId, typ) {
  // INSERT OR IGNORE: bei Duplikat (UNIQUE) ist changes=0; lastInsertRowid bleibt
  // dann auf dem vorherigen Insert stehen → nur bei echtem Insert die ID liefern.
  const info = _stmtInsertRelation.run(parseInt(fromMotifId), parseInt(toMotifId), String(typ));
  return info.changes ? info.lastInsertRowid : null;
}
function deleteRelation(id) {
  _stmtDeleteRelation.run(parseInt(id));
}

// ── Soll-Brücken (Figur / Beat / Kapitel / Seite) ──────────────────────────
// Setter sind Full-Replace pro Motiv (Transaktion: alle Links löschen, neu setzen).
// Alle IDs sind bereits INTEGER-FKs (Route hat fig_id → figures.id aufgelöst).

function _makeBridge(table, col) {
  const del = db.prepare(`DELETE FROM ${table} WHERE motif_id = ?`);
  const ins = db.prepare(`INSERT OR IGNORE INTO ${table} (motif_id, ${col}) VALUES (?, ?)`);
  const set = db.transaction((motifId, ids) => {
    del.run(parseInt(motifId));
    for (const id of ids || []) {
      if (id == null) continue;
      ins.run(parseInt(motifId), parseInt(id));
    }
  });
  return set;
}
const setMotifFigures = _makeBridge('motif_figures', 'figure_id');
const setMotifDraftFigures = _makeBridge('motif_draft_figures', 'draft_figure_id');
const setMotifBeats = _makeBridge('motif_beats', 'beat_id');
const setMotifChapters = _makeBridge('motif_chapters', 'chapter_id');
const setMotifPages = _makeBridge('motif_pages', 'page_id');

// Alle Bridge-Links für die Motive eines Buches am Stück laden → Map motif_id → {…}.
// Anzeige-Label (fig_id/Name/Titel) per JOIN zur Lesezeit (kein Snapshot) — der
// Graph und das Seitenpanel rendern Namen ohne Cross-Store-Lookup. figure: TEXT-
// fig_id nach aussen (Frontend-Identität), plus Name.
const _stmtBridgeFigures = db.prepare(`
  SELECT mf.motif_id, f.fig_id, f.name
    FROM motif_figures mf
    JOIN motifs m ON m.id = mf.motif_id
    JOIN figures f ON f.id = mf.figure_id
   WHERE m.book_id = ? AND m.user_email = ?
`);
const _stmtBridgeDraftFigures = db.prepare(`
  SELECT mdf.motif_id, mdf.draft_figure_id, d.name
    FROM motif_draft_figures mdf
    JOIN motifs m ON m.id = mdf.motif_id
    JOIN draft_figures d ON d.id = mdf.draft_figure_id
   WHERE m.book_id = ? AND m.user_email = ?
`);
const _stmtBridgeBeats = db.prepare(`
  SELECT mb.motif_id, mb.beat_id, b.titel
    FROM motif_beats mb
    JOIN motifs m ON m.id = mb.motif_id
    JOIN plot_beats b ON b.id = mb.beat_id
   WHERE m.book_id = ? AND m.user_email = ?
`);
const _stmtBridgeChapters = db.prepare(`
  SELECT mc.motif_id, mc.chapter_id, c.chapter_name
    FROM motif_chapters mc
    JOIN motifs m ON m.id = mc.motif_id
    JOIN chapters c ON c.chapter_id = mc.chapter_id
   WHERE m.book_id = ? AND m.user_email = ?
`);
const _stmtBridgePages = db.prepare(`
  SELECT mp.motif_id, mp.page_id, p.page_name
    FROM motif_pages mp
    JOIN motifs m ON m.id = mp.motif_id
    JOIN pages p ON p.page_id = mp.page_id
   WHERE m.book_id = ? AND m.user_email = ?
`);

// ── Ist-Index (motif_occurrences) ──────────────────────────────────────────

const _stmtDeleteOccForMotif = db.prepare('DELETE FROM motif_occurrences WHERE motif_id = ?');
const _stmtInsertOcc = db.prepare(`
  INSERT INTO motif_occurrences (motif_id, book_id, kind, page_id, scene_id, score, snippet, source, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
`);

// Full-Replace der Fundstellen eines Motivs (ein Scan-Ergebnis). rows:
// [{ kind:'page'|'scene', pageId?, sceneId?, score, snippet, source }].
const replaceOccurrences = db.transaction((motifId, bookId, rows) => {
  _stmtDeleteOccForMotif.run(parseInt(motifId));
  for (const r of rows || []) {
    const isPage = r.kind === 'page';
    _stmtInsertOcc.run(
      parseInt(motifId), parseInt(bookId), r.kind,
      isPage ? parseInt(r.pageId) : null,
      isPage ? null : parseInt(r.sceneId),
      r.score != null ? Number(r.score) : null,
      r.snippet != null ? String(r.snippet).slice(0, 500) : null,
      r.source,
    );
  }
});

// Fundstellen-Zahl pro Motiv fürs Graph-Rendering (Ist-Dichte). Optionaler Score-
// Floor blendet schwache semantische Treffer aus (Ist-Dichte + Geist-Erkennung
// respektieren die Schwelle live); wörtliche Trigger-Treffer (score=null) zählen immer.
// avg_score = mittlere Übereinstimmung der Fundstellen (Cosinus 0..1); wörtliche
// Trigger-Treffer (score=null) sind exakte Matches → als 1.0 (100%) gewertet.
// Beides fliesst in die Graph-Knotengrösse (Dichte × Übereinstimmung).
const _stmtOccCounts = db.prepare(`
  SELECT o.motif_id, COUNT(*) AS n, AVG(COALESCE(o.score, 1.0)) AS avg_score
    FROM motif_occurrences o
    JOIN motifs m ON m.id = o.motif_id
   WHERE m.book_id = ? AND m.user_email = ?
   GROUP BY o.motif_id
`);
const _stmtOccCountsFloor = db.prepare(`
  SELECT o.motif_id, COUNT(*) AS n, AVG(COALESCE(o.score, 1.0)) AS avg_score
    FROM motif_occurrences o
    JOIN motifs m ON m.id = o.motif_id
   WHERE m.book_id = ? AND m.user_email = ?
     AND (o.score IS NULL OR o.score >= ?)
   GROUP BY o.motif_id
`);
// Fundstellen-Detail eines Motivs (Seiten- + Szenen-Kontext via JOIN, kein Snapshot).
const _stmtOccDetail = db.prepare(`
  SELECT o.id, o.kind, o.page_id, o.scene_id, o.score, o.snippet, o.source,
         p.page_name, p.chapter_id, c.chapter_name, s.titel AS scene_titel
    FROM motif_occurrences o
    LEFT JOIN pages p    ON p.page_id = o.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id
    LEFT JOIN figure_scenes s ON s.id = o.scene_id
   WHERE o.motif_id = ?
   ORDER BY o.score DESC, o.id
`);

// minScore: Cosinus-Floor (0 = aus) — blendet schwache semantische Treffer aus.
// Wörtliche Trigger-Treffer (score=null) sind nie vom Floor betroffen (Exakt-Match).
function listOccurrences(motifId, minScore = 0) {
  const rows = _stmtOccDetail.all(parseInt(motifId));
  const floor = Number(minScore) || 0;
  if (floor <= 0) return rows;
  return rows.filter(r => r.score == null || r.score >= floor);
}

// ── Scoping-Validatoren (Soll-Link-Targets aufs Buch beschränken) ──────────
// Verhindert Cross-Book-Leaks (FK allein liesse ein Motiv aus Buch A auf eine
// Seite aus Buch B zeigen). Figuren nach aussen als TEXT-fig_id → INTEGER id.

const _stmtFigByFigId = db.prepare('SELECT id FROM figures WHERE book_id = ? AND fig_id = ?');
const _stmtFigById = db.prepare('SELECT id FROM figures WHERE book_id = ? AND id = ?');
function resolveFigureIds(bookId, figIds) {
  const bid = parseInt(bookId);
  const out = [];
  for (const raw of figIds || []) {
    if (raw == null) continue;
    // Erst als TEXT-fig_id versuchen, dann als INTEGER-id (Frontend schickt fig_id).
    let row = _stmtFigByFigId.get(bid, String(raw));
    if (!row && /^\d+$/.test(String(raw))) row = _stmtFigById.get(bid, parseInt(raw));
    if (row) out.push(row.id);
  }
  return [...new Set(out)];
}

function _filterIds(sql, bookId, ids, extra = []) {
  const stmt = db.prepare(sql);
  const bid = parseInt(bookId);
  const out = [];
  for (const raw of ids || []) {
    if (raw == null || !/^\d+$/.test(String(raw))) continue;
    if (stmt.get(bid, parseInt(raw), ...extra)) out.push(parseInt(raw));
  }
  return [...new Set(out)];
}
function validBeatIds(bookId, userEmail, beatIds) {
  return _filterIds('SELECT 1 FROM plot_beats WHERE book_id = ? AND id = ? AND user_email = ?', bookId, beatIds, [userEmail]);
}
function validDraftFigureIds(bookId, userEmail, draftFigureIds) {
  return _filterIds('SELECT 1 FROM draft_figures WHERE book_id = ? AND id = ? AND user_email = ?', bookId, draftFigureIds, [userEmail]);
}
function validChapterIds(bookId, chapterIds) {
  return _filterIds('SELECT 1 FROM chapters WHERE book_id = ? AND chapter_id = ?', bookId, chapterIds);
}
function validPageIds(bookId, pageIds) {
  return _filterIds('SELECT 1 FROM pages WHERE book_id = ? AND page_id = ?', bookId, pageIds);
}

// ── Graph-Layout (manuelle Knoten-Positionen, View-Präferenz pro Buch + User) ──
// Ein JSON-Blob node_id → {x,y}. node_id ist ein Render-Token ("m12"/"t3"/…), kein
// FK-fähiges Ziel; die gezogene Anordnung ist reine Ansicht (kein Snapshot von Daten).

const _stmtGetLayout = db.prepare('SELECT positions_json FROM motif_graph_layout WHERE book_id = ? AND user_email = ?');
const _stmtUpsertLayout = db.prepare(`
  INSERT INTO motif_graph_layout (book_id, user_email, positions_json, updated_at)
  VALUES (?, ?, ?, ${NOW_ISO_SQL})
  ON CONFLICT (book_id, user_email) DO UPDATE SET positions_json = excluded.positions_json, updated_at = ${NOW_ISO_SQL}
`);

function getLayout(bookId, userEmail) {
  const row = _stmtGetLayout.get(parseInt(bookId), userEmail);
  if (!row?.positions_json) return {};
  try { const v = JSON.parse(row.positions_json); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
  catch { return {}; }
}
function saveLayout(bookId, userEmail, positions) {
  _stmtUpsertLayout.run(parseInt(bookId), userEmail, JSON.stringify(positions || {}));
}

// ── KI-Brainstorm-Lauf-Historie ─────────────────────────────────────────────
// Persistierte Motiv-Brainstorm-Läufe pro (Buch, User). Insert beim Job-Complete
// in routes/jobs/motif-brainstorm.js; List/Get/Delete via /motifs/brainstorm-runs
// Routes. Die Liste kommt ohne result_json (Spaltensparsamkeit bei vielen
// Einträgen) — vorschlag_count ist denormalisiert fürs Listen-Rendering; das
// Detail liefert die vollen Vorschläge. Buchweit, kein Sub-Scope (der Brainstorm
// schlägt neue Motive/Themen vor, hängt an keinem einzelnen Motiv).

const _stmtInsertBrainstormRun = db.prepare(`
  INSERT INTO motif_brainstorm_runs (book_id, user_email, created_at, vorschlag_count, result_json, model)
  VALUES (?, ?, ${NOW_ISO_SQL}, ?, ?, ?)
`);
const _stmtListBrainstormRuns = db.prepare(`
  SELECT id, book_id, created_at, vorschlag_count, model
    FROM motif_brainstorm_runs
   WHERE book_id = ? AND user_email = ?
   ORDER BY created_at DESC, id DESC
`);
const _stmtGetBrainstormRun = db.prepare(`
  SELECT id, book_id, user_email, created_at, vorschlag_count, result_json, model
    FROM motif_brainstorm_runs
   WHERE id = ?
`);
const _stmtDeleteBrainstormRun = db.prepare('DELETE FROM motif_brainstorm_runs WHERE id = ? AND user_email = ?');

function insertBrainstormRun({ bookId, userEmail, vorschlagCount = 0, result, model = null }) {
  const info = _stmtInsertBrainstormRun.run(
    parseInt(bookId), userEmail, parseInt(vorschlagCount) || 0, JSON.stringify(result), model,
  );
  return info.lastInsertRowid;
}
function listBrainstormRuns(bookId, userEmail) {
  return _stmtListBrainstormRuns.all(parseInt(bookId), userEmail);
}
function getBrainstormRun(id) {
  const r = _stmtGetBrainstormRun.get(parseInt(id));
  if (!r) return null;
  let result = null;
  try { result = JSON.parse(r.result_json); } catch { result = null; }
  return {
    id: r.id, book_id: r.book_id, user_email: r.user_email,
    created_at: r.created_at, vorschlag_count: r.vorschlag_count,
    result, model: r.model,
  };
}
function deleteBrainstormRun(id, userEmail) {
  return _stmtDeleteBrainstormRun.run(parseInt(id), userEmail).changes;
}

// ── KI-Brainstorm Delta-Cache ────────────────────────────────────────────────
// Pro Chunk (Kapitel bzw. __singlepass__) der rohe Modell-Output, keyed auf
// pages_sig (page_id:updated_at + Settings + Kapitelname + Modell/Prompt-Version).
// pages_sig ist NICHT im PK → INSERT OR REPLACE ueberschreibt die Chunk-Zeile bei
// Aenderung (keine Akkumulation). Analog chapter_extract_cache. Roher Output VOR
// seen-Dedup — die Dedup laeuft jeden Lauf frisch (siehe motif-brainstorm.js).
const _stmtLoadBrainstormCache = db.prepare(`
  SELECT result_json FROM motif_brainstorm_cache
   WHERE book_id = ? AND user_email = ? AND provider = ? AND chunk_key = ? AND pages_sig = ?
`);
const _stmtSaveBrainstormCache = db.prepare(`
  INSERT OR REPLACE INTO motif_brainstorm_cache
    (book_id, user_email, provider, chunk_key, pages_sig, result_json, cached_at)
  VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
`);
const _stmtDeleteBrainstormCache = db.prepare(
  'DELETE FROM motif_brainstorm_cache WHERE book_id = ? AND user_email = ?'
);

function loadBrainstormCache(bookId, userEmail, chunkKey, pagesSig, provider = '') {
  const row = _stmtLoadBrainstormCache.get(parseInt(bookId), userEmail || '', provider || '', chunkKey, pagesSig);
  if (!row) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}
function saveBrainstormCache(bookId, userEmail, chunkKey, pagesSig, result, provider = '') {
  _stmtSaveBrainstormCache.run(
    parseInt(bookId), userEmail || '', provider || '', chunkKey, pagesSig, JSON.stringify(result),
  );
}
function deleteBrainstormCache(bookId, userEmail) {
  return _stmtDeleteBrainstormCache.run(parseInt(bookId), userEmail || '').changes;
}

// ── Graph-Payload ───────────────────────────────────────────────────────────
// Ein Aufruf liefert alles fürs Konstellations-Rendering: Themen, Motive (jeweils
// mit Soll-Links + Ist-Count), Beziehungen, plus das persistierte Knoten-Layout.
// minScore: Cosinus-Floor (0 = aus) — schwache semantische Treffer fallen aus Ist-
// Dichte (Knotengrösse), Geist-Erkennung und Peek-Popover. Wörtliche Trigger-Treffer
// (score=null) bleiben immer. Gefiltert am Lese-Chokepoint → wirkt ohne Scan-Neulauf.
function getGraph(bookId, userEmail, minScore = 0) {
  const bid = parseInt(bookId);
  const floor = Number(minScore) || 0;
  const themes = listThemes(bid, userEmail);
  const motifs = listMotifs(bid, userEmail);
  const relations = listRelations(bid, userEmail);

  const byMotif = new Map(motifs.map(m => [m.id, {
    ...m, figures: [], draftFigures: [], beats: [], chapters: [], pages: [], occurrenceCount: 0, occAvgScore: 0,
  }]));
  for (const r of _stmtBridgeFigures.all(bid, userEmail)) byMotif.get(r.motif_id)?.figures.push({ figId: r.fig_id, name: r.name });
  for (const r of _stmtBridgeDraftFigures.all(bid, userEmail)) byMotif.get(r.motif_id)?.draftFigures.push({ id: r.draft_figure_id, name: r.name });
  for (const r of _stmtBridgeBeats.all(bid, userEmail)) byMotif.get(r.motif_id)?.beats.push({ id: r.beat_id, titel: r.titel });
  for (const r of _stmtBridgeChapters.all(bid, userEmail)) byMotif.get(r.motif_id)?.chapters.push({ id: r.chapter_id, name: r.chapter_name });
  for (const r of _stmtBridgePages.all(bid, userEmail)) byMotif.get(r.motif_id)?.pages.push({ id: r.page_id, name: r.page_name });
  const counts = floor > 0 ? _stmtOccCountsFloor.all(bid, userEmail, floor) : _stmtOccCounts.all(bid, userEmail);
  for (const r of counts) { const m = byMotif.get(r.motif_id); if (m) { m.occurrenceCount = r.n; m.occAvgScore = r.avg_score || 0; } }

  return { themes, motifs: [...byMotif.values()], relations, layout: getLayout(bid, userEmail) };
}

module.exports = {
  // Themen
  listThemes, getTheme, createTheme, updateTheme, deleteTheme, reorderThemes,
  // Motive
  listMotifs, getMotif, createMotif, updateMotif, deleteMotif, reorderMotifs,
  // Beziehungen
  listRelations, createRelation, deleteRelation, getRelationOwner,
  // Soll-Brücken
  setMotifFigures, setMotifDraftFigures, setMotifBeats, setMotifChapters, setMotifPages,
  resolveFigureIds, validBeatIds, validDraftFigureIds, validChapterIds, validPageIds,
  // Ist-Index
  replaceOccurrences, listOccurrences,
  // KI-Brainstorm-Lauf-Historie
  insertBrainstormRun, listBrainstormRuns, getBrainstormRun, deleteBrainstormRun,
  // KI-Brainstorm Delta-Cache
  loadBrainstormCache, saveBrainstormCache, deleteBrainstormCache,
  // Graph-Layout (View-Präferenz)
  getLayout, saveLayout,
  // Aggregat
  getGraph,
};
