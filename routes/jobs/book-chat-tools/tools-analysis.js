'use strict';
// Analyse-Tools: Buch-/Kapitel-Reviews, Lektorat-Hotspots + Findings,
// Stil-Metriken (Buch/Kapitel/Seite), N-Gram-Wiederholungen.

const { db } = require('../../../db/schema');
const { htmlToPlainText } = require('../../../lib/html-text');
const { _truncateResult } = require('./shared');

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
    return { scope: 'book', hint: 'Noch keine Buchbewertung vorhanden. Job „Buchbewertung" ausfuehren.' };
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

// ── get_lektorat_hotspots ─────────────────────────────────────────────────────

const HOTSPOTS_DEFAULT_LIMIT = 20;
const HOTSPOTS_FAZIT_CHARS = 200;

function tool_get_lektorat_hotspots(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
  const minErrors     = Number.isInteger(input?.min_errors) ? Math.max(0, input.min_errors) : 0;
  const limit = Math.min(100, Math.max(1, Number.isInteger(input?.limit) ? input.limit : HOTSPOTS_DEFAULT_LIMIT));

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
      hint: 'Keine Lektorat-Ergebnisse mit den gewaehlten Filtern.',
    };
  }

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

// ── get_lektorat_findings ────────────────────────────────────────────────────

const FINDINGS_DEFAULT_LIMIT = 30;
const FINDINGS_MAX_LIMIT     = 100;
const FINDINGS_FIELD_CAP     = 600;

function _clampField(s) {
  if (typeof s !== 'string') return null;
  if (s.length <= FINDINGS_FIELD_CAP) return s;
  return s.slice(0, FINDINGS_FIELD_CAP) + '…';
}

function tool_get_lektorat_findings(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const pageId    = Number.isInteger(input?.page_id)    ? input.page_id    : null;
  const chapterId = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
  const typFilter = typeof input?.typ === 'string' ? input.typ.toLowerCase().trim() : null;
  const limit     = Math.min(FINDINGS_MAX_LIMIT, Math.max(1,
    Number.isInteger(input?.limit) ? input.limit : FINDINGS_DEFAULT_LIMIT));

  let sql = `
    SELECT pc.page_id, pc.checked_at, pc.errors_json, pc.error_count,
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
  if (pageId !== null)         { sql += ' AND pc.page_id = ?';   params.push(pageId); }
  else if (chapterId !== null) { sql += ' AND p.chapter_id = ?'; params.push(chapterId); }
  sql += ' ORDER BY p.chapter_id, p.page_id';

  const rows = db.prepare(sql).all(...params);
  if (!rows.length) {
    return {
      findings: [],
      hint: 'Keine Lektorat-Ergebnisse fuer diesen Filter. Lektorat-Job ausfuehren oder Filter weiten.',
    };
  }

  const findings = [];
  let totalAvailable = 0;
  for (const r of rows) {
    let errs = [];
    try { errs = JSON.parse(r.errors_json || '[]'); } catch { errs = []; }
    if (!Array.isArray(errs)) continue;
    for (const e of errs) {
      if (typFilter && (e.typ || '').toLowerCase() !== typFilter) continue;
      totalAvailable++;
      if (findings.length >= limit) continue;
      findings.push({
        page_id:      r.page_id,
        page_name:    r.page_name,
        chapter_id:   r.chapter_id,
        chapter_name: r.chapter_name || null,
        checked_at:   r.checked_at,
        typ:          e.typ || null,
        original:     _clampField(e.original),
        korrektur:    _clampField(e.korrektur),
        erklaerung:   _clampField(e.erklaerung),
        ...(Number.isInteger(e.offset) ? { offset: e.offset } : {}),
        ...(Number.isInteger(e.length) ? { length: e.length } : {}),
      });
    }
  }

  const byTyp = {};
  for (const r of rows) {
    let errs = [];
    try { errs = JSON.parse(r.errors_json || '[]'); } catch { errs = []; }
    if (!Array.isArray(errs)) continue;
    for (const e of errs) {
      if (typFilter && (e.typ || '').toLowerCase() !== typFilter) continue;
      const key = (e.typ || 'unbekannt').toLowerCase();
      byTyp[key] = (byTyp[key] || 0) + 1;
    }
  }

  return _truncateResult({
    findings,
    total_findings:    totalAvailable,
    pages_with_checks: rows.length,
    by_typ:            byTyp,
    ...(totalAvailable > findings.length
      ? { truncated: true, shown: findings.length, hint: 'Weitere Findings via typ/page_id/chapter_id einschraenken.' }
      : {}),
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
    if (!r || !r.pages) return { hint: 'Keine Stil-Metriken vorhanden. Sync ausfuehren.' };
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
    return { results: [], hint: 'Keine Seiten mit body_html im gewaehlten Scope. Sync ausfuehren.' };
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

module.exports = {
  tool_get_reviews,
  tool_get_lektorat_hotspots,
  tool_get_lektorat_findings,
  tool_get_stil_metrics,
  tool_find_repetitions,
};
