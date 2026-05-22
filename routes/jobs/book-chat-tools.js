'use strict';
// Tool-Implementierungen für den Agentic Buch-Chat.
// Jede Funktion nimmt (input, ctx) und gibt ein JSON-serialisierbares Objekt zurück.
// ctx = { bookId, userEmail, userToken, jobSignal, logger }
// Übersicht aller Tools + Vertrag: docs/buchchat-tools.md

const { db, getBookSettings } = require('../../db/schema');
const { getUser } = require('../../db/app-users');
const { INPUT_BUDGET_CHARS } = require('../../lib/ai');
const { htmlToText } = require('./shared');
const contentStore = require('../../lib/content-store');
const { inClause } = require('../../lib/validate');
const { listDraftFigures, getDraftFigure, listWerkstattRuns, getWerkstattRun } = require('../../db/draft-figures');
const { resolveI18nTree, resolveI18n } = require('../../lib/i18n-server');
const { findDialogRanges } = require('../../lib/page-index');
const { htmlToPlainText } = require('../../lib/html-text');
const pageRevisions = require('../../db/page-revisions');
const { narrativeLabels } = require('./narrative-labels');
const { diffWordsWithSpace } = require('diff');

// Obergrenzen schützen das Token-Budget gegen ausufernde Tool-Calls. Skaliert mit
// MODEL_CONTEXT, damit User mit grösserem Kontextfenster reichere Tool-Antworten
// bekommen (mehr Seiten, längere Snippets). chat.js schneidet zusätzlich hart auf
// TOOL_RESULT_CAP_CHARS, bevor die Antwort an das Modell geht.
// Divisor 36 ≈ BOOK_CHAT_MAX_TOOL_ITER (6) × typische Tool-Calls/Iter (3) × Sicherheit (2).
const MAX_RESULT_CHARS      = Math.max(4000, Math.floor(INPUT_BUDGET_CHARS / 36));
const MAX_CHARS_PER_PAGE    = MAX_RESULT_CHARS;
const DEFAULT_CHARS_PER_PAGE = Math.max(2000, Math.floor(MAX_CHARS_PER_PAGE * 0.4));
// Listen-Limits bleiben fix (UI-Ergonomie, nicht Kontextfenster-Schutz):
const MAX_SEARCH_RESULTS    = 30;
const MAX_PAGES_PER_FETCH   = 20;
const SEARCH_SNIPPET_CONTEXT = 120; // Zeichen vor + nach dem Treffer

/** Kürzt ein Tool-Result-Objekt, damit es nicht das Token-Budget sprengt. */
function _truncateResult(obj) {
  const s = JSON.stringify(obj);
  if (s.length <= MAX_RESULT_CHARS) return obj;
  // Fallback: wenn shown/results-Array existiert, kürzen und truncated-Flag setzen
  if (Array.isArray(obj.results) && obj.results.length > 5) {
    return {
      ..._truncateResult({ ...obj, results: obj.results.slice(0, 10) }),
      truncated: true,
      total_results: obj.results.length,
    };
  }
  // Letzter Ausweg: stringifizieren und hart schneiden
  return { _truncated: s.slice(0, MAX_RESULT_CHARS - 100) + '… [result truncated]' };
}

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

function _findFigure(input, ctx) {
  const userEmail = ctx.userEmail || null;
  let row = null;
  if (input.figur_id) {
    row = db.prepare(
      'SELECT id, fig_id, name, kurzname FROM figures WHERE book_id = ? AND fig_id = ? AND user_email IS ?'
    ).get(ctx.bookId, input.figur_id, userEmail);
  }
  if (!row && input.figur_name) {
    const q = `%${input.figur_name}%`;
    row = db.prepare(
      `SELECT id, fig_id, name, kurzname FROM figures
         WHERE book_id = ? AND user_email IS ?
           AND (name LIKE ? OR kurzname LIKE ?)
         ORDER BY CASE WHEN name = ? OR kurzname = ? THEN 0 ELSE 1 END, id
         LIMIT 1`
    ).get(ctx.bookId, userEmail, q, q, input.figur_name, input.figur_name);
  }
  return row;
}

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

// ── search_passages ───────────────────────────────────────────────────────────

function _buildSearchRegex(pattern, regex) {
  if (!regex) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'gi');
  }
  // Harte Zeitgrenze gegen ReDoS via AbortSignal beim Match-Loop (siehe tool_search_passages).
  return new RegExp(pattern, 'gi');
}

async function tool_search_passages(input, ctx) {
  const pattern = (input.pattern || '').trim();
  if (!pattern) return { error: 'pattern fehlt' };
  const maxResults = Math.min(Math.max(1, input.max_results || 10), MAX_SEARCH_RESULTS);

  let re;
  try { re = _buildSearchRegex(pattern, !!input.regex); }
  catch (e) { return { error: `Ungültiges Regex-Muster: ${e.message}` }; }

  const scopeFilters = [];
  const scopeParams  = [ctx.bookId];
  if (Number.isInteger(input.chapter_id)) {
    scopeFilters.push('chapter_id = ?');
    scopeParams.push(input.chapter_id);
  }
  if (Number.isInteger(input.page_id)) {
    scopeFilters.push('page_id = ?');
    scopeParams.push(input.page_id);
  }
  const where = ['book_id = ?', 'preview_text IS NOT NULL', ...scopeFilters].join(' AND ');

  const pages = db.prepare(
    `SELECT page_id, page_name, chapter_id, preview_text FROM pages WHERE ${where}`
  ).all(...scopeParams);

  const results = [];
  const deadline = Date.now() + 3000; // Hard-Timeout gegen ReDoS

  outer: for (const p of pages) {
    if (Date.now() > deadline) break;
    if (ctx.jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(p.preview_text)) !== null) {
      const start = Math.max(0, m.index - SEARCH_SNIPPET_CONTEXT);
      const end   = Math.min(p.preview_text.length, m.index + m[0].length + SEARCH_SNIPPET_CONTEXT);
      results.push({
        page_id:   p.page_id,
        page_name: p.page_name,
        chapter_id: p.chapter_id,
        offset:    m.index,
        match:     m[0],
        snippet:   (start > 0 ? '…' : '') + p.preview_text.slice(start, end) + (end < p.preview_text.length ? '…' : ''),
      });
      if (results.length >= maxResults) break outer;
      // Bei leerem Match (z.B. leerer Regex) Endlosschleife verhindern
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  return _truncateResult({
    pattern,
    regex: !!input.regex,
    ...(Number.isInteger(input.chapter_id) ? { chapter_id: input.chapter_id } : {}),
    ...(Number.isInteger(input.page_id)    ? { page_id:    input.page_id    } : {}),
    results,
    note: pages.length === 0
      ? 'Kein Seiten-Cache. Sync ausführen.'
      : 'Suche bisher nur im gecachten Vorschautext (~800 Zeichen pro Seite) – für vollständigen Text get_pages verwenden.',
  });
}

// ── get_pages ─────────────────────────────────────────────────────────────────

// Letztes Lektorat einer Seite — Stilanalyse wird hart geclampt (kann lang werden);
// errors_json bewusst ausgelassen, sonst sprengt es das Token-Budget.
const LATEST_CHECK_STILANALYSE_CHARS = 600;

function _latestCheckForPage(pageId, userEmail) {
  const row = db.prepare(`
    SELECT checked_at, error_count, fazit, stilanalyse, model
    FROM page_checks
    WHERE page_id = ? AND user_email IS ?
    ORDER BY checked_at DESC
    LIMIT 1
  `).get(pageId, userEmail || null);
  if (!row) return null;
  const stil = row.stilanalyse || null;
  return {
    checked_at:  row.checked_at,
    error_count: row.error_count ?? 0,
    fazit:       row.fazit || null,
    stilanalyse: stil && stil.length > LATEST_CHECK_STILANALYSE_CHARS
      ? stil.slice(0, LATEST_CHECK_STILANALYSE_CHARS) + '…'
      : stil,
    model:       row.model || null,
  };
}

async function tool_get_pages(input, ctx) {
  const ids = Array.isArray(input.ids) ? input.ids.filter(n => Number.isInteger(n)) : [];
  if (!ids.length) return { error: 'ids fehlen oder leer' };
  const limit = Math.min(MAX_PAGES_PER_FETCH, ids.length);
  const maxChars = Math.min(MAX_CHARS_PER_PAGE, Math.max(500, input.max_chars_per_page || DEFAULT_CHARS_PER_PAGE));
  const toFetch = ids.slice(0, limit);
  if (!ctx.userToken) {
    return { error: 'Kein BookStack-Token in der Session.' };
  }
  const results = [];
  const missing = [];
  for (const pageId of toFetch) {
    if (ctx.jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const pd = await contentStore.loadPage(pageId, ctx.userToken);
      const text = htmlToText(pd.html || '');
      const pageRow = db.prepare(`
        SELECT p.page_name, c.chapter_name FROM pages p
        LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
        WHERE p.page_id = ?
      `).get(pageId);
      const latestCheck = _latestCheckForPage(pageId, ctx.userEmail);
      results.push({
        page_id: pageId,
        page_name: pageRow?.page_name || pd.name || `#${pageId}`,
        chapter_name: pageRow?.chapter_name || null,
        text: text.length > maxChars ? text.slice(0, maxChars) + '…' : text,
        truncated: text.length > maxChars,
        ...(latestCheck ? { latest_check: latestCheck } : {}),
      });
    } catch (e) {
      missing.push({ page_id: pageId, error: e.message });
    }
  }
  const dropped = ids.length - toFetch.length;
  return _truncateResult({
    pages: results,
    ...(missing.length ? { missing } : {}),
    ...(dropped > 0 ? { dropped, note: `${dropped} weitere IDs ignoriert (max ${MAX_PAGES_PER_FETCH} pro Aufruf).` } : {}),
  });
}

// ── get_reviews ──────────────────────────────────────────────────────────────

const CHAPTER_REVIEW_FAZIT_CHARS = 400;
const CHAPTER_REVIEW_DEFAULT_LIMIT = 30;
const BOOK_REVIEW_FAZIT_CHARS = 600;

function _getBookReview(ctx) {
  const userEmail = ctx.userEmail || null;
  const row = db.prepare(`
    SELECT br.reviewed_at, br.review_json, br.model, b.name AS book_name
    FROM book_reviews br
    LEFT JOIN books b ON b.book_id = br.book_id
    WHERE br.book_id = ? AND br.user_email IS ?
    ORDER BY br.reviewed_at DESC
    LIMIT 1
  `).get(ctx.bookId, userEmail);
  if (!row) {
    return { scope: 'book', hint: 'Noch keine Buchbewertung vorhanden. Job „Buchbewertung" ausführen.' };
  }
  let parsed = null;
  try { parsed = row.review_json ? JSON.parse(row.review_json) : null; } catch { parsed = null; }
  if (!parsed) {
    return { scope: 'book', error: 'Buchbewertung kann nicht geparst werden.', reviewed_at: row.reviewed_at };
  }
  const fazit = parsed.fazit || null;
  return _truncateResult({
    scope: 'book',
    book_name: row.book_name || null,
    reviewed_at: row.reviewed_at,
    gesamtnote: typeof parsed.gesamtnote === 'number' ? parsed.gesamtnote : null,
    zusammenfassung: parsed.zusammenfassung || null,
    fazit: fazit && fazit.length > BOOK_REVIEW_FAZIT_CHARS
      ? fazit.slice(0, BOOK_REVIEW_FAZIT_CHARS) + '…'
      : fazit,
    staerken: Array.isArray(parsed.staerken) ? parsed.staerken : [],
    schwaechen: Array.isArray(parsed.schwaechen) ? parsed.schwaechen : [],
    model: row.model || null,
  });
}

function tool_get_reviews(input, ctx) {
  const scope = input?.scope === 'book' ? 'book' : 'chapter';
  if (scope === 'book') return _getBookReview(ctx);
  const userEmail = ctx.userEmail || null;
  const chapterIdsFilter = Array.isArray(input?.chapter_ids)
    ? input.chapter_ids.filter(n => Number.isInteger(n))
    : null;
  const sort = input?.sort === 'note_asc' || input?.sort === 'note_desc' || input?.sort === 'chapter'
    ? input.sort
    : 'note_desc';
  const limit = Math.min(100, Math.max(1, Number.isInteger(input?.limit) ? input.limit : CHAPTER_REVIEW_DEFAULT_LIMIT));

  // Letzten Eintrag pro Kapitel via MAX(reviewed_at)-Subquery.
  let sql = `
    SELECT cr.chapter_id, c.chapter_name, cr.reviewed_at, cr.review_json, cr.model
    FROM chapter_reviews cr
    JOIN chapters c ON c.chapter_id = cr.chapter_id AND c.book_id = cr.book_id
    WHERE cr.book_id = ? AND cr.user_email IS ?
      AND cr.reviewed_at = (
        SELECT MAX(cr2.reviewed_at) FROM chapter_reviews cr2
        WHERE cr2.chapter_id = cr.chapter_id
          AND cr2.book_id = cr.book_id
          AND cr2.user_email IS ?
      )
  `;
  const params = [ctx.bookId, userEmail, userEmail];
  if (chapterIdsFilter && chapterIdsFilter.length) {
    sql += ` AND cr.chapter_id IN (${chapterIdsFilter.map(() => '?').join(',')})`;
    params.push(...chapterIdsFilter);
  }
  const rows = db.prepare(sql).all(...params);

  const items = [];
  for (const r of rows) {
    let parsed = null;
    try { parsed = r.review_json ? JSON.parse(r.review_json) : null; } catch { parsed = null; }
    if (!parsed) continue;
    const fazit = parsed.fazit || null;
    items.push({
      chapter_id:   r.chapter_id,
      chapter_name: r.chapter_name,
      reviewed_at:  r.reviewed_at,
      gesamtnote:   typeof parsed.gesamtnote === 'number' ? parsed.gesamtnote : null,
      zusammenfassung: parsed.zusammenfassung || null,
      fazit:        fazit && fazit.length > CHAPTER_REVIEW_FAZIT_CHARS
        ? fazit.slice(0, CHAPTER_REVIEW_FAZIT_CHARS) + '…'
        : fazit,
      staerken:     Array.isArray(parsed.staerken)   ? parsed.staerken   : [],
      schwaechen:   Array.isArray(parsed.schwaechen) ? parsed.schwaechen : [],
      model:        r.model || null,
    });
  }

  if (sort === 'note_desc')      items.sort((a, b) => (b.gesamtnote ?? -1) - (a.gesamtnote ?? -1));
  else if (sort === 'note_asc')  items.sort((a, b) => (a.gesamtnote ?? 99) - (b.gesamtnote ?? 99));
  else                            items.sort((a, b) => a.chapter_id - b.chapter_id);

  const total = items.length;
  const limited = items.slice(0, limit);

  // Liste aller Kapitel des Buchs, damit das Modell sieht, welche noch keine Bewertung haben.
  const allChapters = db.prepare(
    'SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ? ORDER BY chapter_id'
  ).all(ctx.bookId);
  const reviewedIds = new Set(items.map(i => i.chapter_id));
  const missingReview = allChapters
    .filter(c => !reviewedIds.has(c.chapter_id))
    .map(c => ({ chapter_id: c.chapter_id, chapter_name: c.chapter_name }));

  return _truncateResult({
    scope: 'chapter',
    reviews: limited,
    total,
    sort,
    ...(limited.length < total ? { truncated: true, shown: limited.length } : {}),
    ...(missingReview.length ? {
      ohne_bewertung: missingReview,
      hint: 'Diese Kapitel wurden noch nicht bewertet (chapter_reviews fehlt).',
    } : {}),
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

// ── list_continuity_issues ────────────────────────────────────────────────────

const CONTINUITY_DEFAULT_LIMIT = 30;

function tool_list_continuity_issues(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const check = db.prepare(`
    SELECT id, checked_at, summary, model
    FROM continuity_checks
    WHERE book_id = ? AND user_email IS ?
    ORDER BY checked_at DESC
    LIMIT 1
  `).get(ctx.bookId, userEmail);
  if (!check) {
    return {
      issues: [],
      hint: 'Kein Kontinuitätscheck vorhanden. Job „Kontinuität" ausführen.',
    };
  }

  const schwereFilter = typeof input?.schwere === 'string' ? input.schwere.toLowerCase() : null;
  const typFilter     = typeof input?.typ === 'string'     ? input.typ.toLowerCase()     : null;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id           : null;
  const limit = Math.min(100, Math.max(1, Number.isInteger(input?.limit) ? input.limit : CONTINUITY_DEFAULT_LIMIT));

  let issues = db.prepare(`
    SELECT id, schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung, sort_order
    FROM continuity_issues
    WHERE check_id = ?
    ORDER BY sort_order, id
  `).all(check.id);

  if (schwereFilter) issues = issues.filter(i => (i.schwere || '').toLowerCase() === schwereFilter);
  if (typFilter)     issues = issues.filter(i => (i.typ || '').toLowerCase()     === typFilter);

  if (!issues.length) {
    return { check_id: check.id, checked_at: check.checked_at, summary: check.summary || null, issues: [], total: 0 };
  }

  const issueIds = issues.map(i => i.id);
  const { sql: idSql, values: idVals } = inClause(issueIds);

  const figRows = db.prepare(`
    SELECT cif.issue_id, COALESCE(f.fig_id, NULL) AS fig_id,
           COALESCE(f.name, cif.figur_name) AS name
    FROM continuity_issue_figures cif
    LEFT JOIN figures f ON f.id = cif.figure_id
    WHERE cif.issue_id IN ${idSql}
    ORDER BY cif.issue_id, cif.sort_order
  `).all(...idVals);
  const chRows = db.prepare(`
    SELECT cic.issue_id, cic.chapter_id, c.chapter_name
    FROM continuity_issue_chapters cic
    LEFT JOIN chapters c ON c.chapter_id = cic.chapter_id
    WHERE cic.issue_id IN ${idSql}
    ORDER BY cic.issue_id, cic.sort_order
  `).all(...idVals);

  const figByIssue = new Map();
  for (const r of figRows) {
    if (!r.name) continue;
    if (!figByIssue.has(r.issue_id)) figByIssue.set(r.issue_id, []);
    figByIssue.get(r.issue_id).push({ fig_id: r.fig_id || null, name: r.name });
  }
  const chByIssue = new Map();
  for (const r of chRows) {
    if (!chByIssue.has(r.issue_id)) chByIssue.set(r.issue_id, []);
    chByIssue.get(r.issue_id).push({ chapter_id: r.chapter_id, chapter_name: r.chapter_name || null });
  }

  let enriched = issues.map(i => ({
    issue_id: i.id,
    schwere: i.schwere || null,
    typ: i.typ || null,
    beschreibung: i.beschreibung || null,
    stelle_a: i.stelle_a || null,
    stelle_b: i.stelle_b || null,
    empfehlung: i.empfehlung || null,
    figuren: figByIssue.get(i.id) || [],
    kapitel: chByIssue.get(i.id) || [],
  }));

  if (chapterFilter != null) {
    enriched = enriched.filter(i => i.kapitel.some(c => c.chapter_id === chapterFilter));
  }

  const total = enriched.length;
  const limited = enriched.slice(0, limit);

  return _truncateResult({
    check_id: check.id,
    checked_at: check.checked_at,
    summary: check.summary || null,
    model: check.model || null,
    issues: limited,
    total,
    ...(limited.length < total ? { truncated: true, shown: limited.length } : {}),
  });
}

// ── get_timeline ──────────────────────────────────────────────────────────────

const TIMELINE_DEFAULT_LIMIT = 60;

function tool_get_timeline(input, ctx) {
  const userEmail = ctx.userEmail || '';
  let focusFig = null;
  if (input?.figur_id || input?.figur_name) {
    focusFig = _findFigure(input, ctx);
    if (!focusFig) return { error: 'Figur nicht gefunden', hint: 'Prüfe die Figurenliste im System-Prompt.' };
  }
  const typFilter = typeof input?.typ === 'string' ? input.typ.toLowerCase() : null;
  const limit = Math.min(200, Math.max(1, Number.isInteger(input?.limit) ? input.limit : TIMELINE_DEFAULT_LIMIT));

  const events = db.prepare(`
    SELECT id, datum, ereignis, typ, bedeutung
    FROM zeitstrahl_events
    WHERE book_id = ? AND user_email = ?
    ORDER BY sort_order, id
  `).all(ctx.bookId, userEmail);

  if (!events.length) {
    return {
      events: [],
      hint: 'Kein Zeitstrahl vorhanden. Komplettanalyse ausführen (Phase 6).',
    };
  }

  const eventIds = events.map(e => e.id);
  const { sql: idSql, values: idVals } = inClause(eventIds);

  const chRows = db.prepare(`
    SELECT zec.event_id, zec.chapter_id, c.chapter_name
    FROM zeitstrahl_event_chapters zec
    LEFT JOIN chapters c ON c.chapter_id = zec.chapter_id
    WHERE zec.event_id IN ${idSql}
    ORDER BY zec.event_id, zec.sort_order
  `).all(...idVals);
  const pgRows = db.prepare(`
    SELECT zep.event_id, zep.page_id, p.page_name
    FROM zeitstrahl_event_pages zep
    LEFT JOIN pages p ON p.page_id = zep.page_id
    WHERE zep.event_id IN ${idSql}
    ORDER BY zep.event_id, zep.sort_order
  `).all(...idVals);
  const fgRows = db.prepare(`
    SELECT zef.event_id, f.fig_id, COALESCE(f.name, zef.figur_name) AS name
    FROM zeitstrahl_event_figures zef
    LEFT JOIN figures f ON f.id = zef.figure_id
    WHERE zef.event_id IN ${idSql}
    ORDER BY zef.event_id, zef.sort_order
  `).all(...idVals);

  const chByEvt = new Map();
  for (const r of chRows) {
    if (!chByEvt.has(r.event_id)) chByEvt.set(r.event_id, []);
    chByEvt.get(r.event_id).push({ chapter_id: r.chapter_id, chapter_name: r.chapter_name || null });
  }
  const pgByEvt = new Map();
  for (const r of pgRows) {
    if (!pgByEvt.has(r.event_id)) pgByEvt.set(r.event_id, []);
    pgByEvt.get(r.event_id).push({ page_id: r.page_id, page_name: r.page_name || null });
  }
  const fgByEvt = new Map();
  for (const r of fgRows) {
    if (!r.name) continue;
    if (!fgByEvt.has(r.event_id)) fgByEvt.set(r.event_id, []);
    fgByEvt.get(r.event_id).push({ fig_id: r.fig_id || null, name: r.name });
  }

  let enriched = events.map(e => ({
    datum: e.datum,
    ereignis: e.ereignis,
    typ: e.typ || 'persoenlich',
    bedeutung: e.bedeutung || null,
    kapitel: chByEvt.get(e.id) || [],
    seiten:  pgByEvt.get(e.id) || [],
    figuren: fgByEvt.get(e.id) || [],
  }));

  if (typFilter) enriched = enriched.filter(e => (e.typ || '').toLowerCase() === typFilter);
  if (focusFig) {
    enriched = enriched.filter(e => e.figuren.some(f => f.fig_id === focusFig.fig_id));
  }

  const total = enriched.length;
  const limited = enriched.slice(0, limit);

  return _truncateResult({
    ...(focusFig ? { focus: { fig_id: focusFig.fig_id, name: focusFig.name } } : {}),
    events: limited,
    total,
    ...(limited.length < total ? { truncated: true, shown: limited.length } : {}),
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

// ── get_lektorat_hotspots ─────────────────────────────────────────────────────

const HOTSPOTS_DEFAULT_LIMIT = 20;
const HOTSPOTS_FAZIT_CHARS = 200;

function tool_get_lektorat_hotspots(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
  const minErrors     = Number.isInteger(input?.min_errors) ? Math.max(0, input.min_errors) : 0;
  const limit = Math.min(100, Math.max(1, Number.isInteger(input?.limit) ? input.limit : HOTSPOTS_DEFAULT_LIMIT));

  // Letzter Check pro Seite via MAX(checked_at)-Subquery.
  let sql = `
    SELECT pc.page_id, pc.checked_at, pc.error_count, pc.fazit, pc.stilanalyse,
           p.page_name, p.chapter_id, c.chapter_name
    FROM page_checks pc
    JOIN pages    p ON p.page_id    = pc.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE pc.book_id = ? AND pc.user_email IS ?
      AND pc.checked_at = (
        SELECT MAX(pc2.checked_at) FROM page_checks pc2
        WHERE pc2.page_id = pc.page_id AND pc2.user_email IS ?
      )
  `;
  const params = [ctx.bookId, userEmail, userEmail];
  if (chapterFilter !== null) { sql += ' AND p.chapter_id = ?'; params.push(chapterFilter); }
  sql += ' ORDER BY pc.error_count DESC, pc.checked_at DESC';

  const rows = db.prepare(sql).all(...params).filter(r => (r.error_count || 0) >= minErrors);
  if (!rows.length) {
    return {
      hotspots: [],
      hint: 'Keine Lektorat-Ergebnisse mit den gewählten Filtern.',
    };
  }

  // Pro-Kapitel-Aggregat
  const byChapter = new Map();
  for (const r of rows) {
    const key = r.chapter_id ?? 0;
    if (!byChapter.has(key)) byChapter.set(key, {
      chapter_id: r.chapter_id,
      chapter_name: r.chapter_name || '(ohne Kapitel)',
      pages: 0, total_errors: 0, max_errors: 0,
    });
    const ch = byChapter.get(key);
    ch.pages++;
    ch.total_errors += r.error_count || 0;
    if ((r.error_count || 0) > ch.max_errors) ch.max_errors = r.error_count;
  }
  const perChapter = [...byChapter.values()].map(c => ({
    chapter_id: c.chapter_id,
    chapter_name: c.chapter_name,
    pages_checked: c.pages,
    total_errors: c.total_errors,
    avg_errors: Math.round((c.total_errors / c.pages) * 10) / 10,
    max_errors: c.max_errors,
  })).sort((a, b) => b.total_errors - a.total_errors);

  const top = rows.slice(0, limit).map(r => ({
    page_id: r.page_id,
    page_name: r.page_name,
    chapter_id: r.chapter_id,
    chapter_name: r.chapter_name || null,
    error_count: r.error_count || 0,
    checked_at: r.checked_at,
    fazit: r.fazit && r.fazit.length > HOTSPOTS_FAZIT_CHARS
      ? r.fazit.slice(0, HOTSPOTS_FAZIT_CHARS) + '…'
      : (r.fazit || null),
  }));

  return _truncateResult({
    pages_checked: rows.length,
    total_errors: rows.reduce((s, r) => s + (r.error_count || 0), 0),
    per_chapter: perChapter,
    top_pages: top,
    ...(top.length < rows.length ? { truncated: true, shown: top.length } : {}),
  });
}

// ── get_stil_metrics ──────────────────────────────────────────────────────────

const STIL_METRIC_COLS = ['filler_count', 'passive_count', 'adverb_count', 'sentences', 'dialog_chars', 'avg_sentence_len', 'sentence_len_p90', 'lix', 'flesch_de'];
const STIL_DEFAULT_LIMIT = 10;

function tool_get_stil_metrics(input, ctx) {
  const scope = input?.scope === 'chapter' || input?.scope === 'page' ? input.scope : 'book';
  const metric = STIL_METRIC_COLS.includes(input?.metric) ? input.metric : 'passive_count';
  const order = input?.order === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(50, Math.max(1, Number.isInteger(input?.limit) ? input.limit : STIL_DEFAULT_LIMIT));

  if (scope === 'book') {
    const r = db.prepare(`
      SELECT
        COUNT(*) AS pages,
        SUM(words) AS words, SUM(chars) AS chars,
        SUM(sentences) AS sentences, SUM(dialog_chars) AS dialog_chars,
        SUM(filler_count) AS filler_count,
        SUM(passive_count) AS passive_count,
        SUM(adverb_count) AS adverb_count,
        AVG(avg_sentence_len) AS avg_sentence_len,
        AVG(sentence_len_p90) AS sentence_len_p90,
        AVG(lix) AS lix, AVG(flesch_de) AS flesch_de
      FROM page_stats
      WHERE book_id = ? AND sentences IS NOT NULL
    `).get(ctx.bookId);
    if (!r || !r.pages) return { hint: 'Keine Stil-Metriken vorhanden. Sync ausführen.' };
    const dialog_ratio = r.chars ? Math.round((r.dialog_chars / r.chars) * 1000) / 10 : null;
    return _truncateResult({
      scope: 'book',
      pages: r.pages,
      words: r.words, chars: r.chars,
      sentences: r.sentences, dialog_chars: r.dialog_chars,
      dialog_ratio_percent: dialog_ratio,
      filler_count: r.filler_count, passive_count: r.passive_count, adverb_count: r.adverb_count,
      avg_sentence_len: r.avg_sentence_len ? Math.round(r.avg_sentence_len * 10) / 10 : null,
      sentence_len_p90: r.sentence_len_p90 ? Math.round(r.sentence_len_p90 * 10) / 10 : null,
      lix: r.lix != null ? Math.round(r.lix * 10) / 10 : null,
      flesch_de: r.flesch_de != null ? Math.round(r.flesch_de * 10) / 10 : null,
    });
  }

  if (scope === 'chapter') {
    const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
    const includeFigures = !!input?.include_figures;
    let sql = `
      SELECT p.chapter_id, c.chapter_name,
             COUNT(*) AS pages,
             SUM(ps.words) AS words, SUM(ps.chars) AS chars,
             SUM(ps.sentences) AS sentences, SUM(ps.dialog_chars) AS dialog_chars,
             SUM(ps.filler_count) AS filler_count,
             SUM(ps.passive_count) AS passive_count,
             SUM(ps.adverb_count) AS adverb_count,
             AVG(ps.avg_sentence_len) AS avg_sentence_len,
             AVG(ps.sentence_len_p90) AS sentence_len_p90,
             AVG(ps.lix) AS lix, AVG(ps.flesch_de) AS flesch_de
      FROM page_stats ps
      JOIN pages p ON p.page_id = ps.page_id
      LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
      WHERE ps.book_id = ? AND ps.sentences IS NOT NULL
    `;
    const params = [ctx.bookId];
    if (chapterFilter !== null) { sql += ' AND p.chapter_id = ?'; params.push(chapterFilter); }
    sql += ' GROUP BY p.chapter_id, c.chapter_name ORDER BY p.chapter_id';
    const rows = db.prepare(sql).all(...params);
    if (!rows.length) return { hint: 'Keine Stil-Metriken vorhanden.' };

    const topFigStmt = includeFigures ? db.prepare(`
      SELECT f.fig_id, f.name, SUM(pfm.count) AS total
      FROM page_figure_mentions pfm
      JOIN pages p  ON p.page_id = pfm.page_id
      JOIN figures f ON f.id = pfm.figure_id
      WHERE p.chapter_id = ? AND p.book_id = ? AND f.user_email IS ?
      GROUP BY f.id
      ORDER BY total DESC
      LIMIT 5
    `) : null;

    return _truncateResult({
      scope: 'chapter',
      chapters: rows.map(r => {
        const out = {
          chapter_id: r.chapter_id,
          chapter_name: r.chapter_name || '(ohne Kapitel)',
          pages: r.pages, words: r.words, chars: r.chars,
          sentences: r.sentences, dialog_chars: r.dialog_chars,
          dialog_ratio_percent: r.chars ? Math.round((r.dialog_chars / r.chars) * 1000) / 10 : null,
          filler_count: r.filler_count, passive_count: r.passive_count, adverb_count: r.adverb_count,
          avg_sentence_len: r.avg_sentence_len ? Math.round(r.avg_sentence_len * 10) / 10 : null,
          sentence_len_p90: r.sentence_len_p90 ? Math.round(r.sentence_len_p90 * 10) / 10 : null,
          lix: r.lix != null ? Math.round(r.lix * 10) / 10 : null,
          flesch_de: r.flesch_de != null ? Math.round(r.flesch_de * 10) / 10 : null,
        };
        if (includeFigures) {
          const top = topFigStmt.all(r.chapter_id, ctx.bookId, ctx.userEmail || null);
          out.top_figuren = top.map(f => ({ fig_id: f.fig_id, name: f.name, mentions: f.total }));
        }
        return out;
      }),
    });
  }

  // scope === 'page' → Top-N nach Metrik
  const sql = `
    SELECT ps.page_id, p.page_name, p.chapter_id, c.chapter_name,
           ps.words, ps.${metric} AS metric_value
    FROM page_stats ps
    JOIN pages p ON p.page_id = ps.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE ps.book_id = ? AND ps.${metric} IS NOT NULL
    ORDER BY ps.${metric} ${order}, ps.page_id
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(ctx.bookId, limit);
  return _truncateResult({
    scope: 'page',
    metric,
    order: order.toLowerCase(),
    pages: rows.map(r => ({
      page_id: r.page_id,
      page_name: r.page_name,
      chapter_id: r.chapter_id,
      chapter_name: r.chapter_name || null,
      words: r.words,
      [metric]: r.metric_value != null && metric.startsWith('avg_') ? Math.round(r.metric_value * 10) / 10 : r.metric_value,
    })),
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

// ── Figuren-Werkstatt ─────────────────────────────────────────────────────────

const WERKSTATT_NOTES_PREVIEW_CHARS = 200;
const WERKSTATT_RUN_LIMIT_DEFAULT = 5;
const WERKSTATT_CONSISTENCY_FAZIT_PREVIEW = 400;
const WERKSTATT_CONSISTENCY_PROBLEM_PREVIEW = 240;
const WERKSTATT_BRAINSTORM_BEGRUENDUNG_PREVIEW = 160;

function _userLocale(userEmail) {
  return getUser(userEmail)?.language || 'de';
}

function _flattenMindmapTree(node, indent = 0, out = []) {
  if (!node) return out;
  const topic = (typeof node.topic === 'string' ? node.topic : '').trim();
  if (topic) out.push('  '.repeat(indent) + '- ' + topic);
  for (const child of node.children || []) _flattenMindmapTree(child, indent + 1, out);
  return out;
}

function _summarizeRunListItem(runRow, locale) {
  const path = runRow.knoten_pfad ? resolveI18n(runRow.knoten_pfad, locale) : null;
  return {
    run_id: runRow.id,
    kind: runRow.kind,
    created_at: runRow.created_at,
    ...(path ? { knoten_pfad: path } : {}),
    model: runRow.model || null,
  };
}

function _findDraftByNameOrId(input, ctx) {
  const userEmail = ctx.userEmail || '';
  if (Number.isInteger(input?.draft_id)) {
    const d = getDraftFigure(input.draft_id);
    if (d && d.book_id === ctx.bookId && d.user_email === userEmail) return d;
    return null;
  }
  if (typeof input?.figur_name === 'string' && input.figur_name.trim()) {
    const needle = input.figur_name.trim().toLowerCase();
    const all = listDraftFigures(ctx.bookId, userEmail);
    return all.find(d => (d.name || '').toLowerCase() === needle)
        || all.find(d => (d.name || '').toLowerCase().includes(needle))
        || null;
  }
  return null;
}

function tool_list_werkstatt_drafts(_input, ctx) {
  const userEmail = ctx.userEmail || '';
  const locale = _userLocale(userEmail);

  const drafts = listDraftFigures(ctx.bookId, userEmail);
  if (!drafts.length) {
    return {
      drafts: [],
      total: 0,
      hint: 'Keine Figuren-Werkstatt-Drafts vorhanden. User legt sie über die Werkstatt-Karte (tile.werkstatt) an.',
    };
  }
  const items = drafts.map(d => {
    const runRows = listWerkstattRuns(d.id, userEmail);
    const counts = { brainstorm: 0, consistency: 0 };
    for (const r of runRows) {
      if (r.kind === 'brainstorm') counts.brainstorm++;
      else if (r.kind === 'consistency') counts.consistency++;
    }
    const lastRun = runRows[0] || null;
    const notes = d.notes || null;
    return {
      draft_id: d.id,
      name: d.name,
      archetype: d.archetype || null,
      source_figure_name: d.source_figure_name || null,
      notes: notes && notes.length > WERKSTATT_NOTES_PREVIEW_CHARS
        ? notes.slice(0, WERKSTATT_NOTES_PREVIEW_CHARS) + '…'
        : notes,
      updated_at: d.updated_at,
      runs: counts,
      ...(lastRun ? { last_run: _summarizeRunListItem(lastRun, locale) } : {}),
    };
  });
  return _truncateResult({ drafts: items, total: items.length });
}

function tool_get_werkstatt_draft(input, ctx) {
  const userEmail = ctx.userEmail || '';
  const locale = _userLocale(userEmail);

  const draft = _findDraftByNameOrId(input, ctx);
  if (!draft) {
    return {
      error: 'Werkstatt-Draft nicht gefunden',
      hint: 'Per draft_id (aus list_werkstatt_drafts) oder figur_name suchen.',
    };
  }

  const resolvedRoot = draft.mindmap?.data ? resolveI18nTree(draft.mindmap.data, locale) : null;
  const mindmapText = resolvedRoot ? _flattenMindmapTree(resolvedRoot).join('\n') : '';

  const includeRuns = input?.include_runs !== false;
  const runLimit = Math.min(20, Math.max(1, Number.isInteger(input?.run_limit) ? input.run_limit : WERKSTATT_RUN_LIMIT_DEFAULT));

  const runs = [];
  if (includeRuns) {
    const runRows = listWerkstattRuns(draft.id, userEmail).slice(0, runLimit);
    for (const r of runRows) {
      const detail = getWerkstattRun(r.id);
      if (!detail) continue;
      const path = detail.knoten_pfad ? resolveI18n(detail.knoten_pfad, locale) : null;
      const entry = {
        run_id: detail.id,
        kind: detail.kind,
        created_at: detail.created_at,
        ...(path ? { knoten_pfad: path } : {}),
      };
      if (detail.kind === 'brainstorm' && Array.isArray(detail.result?.vorschlaege)) {
        entry.vorschlaege = detail.result.vorschlaege.map(v => ({
          label: v.label,
          begruendung: typeof v.begruendung === 'string' && v.begruendung.length > WERKSTATT_BRAINSTORM_BEGRUENDUNG_PREVIEW
            ? v.begruendung.slice(0, WERKSTATT_BRAINSTORM_BEGRUENDUNG_PREVIEW) + '…'
            : (v.begruendung || ''),
        }));
      } else if (detail.kind === 'consistency') {
        const fazit = detail.result?.fazit || null;
        entry.fazit = fazit && fazit.length > WERKSTATT_CONSISTENCY_FAZIT_PREVIEW
          ? fazit.slice(0, WERKSTATT_CONSISTENCY_FAZIT_PREVIEW) + '…'
          : fazit;
        if (Array.isArray(detail.result?.konflikte)) {
          entry.konflikte = detail.result.konflikte.map(k => ({
            feld: k.feld,
            schwere: k.schwere,
            problem: typeof k.problem === 'string' && k.problem.length > WERKSTATT_CONSISTENCY_PROBLEM_PREVIEW
              ? k.problem.slice(0, WERKSTATT_CONSISTENCY_PROBLEM_PREVIEW) + '…'
              : k.problem,
            vorschlag: k.vorschlag || null,
          }));
        }
      }
      runs.push(entry);
    }
  }

  return _truncateResult({
    draft_id: draft.id,
    name: draft.name,
    archetype: draft.archetype || null,
    source_figure_name: draft.source_figure_name || null,
    notes: draft.notes || null,
    updated_at: draft.updated_at,
    mindmap_text: mindmapText,
    ...(includeRuns ? { runs } : {}),
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

// ── find_repetitions ──────────────────────────────────────────────────────────

const REPETITIONS_DEFAULT_LIMIT = 30;
const REPETITIONS_MAX_LIMIT     = 100;
const REPETITIONS_SAMPLE_PAGES  = 5;
const REPETITION_STOPWORDS = new Set([
  'der','die','das','den','dem','des','ein','eine','einen','einem','einer','eines',
  'und','oder','aber','doch','denn','sondern','als','wie','wenn','dass','daß','weil',
  'in','im','an','am','auf','auch','aus','bei','beim','mit','nach','von','vom','vor',
  'zu','zum','zur','über','unter','durch','für','um','ohne','gegen','seit','bis',
  'ist','war','sind','waren','sein','seine','seinen','seinem','seiner','wird','werden',
  'wurde','wurden','hat','hatte','haben','hatten','kann','konnte','soll','sollte',
  'mag','mochte','muss','musste','will','wollte','er','sie','es','wir','ihr','sich',
  'mir','dir','ihm','ihn','ihnen','mich','dich','uns','euch','mein','dein','sein',
  'unser','euer','nicht','nur','noch','schon','immer','dann','so','sehr',
  'mehr','wieder','etwas','nichts','jetzt','dort','hier','heute','gestern','morgen',
  'the','a','an','and','or','but','as','if','when','that','because','of','in','on',
  'at','by','for','to','with','from','up','about','into','over','after','it','he',
  'she','they','we','his','her','their','our','my','your','is','are','was','were',
  'be','been','being','have','has','had','do','does','did','can','could','will',
  'would','should','may','might','must','not','no','yes','so','very','more','only',
]);

const _TOKEN_RE = /[a-zäöüß][a-zäöüß'-]*/gi;

function _tokenizeForRepetitions(text) {
  const tokens = [];
  for (const m of text.toLowerCase().matchAll(_TOKEN_RE)) {
    if (m[0].length >= 2) tokens.push(m[0]);
  }
  return tokens;
}

function _ngramFreq(tokens, n, ignoreStopwords) {
  const freq = new Map();
  if (tokens.length < n) return freq;
  for (let i = 0; i <= tokens.length - n; i++) {
    let allStop = true;
    for (let k = 0; k < n; k++) {
      if (!REPETITION_STOPWORDS.has(tokens[i + k])) { allStop = false; break; }
    }
    if (ignoreStopwords && allStop) continue;
    const phrase = tokens.slice(i, i + n).join(' ');
    freq.set(phrase, (freq.get(phrase) || 0) + 1);
  }
  return freq;
}

function tool_find_repetitions(input, ctx) {
  const n = [2, 3, 4, 5].includes(input?.n) ? input.n : 3;
  const scope = ['book', 'chapter', 'page'].includes(input?.scope) ? input.scope : 'book';
  const ignoreStopwords = input?.ignore_stopwords !== false;
  const minCount = Math.max(2, Number.isInteger(input?.min_count) ? input.min_count : (scope === 'book' ? 5 : 2));
  const limit = Math.min(REPETITIONS_MAX_LIMIT, Math.max(1, Number.isInteger(input?.limit) ? input.limit : REPETITIONS_DEFAULT_LIMIT));

  let sql = 'SELECT page_id, page_name, chapter_id, body_html FROM pages WHERE book_id = ? AND body_html IS NOT NULL';
  const params = [ctx.bookId];
  if (scope === 'chapter') {
    if (!Number.isInteger(input?.chapter_id)) return { error: 'chapter_id fehlt (scope=chapter)' };
    sql += ' AND chapter_id = ?';
    params.push(input.chapter_id);
  } else if (scope === 'page') {
    if (!Number.isInteger(input?.page_id)) return { error: 'page_id fehlt (scope=page)' };
    sql += ' AND page_id = ?';
    params.push(input.page_id);
  }
  const pages = db.prepare(sql).all(...params);
  if (!pages.length) {
    return { results: [], hint: 'Keine Seiten mit body_html im gewählten Scope. Sync ausführen.' };
  }

  const totalFreq = new Map();
  const perPage = new Map();
  const pageInfo = new Map();
  for (const p of pages) {
    pageInfo.set(p.page_id, { page_name: p.page_name, chapter_id: p.chapter_id });
    const text = htmlToPlainText(p.body_html);
    const tokens = _tokenizeForRepetitions(text);
    const freq = _ngramFreq(tokens, n, ignoreStopwords);
    for (const [phrase, count] of freq) {
      totalFreq.set(phrase, (totalFreq.get(phrase) || 0) + count);
      if (!perPage.has(phrase)) perPage.set(phrase, new Map());
      perPage.get(phrase).set(p.page_id, count);
    }
  }

  const filtered = [...totalFreq.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const total = filtered.length;
  const top = filtered.slice(0, limit).map(([phrase, count]) => {
    const samples = [...(perPage.get(phrase) || new Map()).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, REPETITIONS_SAMPLE_PAGES)
      .map(([pageId, c]) => {
        const info = pageInfo.get(pageId);
        return { page_id: pageId, page_name: info?.page_name || null, count: c };
      });
    return { phrase, count, sample_pages: samples };
  });

  return _truncateResult({
    n,
    scope,
    min_count: minCount,
    pages_scanned: pages.length,
    total_results: total,
    results: top,
    ...(total > top.length ? { truncated: true } : {}),
  });
}

// ── get_dialogue ──────────────────────────────────────────────────────────────

const DIALOGUE_DEFAULT_LIMIT  = 30;
const DIALOGUE_MAX_LIMIT      = 100;
const DIALOGUE_CONTEXT_CHARS  = 80;
const DIALOGUE_SPEAKER_WINDOW = 100;

function _figureNamePatterns(figRow) {
  const names = [];
  if (figRow.name) names.push(figRow.name);
  if (figRow.kurzname && figRow.kurzname !== figRow.name) names.push(figRow.kurzname);
  return names;
}

function tool_get_dialogue(input, ctx) {
  const limit = Math.min(DIALOGUE_MAX_LIMIT, Math.max(1, Number.isInteger(input?.limit) ? input.limit : DIALOGUE_DEFAULT_LIMIT));
  const minLen = Math.max(1, Number.isInteger(input?.min_length) ? input.min_length : 4);

  let figRow = null;
  let figNames = null;
  if (input?.figur_id || input?.figur_name) {
    figRow = _findFigure(input, ctx);
    if (!figRow) return { error: 'Figur nicht gefunden' };
    figNames = _figureNamePatterns(figRow).map(n => n.toLowerCase());
  }

  let sql = 'SELECT page_id, page_name, chapter_id, body_html FROM pages WHERE book_id = ? AND body_html IS NOT NULL';
  const params = [ctx.bookId];
  if (Number.isInteger(input?.chapter_id)) { sql += ' AND chapter_id = ?'; params.push(input.chapter_id); }
  if (Number.isInteger(input?.page_id))    { sql += ' AND page_id    = ?'; params.push(input.page_id); }
  sql += ' ORDER BY chapter_id, page_id';
  const pages = db.prepare(sql).all(...params);
  if (!pages.length) return { results: [], hint: 'Keine Seiten im Scope.' };

  const results = [];
  let totalFound = 0;
  for (const p of pages) {
    const text = htmlToPlainText(p.body_html);
    const ranges = findDialogRanges(text);
    for (const [a, b] of ranges) {
      const segment = text.slice(a, b).trim();
      if (segment.length < minLen) continue;
      if (figNames) {
        const winStart = Math.max(0, a - DIALOGUE_SPEAKER_WINDOW);
        const winEnd   = Math.min(text.length, b + DIALOGUE_SPEAKER_WINDOW);
        const ctxLower = text.slice(winStart, winEnd).toLowerCase();
        if (!figNames.some(n => ctxLower.includes(n))) continue;
      }
      totalFound++;
      if (results.length >= limit) continue;
      const before = text.slice(Math.max(0, a - DIALOGUE_CONTEXT_CHARS), a).trim();
      const after  = text.slice(b, Math.min(text.length, b + DIALOGUE_CONTEXT_CHARS)).trim();
      results.push({
        page_id:    p.page_id,
        page_name:  p.page_name,
        chapter_id: p.chapter_id,
        offset:     a,
        length:     b - a,
        text:       segment,
        before:     before || null,
        after:      after  || null,
      });
    }
    if (results.length >= limit && !figNames) break;
  }

  return _truncateResult({
    ...(figRow ? { figur: { fig_id: figRow.fig_id, name: figRow.name } } : {}),
    results,
    total_results: totalFound,
    ...(totalFound > results.length ? { truncated: true, shown: results.length } : {}),
    hint: 'Heuristische Dialog-Erkennung (Anführungszeichen, Speech-Verb+Doppelpunkt, Em-Dash). Einfache gerade Quotes werden ignoriert.',
  });
}

// ── diff_page_revisions ───────────────────────────────────────────────────────

const DIFF_MAX_BLOCKS   = 100;
const DIFF_MAX_TEXT_LEN = 600;

function _diffBlocks(oldText, newText) {
  const parts = diffWordsWithSpace(oldText, newText);
  const blocks = [];
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (p.removed && parts[i + 1]?.added) {
      blocks.push({ kind: 'change', from: p.value, to: parts[i + 1].value });
      i += 2;
    } else if (p.added) {
      blocks.push({ kind: 'add', text: p.value });
      i += 1;
    } else if (p.removed) {
      blocks.push({ kind: 'del', text: p.value });
      i += 1;
    } else {
      i += 1;
    }
  }
  return blocks;
}

function _clampDiffPart(s) {
  if (s == null) return s;
  return s.length > DIFF_MAX_TEXT_LEN ? s.slice(0, DIFF_MAX_TEXT_LEN) + '…' : s;
}

function tool_diff_page_revisions(input, ctx) {
  const pageId = input?.page_id;
  if (!Number.isInteger(pageId)) return { error: 'page_id fehlt' };

  const pageRow = db.prepare(`
    SELECT p.page_id, p.page_name, c.chapter_name, p.book_id
    FROM pages p
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE p.page_id = ?
  `).get(pageId);
  if (!pageRow || pageRow.book_id !== ctx.bookId) {
    return { error: 'Seite nicht im aktuellen Buch.' };
  }

  let fromRev = null;
  let toRev   = null;
  if (Number.isInteger(input?.from_rev_id) && Number.isInteger(input?.to_rev_id)) {
    fromRev = pageRevisions.get(input.from_rev_id);
    toRev   = pageRevisions.get(input.to_rev_id);
    if (!fromRev || !toRev) return { error: 'Revision-ID nicht gefunden.' };
    if (fromRev.page_id !== pageId || toRev.page_id !== pageId) {
      return { error: 'Revision gehört nicht zur Seite.' };
    }
  } else {
    const recent = pageRevisions.listForPage(pageId, 2);
    if (recent.length < 2) {
      return { error: 'Weniger als 2 Revisionen vorhanden.', total_revisions: recent.length };
    }
    toRev   = pageRevisions.get(recent[0].id);
    fromRev = pageRevisions.get(recent[1].id);
  }

  const oldText = htmlToPlainText(fromRev.body_html);
  const newText = htmlToPlainText(toRev.body_html);
  if (oldText === newText) {
    return {
      page_id: pageId,
      page_name: pageRow.page_name,
      from: { id: fromRev.id, created_at: fromRev.created_at, source: fromRev.source, chars: fromRev.chars },
      to:   { id: toRev.id,   created_at: toRev.created_at,   source: toRev.source,   chars: toRev.chars   },
      unchanged: true,
    };
  }

  const blocks = _diffBlocks(oldText, newText);
  const summary = { add: 0, del: 0, change: 0 };
  for (const b of blocks) summary[b.kind]++;

  const limited = blocks.slice(0, DIFF_MAX_BLOCKS).map(b => {
    if (b.kind === 'change') return { kind: 'change', from: _clampDiffPart(b.from), to: _clampDiffPart(b.to) };
    return { kind: b.kind, text: _clampDiffPart(b.text) };
  });

  return _truncateResult({
    page_id:   pageId,
    page_name: pageRow.page_name,
    chapter_name: pageRow.chapter_name || null,
    from: {
      id:         fromRev.id,
      created_at: fromRev.created_at,
      source:     fromRev.source,
      user_email: fromRev.user_email || null,
      chars:      fromRev.chars,
      words:      fromRev.words,
    },
    to: {
      id:         toRev.id,
      created_at: toRev.created_at,
      source:     toRev.source,
      user_email: toRev.user_email || null,
      chars:      toRev.chars,
      words:      toRev.words,
    },
    chars_delta: (toRev.chars || 0) - (fromRev.chars || 0),
    summary,
    blocks: limited,
    ...(blocks.length > limited.length ? { truncated: true, total_blocks: blocks.length } : {}),
  });
}

// ── find_first_last_mention ───────────────────────────────────────────────────

function tool_find_first_last_mention(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const hasFigSelector = (typeof input?.figur_id === 'string' && input.figur_id.trim())
                      || (typeof input?.figur_name === 'string' && input.figur_name.trim());
  const hasLocSelector = typeof input?.loc_id === 'string' && input.loc_id.trim();

  if (!hasFigSelector && !hasLocSelector) {
    return { error: 'figur_id, figur_name oder loc_id erforderlich.' };
  }

  if (hasFigSelector) {
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
        error: 'Keine Index-Erwähnung vorhanden. Komplettanalyse/Sync ausführen, um den Figuren-Index zu aktualisieren.',
      };
    }
    const first = mentions[0];
    const last  = mentions[mentions.length - 1];
    const total = mentions.reduce((s, m) => s + m.count, 0);
    return {
      fig_id: figRow.fig_id,
      name: figRow.name,
      total_mentions: total,
      pages_with_mention: mentions.length,
      first_appearance: {
        chapter_id: first.chapter_id,
        chapter_name: first.chapter_name || '(ohne Kapitel)',
        page_id: first.page_id,
        page_name: first.page_name,
        first_offset: first.first_offset,
        count: first.count,
      },
      last_appearance: {
        chapter_id: last.chapter_id,
        chapter_name: last.chapter_name || '(ohne Kapitel)',
        page_id: last.page_id,
        page_name: last.page_name,
        count: last.count,
      },
    };
  }

  // loc_id-Pfad
  const locRow = db.prepare(
    'SELECT id, loc_id, name FROM locations WHERE book_id = ? AND user_email IS ? AND loc_id = ?'
  ).get(ctx.bookId, userEmail, input.loc_id.trim());
  if (!locRow) {
    return { error: 'Ort nicht gefunden', hint: 'Prüfe loc_id via list_locations.' };
  }
  const chRows = db.prepare(`
    SELECT lc.chapter_id, c.chapter_name, lc.haeufigkeit
    FROM location_chapters lc
    LEFT JOIN chapters c ON c.chapter_id = lc.chapter_id
    WHERE lc.location_id = ?
    ORDER BY lc.chapter_id
  `).all(locRow.id);
  if (!chRows.length) {
    return {
      loc_id: locRow.loc_id,
      name: locRow.name,
      error: 'Keine Index-Erwähnung vorhanden. Komplettanalyse/Sync ausführen, um den Orte-Index zu aktualisieren.',
    };
  }
  const first = chRows[0];
  const last  = chRows[chRows.length - 1];
  return {
    loc_id: locRow.loc_id,
    name: locRow.name,
    chapters_with_mention: chRows.length,
    first_appearance: {
      chapter_id: first.chapter_id,
      chapter_name: first.chapter_name || '(ohne Kapitel)',
      haeufigkeit: first.haeufigkeit,
    },
    last_appearance: {
      chapter_id: last.chapter_id,
      chapter_name: last.chapter_name || '(ohne Kapitel)',
      haeufigkeit: last.haeufigkeit,
    },
  };
}

// ── quote_passage ─────────────────────────────────────────────────────────────

const QUOTE_DEFAULT_CONTEXT = 80;
const QUOTE_MAX_LENGTH      = 800;
const QUOTE_MAX_CONTEXT     = 300;

async function tool_quote_passage(input, ctx) {
  const pageId = input?.page_id;
  const offset = input?.offset;
  const length = input?.length;
  if (!Number.isInteger(pageId)) return { error: 'page_id fehlt' };
  if (!Number.isInteger(offset) || offset < 0) return { error: 'offset (>= 0) fehlt' };
  if (!Number.isInteger(length) || length <= 0) return { error: 'length (> 0) fehlt' };
  if (length > QUOTE_MAX_LENGTH) return { error: `length zu gross (max ${QUOTE_MAX_LENGTH}).` };

  const contextChars = Math.min(QUOTE_MAX_CONTEXT, Math.max(0, Number.isInteger(input?.context_chars) ? input.context_chars : QUOTE_DEFAULT_CONTEXT));

  const pageRow = db.prepare(`
    SELECT p.page_id, p.page_name, p.book_id, c.chapter_id, c.chapter_name
    FROM pages p
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE p.page_id = ?
  `).get(pageId);
  if (!pageRow || pageRow.book_id !== ctx.bookId) {
    return { error: 'Seite nicht im aktuellen Buch.' };
  }
  if (!ctx.userToken) return { error: 'Kein BookStack-Token in der Session.' };

  if (ctx.jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const pd = await contentStore.loadPage(pageId, ctx.userToken);
  const text = htmlToPlainText(pd.html || '');
  if (offset >= text.length) {
    return { error: `offset (${offset}) liegt ausserhalb des Texts (Länge ${text.length}).` };
  }
  const end = Math.min(text.length, offset + length);
  const quote = text.slice(offset, end);
  const before = contextChars ? text.slice(Math.max(0, offset - contextChars), offset) : '';
  const after  = contextChars ? text.slice(end, Math.min(text.length, end + contextChars)) : '';

  return {
    page_id:      pageId,
    page_name:    pageRow.page_name,
    chapter_id:   pageRow.chapter_id || null,
    chapter_name: pageRow.chapter_name || null,
    offset,
    length:       end - offset,
    page_chars:   text.length,
    quote,
    ...(before ? { before } : {}),
    ...(after  ? { after  } : {}),
    ...(end - offset < length ? { clamped_to_eot: true } : {}),
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

// ── Dispatch ──────────────────────────────────────────────────────────────────

const TOOLS = {
  list_chapters:          tool_list_chapters,
  list_figures:           tool_list_figures,
  list_revisions:         tool_list_revisions,
  count_pronouns:         tool_count_pronouns,
  get_figure_mentions:    tool_get_figure_mentions,
  search_passages:        tool_search_passages,
  get_pages:              tool_get_pages,
  get_reviews:            tool_get_reviews,
  get_figure_relations:   tool_get_figure_relations,
  get_figure_profile:     tool_get_figure_profile,
  list_continuity_issues: tool_list_continuity_issues,
  get_timeline:           tool_get_timeline,
  list_ideen:             tool_list_ideen,
  get_lektorat_hotspots:  tool_get_lektorat_hotspots,
  get_stil_metrics:       tool_get_stil_metrics,
  list_locations:         tool_list_locations,
  list_scenes:            tool_list_scenes,
  list_werkstatt_drafts:  tool_list_werkstatt_drafts,
  get_werkstatt_draft:    tool_get_werkstatt_draft,
  get_book_settings:      tool_get_book_settings,
  find_repetitions:       tool_find_repetitions,
  get_dialogue:           tool_get_dialogue,
  diff_page_revisions:    tool_diff_page_revisions,
  find_first_last_mention: tool_find_first_last_mention,
  quote_passage:          tool_quote_passage,
};

async function executeTool(name, input, ctx) {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`Unbekanntes Werkzeug: ${name}`);
  const result = await fn(input || {}, ctx);
  return _truncateResult(result);
}

module.exports = { executeTool, TOOLS };
