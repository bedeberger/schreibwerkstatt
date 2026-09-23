'use strict';
// lib/anthropic-billing.js — Kosten-Abgleich gegen die Anthropic-Cost-Report-API.
// Kein Netz: fetchImpl wird injiziert.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(os.tmpdir(), `anthropic-billing-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.ANTHROPIC_ADMIN_KEY;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-anthropic-billing';

require('../../db/migrations');
const { db } = require('../../db/connection');
const appSettings = require('../../lib/app-settings');
const billing = require('../../lib/anthropic-billing');

test.after(() => {
  try { db.close(); } catch {}
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { fs.unlinkSync(f); } catch {} }
});

function _res(status, body) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    status, ok: status >= 200 && status < 300,
    body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
  };
}

function _today() { return new Date().toISOString().slice(0, 10); }

test('bucketsToRows: Cent-Strings → USD, leerer Tag → 0-Marker', () => {
  const rows = billing.bucketsToRows([
    { starting_at: '2026-09-01T00:00:00Z', results: [
      { amount: '123.45', currency: 'USD', model: 'claude-opus-5-5', cost_type: 'tokens',
        token_type: 'output_tokens', workspace_id: null, description: 'x' },
    ] },
    { starting_at: '2026-09-02T00:00:00Z', results: [] },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].usd, 1.2345);
  assert.equal(rows[0].model, 'claude-opus-5-5');
  assert.deepEqual({ day: rows[1].day, usd: rows[1].usd, model: rows[1].model }, { day: '2026-09-02', usd: 0, model: null });
});

test('normalizeModel: Kontext-Suffix faellt weg', () => {
  assert.equal(billing.normalizeModel('claude-opus-4-8[1m]'), 'claude-opus-4-8');
  assert.equal(billing.normalizeModel('claude-sonnet-5'), 'claude-sonnet-5');
});

test('fetchCostReport: folgt next_page, sendet Admin-Key + group_by', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: new URL(url), opts });
    const page = new URL(url).searchParams.get('page');
    return page
      ? _res(200, { data: [{ starting_at: '2026-09-02T00:00:00Z', results: [] }], has_more: false, next_page: null })
      : _res(200, { data: [{ starting_at: '2026-09-01T00:00:00Z', results: [] }], has_more: true, next_page: 'p2' });
  };
  const buckets = await billing.fetchCostReport({ fromDay: '2026-09-01', toDay: '2026-09-03', apiKey: 'sk-ant-admin01-x', fetchImpl });
  assert.equal(buckets.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.headers['x-api-key'], 'sk-ant-admin01-x');
  assert.deepEqual(calls[0].url.searchParams.getAll('group_by[]'), ['description', 'workspace_id']);
  assert.equal(calls[1].url.searchParams.get('page'), 'p2');
});

test('fetchCostReport: 401 → BILLING_AUTH_FAILED', async () => {
  const fetchImpl = async () => _res(401, { error: {} });
  await assert.rejects(
    billing.fetchCostReport({ fromDay: '2026-09-01', toDay: '2026-09-02', apiKey: 'k', fetchImpl }),
    e => e.code === 'BILLING_AUTH_FAILED' && e.status === 401,
  );
});

test('syncBilling ohne Admin-Key: No-op', async () => {
  const r = await billing.syncBilling({ fetchImpl: async () => { throw new Error('darf nicht fetchen'); } });
  assert.deepEqual(r, { configured: false });
});

test('syncBilling + buildReport: Abgleich Rechnung vs. Ledger, Workspace-Filter', async () => {
  appSettings.set('ai.claude.admin_api_key', 'sk-ant-admin01-test');
  const day = _today();
  const fetchImpl = async () => _res(200, {
    data: [{ starting_at: `${day}T00:00:00Z`, results: [
      { amount: '300', currency: 'USD', model: 'claude-opus-5-5', cost_type: 'tokens', workspace_id: 'wrkspc_app' },
      { amount: '50', currency: 'USD', model: null, cost_type: 'web_search', workspace_id: 'wrkspc_app' },
      { amount: '1000', currency: 'USD', model: 'claude-fable-5-1', cost_type: 'tokens', workspace_id: 'wrkspc_other' },
    ] }],
    has_more: false, next_page: null,
  });
  const r = await billing.syncBilling({ days: 1, fetchImpl });
  assert.equal(r.rows, 3);

  db.prepare(`INSERT INTO ai_cost_ledger (ts, source, provider, model, usd, source_ref)
              VALUES (?, 'job', 'claude', 'claude-opus-5-5[1m]', 3.00, 'job:t1')`).run(`${day}T08:00:00.000Z`);

  const all = billing.buildReport({});
  assert.equal(all.totals.billedUsd, 13.5);
  assert.equal(all.totals.ledgerUsd, 3);

  appSettings.set('ai.claude.billing.workspace_id', 'wrkspc_app');
  const ws = billing.buildReport({});
  assert.equal(ws.totals.billedUsd, 3.5);
  const opus = ws.models.find(m => m.key === 'claude-opus-5-5');
  assert.equal(opus.billedUsd, 3);
  assert.equal(opus.ledgerUsd, 3); // [1m]-Suffix normalisiert
  assert.equal(opus.diffUsd, 0);
  assert.ok(ws.models.some(m => m.key === 'cost:web_search'));

  // Workspace ohne Verbrauch: Tag bleibt „abgerufen" (0), nicht „nie abgerufen".
  appSettings.set('ai.claude.billing.workspace_id', 'wrkspc_leer');
  const empty = billing.buildReport({});
  assert.equal(empty.days.find(d => d.day === day).billedUsd, 0);
});

test('syncBilling ersetzt den Tagesbereich statt anzuhaengen', async () => {
  const day = _today();
  const fetchImpl = async () => _res(200, {
    data: [{ starting_at: `${day}T00:00:00Z`, results: [
      { amount: '100', currency: 'USD', model: 'claude-opus-5-5', cost_type: 'tokens', workspace_id: 'wrkspc_app' },
    ] }],
    has_more: false, next_page: null,
  });
  await billing.syncBilling({ days: 1, fetchImpl });
  const n = db.prepare('SELECT COUNT(*) AS n FROM anthropic_cost_daily WHERE day = ?').get(day).n;
  assert.equal(n, 1);
});
