'use strict';
// Kosten-Abgleich mit der Anthropic-Rechnung.
//
// Holt die abgerechneten Tageskosten aus der Cost-Report-API der Admin-API
// (GET /v1/organizations/cost_report) nach anthropic_cost_daily und stellt sie
// dem eigenen Kosten-Ledger (ai_cost_ledger) gegenueber. Die beiden Quellen
// ergaenzen sich, keine ersetzt die andere:
//   - Anthropic: was tatsaechlich in Rechnung steht — aber nur je Tag x
//     Modell/Token-Art/Workspace, ohne User- oder Buchbezug.
//   - Ledger: pro Call eingefrorene USD mit User/Buch/Job-Typ — Grundlage fuer
//     Budget-Gate und Pro-User-Auswertung, aber nur so genau wie lib/pricing.js.
// Weicht beides auseinander, ist die Preistabelle veraltet oder es laeuft
// Fremdverbrauch im selben Workspace.
//
// Kein KI-Call (keine Job-Queue noetig) und ein fest verdrahteter Host (kein
// SSRF-Guard) — Timeout und Byte-Deckel gelten trotzdem, ein haengender Abruf
// darf den Cron nicht blockieren.

const appSettings = require('./app-settings');
const billingDb = require('../db/anthropic-billing');
const costLedger = require('../db/cost-ledger');
const logger = require('../logger');

const COST_REPORT_URL = 'https://api.anthropic.com/v1/organizations/cost_report';
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 20;
// Erstbefuellung holt ein Quartal; danach genuegt eine Woche, um die
// nachtraeglichen Korrekturen der juengsten Tage mitzunehmen.
const BACKFILL_DAYS = 90;
const DAILY_DAYS = 7;

let _lastError = null; // { at, code, status }

function _dayOf(date) { return date.toISOString().slice(0, 10); }
function _addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return _dayOf(d);
}

function _apiKey() {
  return String(appSettings.get('ai.claude.admin_api_key') || '').trim();
}

function isConfigured() { return !!_apiKey(); }

function _fail(code, status) {
  const err = new Error(code);
  err.code = code;
  if (status) err.status = status;
  return err;
}

async function _readCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { await reader.cancel(); throw _fail('BILLING_RESPONSE_TOO_LARGE'); }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Alle Seiten eines Zeitraums. `fetchImpl` ist fuer Tests injizierbar.
async function fetchCostReport({ fromDay, toDay, apiKey, fetchImpl = fetch }) {
  const buckets = [];
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL(COST_REPORT_URL);
    url.searchParams.set('starting_at', `${fromDay}T00:00:00Z`);
    url.searchParams.set('ending_at', `${toDay}T00:00:00Z`);
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('limit', '31');
    url.searchParams.append('group_by[]', 'description');
    url.searchParams.append('group_by[]', 'workspace_id');
    if (page) url.searchParams.set('page', page);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let body;
    try {
      const res = await fetchImpl(url.toString(), {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Accept': 'application/json',
          'User-Agent': 'schreibwerkstatt-billing',
        },
        signal: ctrl.signal,
      });
      if (res.status === 401 || res.status === 403) throw _fail('BILLING_AUTH_FAILED', res.status);
      if (!res.ok) throw _fail('BILLING_FETCH_FAILED', res.status);
      body = await _readCapped(res);
    } catch (e) {
      if (e.code) throw e;
      throw _fail(e.name === 'AbortError' ? 'BILLING_TIMEOUT' : 'BILLING_FETCH_FAILED');
    } finally {
      clearTimeout(timer);
    }
    if (!Array.isArray(body?.data)) throw _fail('BILLING_BAD_RESPONSE');
    buckets.push(...body.data);
    if (!body.has_more || !body.next_page) return buckets;
    page = body.next_page;
  }
  throw _fail('BILLING_TOO_MANY_PAGES');
}

// Buckets → Tabellenzeilen. `amount` ist ein Dezimal-String in Cent. Ein Tag
// ohne Kosten bekommt eine 0-Zeile ohne Dimensionen: so unterscheidet der
// Abgleich „abgerufen, nichts angefallen" (0) von „nie abgerufen" (keine Zeile).
function bucketsToRows(buckets) {
  const rows = [];
  for (const b of buckets) {
    const day = String(b.starting_at || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const results = Array.isArray(b.results) ? b.results : [];
    if (!results.length) {
      rows.push({ day, workspace_id: null, description: null, model: null, cost_type: null,
        token_type: null, service_tier: null, context_window: null, usd: 0 });
      continue;
    }
    for (const r of results) {
      if (r.currency && r.currency !== 'USD') continue;
      const cents = Number(r.amount);
      rows.push({
        day,
        workspace_id: r.workspace_id ?? null,
        description: r.description ?? null,
        model: r.model ?? null,
        cost_type: r.cost_type ?? null,
        token_type: r.token_type ?? null,
        service_tier: r.service_tier ?? null,
        context_window: r.context_window ?? null,
        usd: Number.isFinite(cents) ? cents / 100 : 0,
      });
    }
  }
  return rows;
}

// Ruft die letzten `days` UTC-Tage (inkl. heute) ab und ersetzt sie in der DB.
// Ohne `days`: Erstbefuellung bei leerer Tabelle, sonst die Korrekturwoche.
// Ohne Admin-Key ein No-op (`{ configured: false }`), damit der Cron auf
// Instanzen ohne Anthropic-Organisation still bleibt.
async function syncBilling({ days, fetchImpl } = {}) {
  const apiKey = _apiKey();
  if (!apiKey) return { configured: false };
  const span = days || (billingDb.lastFetchedAt() ? DAILY_DAYS : BACKFILL_DAYS);
  const toDay = _addDays(_dayOf(new Date()), 1);
  const fromDay = _addDays(toDay, -span);
  try {
    const buckets = await fetchCostReport({ fromDay, toDay, apiKey, fetchImpl });
    const rows = bucketsToRows(buckets);
    billingDb.replaceRange(fromDay, toDay, rows);
    _lastError = null;
    logger.info(`[billing] Anthropic-Kosten ${fromDay}..${toDay} abgerufen (${rows.length} Zeilen).`);
    return { configured: true, fromDay, toDay, rows: rows.length };
  } catch (e) {
    _lastError = { at: new Date().toISOString(), code: e.code || 'BILLING_FETCH_FAILED', status: e.status || null };
    logger.warn(`[billing] Abruf fehlgeschlagen: ${e.code || e.message}${e.status ? ` (HTTP ${e.status})` : ''}`);
    throw e;
  }
}

// Ledger-Modelle tragen gelegentlich einen Kontext-Suffix (`claude-opus-4-8[1m]`),
// die API liefert die blanke ID.
function normalizeModel(model) {
  return String(model || '').replace(/\[[^\]]*\]$/, '').trim();
}

// Abweichung Rechnung minus Ledger; relativ zum Ledger (positiv = Anthropic
// berechnet mehr, als die App bucht). Ohne Abrechnung keine Abweichung.
function _withDiff(row) {
  if (row.billedUsd === null) return { ...row, diffUsd: null, diffPct: null };
  const diffUsd = row.billedUsd - row.ledgerUsd;
  return { ...row, diffUsd, diffPct: row.ledgerUsd > 0 ? diffUsd / row.ledgerUsd : null };
}

// Gegenueberstellung fuer das Admin-UI. `from`/`to` wie die uebrigen
// Usage-Tabs: from inklusiv, to exklusiv, als Datum. Beide Seiten rechnen in
// UTC-Tagen (so schneidet die API ihre Buckets) — der Default ist darum der
// UTC-Monatsanfang, nicht der lokale.
function buildReport({ from, to } = {}) {
  const fromDay = String(from || `${_dayOf(new Date()).slice(0, 7)}-01`).slice(0, 10);
  const toDay = String(to || _addDays(_dayOf(new Date()), 1)).slice(0, 10);
  const workspace = String(appSettings.get('ai.claude.billing.workspace_id') || '').trim();

  const billedByDay = new Map(billingDb.dailyTotals({ fromDay, toDay, workspace }).map(r => [r.day, r.usd]));
  const ledgerByDay = new Map();
  const models = new Map();
  const bumpModel = (key, field, usd) => {
    const v = models.get(key) || { key, billedUsd: 0, ledgerUsd: 0 };
    v[field] += usd || 0;
    models.set(key, v);
  };
  for (const r of costLedger.claudeByDayModel(fromDay, toDay)) {
    ledgerByDay.set(r.day, (ledgerByDay.get(r.day) || 0) + (r.usd || 0));
    bumpModel(normalizeModel(r.model) || 'unknown', 'ledgerUsd', r.usd);
  }
  for (const r of billingDb.totalsByModel({ fromDay, toDay, workspace })) {
    if (!r.model && !r.cost_type) continue; // 0-Marker leerer Tage
    bumpModel(r.model || `cost:${r.cost_type}`, 'billedUsd', r.usd);
  }

  const dayKeys = [...new Set([...billedByDay.keys(), ...ledgerByDay.keys()])].sort();
  const days = dayKeys.map(day => _withDiff({
    day,
    billedUsd: billedByDay.has(day) ? billedByDay.get(day) : null,
    ledgerUsd: ledgerByDay.get(day) || 0,
  }));
  // Summen nur ueber Tage, fuer die eine Abrechnung vorliegt — sonst liefe ein
  // noch nicht abgerufener Tag als scheinbare Abweichung in den Vergleich.
  const covered = days.filter(d => d.billedUsd !== null);
  const billedUsd = covered.reduce((s, d) => s + d.billedUsd, 0);
  const ledgerUsdCovered = covered.reduce((s, d) => s + d.ledgerUsd, 0);

  return {
    configured: isConfigured(),
    workspace,
    fromDay, toDay,
    lastFetchedAt: billingDb.lastFetchedAt(),
    lastError: _lastError,
    totals: { ..._withDiff({ billedUsd, ledgerUsd: ledgerUsdCovered }), coveredDays: covered.length },
    days,
    models: [...models.values()].map(_withDiff).sort((a, b) => (b.billedUsd + b.ledgerUsd) - (a.billedUsd + a.ledgerUsd)),
    workspaces: billingDb.listWorkspaces(),
  };
}

module.exports = { syncBilling, buildReport, fetchCostReport, bucketsToRows, normalizeModel, isConfigured };
