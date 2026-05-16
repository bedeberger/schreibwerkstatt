// Phase 4d: checkBudget + enforceBudget.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDb = path.join(os.tmpdir(), `budget-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const { checkBudget, enforceBudget, firstOfCurrentMonthUtc, sumCostUsdSince } = require('../../lib/budget');

function seedUser(email, mode = 'none', budget = null) {
  appUsers.createUser({ email });
  appUsers.setBudget(email, { usd: budget, mode });
}

function insertJobRun({ email, tokensIn = 0, tokensOut = 0, model = 'claude-sonnet-4-6', provider = 'claude', when = new Date() }) {
  db.prepare(`
    INSERT INTO job_runs (job_id, type, book_id, user_email, status, queued_at, started_at, ended_at,
                          tokens_in, tokens_out, provider, model, cache_read_in, cache_creation_in)
    VALUES (?, 'check', NULL, ?, 'done', ?, ?, ?, ?, ?, ?, ?, 0, 0)
  `).run(
    `j-${Math.random().toString(36).slice(2, 10)}`,
    email, when.toISOString(), when.toISOString(), when.toISOString(),
    tokensIn, tokensOut, provider, model,
  );
}

test('checkBudget: mode none → allowed, kein DB-Scan', () => {
  seedUser('none@ex.com', 'none');
  insertJobRun({ email: 'none@ex.com', tokensIn: 1_000_000, tokensOut: 1_000_000 });
  const r = checkBudget('none@ex.com');
  assert.equal(r.allowed, true);
  assert.equal(r.mode, 'none');
});

test('checkBudget: mode soft + over budget → allowed=true, overrun=true', () => {
  seedUser('soft@ex.com', 'soft', 1);
  insertJobRun({ email: 'soft@ex.com', tokensIn: 1_000_000, tokensOut: 1_000_000 });
  const r = checkBudget('soft@ex.com');
  assert.equal(r.allowed, true);
  assert.equal(r.mode, 'soft');
  assert.equal(r.overrun, true);
  assert.ok(r.usd >= 18);
});

test('checkBudget: mode hard + over budget → allowed=false', () => {
  seedUser('hard@ex.com', 'hard', 5);
  insertJobRun({ email: 'hard@ex.com', tokensIn: 1_000_000, tokensOut: 1_000_000 });
  const r = checkBudget('hard@ex.com');
  assert.equal(r.allowed, false);
  assert.equal(r.mode, 'hard');
  assert.equal(r.overrun, true);
});

test('checkBudget: mode hard + under budget → allowed=true', () => {
  seedUser('under@ex.com', 'hard', 100);
  insertJobRun({ email: 'under@ex.com', tokensIn: 1_000, tokensOut: 1_000 });
  const r = checkBudget('under@ex.com');
  assert.equal(r.allowed, true);
  assert.equal(r.overrun, false);
});

test('checkBudget: lokaler Provider (ollama) zaehlt 0 USD', () => {
  seedUser('local@ex.com', 'hard', 1);
  insertJobRun({ email: 'local@ex.com', tokensIn: 10_000_000, tokensOut: 10_000_000, provider: 'ollama', model: 'llama3.2' });
  const r = checkBudget('local@ex.com');
  assert.equal(r.allowed, true);
  assert.equal(r.overrun, false);
  assert.equal(r.usd, 0);
});

test('checkBudget: monatliche Grenze schneidet Vormonats-Jobs ab', () => {
  seedUser('lastmonth@ex.com', 'hard', 1);
  const lastMonth = new Date();
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  insertJobRun({ email: 'lastmonth@ex.com', tokensIn: 10_000_000, tokensOut: 10_000_000, when: lastMonth });
  const r = checkBudget('lastmonth@ex.com');
  assert.equal(r.allowed, true);
  assert.equal(r.usd, 0);
});

test('checkBudget: unbekannter User → allowed, mode=none', () => {
  const r = checkBudget('nobody@ex.com');
  assert.equal(r.allowed, true);
  assert.equal(r.mode, 'none');
});

test('checkBudget: budget=null mit mode=soft/hard → kein numerisches Limit, allowed', () => {
  seedUser('nolimit@ex.com', 'hard', null);
  insertJobRun({ email: 'nolimit@ex.com', tokensIn: 10_000_000, tokensOut: 10_000_000 });
  const r = checkBudget('nolimit@ex.com');
  assert.equal(r.allowed, true);
});

test('sumCostUsdSince: aggregiert ueber job_runs + chat_messages', () => {
  seedUser('agg@ex.com', 'none', null);
  insertJobRun({ email: 'agg@ex.com', tokensIn: 1_000_000, tokensOut: 0 });

  // FK: chat_sessions.book_id → books(book_id). Seeded Book vorab.
  db.prepare(`INSERT OR IGNORE INTO books (book_id, name, created_at, updated_at)
              VALUES (4242, 'agg-test', datetime('now'), datetime('now'))`).run();

  const csResult = db.prepare(`
    INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at)
    VALUES (4242, 'book', 'agg@ex.com', datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO chat_messages (session_id, role, content, tokens_in, tokens_out, provider, model, cache_read_in, cache_creation_in, created_at)
    VALUES (?, 'assistant', 'hi', 1000000, 0, 'claude', 'claude-sonnet-4-6', 0, 0, datetime('now'))
  `).run(csResult.lastInsertRowid);

  const total = sumCostUsdSince('agg@ex.com', firstOfCurrentMonthUtc());
  // 2 Mio Input @ 3 USD/Mio = 6 USD
  assert.equal(Math.round(total * 100) / 100, 6.00);
});

test('enforceBudget middleware: GET → next() ohne Pruefung', () => {
  let called = false;
  enforceBudget(
    { method: 'GET', session: { user: { email: 'hard@ex.com' } } },
    { status: () => ({ json: () => {} }) },
    () => { called = true; }
  );
  assert.equal(called, true);
});

test('enforceBudget middleware: POST + hard-overrun → 429', () => {
  let statusCode = 0;
  let body = null;
  enforceBudget(
    { method: 'POST', session: { user: { email: 'hard@ex.com' } } },
    {
      status(n) { statusCode = n; return { json(b) { body = b; } }; },
    },
    () => { throw new Error('next should not be called'); }
  );
  assert.equal(statusCode, 429);
  assert.equal(body.error_code, 'BUDGET_EXCEEDED');
});
