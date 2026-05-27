'use strict';
// Prometheus-Exposition (Text-Format 0.0.4) fuer externe Scraper.
// Gauges spiegeln Live-Zustand (DB-Counts, Job-Queue), Counter sind
// kumuliert seit DB-Init (job_runs/chat_messages-Lifetime).
// Pricing-Re-Compute erfolgt aggregiert pro (provider, model) — Cost ist
// additiv in den Token-Summen, daher mathematisch identisch zu Per-Row-Cost.

const { db } = require('../db/connection');
const { costUsd } = require('./pricing');
const { localIsoDate } = require('./local-date');
const { allMergeCounters } = require('../db/merge-telemetry');
const { jobs: jobsMap, jobQueue } = require('../routes/jobs/shared/state');

let _pkgVersion = '0.0.0';
try { _pkgVersion = require('../package.json').version || '0.0.0'; } catch (_) {}

function escLabel(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function fmtLabels(labels) {
  if (!labels) return '';
  const parts = [];
  for (const [k, v] of Object.entries(labels)) {
    if (v == null || v === '') continue;
    parts.push(`${k}="${escLabel(v)}"`);
  }
  return parts.length ? `{${parts.join(',')}}` : '';
}

function makeEmitter() {
  const lines = [];
  const seenHeader = new Set();
  function emit(name, type, help, value, labels) {
    if (!seenHeader.has(name)) {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      seenHeader.add(name);
    }
    const n = Number(value);
    lines.push(`${name}${fmtLabels(labels)} ${Number.isFinite(n) ? n : 0}`);
  }
  return { lines, emit };
}

function collectMetrics() {
  const { lines, emit } = makeEmitter();

  emit('sw_build_info', 'gauge', 'Build-/Versionsinfo (Wert immer 1)',
       1, { version: _pkgVersion });

  // ── User ──────────────────────────────────────────────────────────────────
  const userRows = db.prepare(
    "SELECT status, COUNT(*) AS n FROM app_users GROUP BY status"
  ).all();
  for (const r of userRows) {
    emit('sw_users', 'gauge', 'Anzahl User pro Status', r.n, { status: r.status });
  }
  const now = Date.now();
  const iso24h = new Date(now - 24 * 3600 * 1000).toISOString();
  const iso7d  = new Date(now - 7 * 86400 * 1000).toISOString();
  emit('sw_active_users_24h', 'gauge',
       'Aktive User (last_seen_at innerhalb 24h)',
       db.prepare('SELECT COUNT(*) n FROM app_users WHERE last_seen_at >= ?').get(iso24h).n);
  emit('sw_active_users_7d', 'gauge',
       'Aktive User (last_seen_at innerhalb 7 Tagen)',
       db.prepare('SELECT COUNT(*) n FROM app_users WHERE last_seen_at >= ?').get(iso7d).n);

  // ── Content ───────────────────────────────────────────────────────────────
  emit('sw_books', 'gauge', 'Anzahl Buecher in der DB',
       db.prepare('SELECT COUNT(*) n FROM books').get().n);
  emit('sw_pages', 'gauge', 'Anzahl Seiten in der DB',
       db.prepare('SELECT COUNT(*) n FROM pages').get().n);
  emit('sw_chapters', 'gauge', 'Anzahl Kapitel in der DB',
       db.prepare('SELECT COUNT(*) n FROM chapters').get().n);
  const totalChars = db.prepare('SELECT COALESCE(SUM(chars),0) n FROM page_stats').get().n;
  emit('sw_chars', 'gauge', 'Summe Zeichen ueber alle Seiten (page_stats.chars)',
       totalChars);
  emit('sw_words', 'gauge', 'Summe Woerter ueber alle Seiten (page_stats.words)',
       db.prepare('SELECT COALESCE(SUM(words),0) n FROM page_stats').get().n);
  emit('sw_normseiten', 'gauge',
       'Normseiten (1800 Zeichen je Normseite, abgeleitet aus sw_chars)',
       Math.round(totalChars / 1800));

  // ── Writing-Activity (heute, lokale TZ aus app.timezone) ──────────────────
  const today = localIsoDate(new Date());
  emit('sw_writing_seconds_today', 'gauge',
       'Schreibsekunden heute (writing_time, app.timezone)',
       db.prepare('SELECT COALESCE(SUM(seconds),0) n FROM writing_time WHERE date = ?').get(today).n);
  emit('sw_lektorat_seconds_today', 'gauge',
       'Lektorat-Sekunden heute (lektorat_time, app.timezone)',
       db.prepare('SELECT COALESCE(SUM(seconds),0) n FROM lektorat_time WHERE date = ?').get(today).n);

  // ── Job-Queue (In-Memory Live-State) ──────────────────────────────────────
  let running = 0, queuedStatus = 0;
  const byStatusType = new Map();
  for (const j of jobsMap.values()) {
    if (j.status === 'running') running++;
    if (j.status === 'queued')  queuedStatus++;
    const key = `${j.type || 'unknown'}\t${j.status || 'unknown'}`;
    byStatusType.set(key, (byStatusType.get(key) || 0) + 1);
  }
  emit('sw_jobs_running', 'gauge', 'Aktuell laufende Jobs (in-memory state)', running);
  emit('sw_jobs_queued',  'gauge', 'Wartende Jobs in der Queue',
       Math.max(queuedStatus, jobQueue.length));
  for (const [k, n] of byStatusType.entries()) {
    const [type, status] = k.split('\t');
    emit('sw_jobs_in_memory', 'gauge',
         'Jobs im In-Memory-State (vor Cleanup) nach Typ und Status',
         n, { type, status });
  }

  // ── Persistente Job-Historie (kumuliert seit DB-Init) ─────────────────────
  const jrByType = db.prepare(
    'SELECT type, status, COUNT(*) n FROM job_runs GROUP BY type, status'
  ).all();
  for (const r of jrByType) {
    emit('sw_jobs_finished_total', 'counter',
         'Beendete Jobs aus job_runs nach Typ und Status (kumuliert)',
         r.n, { type: r.type || 'unknown', status: r.status || 'unknown' });
  }

  // ── Tokens + Cost (job_runs + chat_messages, aggregiert pro provider/model) ─
  const tokenRows = db.prepare(`
    SELECT provider, model,
           COALESCE(SUM(tokens_in),0)         AS t_in,
           COALESCE(SUM(tokens_out),0)        AS t_out,
           COALESCE(SUM(cache_read_in),0)     AS c_r,
           COALESCE(SUM(cache_creation_in),0) AS c_w
      FROM (
        SELECT provider, model, tokens_in, tokens_out, cache_read_in, cache_creation_in
          FROM job_runs
        UNION ALL
        SELECT cm.provider, cm.model, cm.tokens_in, cm.tokens_out,
               cm.cache_read_in, cm.cache_creation_in
          FROM chat_messages cm
         WHERE cm.role = 'assistant'
      )
     GROUP BY provider, model
  `).all();
  for (const r of tokenRows) {
    const labels = { provider: r.provider || 'unknown', model: r.model || 'unknown' };
    emit('sw_tokens_in_total', 'counter',
         'Input-Tokens kumuliert pro Provider/Modell', r.t_in, labels);
    emit('sw_tokens_out_total', 'counter',
         'Output-Tokens kumuliert pro Provider/Modell', r.t_out, labels);
    emit('sw_cache_read_tokens_total', 'counter',
         'Cache-Read-Tokens kumuliert pro Provider/Modell', r.c_r, labels);
    emit('sw_cache_creation_tokens_total', 'counter',
         'Cache-Write-Tokens kumuliert pro Provider/Modell', r.c_w, labels);
    const usd = costUsd({
      provider: r.provider, model: r.model,
      tokensIn: r.t_in, tokensOut: r.t_out,
      cacheReadIn: r.c_r, cacheCreationIn: r.c_w,
    });
    emit('sw_cost_usd_total', 'counter',
         'Kumulierte API-Kosten in USD pro Provider/Modell (re-computed aus Pricing-Tabelle)',
         usd, labels);
  }

  // ── Block-Level-Merge-Telemetrie (kumuliert seit DB-Init) ─────────────────
  const mc = allMergeCounters();
  emit('sw_merge_silent_total', 'counter',
       'Stille Block-Auto-Merges ohne User-Aktion (kumuliert)',
       mc.silent_success || 0);
  emit('sw_merge_conflict_shown_total', 'counter',
       'Konflikt-Auflösungs-Banner angezeigt (kumuliert)',
       mc.conflict_shown || 0);
  emit('sw_merge_fallback_overwrite_total', 'counter',
       'Klassischer Last-Write-Wins-Overwrite trotz aktivem Block-Merge (kumuliert)',
       mc.fallback_overwrite || 0);
  for (const choice of ['local', 'remote', 'both']) {
    emit('sw_merge_conflict_resolved_total', 'counter',
         'Aufgelöste Konflikt-Blöcke nach gewählter Seite (kumuliert)',
         mc[`conflict_resolved_${choice}`] || 0, { choice });
  }

  return lines.join('\n') + '\n';
}

module.exports = { collectMetrics };
