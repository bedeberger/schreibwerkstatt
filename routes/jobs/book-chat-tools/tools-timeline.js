'use strict';
// Temporal-Aggregat-Tools: Kontinuitaetspruefungen + Zeitstrahl-Events.
// Beide bauen auf Subqueries mit MAX(checked_at) bzw. sort_order auf und
// haengen via Bridge-Tabellen (issue_figures/issue_chapters bzw.
// event_chapters/event_pages/event_figures) an figures/pages/chapters.
// Das SQL liegt in db/book-chat/timeline.js.

const {
  getLatestContinuityCheck,
  listContinuityIssuesForCheck,
  listContinuityIssueFigures,
  listContinuityIssueChapters,
  listTimelineEvents,
  listTimelineEventFigures,
  listTimelineEventChapters,
  listTimelineEventPages,
} = require('../../../db/book-chat/timeline');
const { _truncateResult, _findFigure } = require('./shared');

// ── list_continuity_issues ────────────────────────────────────────────────────

const CONTINUITY_DEFAULT_LIMIT = 30;

function tool_list_continuity_issues(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const check = getLatestContinuityCheck(ctx.bookId, userEmail);
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

  let issues = listContinuityIssuesForCheck(check.id);

  if (schwereFilter) issues = issues.filter(i => (i.schwere || '').toLowerCase() === schwereFilter);
  if (typFilter)     issues = issues.filter(i => (i.typ || '').toLowerCase()     === typFilter);

  if (!issues.length) {
    return { check_id: check.id, checked_at: check.checked_at, summary: check.summary || null, issues: [], total: 0 };
  }

  const issueIds = issues.map(i => i.id);

  const figRows = listContinuityIssueFigures(issueIds);
  const chRows = listContinuityIssueChapters(issueIds);

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

  const events = listTimelineEvents(ctx.bookId, userEmail);

  if (!events.length) {
    return {
      events: [],
      hint: 'Kein Zeitstrahl vorhanden. Komplettanalyse ausführen (Phase 6).',
    };
  }

  const eventIds = events.map(e => e.id);

  const chRows = listTimelineEventChapters(eventIds);
  const pgRows = listTimelineEventPages(eventIds);
  const fgRows = listTimelineEventFigures(eventIds);

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

module.exports = {
  tool_list_continuity_issues,
  tool_get_timeline,
};
