'use strict';
// Figuren-fokussierte Tools: Pronomenzählung, Auftritte, Beziehungen, Voll-Profil.

const { db } = require('../../../db/schema');
const { _truncateResult, _findFigure } = require('./shared');

// ── count_pronouns ────────────────────────────────────────────────────────────

const PRONOUN_KEYS = ['ich', 'du', 'er', 'sie_sg', 'wir', 'ihr_pl', 'man'];

function _aggregatePronounsFromRows(rows, filterKeys) {
  const agg = {};
  for (const k of filterKeys) agg[k] = { narr: 0, dlg: 0 };
  for (const r of rows) {
    if (!r.pronoun_counts) continue;
    let parsed;
    try { parsed = JSON.parse(r.pronoun_counts); } catch { continue; }
    for (const k of filterKeys) {
      const v = parsed[k];
      if (!v) continue;
      agg[k].narr += v.narr || 0;
      agg[k].dlg  += v.dlg  || 0;
    }
  }
  return agg;
}

function tool_count_pronouns(input, ctx) {
  const perChapter = !!input.per_chapter;
  const filterKeys = Array.isArray(input.pronouns) && input.pronouns.length
    ? input.pronouns.filter(p => PRONOUN_KEYS.includes(p))
    : PRONOUN_KEYS;

  if (!perChapter) {
    const rows = db.prepare(
      'SELECT pronoun_counts FROM page_stats WHERE book_id = ? AND pronoun_counts IS NOT NULL'
    ).all(ctx.bookId);
    const counts = _aggregatePronounsFromRows(rows, filterKeys);
    return { counts, scope: 'book', pronouns: filterKeys, pages_indexed: rows.length };
  }

  // Pro Kapitel aggregieren
  const rows = db.prepare(`
    SELECT p.chapter_id, c.chapter_name, ps.pronoun_counts
    FROM page_stats ps
    JOIN pages p      ON p.page_id = ps.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE ps.book_id = ? AND ps.pronoun_counts IS NOT NULL
  `).all(ctx.bookId);
  const byChapter = new Map();
  for (const r of rows) {
    const key = r.chapter_id ?? 0;
    if (!byChapter.has(key)) {
      byChapter.set(key, { chapter_id: r.chapter_id, chapter_name: r.chapter_name || '(ohne Kapitel)', rows: [] });
    }
    byChapter.get(key).rows.push(r);
  }
  const chapters = [...byChapter.values()]
    .sort((a, b) => (a.chapter_id ?? 0) - (b.chapter_id ?? 0))
    .map(ch => ({
      chapter_id: ch.chapter_id,
      chapter_name: ch.chapter_name,
      counts: _aggregatePronounsFromRows(ch.rows, filterKeys),
    }));
  return { chapters, scope: 'chapters', pronouns: filterKeys };
}

// ── get_figure_mentions ───────────────────────────────────────────────────────

function tool_get_figure_mentions(input, ctx) {
  const figRow = _findFigure(input, ctx);
  if (!figRow) {
    return { error: 'Figur nicht gefunden', hint: 'Prüfe die Figurenliste im System-Prompt.' };
  }

  const mentions = db.prepare(`
    SELECT p.page_id, p.page_name, p.chapter_id, c.chapter_name, pfm.count, pfm.first_offset
    FROM page_figure_mentions pfm
    JOIN pages p      ON p.page_id = pfm.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE pfm.figure_id = ? AND p.book_id = ?
    ORDER BY p.chapter_id, p.page_id
  `).all(figRow.id, ctx.bookId);

  if (!mentions.length) {
    return {
      fig_id: figRow.fig_id,
      name: figRow.name,
      total_mentions: 0,
      note: 'Keine Index-Erwähnungen vorhanden. Führe Komplettanalyse oder Sync aus, um den Figuren-Index zu aktualisieren.',
    };
  }

  const total = mentions.reduce((s, m) => s + m.count, 0);
  const first = mentions[0];
  const last  = mentions[mentions.length - 1];

  const byChapter = new Map();
  for (const m of mentions) {
    const key = m.chapter_id ?? 0;
    if (!byChapter.has(key)) byChapter.set(key, { chapter_id: m.chapter_id, chapter_name: m.chapter_name || '(ohne Kapitel)', count: 0, pages: [] });
    const ch = byChapter.get(key);
    ch.count += m.count;
    ch.pages.push({ page_id: m.page_id, page_name: m.page_name, count: m.count });
  }

  return _truncateResult({
    fig_id: figRow.fig_id,
    name: figRow.name,
    total_mentions: total,
    pages_with_mention: mentions.length,
    first_appearance: {
      chapter_id: first.chapter_id,
      chapter_name: first.chapter_name || '(ohne Kapitel)',
      page_id: first.page_id,
      page_name: first.page_name,
      count: first.count,
    },
    last_appearance: {
      chapter_id: last.chapter_id,
      chapter_name: last.chapter_name || '(ohne Kapitel)',
      page_id: last.page_id,
      page_name: last.page_name,
      count: last.count,
    },
    by_chapter: [...byChapter.values()],
  });
}

// ── get_figure_relations ──────────────────────────────────────────────────────

function tool_get_figure_relations(input, ctx) {
  const userEmail = ctx.userEmail || null;
  let focus = null;
  if (input?.figur_id || input?.figur_name) {
    focus = _findFigure(input, ctx);
    if (!focus) return { error: 'Figur nicht gefunden', hint: 'Prüfe die Figurenliste im System-Prompt.' };
  }

  const rows = db.prepare(`
    SELECT ff.fig_id   AS from_fig_id, ff.name AS from_name,
           ft.fig_id   AS to_fig_id,   ft.name AS to_name,
           r.typ, r.beschreibung, r.machtverhaltnis, r.belege
    FROM figure_relations r
    JOIN figures ff ON ff.id = r.from_fig_id
    JOIN figures ft ON ft.id = r.to_fig_id
    WHERE r.book_id = ? AND r.user_email IS ?
    ORDER BY ff.name, ft.name
  `).all(ctx.bookId, userEmail);

  const filtered = focus
    ? rows.filter(r => r.from_fig_id === focus.fig_id || r.to_fig_id === focus.fig_id)
    : rows;

  const edges = filtered.map(r => {
    let belege = [];
    if (r.belege) { try { belege = JSON.parse(r.belege) || []; } catch { belege = []; } }
    return {
      from: { fig_id: r.from_fig_id, name: r.from_name },
      to:   { fig_id: r.to_fig_id,   name: r.to_name },
      typ: r.typ,
      beschreibung: r.beschreibung || null,
      machtverhaltnis: r.machtverhaltnis ?? null,
      belege: Array.isArray(belege) ? belege.slice(0, 3) : [],
    };
  });

  const nodeIds = new Set();
  for (const e of edges) { nodeIds.add(e.from.fig_id); nodeIds.add(e.to.fig_id); }
  const nodes = nodeIds.size
    ? db.prepare(
        `SELECT fig_id, name, kurzname, typ FROM figures
           WHERE book_id = ? AND user_email IS ?
             AND fig_id IN (${[...nodeIds].map(() => '?').join(',')})`
      ).all(ctx.bookId, userEmail, ...nodeIds)
    : [];

  return _truncateResult({
    ...(focus ? { focus: { fig_id: focus.fig_id, name: focus.name } } : {}),
    edges,
    nodes,
    total: edges.length,
    ...(rows.length === 0
      ? { hint: 'Keine Beziehungen vorhanden. Komplettanalyse (Soziogramm) noch nicht ausgeführt.' }
      : {}),
  });
}

// ── get_figure_profile ────────────────────────────────────────────────────────

function tool_get_figure_profile(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const figRow = _findFigure(input, ctx);
  if (!figRow) return { error: 'Figur nicht gefunden', hint: 'Prüfe die Figurenliste im System-Prompt.' };

  const f = db.prepare(`
    SELECT * FROM figures WHERE id = ?
  `).get(figRow.id);

  const tags = db.prepare('SELECT tag FROM figure_tags WHERE figure_id = ?').all(figRow.id).map(t => t.tag);

  const appearances = db.prepare(`
    SELECT fa.chapter_id, c.chapter_name, fa.haeufigkeit
    FROM figure_appearances fa
    LEFT JOIN chapters c ON c.chapter_id = fa.chapter_id
    WHERE fa.figure_id = ?
    ORDER BY fa.chapter_id
  `).all(figRow.id);

  const events = db.prepare(`
    SELECT fe.datum, fe.ereignis, fe.bedeutung, fe.typ,
           fe.chapter_id, c.chapter_name,
           fe.page_id, p.page_name
    FROM figure_events fe
    LEFT JOIN chapters c ON c.chapter_id = fe.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fe.page_id
    WHERE fe.figure_id = ?
    ORDER BY fe.sort_order, fe.datum
  `).all(figRow.id);

  const scenes = db.prepare(`
    SELECT fs.id, fs.titel, fs.wertung, fs.kommentar,
           fs.chapter_id, c.chapter_name,
           fs.page_id, p.page_name
    FROM figure_scenes fs
    JOIN scene_figures sf ON sf.scene_id = fs.id
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fs.page_id
    WHERE sf.figure_id = ? AND fs.book_id = ? AND fs.user_email IS ?
    ORDER BY fs.sort_order
  `).all(figRow.id, ctx.bookId, userEmail);

  const relations = db.prepare(`
    SELECT ff.fig_id AS from_fig_id, ff.name AS from_name,
           ft.fig_id AS to_fig_id,   ft.name AS to_name,
           r.typ, r.beschreibung, r.machtverhaltnis
    FROM figure_relations r
    JOIN figures ff ON ff.id = r.from_fig_id
    JOIN figures ft ON ft.id = r.to_fig_id
    WHERE r.book_id = ? AND r.user_email IS ?
      AND (ff.id = ? OR ft.id = ?)
  `).all(ctx.bookId, userEmail, figRow.id, figRow.id);

  let zitate = [];
  if (f.schluesselzitate) { try { zitate = JSON.parse(f.schluesselzitate) || []; } catch { zitate = []; } }

  return _truncateResult({
    fig_id: f.fig_id,
    name: f.name,
    kurzname: f.kurzname || null,
    typ: f.typ || null,
    geburtstag: f.geburtstag || null,
    geschlecht: f.geschlecht || null,
    beruf: f.beruf || null,
    wohnadresse: f.wohnadresse || null,
    beschreibung: f.beschreibung || null,
    sozialschicht: f.sozialschicht || null,
    praesenz: f.praesenz || null,
    rolle: f.rolle || null,
    motivation: f.motivation || null,
    konflikt: f.konflikt || null,
    entwicklung: f.entwicklung || null,
    erste_erwaehnung: f.erste_erwaehnung || null,
    erste_erwaehnung_page_id: f.erste_erwaehnung_page_id || null,
    eigenschaften: tags,
    schluesselzitate: Array.isArray(zitate) ? zitate : [],
    kapitel: appearances.map(a => ({ chapter_id: a.chapter_id, chapter_name: a.chapter_name, haeufigkeit: a.haeufigkeit })),
    lebensereignisse: events.map(e => ({
      datum: e.datum,
      ereignis: e.ereignis,
      bedeutung: e.bedeutung || null,
      typ: e.typ || 'persoenlich',
      chapter_id: e.chapter_id, chapter_name: e.chapter_name || null,
      page_id: e.page_id,       page_name: e.page_name || null,
    })),
    szenen: scenes.map(s => ({
      scene_id: s.id, titel: s.titel, wertung: s.wertung || null, kommentar: s.kommentar || null,
      chapter_id: s.chapter_id, chapter_name: s.chapter_name || null,
      page_id: s.page_id, page_name: s.page_name || null,
    })),
    beziehungen: relations.map(r => ({
      from: { fig_id: r.from_fig_id, name: r.from_name },
      to:   { fig_id: r.to_fig_id,   name: r.to_name },
      typ: r.typ, beschreibung: r.beschreibung || null,
      machtverhaltnis: r.machtverhaltnis ?? null,
    })),
  });
}

module.exports = {
  tool_count_pronouns,
  tool_get_figure_mentions,
  tool_get_figure_relations,
  tool_get_figure_profile,
};
