'use strict';
// Tool-Implementierungen für den Agentic Buch-Chat.
// Jede Funktion nimmt (input, ctx) und gibt ein JSON-serialisierbares Objekt zurück.
// ctx = { bookId, userEmail, userToken, jobSignal, logger }

const { db } = require('../../db/schema');
const { INPUT_BUDGET_CHARS } = require('../../lib/ai');
const { bsGet, htmlToText } = require('./shared');
const { inClause } = require('../../lib/validate');

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

// ── get_chapter_stats ─────────────────────────────────────────────────────────

function tool_get_chapter_stats(input, ctx) {
  const chapterId = input.chapter_id;
  if (chapterId == null) throw new Error('chapter_id fehlt');

  const chRow = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE chapter_id = ? AND book_id = ?')
    .get(chapterId, ctx.bookId);
  if (!chRow) return { chapter_id: chapterId, error: 'Kapitel nicht gefunden' };

  const pages = db.prepare(`
    SELECT p.page_id, p.page_name, ps.words, ps.chars, ps.sentences, ps.dialog_chars, ps.pronoun_counts
    FROM pages p
    LEFT JOIN page_stats ps ON ps.page_id = p.page_id
    WHERE p.chapter_id = ? AND p.book_id = ?
    ORDER BY p.page_id
  `).all(chapterId, ctx.bookId);

  let words = 0, chars = 0, sentences = 0, dialogChars = 0;
  for (const p of pages) {
    words += p.words || 0;
    chars += p.chars || 0;
    sentences += p.sentences || 0;
    dialogChars += p.dialog_chars || 0;
  }
  const dialogRatio = chars > 0 ? Math.round((dialogChars / chars) * 1000) / 1000 : 0;

  // Top-5 Figuren dieses Kapitels
  const topFiguren = db.prepare(`
    SELECT f.fig_id, f.name, f.user_email, SUM(pfm.count) AS total
    FROM page_figure_mentions pfm
    JOIN pages p  ON p.page_id = pfm.page_id
    JOIN figures f ON f.id = pfm.figure_id
    WHERE p.chapter_id = ? AND p.book_id = ? AND f.user_email IS ?
    GROUP BY f.id
    ORDER BY total DESC
    LIMIT 5
  `).all(chapterId, ctx.bookId, ctx.userEmail || null);

  return {
    chapter_id: chapterId,
    chapter_name: chRow.chapter_name,
    pages: pages.length,
    words,
    sentences,
    chars,
    dialog_chars: dialogChars,
    dialog_ratio: dialogRatio,
    top_figuren: topFiguren.map(f => ({ fig_id: f.fig_id, name: f.name, mentions: f.total })),
  };
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
  // Erstes Vorkommen
  const first = mentions[0];

  // Nach Kapitel gruppieren
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
    first_appearance: {
      chapter_id: first.chapter_id,
      chapter_name: first.chapter_name || '(ohne Kapitel)',
      page_id: first.page_id,
      page_name: first.page_name,
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

  // Kandidaten: zuerst preview_text (gecacht) scannen. Bei Treffer → page_id merken,
  // bis Limit erreicht ist oder Preview-Scan durch ist.
  const pages = db.prepare(
    'SELECT page_id, page_name, chapter_id, preview_text FROM pages WHERE book_id = ? AND preview_text IS NOT NULL'
  ).all(ctx.bookId);

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
      const pd = await bsGet(`pages/${pageId}`, ctx.userToken);
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

// ── list_chapter_reviews ─────────────────────────────────────────────────────

const CHAPTER_REVIEW_FAZIT_CHARS = 400;
const CHAPTER_REVIEW_DEFAULT_LIMIT = 30;

function tool_list_chapter_reviews(input, ctx) {
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

// ── Dispatch ──────────────────────────────────────────────────────────────────

const TOOLS = {
  list_chapters:         tool_list_chapters,
  count_pronouns:        tool_count_pronouns,
  get_chapter_stats:     tool_get_chapter_stats,
  get_figure_mentions:   tool_get_figure_mentions,
  search_passages:       tool_search_passages,
  get_pages:             tool_get_pages,
  list_chapter_reviews:  tool_list_chapter_reviews,
  get_figure_relations:  tool_get_figure_relations,
  get_figure_profile:    tool_get_figure_profile,
  list_continuity_issues: tool_list_continuity_issues,
  get_timeline:          tool_get_timeline,
};

async function executeTool(name, input, ctx) {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`Unbekanntes Werkzeug: ${name}`);
  const result = await fn(input || {}, ctx);
  return _truncateResult(result);
}

module.exports = { executeTool, TOOLS };
