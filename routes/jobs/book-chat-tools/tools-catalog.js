'use strict';
// Listing-/Lookup-Tools: Buch-Inventar (Kapitel, Figuren, Orte, Szenen,
// Ideen, Buch-Settings, Revisionen). Reines DB-Aggregat, kein BookStack-
// Roundtrip. Temporal-Tools (Kontinuitaet/Zeitstrahl) liegen in tools-timeline.js.

const { db, getBookSettings } = require('../../../db/schema');
const { inClause } = require('../../../lib/validate');
const { narrativeLabels } = require('../narrative-labels');
const pageRevisions = require('../../../db/page-revisions');
const { _truncateResult, _findFigure } = require('./shared');

// ── list_chapters ────────────────────────────────────────────────────────────

function tool_list_chapters(_input, ctx) {
  const chapterRows = db.prepare(`
    SELECT c.chapter_id, c.chapter_name,
           COUNT(p.page_id)            AS page_count,
           COALESCE(SUM(ps.words), 0)  AS words,
           COALESCE(SUM(ps.chars), 0)  AS chars
    FROM chapters c
    LEFT JOIN pages p      ON p.chapter_id = c.chapter_id AND p.book_id = c.book_id
    LEFT JOIN page_stats ps ON ps.page_id = p.page_id
    WHERE c.book_id = ?
    GROUP BY c.chapter_id, c.chapter_name
    ORDER BY c.chapter_id
  `).all(ctx.bookId);

  // Seiten mit ihren Kapitelzuordnungen laden – inkl. Seiten ohne Kapitel (chapter_id IS NULL)
  const pageRows = db.prepare(`
    SELECT p.page_id, p.page_name, p.chapter_id, COALESCE(ps.words, 0) AS words
    FROM pages p
    LEFT JOIN page_stats ps ON ps.page_id = p.page_id
    WHERE p.book_id = ?
    ORDER BY p.chapter_id, p.page_id
  `).all(ctx.bookId);

  const pagesByChapter = new Map();
  const orphanPages = [];
  let totalWords = 0, totalPages = 0;
  for (const p of pageRows) {
    totalPages++;
    totalWords += p.words;
    const entry = { page_id: p.page_id, page_name: p.page_name, words: p.words };
    if (p.chapter_id == null) orphanPages.push(entry);
    else {
      if (!pagesByChapter.has(p.chapter_id)) pagesByChapter.set(p.chapter_id, []);
      pagesByChapter.get(p.chapter_id).push(entry);
    }
  }

  const chapters = chapterRows.map(r => ({
    chapter_id:   r.chapter_id,
    chapter_name: r.chapter_name,
    page_count:   r.page_count,
    words:        r.words,
    pages:        pagesByChapter.get(r.chapter_id) || [],
  }));

  return _truncateResult({
    chapters,
    ...(orphanPages.length ? { pages_without_chapter: orphanPages } : {}),
    total_pages: totalPages,
    total_words: totalWords,
    hint: totalWords < 12000
      ? 'Kleines Buch – du kannst alle Seiten via get_pages laden, wenn das für die Frage sinnvoll ist.'
      : undefined,
  });
}

// ── list_ideen ────────────────────────────────────────────────────────────────

const IDEEN_DEFAULT_LIMIT = 50;
const IDEEN_CONTENT_CHARS = 400;

function tool_list_ideen(input, ctx) {
  const userEmail = ctx.userEmail || '';
  const erledigtFilter = typeof input?.erledigt === 'boolean' ? (input.erledigt ? 1 : 0) : null;
  const pageFilter    = Number.isInteger(input?.page_id)    ? input.page_id    : null;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
  const limit = Math.min(200, Math.max(1, Number.isInteger(input?.limit) ? input.limit : IDEEN_DEFAULT_LIMIT));

  // Ideen können entweder an einer Seite oder an einem Kapitel hängen (XOR).
  // `effective_chapter_id` deckt beide Quellen ab: direkt-am-Kapitel-Idee
  // (i.chapter_id) ODER an einer Seite, die zum Kapitel gehört (p.chapter_id).
  let sql = `
    SELECT i.id, i.content, i.erledigt, i.erledigt_at, i.created_at, i.updated_at,
           i.page_id, p.page_name,
           COALESCE(i.chapter_id, p.chapter_id) AS effective_chapter_id,
           COALESCE(cc.chapter_name, cp.chapter_name) AS chapter_name,
           CASE WHEN i.page_id IS NOT NULL THEN 'page' ELSE 'chapter' END AS scope
    FROM ideen i
    LEFT JOIN pages    p  ON p.page_id    = i.page_id
    LEFT JOIN chapters cc ON cc.chapter_id = i.chapter_id AND cc.book_id = i.book_id
    LEFT JOIN chapters cp ON cp.chapter_id = p.chapter_id AND cp.book_id = i.book_id
    WHERE i.book_id = ? AND i.user_email = ?
  `;
  const params = [ctx.bookId, userEmail];
  if (erledigtFilter !== null) { sql += ' AND i.erledigt = ?'; params.push(erledigtFilter); }
  if (pageFilter    !== null) { sql += ' AND i.page_id = ?'; params.push(pageFilter); }
  if (chapterFilter !== null) {
    sql += ' AND COALESCE(i.chapter_id, p.chapter_id) = ?';
    params.push(chapterFilter);
  }
  sql += ' ORDER BY i.erledigt ASC, i.updated_at DESC, i.id DESC';

  const rows = db.prepare(sql).all(...params);
  if (!rows.length) return { ideen: [], total: 0 };

  const total = rows.length;
  const limited = rows.slice(0, limit).map(r => ({
    id: r.id,
    scope: r.scope,
    content: r.content && r.content.length > IDEEN_CONTENT_CHARS
      ? r.content.slice(0, IDEEN_CONTENT_CHARS) + '…'
      : (r.content || ''),
    erledigt: !!r.erledigt,
    erledigt_at: r.erledigt_at || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    page_id: r.page_id,
    page_name: r.page_name || null,
    chapter_id: r.effective_chapter_id ?? null,
    chapter_name: r.chapter_name || null,
  }));

  const offen = rows.filter(r => !r.erledigt).length;
  return _truncateResult({
    ideen: limited,
    total,
    offen,
    erledigt: total - offen,
    ...(limited.length < total ? { truncated: true, shown: limited.length } : {}),
  });
}

// ── list_locations ────────────────────────────────────────────────────────────

function tool_list_locations(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;

  let sql = `
    SELECT l.id, l.loc_id, l.name, l.typ, l.beschreibung, l.stimmung,
           l.erste_erwaehnung, l.erste_erwaehnung_page_id, p.page_name AS erste_erwaehnung_page_name
    FROM locations l
    LEFT JOIN pages p ON p.page_id = l.erste_erwaehnung_page_id
    WHERE l.book_id = ? AND l.user_email IS ?
  `;
  const params = [ctx.bookId, userEmail];
  if (chapterFilter !== null) {
    sql = `
      SELECT DISTINCT l.id, l.loc_id, l.name, l.typ, l.beschreibung, l.stimmung,
             l.erste_erwaehnung, l.erste_erwaehnung_page_id, p.page_name AS erste_erwaehnung_page_name
      FROM locations l
      LEFT JOIN pages p ON p.page_id = l.erste_erwaehnung_page_id
      JOIN location_chapters lc ON lc.location_id = l.id
      WHERE l.book_id = ? AND l.user_email IS ? AND lc.chapter_id = ?
    `;
    params.push(chapterFilter);
  }
  sql += ' ORDER BY l.sort_order, l.id';

  const rows = db.prepare(sql).all(...params);
  if (!rows.length) {
    return { locations: [], hint: 'Keine Orte vorhanden. Komplettanalyse ausführen.' };
  }

  const locIds = rows.map(r => r.id);
  const { sql: idSql, values: idVals } = inClause(locIds);

  const chRows = db.prepare(`
    SELECT lc.location_id, lc.chapter_id, c.chapter_name, lc.haeufigkeit
    FROM location_chapters lc
    LEFT JOIN chapters c ON c.chapter_id = lc.chapter_id
    WHERE lc.location_id IN ${idSql}
    ORDER BY lc.location_id, lc.chapter_id
  `).all(...idVals);
  const fgRows = db.prepare(`
    SELECT lf.location_id, lf.fig_id, f.name
    FROM location_figures lf
    LEFT JOIN figures f ON f.fig_id = lf.fig_id AND f.book_id = ? AND f.user_email IS ?
    WHERE lf.location_id IN ${idSql}
  `).all(ctx.bookId, userEmail, ...idVals);

  const chByLoc = new Map();
  for (const r of chRows) {
    if (!chByLoc.has(r.location_id)) chByLoc.set(r.location_id, []);
    chByLoc.get(r.location_id).push({ chapter_id: r.chapter_id, chapter_name: r.chapter_name || null, haeufigkeit: r.haeufigkeit });
  }
  const fgByLoc = new Map();
  for (const r of fgRows) {
    if (!fgByLoc.has(r.location_id)) fgByLoc.set(r.location_id, []);
    fgByLoc.get(r.location_id).push({ fig_id: r.fig_id, name: r.name || null });
  }

  return _truncateResult({
    locations: rows.map(r => {
      const kap = chByLoc.get(r.id) || [];
      return {
        loc_id: r.loc_id,
        name: r.name,
        typ: r.typ || null,
        beschreibung: r.beschreibung || null,
        stimmung: r.stimmung || null,
        erste_erwaehnung: r.erste_erwaehnung || null,
        erste_erwaehnung_page_id: r.erste_erwaehnung_page_id || null,
        erste_erwaehnung_page_name: r.erste_erwaehnung_page_name || null,
        kapitel: kap,
        last_chapter: kap.length ? kap[kap.length - 1] : null,
        figuren: fgByLoc.get(r.id) || [],
      };
    }),
    total: rows.length,
  });
}

// ── list_scenes ───────────────────────────────────────────────────────────────

const SCENES_DEFAULT_LIMIT = 50;

function tool_list_scenes(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
  const pageFilter    = Number.isInteger(input?.page_id)    ? input.page_id    : null;
  const limit = Math.min(200, Math.max(1, Number.isInteger(input?.limit) ? input.limit : SCENES_DEFAULT_LIMIT));

  let figFilterId = null;
  if (input?.figur_id || input?.figur_name) {
    const figRow = _findFigure(input, ctx);
    if (!figRow) return { error: 'Figur nicht gefunden' };
    figFilterId = figRow.id;
  }
  let locFilterId = null;
  if (input?.loc_id) {
    const locRow = db.prepare(
      'SELECT id FROM locations WHERE book_id = ? AND loc_id = ? AND user_email IS ?'
    ).get(ctx.bookId, input.loc_id, userEmail);
    if (!locRow) return { error: 'Ort nicht gefunden' };
    locFilterId = locRow.id;
  }

  let sql = `
    SELECT fs.id, fs.titel, fs.wertung, fs.kommentar, fs.sort_order,
           fs.chapter_id, c.chapter_name,
           fs.page_id, p.page_name
    FROM figure_scenes fs
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fs.page_id
    WHERE fs.book_id = ? AND fs.user_email IS ?
  `;
  const params = [ctx.bookId, userEmail];
  if (chapterFilter !== null) { sql += ' AND fs.chapter_id = ?'; params.push(chapterFilter); }
  if (pageFilter    !== null) { sql += ' AND fs.page_id = ?';    params.push(pageFilter); }
  if (figFilterId   !== null) {
    sql += ' AND fs.id IN (SELECT scene_id FROM scene_figures WHERE figure_id = ?)';
    params.push(figFilterId);
  }
  if (locFilterId !== null) {
    sql += ' AND fs.id IN (SELECT scene_id FROM scene_locations WHERE location_id = ?)';
    params.push(locFilterId);
  }
  sql += ' ORDER BY fs.sort_order, fs.id';

  const rows = db.prepare(sql).all(...params);
  if (!rows.length) return { scenes: [], total: 0, hint: 'Keine Szenen für diesen Filter.' };

  const sceneIds = rows.map(r => r.id);
  const { sql: idSql, values: idVals } = inClause(sceneIds);

  const sfRows = db.prepare(`
    SELECT sf.scene_id, f.fig_id, f.name
    FROM scene_figures sf
    JOIN figures f ON f.id = sf.figure_id
    WHERE sf.scene_id IN ${idSql}
  `).all(...idVals);
  const slRows = db.prepare(`
    SELECT sl.scene_id, l.loc_id, l.name
    FROM scene_locations sl
    JOIN locations l ON l.id = sl.location_id
    WHERE sl.scene_id IN ${idSql}
  `).all(...idVals);

  const sfBy = new Map();
  for (const r of sfRows) {
    if (!sfBy.has(r.scene_id)) sfBy.set(r.scene_id, []);
    sfBy.get(r.scene_id).push({ fig_id: r.fig_id, name: r.name });
  }
  const slBy = new Map();
  for (const r of slRows) {
    if (!slBy.has(r.scene_id)) slBy.set(r.scene_id, []);
    slBy.get(r.scene_id).push({ loc_id: r.loc_id, name: r.name });
  }

  const total = rows.length;
  const limited = rows.slice(0, limit).map(r => ({
    scene_id: r.id,
    titel: r.titel,
    wertung: r.wertung || null,
    kommentar: r.kommentar || null,
    chapter_id: r.chapter_id, chapter_name: r.chapter_name || null,
    page_id: r.page_id, page_name: r.page_name || null,
    figuren: sfBy.get(r.id) || [],
    orte:    slBy.get(r.id) || [],
  }));

  return _truncateResult({
    scenes: limited,
    total,
    ...(limited.length < total ? { truncated: true, shown: limited.length } : {}),
  });
}

// ── get_book_settings ─────────────────────────────────────────────────────────

const BUCHTYP_LABELS_DE = {
  roman: 'Roman',
  kurzgeschichten: 'Kurzgeschichten',
  gesellschaft: 'Gesellschaftsroman',
  krimi: 'Krimi / Thriller',
  historisch: 'Historischer Roman',
  fantasy_scifi: 'Fantasy / Science-Fiction',
  erotik: 'Erotik',
  jugend: 'Jugendbuch / Kinderbuch',
  autobiografie: 'Autobiografie / Memoir',
  tagebuch: 'Tagebuch',
  sachbuch: 'Sachbuch',
  lyrik: 'Lyrik',
  essay: 'Essay',
  blog: 'Blog',
  satire: 'Satire',
  andere: 'Andere',
};

function tool_get_book_settings(_input, ctx) {
  const userEmail = ctx.userEmail || null;
  const settings = getBookSettings(ctx.bookId, userEmail);
  const bookRow = db.prepare('SELECT name FROM books WHERE book_id = ?').get(ctx.bookId);
  const labels = narrativeLabels(settings);
  return {
    book_id:                  ctx.bookId,
    book_name:                bookRow?.name || null,
    language:                 settings.language,
    region:                   settings.region,
    locale:                   `${settings.language}-${settings.region}`,
    buchtyp:                  settings.buchtyp || null,
    buchtyp_label:            settings.buchtyp ? (BUCHTYP_LABELS_DE[settings.buchtyp] || settings.buchtyp) : null,
    erzaehlperspektive:       settings.erzaehlperspektive || null,
    erzaehlperspektive_label: labels.erzaehlperspektive,
    erzaehlzeit:              settings.erzaehlzeit || null,
    erzaehlzeit_label:        labels.erzaehlzeit,
    buch_kontext:             settings.buch_kontext || null,
    is_finished:              settings.is_finished ? 1 : 0,
    daily_goal_chars:         settings.daily_goal_chars || null,
  };
}

// ── list_figures ──────────────────────────────────────────────────────────────

const LIST_FIGURES_DEFAULT_LIMIT = 50;
const LIST_FIGURES_MAX_LIMIT     = 200;

function tool_list_figures(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const limit = Math.min(Math.max(1, input?.limit || LIST_FIGURES_DEFAULT_LIMIT), LIST_FIGURES_MAX_LIMIT);
  const sort = ['mentions_desc', 'name', 'presence_desc'].includes(input?.sort) ? input.sort : 'mentions_desc';

  const rows = db.prepare(`
    SELECT f.id, f.fig_id, f.name, f.kurzname, f.typ, f.rolle, f.praesenz,
           COALESCE(SUM(pfm.count), 0) AS mentions
    FROM figures f
    LEFT JOIN page_figure_mentions pfm ON pfm.figure_id = f.id
    LEFT JOIN pages p ON p.page_id = pfm.page_id AND p.book_id = f.book_id
    WHERE f.book_id = ? AND f.user_email IS ?
    GROUP BY f.id
    ORDER BY f.sort_order, f.id
  `).all(ctx.bookId, userEmail);

  const PRES_ORDER = { 'haupt': 0, 'protagonist': 0, 'haupt-': 0, 'wichtig': 1, 'neben': 2, 'rand': 3, 'statist': 4 };
  const presKey = (p) => {
    if (!p) return 99;
    const k = String(p).toLowerCase();
    for (const key of Object.keys(PRES_ORDER)) if (k.includes(key)) return PRES_ORDER[key];
    return 50;
  };

  const sorted = [...rows];
  if (sort === 'mentions_desc') sorted.sort((a, b) => b.mentions - a.mentions || a.id - b.id);
  else if (sort === 'name')      sorted.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'presence_desc') sorted.sort((a, b) => presKey(a.praesenz) - presKey(b.praesenz) || b.mentions - a.mentions);

  const sliced = sorted.slice(0, limit);
  return _truncateResult({
    total: rows.length,
    results: sliced.map(r => ({
      fig_id:   r.fig_id,
      name:     r.name,
      kurzname: r.kurzname || null,
      typ:      r.typ || null,
      rolle:    r.rolle || null,
      praesenz: r.praesenz || null,
      mentions: r.mentions,
    })),
    ...(sliced.length < rows.length ? { truncated: true, total_results: rows.length } : {}),
  });
}

// ── list_revisions ────────────────────────────────────────────────────────────

const LIST_REVISIONS_DEFAULT_LIMIT = 20;
const LIST_REVISIONS_MAX_LIMIT     = 100;

function tool_list_revisions(input, ctx) {
  const pageId = input?.page_id;
  if (!Number.isInteger(pageId)) return { error: 'page_id fehlt' };

  const pageRow = db.prepare(`
    SELECT p.page_id, p.page_name, p.chapter_id, c.chapter_name, p.book_id
    FROM pages p
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE p.page_id = ?
  `).get(pageId);
  if (!pageRow || pageRow.book_id !== ctx.bookId) {
    return { error: 'Seite nicht im aktuellen Buch.' };
  }

  const limit = Math.min(Math.max(1, input?.limit || LIST_REVISIONS_DEFAULT_LIMIT), LIST_REVISIONS_MAX_LIMIT);
  const total = pageRevisions.countForPage(pageId);
  const revs  = pageRevisions.listForPage(pageId, limit);

  return _truncateResult({
    page_id:      pageId,
    page_name:    pageRow.page_name,
    chapter_id:   pageRow.chapter_id || null,
    chapter_name: pageRow.chapter_name || null,
    total_revisions: total,
    results: revs.map(r => ({
      rev_id:     r.id,
      created_at: r.created_at,
      source:     r.source,
      user_email: r.user_email || null,
      chars:      r.chars,
      words:      r.words,
      summary:    r.summary || null,
    })),
    ...(revs.length < total ? { truncated: true, total_results: total } : {}),
  });
}

module.exports = {
  tool_list_chapters,
  tool_list_ideen,
  tool_list_locations,
  tool_list_scenes,
  tool_get_book_settings,
  tool_list_figures,
  tool_list_revisions,
};
