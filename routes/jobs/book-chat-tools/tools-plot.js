'use strict';
// Plot-Werkstatt-Tool: liefert das geplante Beat-Board (Akte → Beats) als
// kompakten Snapshot. Planendes Pendant zur rueckwaertsgewandten Szenen-Analyse —
// zeigt, was der User VORHAT, nicht was schon im Manuskript steht. Pro Buch + User
// skopiert (kein geteilter Katalog). Read-only, kein KI-Call.

const { db } = require('../../../db/schema');
const { listActs, listBeats } = require('../../../db/plot');
const { listDraftFigures } = require('../../../db/draft-figures');
const { _truncateResult } = require('./shared');

const BEAT_DESC_PREVIEW = 600;
const BEAT_STATUS = ['geplant', 'entwurf', 'im_buch', 'verworfen'];

// fig_id (TEXT, Frontend-Identitaet) → Anzeigename, aufs (Buch, User)-Subset
// gescoped — analog zu db/plot.js#resolveFigureIds.
function _figureNameMap(bookId, userEmail) {
  const map = {};
  for (const r of db.prepare(
    'SELECT fig_id, name, kurzname FROM figures WHERE book_id = ? AND user_email = ?'
  ).all(bookId, userEmail)) {
    map[r.fig_id] = r.name || r.kurzname || r.fig_id;
  }
  return map;
}

// draft_figures.id (INTEGER) → Name. listDraftFigures ist bereits (Buch, User)-gescoped.
function _draftFigureNameMap(bookId, userEmail) {
  const map = {};
  for (const d of listDraftFigures(bookId, userEmail)) map[d.id] = d.name;
  return map;
}

function tool_get_plot_board(input, ctx) {
  const userEmail = ctx.userEmail || '';
  const acts = listActs(ctx.bookId, userEmail);
  if (!acts.length) {
    return {
      acts: [],
      total_acts: 0,
      total_beats: 0,
      hint: 'Keine Plot-Werkstatt vorhanden. Der User plant die Handlung als Beat-Board (Akte → Beats) ueber die Plot-Karte (tile.plot). Leeres Board ≠ Buch ohne Handlung — es heisst nur, dass der User keine separate Plot-Planung angelegt hat.',
    };
  }

  const statusFilter = BEAT_STATUS.includes(input?.status) ? input.status : null;
  const actFilter = Number.isInteger(input?.act_id) ? input.act_id : null;

  const allBeats = listBeats(ctx.bookId, userEmail);
  const figNames = _figureNameMap(ctx.bookId, userEmail);
  const draftNames = _draftFigureNameMap(ctx.bookId, userEmail);

  // Statusverteilung ueber das GANZE Board (vor Filter) — gibt dem Modell die
  // Gesamtsicht „wie viel geplant vs. schon im Buch".
  const statusCounts = { geplant: 0, entwurf: 0, im_buch: 0, verworfen: 0 };
  for (const b of allBeats) {
    if (statusCounts[b.status] != null) statusCounts[b.status]++;
  }

  const beatsByAct = new Map();
  for (const b of allBeats) {
    if (statusFilter && b.status !== statusFilter) continue;
    if (!beatsByAct.has(b.act_id)) beatsByAct.set(b.act_id, []);
    beatsByAct.get(b.act_id).push({
      id: b.id,
      titel: b.titel,
      beschreibung: b.beschreibung && b.beschreibung.length > BEAT_DESC_PREVIEW
        ? b.beschreibung.slice(0, BEAT_DESC_PREVIEW) + '…'
        : (b.beschreibung || null),
      status: b.status,
      chapter_id: b.chapter_id || null,
      chapter_name: b.chapter_name || null,
      figures: (b.fig_ids || []).map(fid => figNames[fid] || fid),
      werkstatt_figures: (b.draft_fig_ids || []).map(did => draftNames[did]).filter(Boolean),
    });
  }

  const actList = acts
    .filter(a => actFilter == null || a.id === actFilter)
    .map(a => {
      const beats = beatsByAct.get(a.id) || [];
      return {
        id: a.id,
        name: a.name,
        ...(a.farbe ? { farbe: a.farbe } : {}),
        beat_count: beats.length,
        beats,
      };
    });

  return _truncateResult({
    acts: actList,
    total_acts: acts.length,
    total_beats: allBeats.length,
    status_counts: statusCounts,
    ...(statusFilter ? { status_filter: statusFilter } : {}),
    status_legende: 'geplant = noch nicht geschrieben · entwurf = in Arbeit · im_buch = im Manuskript umgesetzt · verworfen = aufgegeben',
  });
}

module.exports = {
  tool_get_plot_board,
};
