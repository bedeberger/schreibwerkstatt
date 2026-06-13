'use strict';
// Admin-Usage-Queries.
//
// Cost lebt in lib/pricing.js (Re-Compute zur Lese-Zeit). Hier werden nur
// die noetigen Token-/Modell-/Provider-Felder geladen, costUsd() pro Row
// gerufen und aggregiert. Keine Materialisierung in DB.
//
// Privacy-Boundary: keine Joins auf books.name — `book_id` bleibt anonyme
// Integer-Spalte fuer den Admin. Wer Buchnamen sehen will, braucht ACL-
// Zugriff via book_access.

const { db } = require('./connection');
const { costUsd } = require('../lib/pricing');
const { firstOfCurrentMonthIso } = require('../lib/budget');
const { excludeChatSourcedSql } = require('../lib/usage-sources');

function _isoOrNull(v) {
  if (!v) return null;
  if (typeof v !== 'string') return null;
  return v;
}

function _resolveRange({ from, to } = {}) {
  const fromIso = _isoOrNull(from) || firstOfCurrentMonthIso();
  const toIso   = _isoOrNull(to)   || new Date(Date.now() + 86400_000).toISOString();
  return { fromIso, toIso };
}

// ── Cost-Aggregation ────────────────────────────────────────────────────────

// Chat-Verbrauch wird hier NICHT aus job_runs gezogen — er lebt in chat_messages
// (_stmtChatsRange). Ohne Ausschluss zaehlte jeder Chat-Dollar doppelt.
const _stmtJobsRange = db.prepare(`
  SELECT user_email, provider, model, tokens_in, tokens_out,
         cache_read_in, cache_creation_in, cache_creation_1h_in
    FROM job_runs
   WHERE queued_at >= ? AND queued_at < ? AND ${excludeChatSourcedSql()}
`);

const _stmtChatsRange = db.prepare(`
  SELECT cs.user_email AS user_email, cm.provider, cm.model,
         cm.tokens_in, cm.tokens_out, cm.cache_read_in, cm.cache_creation_in, cm.cache_creation_1h_in
    FROM chat_messages cm
    JOIN chat_sessions cs ON cs.id = cm.session_id
   WHERE cm.created_at >= ? AND cm.created_at < ? AND cm.role = 'assistant'
`);

function _cost(row) {
  return costUsd({
    provider: row.provider, model: row.model,
    tokensIn: row.tokens_in, tokensOut: row.tokens_out,
    cacheReadIn: row.cache_read_in, cacheCreationIn: row.cache_creation_in,
    cacheCreation1hIn: row.cache_creation_1h_in,
  });
}

// Admin-User nutzen die KI-Pipelines nicht (nur Plattform-Mgmt); aus allen
// Cost-/Usage-Aggregaten ausschliessen, damit Reports den echten KI-Verbrauch
// zeigen.
const _stmtAdminEmails = db.prepare(`SELECT email FROM app_users WHERE global_role = 'admin'`);
function _adminEmailSet() {
  const s = new Set();
  for (const r of _stmtAdminEmails.all()) s.add(r.email);
  return s;
}

function _aggregateByUser({ fromIso, toIso }) {
  const admins = _adminEmailSet();
  const acc = new Map();
  const add = (row, source) => {
    const email = row.user_email || '';
    if (!email || admins.has(email)) return;
    const prev = acc.get(email) || {
      email, usd: 0, tokensIn: 0, tokensOut: 0,
      cacheReadIn: 0, cacheCreationIn: 0,
      jobCalls: 0, chatCalls: 0,
    };
    prev.usd += _cost(row);
    prev.tokensIn        += row.tokens_in || 0;
    prev.tokensOut       += row.tokens_out || 0;
    prev.cacheReadIn     += row.cache_read_in || 0;
    prev.cacheCreationIn += row.cache_creation_in || 0;
    if (source === 'job')  prev.jobCalls  += 1;
    if (source === 'chat') prev.chatCalls += 1;
    acc.set(email, prev);
  };
  for (const r of _stmtJobsRange.all(fromIso, toIso))  add(r, 'job');
  for (const r of _stmtChatsRange.all(fromIso, toIso)) add(r, 'chat');
  return acc;
}

// Liefert alle User mit Monatskosten + Budget + Mode. Nicht-Claude-Provider
// landen mit usd=0 in der Liste (Token-Counts trotzdem korrekt).
function listUsersWithUsage({ from, to } = {}) {
  const { fromIso, toIso } = _resolveRange({ from, to });
  const agg = _aggregateByUser({ fromIso, toIso });
  const users = db.prepare(`
    SELECT email, display_name, global_role, status,
           monthly_budget_usd, budget_mode, last_seen_at
      FROM app_users
     WHERE status != 'deleted' AND global_role != 'admin'
     ORDER BY email
  `).all();
  return users.map(u => {
    const a = agg.get(u.email) || { usd: 0, tokensIn: 0, tokensOut: 0, cacheReadIn: 0, cacheCreationIn: 0, jobCalls: 0, chatCalls: 0 };
    return {
      email: u.email,
      displayName: u.display_name,
      globalRole: u.global_role,
      status: u.status,
      monthlyBudgetUsd: u.monthly_budget_usd,
      budgetMode: u.budget_mode || 'none',
      lastSeenAt: u.last_seen_at,
      usd: a.usd,
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
      cacheReadIn: a.cacheReadIn,
      cacheCreationIn: a.cacheCreationIn,
      jobCalls: a.jobCalls,
      chatCalls: a.chatCalls,
      overrun: !!(u.monthly_budget_usd && u.budget_mode !== 'none' && a.usd >= u.monthly_budget_usd),
    };
  });
}

// ── Job-Run-Liste (paginiert; mit/ohne User-Filter) ─────────────────────────

function _buildJobsQuery({ emailCount, includeWhere }) {
  const where = ['queued_at >= ?', 'queued_at < ?'];
  if (emailCount > 0) {
    const placeholders = new Array(emailCount).fill('?').join(',');
    where.push(`user_email IN (${placeholders})`);
  }
  if (includeWhere) where.push(includeWhere);
  return `
    SELECT id, job_id, user_email, type, book_id, label, status,
           queued_at, started_at, ended_at,
           provider, model,
           tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in
      FROM job_runs
     WHERE ${where.join(' AND ')}
     ORDER BY queued_at DESC
     LIMIT ? OFFSET ?`;
}

function _buildJobsCountQuery({ emailCount, includeWhere }) {
  const where = ['queued_at >= ?', 'queued_at < ?'];
  if (emailCount > 0) {
    const placeholders = new Array(emailCount).fill('?').join(',');
    where.push(`user_email IN (${placeholders})`);
  }
  if (includeWhere) where.push(includeWhere);
  return `SELECT COUNT(*) AS n FROM job_runs WHERE ${where.join(' AND ')}`;
}

function _adminEmailWhereClause(set) {
  if (!set.size) return null;
  const list = [...set].map(e => `'${e.replace(/'/g, "''")}'`).join(',');
  return `(user_email IS NULL OR user_email NOT IN (${list}))`;
}

function getJobRuns({ emails, email, from, to, limit = 50, offset = 0 } = {}) {
  const list = Array.isArray(emails) ? emails : (email ? [email] : []);
  const { fromIso, toIso } = _resolveRange({ from, to });
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const adminFilter = list.length ? null : _adminEmailWhereClause(_adminEmailSet());
  const listSql  = _buildJobsQuery({ emailCount: list.length, includeWhere: adminFilter });
  const countSql = _buildJobsCountQuery({ emailCount: list.length, includeWhere: adminFilter });
  const args = [fromIso, toIso, ...list, lim, off];
  const countArgs = [fromIso, toIso, ...list];
  const rows = db.prepare(listSql).all(...args).map(r => ({
    id: r.id, jobId: r.job_id, userEmail: r.user_email, type: r.type, bookId: r.book_id, label: r.label,
    status: r.status, queuedAt: r.queued_at, startedAt: r.started_at, endedAt: r.ended_at,
    provider: r.provider, model: r.model,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out,
    cacheReadIn: r.cache_read_in, cacheCreationIn: r.cache_creation_in,
    usd: _cost(r),
  }));
  const total = db.prepare(countSql).get(...countArgs).n;
  return { rows, total };
}

// ── Chat-Messages (paginiert; mit/ohne User-Filter) ─────────────────────────

function _buildChatQuery({ emailCount, includeWhere }) {
  const where = [
    "cm.created_at >= ?", "cm.created_at < ?", "cm.role = 'assistant'",
  ];
  if (emailCount > 0) {
    const placeholders = new Array(emailCount).fill('?').join(',');
    where.push(`cs.user_email IN (${placeholders})`);
  }
  if (includeWhere) where.push(includeWhere);
  return `
    SELECT cm.id, cm.session_id, cs.user_email, cm.created_at,
           cs.kind AS session_kind, cs.book_id, cs.page_id,
           cm.provider, cm.model,
           cm.tokens_in, cm.tokens_out, cm.cache_read_in, cm.cache_creation_in, cm.cache_creation_1h_in
      FROM chat_messages cm
      JOIN chat_sessions cs ON cs.id = cm.session_id
     WHERE ${where.join(' AND ')}
     ORDER BY cm.created_at DESC
     LIMIT ? OFFSET ?`;
}

function _buildChatCountQuery({ emailCount, includeWhere }) {
  const where = [
    "cm.created_at >= ?", "cm.created_at < ?", "cm.role = 'assistant'",
  ];
  if (emailCount > 0) {
    const placeholders = new Array(emailCount).fill('?').join(',');
    where.push(`cs.user_email IN (${placeholders})`);
  }
  if (includeWhere) where.push(includeWhere);
  return `
    SELECT COUNT(*) AS n
      FROM chat_messages cm
      JOIN chat_sessions cs ON cs.id = cm.session_id
     WHERE ${where.join(' AND ')}`;
}

function _adminChatWhereClause(set) {
  if (!set.size) return null;
  const list = [...set].map(e => `'${e.replace(/'/g, "''")}'`).join(',');
  return `cs.user_email NOT IN (${list})`;
}

function getChatMessages({ emails, email, from, to, limit = 50, offset = 0 } = {}) {
  const list = Array.isArray(emails) ? emails : (email ? [email] : []);
  const { fromIso, toIso } = _resolveRange({ from, to });
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const adminFilter = list.length ? null : _adminChatWhereClause(_adminEmailSet());
  const listSql  = _buildChatQuery({ emailCount: list.length, includeWhere: adminFilter });
  const countSql = _buildChatCountQuery({ emailCount: list.length, includeWhere: adminFilter });
  const args = [fromIso, toIso, ...list, lim, off];
  const countArgs = [fromIso, toIso, ...list];
  const rows = db.prepare(listSql).all(...args).map(r => ({
    id: r.id, sessionId: r.session_id, userEmail: r.user_email, createdAt: r.created_at,
    sessionKind: r.session_kind, bookId: r.book_id, pageId: r.page_id,
    provider: r.provider, model: r.model,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out,
    cacheReadIn: r.cache_read_in, cacheCreationIn: r.cache_creation_in,
    usd: _cost(r),
  }));
  const total = db.prepare(countSql).get(...countArgs).n;
  return { rows, total };
}

// ── Summary: Gesamt + Top-User + Pro-Modell + Pro-Job-Typ ──────────────────

function monthlyTotals({ from, to } = {}) {
  const { fromIso, toIso } = _resolveRange({ from, to });
  const admins = _adminEmailSet();
  const notAdmin = (r) => r.user_email && !admins.has(r.user_email);
  const jobs = _stmtJobsRange.all(fromIso, toIso).filter(notAdmin);
  const chats = _stmtChatsRange.all(fromIso, toIso).filter(notAdmin);

  let totalUsd = 0, totalIn = 0, totalOut = 0, totalCacheR = 0, totalCacheW = 0;
  const byUser  = new Map();
  const byModel = new Map();
  const byType  = new Map();

  const bumpUser = (email, usd, row) => {
    const v = byUser.get(email) || { email, usd: 0, tokensIn: 0, tokensOut: 0 };
    v.usd += usd; v.tokensIn += row.tokens_in || 0; v.tokensOut += row.tokens_out || 0;
    byUser.set(email, v);
  };
  const bumpModel = (model, usd, row) => {
    const v = byModel.get(model) || { model, usd: 0, tokensIn: 0, tokensOut: 0 };
    v.usd += usd; v.tokensIn += row.tokens_in || 0; v.tokensOut += row.tokens_out || 0;
    byModel.set(model, v);
  };
  const bumpType = (type, usd) => {
    const v = byType.get(type) || { type, usd: 0, count: 0 };
    v.usd += usd; v.count += 1;
    byType.set(type, v);
  };

  for (const r of jobs) {
    const usd = _cost(r);
    totalUsd += usd;
    totalIn += r.tokens_in || 0;
    totalOut += r.tokens_out || 0;
    totalCacheR += r.cache_read_in || 0;
    totalCacheW += r.cache_creation_in || 0;
    if (r.user_email) bumpUser(r.user_email, usd, r);
    if (r.model) bumpModel(r.model, usd, r);
  }
  for (const r of chats) {
    const usd = _cost(r);
    totalUsd += usd;
    totalIn += r.tokens_in || 0;
    totalOut += r.tokens_out || 0;
    totalCacheR += r.cache_read_in || 0;
    totalCacheW += r.cache_creation_in || 0;
    if (r.user_email) bumpUser(r.user_email, usd, r);
    if (r.model) bumpModel(r.model, usd, r);
  }

  // Job-Typ-Aggregat braucht separates Query mit `type`-Spalte. Chat-Typen
  // ausgeschlossen (siehe _stmtJobsRange) — sie werden unten als ein 'chat'-
  // Bucket aus chat_messages addiert, nicht doppelt aus job_runs.
  const typeRows = db.prepare(`
    SELECT user_email, type, provider, model, tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in
      FROM job_runs WHERE queued_at >= ? AND queued_at < ? AND ${excludeChatSourcedSql()}
  `).all(fromIso, toIso).filter(notAdmin);
  for (const r of typeRows) {
    bumpType(r.type || 'unknown', _cost(r));
  }
  // Chat als eigener „Typ"
  const chatTypeUsd = chats.reduce((s, r) => s + _cost(r), 0);
  if (chatTypeUsd > 0 || chats.length > 0) {
    byType.set('chat', { type: 'chat', usd: chatTypeUsd, count: chats.length });
  }

  const topUsers = [...byUser.values()].sort((a, b) => b.usd - a.usd).slice(0, 10);
  const byModelArr = [...byModel.values()].sort((a, b) => b.usd - a.usd);
  const byTypeArr  = [...byType.values()].sort((a, b) => b.usd - a.usd);

  return {
    from: fromIso, to: toIso,
    totals: {
      usd: totalUsd, tokensIn: totalIn, tokensOut: totalOut,
      cacheReadIn: totalCacheR, cacheCreationIn: totalCacheW,
      jobCalls: jobs.length, chatCalls: chats.length,
    },
    topUsers, byModel: byModelArr, byType: byTypeArr,
  };
}

// ── Feature-Usage (welche Karten/Aktionen) ─────────────────────────────────

const _stmtFeatureUsage = db.prepare(`
  SELECT user_email, feature_key, use_count, last_used
    FROM user_feature_usage
   WHERE last_used >= ? AND last_used < ?
   ORDER BY user_email, feature_key
`);

function listFeatureUsage({ from, to } = {}) {
  const { fromIso, toIso } = _resolveRange({ from, to });
  const fromMs = Date.parse(fromIso);
  const toMs   = Date.parse(toIso);
  const admins = _adminEmailSet();
  const rows = _stmtFeatureUsage.all(fromMs, toMs).filter(r => !admins.has(r.user_email));
  return rows.map(r => ({
    email: r.user_email, featureKey: r.feature_key,
    count: r.use_count, lastUsed: r.last_used,
  }));
}

function featureUsageTotals({ from, to } = {}) {
  const items = listFeatureUsage({ from, to });
  const byKey = new Map();
  for (const r of items) {
    const v = byKey.get(r.featureKey) || { featureKey: r.featureKey, count: 0 };
    v.count += r.count;
    byKey.set(r.featureKey, v);
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

// ── Zeit-Aggregation (writing_time + lektorat_time) ─────────────────────────

function _yyyymmdd(iso) { return (iso || '').slice(0, 10); }

const _stmtWritingTime = db.prepare(`
  SELECT user_email, book_id, SUM(seconds) AS seconds
    FROM writing_time
   WHERE date >= ? AND date <= ?
   GROUP BY user_email, book_id
`);

const _stmtLektoratTime = db.prepare(`
  SELECT user_email, book_id, SUM(seconds) AS seconds
    FROM lektorat_time
   WHERE date >= ? AND date <= ?
   GROUP BY user_email, book_id
`);

function listTimeUsage({ from, to } = {}) {
  const { fromIso, toIso } = _resolveRange({ from, to });
  const fromDay = _yyyymmdd(fromIso);
  const toDay   = _yyyymmdd(toIso);
  const admins = _adminEmailSet();
  const skipAdmin = (r) => !admins.has(r.user_email);
  const writing  = _stmtWritingTime.all(fromDay, toDay).filter(skipAdmin);
  const lektorat = _stmtLektoratTime.all(fromDay, toDay).filter(skipAdmin);
  const merged = new Map();
  const keyOf = (email, book) => `${email}\t${book}`;
  for (const r of writing) {
    merged.set(keyOf(r.user_email, r.book_id), {
      email: r.user_email, bookId: r.book_id,
      writingSeconds: r.seconds || 0, lektoratSeconds: 0,
    });
  }
  for (const r of lektorat) {
    const k = keyOf(r.user_email, r.book_id);
    const v = merged.get(k) || { email: r.user_email, bookId: r.book_id, writingSeconds: 0, lektoratSeconds: 0 };
    v.lektoratSeconds = (v.lektoratSeconds || 0) + (r.seconds || 0);
    merged.set(k, v);
  }
  return [...merged.values()].map(v => ({
    ...v, totalSeconds: v.writingSeconds + v.lektoratSeconds,
  })).sort((a, b) => b.totalSeconds - a.totalSeconds);
}

const _stmtWritingSeries = db.prepare(`
  SELECT date, SUM(seconds) AS seconds FROM writing_time
   WHERE user_email = ? AND book_id = ? AND date >= ? AND date <= ?
   GROUP BY date
`);
const _stmtLektoratSeries = db.prepare(`
  SELECT date, SUM(seconds) AS seconds FROM lektorat_time
   WHERE user_email = ? AND book_id = ? AND date >= ? AND date <= ?
   GROUP BY date
`);

function dailyTimeSeries(email, bookId, { from, to } = {}) {
  if (!email || !bookId) return [];
  const { fromIso, toIso } = _resolveRange({ from, to });
  const fromDay = _yyyymmdd(fromIso);
  const toDay   = _yyyymmdd(toIso);
  const byDay = new Map();
  for (const r of _stmtWritingSeries.all(email, bookId, fromDay, toDay)) {
    byDay.set(r.date, { date: r.date, writingSeconds: r.seconds || 0, lektoratSeconds: 0 });
  }
  for (const r of _stmtLektoratSeries.all(email, bookId, fromDay, toDay)) {
    const v = byDay.get(r.date) || { date: r.date, writingSeconds: 0, lektoratSeconds: 0 };
    v.lektoratSeconds += r.seconds || 0;
    byDay.set(r.date, v);
  }
  return [...byDay.values()]
    .map(v => ({ ...v, totalSeconds: v.writingSeconds + v.lektoratSeconds }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = {
  listUsersWithUsage,
  getJobRuns, getChatMessages,
  monthlyTotals,
  listFeatureUsage, featureUsageTotals,
  listTimeUsage, dailyTimeSeries,
};
