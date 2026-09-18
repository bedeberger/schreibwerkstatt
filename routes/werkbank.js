'use strict';
// Werkbank — die Ansicht, die die drei Werkstätten zusammen liest.
//
// Why: Figuren-, Plot- und Motiv-Werkstatt beantworten je ihre eigene Frage.
// Die Frage einer Autorin lautet aber nicht „wie steht mein Plot", sondern
// „Figur X will A und braucht B — wo im Plot wird das herausgefordert, und
// welches Motiv trägt es". Diese Frage kreuzt alle drei, und bisher liess sie
// sich nur im Kopf beantworten.
//
// KEIN eigener Index, read-time: `plot_beats`, `motif_*` und
// `draft_figure_occurrences` SIND bereits die abgeleiteten Stände — ein vierter
// wäre eine vierte Wahrheit, die nach jedem Lauf invalidiert werden müsste
// (gleiches Muster wie das Autorenprofil und der Buch-Befund in
// db/narrative-report.js). Darum auch kein Job und kein `callAI`.
//
// Zwei Sichten, ein Bestand:
//   GET /werkbank          → Figuren × Akte (die Matrix)
//   GET /werkbank/befunde  → die gemessenen Befunde aller drei Werkstätten
// Beide lesen dieselben Quellen; ein zweiter Lesepfad zeigte zwei Bestände.

const express = require('express');
const plotDb = require('../db/plot');
const motifsDb = require('../db/motifs');
const draftDb = require('../db/draft-figures');
const occDb = require('../db/draft-figure-occurrences');
const contentStore = require('../lib/content-store');
const appSettings = require('../lib/app-settings');
const { extractPsychologie, PSYCHE_KERNE } = require('../lib/draft-mindmap-extract');
const { computeArcFindings } = require('../lib/figure-arc');
const { computeMotifFindings } = require('../lib/motif-consistency');
const { computeTimeFindings } = require('../lib/plot-time-consistency');
const { yearFromString, bookYearSpan } = require('../lib/figure-years');
const { listFigurenWithDetails } = require('../db/schema');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const { setContext } = require('../lib/log-context');
const logger = require('../logger');

const router = express.Router();

function _scope(req, res) {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.query.book_id);
  if (!bookId) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  setContext({ book: bookId });
  // Planende Werkzeuge: `editor`, wie Plot- und Motiv-Werkstatt selbst.
  if (!guardBook(req, res, bookId, 'editor')) return null;
  return { bookId, userEmail };
}

// Kapitel-Reihenfolge über die Content-Store-Facade (kein Direkt-SQL auf
// `chapters`), wortgleich mit routes/motifs.js und routes/draft-figures.js.
function _chapterOrder(tree) {
  const out = [];
  (function walk(chapters) {
    for (const c of chapters || []) { out.push(c.id); walk(c.subchapters); }
  })(tree?.chapters);
  return out;
}

// Board-Lesereihenfolge eines Beats: Akt-Position, dann sort_order. Dieselbe
// Ordnung, die das Board zeichnet — die Zeit-Messung urteilt über genau sie.
function _beatOrder(acts, beats) {
  const actPos = new Map(acts.map((a, i) => [a.id, a.position ?? i]));
  return [...beats]
    .sort((a, b) => ((actPos.get(a.act_id) ?? 0) - (actPos.get(b.act_id) ?? 0))
                 || ((a.sort_order ?? 0) - (b.sort_order ?? 0))
                 || (a.id - b.id))
    .map((b, i) => ({ ...b, ordnung: i }));
}

// Eine Figur der Werkbank. `key` ist die Zeilen-Identität der Matrix und trägt
// die Herkunft im Präfix, weil Katalog-IDs TEXT und Draft-IDs INTEGER sind —
// ohne Präfix kollidierten sie (dieselbe Konvention wie die Figuren-Combobox
// des Beat-Edits, `fig:` / `draft:`).
function _figureRow(kind, id, name, extra = {}) {
  return { key: `${kind}:${id}`, kind, id, name, beats: {}, motive: [], beatCount: 0, activeBeatCount: 0, ...extra };
}

// ── Matrix: Figuren × Akte ──────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const ctx = _scope(req, res);
  if (!ctx) return;
  const { bookId, userEmail } = ctx;
  try {
    const acts = plotDb.listActs(bookId, userEmail);
    const beats = _beatOrder(acts, plotDb.listBeats(bookId, userEmail));
    const drafts = draftDb.listDraftFigures(bookId, userEmail);
    // `listFigurenWithDetails` liefert die Katalog-Figur unter ihrer TEXT-fig_id
    // (`id`) — dieselbe Identitaet, die `plot_beat_figures` nach aussen gibt und
    // die `draft_figures.source_fig_id` traegt. Damit braucht die Werkbank keine
    // eigene TEXT/INTEGER-Uebersetzung.
    const katalog = (listFigurenWithDetails(bookId, userEmail) || {}).figuren || [];

    // Eine Werkstatt-Figur MIT Quell-Figur ist EINE Zeile, nicht zwei: genau
    // dafür gibt es `source_figure_id`. Ohne diese Zusammenführung stünde
    // dieselbe Figur zweimal im Raster, einmal mit Plan und einmal mit Text.
    const draftBySource = new Map();
    const rows = [];
    for (const d of drafts) {
      const psy = extractPsychologie(d.mindmap);
      const geplant = {};
      for (const k of PSYCHE_KERNE) geplant[k] = !!(psy && psy[k] && psy[k].length);
      const row = _figureRow('draft', d.id, d.name, {
        archetype: d.archetype || null,
        source_figure_id: d.source_figure_id || null,
        geplant,
      });
      rows.push(row);
      if (d.source_fig_id) draftBySource.set(d.source_fig_id, row);
    }
    const katalogRowByFigId = new Map();
    for (const f of katalog) {
      // Verknuepfte Katalog-Figur: KEINE eigene Zeile, sondern dieselbe wie ihr
      // Draft — sonst stuende dieselbe Figur zweimal im Raster, einmal mit Plan
      // und einmal mit Text. Genau dafuer gibt es `source_figure_id`.
      const linked = draftBySource.get(f.id);
      if (linked) { katalogRowByFigId.set(f.id, linked); continue; }
      const row = _figureRow('katalog', f.id, f.name, { typ: f.typ || null });
      rows.push(row);
      katalogRowByFigId.set(f.id, row);
    }

    // Beats auf die Zeilen verteilen — über BEIDE Brücken, damit eine
    // zusammengeführte Figur die Beats aus Katalog- und Werkstatt-Seite trägt.
    const rowByDraftId = new Map(rows.filter(r => r.kind === 'draft').map(r => [r.id, r]));
    for (const b of beats) {
      const targets = new Set();
      for (const fid of (b.fig_ids || [])) { const r = katalogRowByFigId.get(fid); if (r) targets.add(r); }
      for (const did of (b.draft_fig_ids || [])) { const r = rowByDraftId.get(did); if (r) targets.add(r); }
      for (const r of targets) {
        (r.beats[b.act_id] ||= []).push({
          id: b.id, titel: b.titel, status: b.status, verworfen: b.verworfen,
          zeit: b.zeit || null, intensitaet: b.intensitaet || null,
        });
        r.beatCount++;
        if (!b.verworfen) r.activeBeatCount++;
      }
    }

    // Motive je Figur (Soll-Seite der Motiv-Werkstatt). EIN buchweiter Griff
    // statt eines Aufrufs pro Zeile: `bridgeRows` liefert beide Figuren-Brücken
    // (`motif_figures` über die TEXT-fig_id, `motif_draft_figures` über die
    // Draft-id) auf einmal — genau die zwei Achsen, die die Matrix ohnehin
    // schon fürs Verteilen der Beats führt.
    //
    // `figureMotifUsage` taugt hier NICHT: es erwartet die INTEGER-figures.id,
    // und eine reine Katalog-Zeile hat nur ihre fig_id. Mit null/null käme sie
    // still ohne Motive zurück — ein Fehler, den man erst am leeren Raster sieht.
    const graph = motifsDb.getGraph(bookId, userEmail, Number(appSettings.get('motif.scan.min_score')) || 0);
    const motifById = new Map((graph.motifs || []).map(m => [m.id, m]));
    const bridges = motifsDb.bridgeRows(bookId, userEmail);
    const pushMotif = (row, motifId) => {
      if (!row) return;
      const m = motifById.get(motifId);
      if (!m || row.motive.some(x => x.id === motifId)) return;
      row.motive.push({ id: m.id, name: m.name, farbe: m.farbe || null, ist: m.occurrenceCount || 0 });
    };
    for (const r of bridges.figures) pushMotif(katalogRowByFigId.get(r.fig_id), r.motif_id);
    for (const r of bridges.draftFigures) pushMotif(rowByDraftId.get(r.draft_figure_id), r.motif_id);

    // Bogen-Ist je Werkstatt-Figur (nur dort: der Katalog hat keinen Plan, den
    // man gegen den Text stellen könnte).
    const floor = Number(appSettings.get('werkstatt.anchor.min_score')) || 0;
    const counts = new Map();
    for (const c of occDb.occCounts(bookId, userEmail, floor)) {
      if (!counts.has(c.draft_id)) counts.set(c.draft_id, {});
      counts.get(c.draft_id)[c.kern] = c.n;
    }
    for (const r of rows) if (r.kind === 'draft') r.counts = counts.get(r.id) || {};

    res.json({
      akte: acts.map(a => ({ id: a.id, name: a.name, farbe: a.farbe, archiviert: a.archiviert, position: a.position })),
      figuren: rows,
      kerne: PSYCHE_KERNE,
      scanned: occDb.hasDraftOccurrences(bookId, userEmail),
    });
  } catch (e) {
    logger.error(`[werkbank] Matrix fehlgeschlagen book=${bookId}: ${e.message}`, { stack: e.stack });
    res.status(500).json({ error_code: 'WERKBANK_FAILED' });
  }
});

// ── Befunde: die gemessenen Aussagen aller drei Werkstätten ─────────────────
//
// Nur die MESSUNGEN. Die KI-Urteile bleiben, wo sie hingehören — sie kosten
// Geld und gehören zu ihrem Gegenstand; hier stünden sie ohne den Kontext, der
// sie lesbar macht. Jeder Befund trägt `werkstatt` (figur|plot|motiv) und
// `quelle: 'messung'` (aus den Engines), damit die Herkunft sichtbar bleibt.
router.get('/befunde', async (req, res) => {
  const ctx = _scope(req, res);
  if (!ctx) return;
  const { bookId, userEmail } = ctx;
  try {
    const chapterOrder = _chapterOrder(await contentStore.bookTree(bookId, req));

    // 1. Motive — Kanten gegen den Ist-Index.
    const graph = motifsDb.getGraph(bookId, userEmail, Number(appSettings.get('motif.scan.min_score')) || 0);
    const motifScanned = motifsDb.hasOccurrences(bookId, userEmail);
    const motivBefunde = computeMotifFindings({
      motifs: graph.motifs, relations: graph.relations, chapterOrder, scanned: motifScanned,
    }).map(f => ({ ...f, werkstatt: 'motiv' }));

    // 2. Figurenbogen — Mindmap-Kerne gegen den Ist-Index.
    const floor = Number(appSettings.get('werkstatt.anchor.min_score')) || 0;
    const arcScanned = occDb.hasDraftOccurrences(bookId, userEmail);
    const counts = new Map();
    for (const c of occDb.occCounts(bookId, userEmail, floor)) {
      if (!counts.has(c.draft_id)) counts.set(c.draft_id, {});
      counts.get(c.draft_id)[c.kern] = c.n;
    }
    const chapters = new Map();
    for (const c of occDb.occChapters(bookId, userEmail)) {
      if (c.chapter_id == null) continue;
      if (!chapters.has(c.draft_id)) chapters.set(c.draft_id, {});
      (chapters.get(c.draft_id)[c.kern] ||= []).push({ chapterId: c.chapter_id, n: c.n });
    }
    const arcDrafts = draftDb.listDraftFigures(bookId, userEmail).map(d => {
      const psy = extractPsychologie(d.mindmap);
      const geplant = {};
      for (const k of PSYCHE_KERNE) geplant[k] = !!(psy && psy[k] && psy[k].length);
      return { id: d.id, name: d.name, geplant, counts: counts.get(d.id) || {}, occ: chapters.get(d.id) || {} };
    });
    const figurBefunde = computeArcFindings({ drafts: arcDrafts, chapterOrder, scanned: arcScanned })
      .map(f => ({ ...f, werkstatt: 'figur' }));

    // 3. Zeit — datierte Beats gegen Geburtsjahre und Board-Reihenfolge. Das
    //    Geburtsjahr kommt aus derselben SSoT wie Alters-Analyse und Lebenslauf
    //    (lib/figure-years.js); ohne echte Zeitlinie liefert sie null, und dann
    //    gibt es keinen Alters-Befund — nur den Chronologie-Teil.
    const acts = plotDb.listActs(bookId, userEmail);
    const beats = _beatOrder(acts, plotDb.listBeats(bookId, userEmail))
      .map(b => ({ ...b, jahr: yearFromString(b.zeit) }));
    // Das Geburtsjahr liefert `listFigurenWithDetails` bereits aufgeloest (es
    // ruft intern dieselbe SSoT lib/figure-years.js, die auch die Alters-Analyse
    // und der Lebenslauf lesen) — eine zweite Aufloesung hier waere eine zweite
    // Rechnung ueber dieselbe Frage. Ohne echte Zeitlinie ist `geburtsjahr` null
    // und es entsteht nur der Chronologie-Teil der Messung.
    const figMap = new Map();
    for (const f of ((listFigurenWithDetails(bookId, userEmail) || {}).figuren || [])) {
      if (f.geburtsjahr != null) figMap.set(f.id, { name: f.name, geburtsjahr: f.geburtsjahr });
    }
    const plotBefunde = computeTimeFindings({
      beats, figures: figMap, bookSpan: bookYearSpan(bookId, userEmail),
    }).map(f => ({ ...f, werkstatt: 'plot' }));

    res.json({
      befunde: [...figurBefunde, ...plotBefunde, ...motivBefunde],
      // Jede Werkstatt sagt fuer sich, ob sie ueberhaupt gemessen hat —
      // UNGESCANNT IST UNGEPRUEFT, NICHT ABWESEND, und eine leere Liste ohne
      // diesen Zusatz waere als „alles in Ordnung" lesbar.
      scanned: { motiv: motifScanned, figur: arcScanned, plot: beats.some(b => Number.isFinite(b.jahr)) },
    });
  } catch (e) {
    logger.error(`[werkbank] Befunde fehlgeschlagen book=${bookId}: ${e.message}`, { stack: e.stack });
    res.status(500).json({ error_code: 'WERKBANK_BEFUNDE_FAILED' });
  }
});

module.exports = router;
