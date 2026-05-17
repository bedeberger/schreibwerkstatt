// admin-usage DB-Queries (listUsersWithUsage, monthlyTotals,
// listFeatureUsage, listTimeUsage, getJobRuns, getChatMessages).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDb = path.join(os.tmpdir(), `admin-usage-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const adminUsage = require('../../db/admin-usage');

function seedUser(email) {
  appUsers.createUser({ email });
}

function seedBook(id, name = 'B') {
  db.prepare(`INSERT OR IGNORE INTO books (book_id, name, created_at, updated_at)
              VALUES (?, ?, datetime('now'), datetime('now'))`).run(id, name);
}

function insertJobRun({ email, bookId = null, type = 'check', tokensIn = 0, tokensOut = 0, model = 'claude-sonnet-4-6', provider = 'claude', when = new Date() }) {
  db.prepare(`
    INSERT INTO job_runs (job_id, type, book_id, user_email, status, queued_at, started_at, ended_at,
                          tokens_in, tokens_out, provider, model, cache_read_in, cache_creation_in)
    VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, ?, 0, 0)
  `).run(
    `j-${Math.random().toString(36).slice(2, 10)}`,
    type, bookId, email, when.toISOString(), when.toISOString(), when.toISOString(),
    tokensIn, tokensOut, provider, model,
  );
}

function insertChatMsg({ email, bookId, kind = 'book', tokensIn = 0, tokensOut = 0, model = 'claude-sonnet-4-6' }) {
  const csResult = db.prepare(`
    INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
  `).run(bookId, kind, email);
  db.prepare(`
    INSERT INTO chat_messages (session_id, role, content, tokens_in, tokens_out, provider, model, cache_read_in, cache_creation_in, created_at)
    VALUES (?, 'assistant', 'hi', ?, ?, 'claude', ?, 0, 0, datetime('now'))
  `).run(csResult.lastInsertRowid, tokensIn, tokensOut, model);
}

test('listUsersWithUsage: aggregiert Jobs + Chat pro User', () => {
  seedUser('a@ex.com');
  seedUser('b@ex.com');
  seedBook(5001);
  insertJobRun({ email: 'a@ex.com', bookId: 5001, tokensIn: 1_000_000, tokensOut: 0 });
  insertChatMsg({ email: 'a@ex.com', bookId: 5001, tokensIn: 0, tokensOut: 1_000_000 });
  insertJobRun({ email: 'b@ex.com', tokensIn: 100_000, tokensOut: 0 });

  const rows = adminUsage.listUsersWithUsage({});
  const a = rows.find(r => r.email === 'a@ex.com');
  const b = rows.find(r => r.email === 'b@ex.com');
  assert.ok(a);
  assert.ok(b);
  // a: 1 Mio Input (3 USD) + 1 Mio Output (15 USD) = 18 USD
  assert.equal(Math.round(a.usd * 100) / 100, 18.00);
  // b: 100k Input = 0.30 USD
  assert.equal(Math.round(b.usd * 100) / 100, 0.30);
  assert.equal(a.jobCalls, 1);
  assert.equal(a.chatCalls, 1);
});

test('listUsersWithUsage: budget + mode + overrun-Flag', () => {
  seedUser('over@ex.com');
  appUsers.setBudget('over@ex.com', { usd: 1, mode: 'hard' });
  insertJobRun({ email: 'over@ex.com', tokensIn: 1_000_000, tokensOut: 0 });
  const rows = adminUsage.listUsersWithUsage({});
  const u = rows.find(r => r.email === 'over@ex.com');
  assert.equal(u.budgetMode, 'hard');
  assert.equal(u.monthlyBudgetUsd, 1);
  assert.equal(u.overrun, true);
});

test('monthlyTotals: Top-User + byModel + byType', () => {
  seedUser('xtop@ex.com');
  seedUser('ytop@ex.com');
  insertJobRun({ email: 'xtop@ex.com', type: 'review', tokensIn: 5_000_000, tokensOut: 0 });
  insertJobRun({ email: 'xtop@ex.com', type: 'review', tokensIn: 2_000_000, tokensOut: 0, model: 'claude-opus-4-7' });
  insertJobRun({ email: 'ytop@ex.com', type: 'check',  tokensIn: 100_000, tokensOut: 0 });

  const s = adminUsage.monthlyTotals({});
  assert.ok(s.totals.usd > 0);
  // xtop hat sehr hohen Spend; muss in Top-10 sein. Order kann durch frueheren
  // Seed-State variieren — daher nur Anwesenheit pruefen.
  const xtop = s.topUsers.find(u => u.email === 'xtop@ex.com');
  assert.ok(xtop, 'xtop in topUsers');
  assert.ok(xtop.usd > 30);
  const models = s.byModel.map(m => m.model);
  assert.ok(models.includes('claude-sonnet-4-6'));
  assert.ok(models.includes('claude-opus-4-7'));
  const types = s.byType.map(t => t.type);
  assert.ok(types.includes('review'));
  assert.ok(types.includes('check'));
});

test('getJobRuns: User-Filter paginiert + Cost pro Row', () => {
  seedUser('p@ex.com');
  for (let i = 0; i < 5; i++) {
    insertJobRun({ email: 'p@ex.com', tokensIn: 100_000, tokensOut: 0 });
  }
  const r = adminUsage.getJobRuns({ email: 'p@ex.com', limit: 3 });
  assert.equal(r.total, 5);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].userEmail, 'p@ex.com');
  // 100k @ 3 USD/Mio = 0.30 USD pro Row
  assert.equal(Math.round(r.rows[0].usd * 100) / 100, 0.30);
});

test('getJobRuns: ohne email liefert alle Non-Admin-User', () => {
  seedUser('all1@ex.com');
  seedUser('all2@ex.com');
  insertJobRun({ email: 'all1@ex.com', tokensIn: 50_000, tokensOut: 0 });
  insertJobRun({ email: 'all2@ex.com', tokensIn: 50_000, tokensOut: 0 });
  const r = adminUsage.getJobRuns({ limit: 500 });
  const emails = new Set(r.rows.map(x => x.userEmail));
  assert.ok(emails.has('all1@ex.com'));
  assert.ok(emails.has('all2@ex.com'));
});

test('getChatMessages: User-Filter + assistant + paginiert', () => {
  seedUser('c@ex.com');
  seedBook(5002);
  insertChatMsg({ email: 'c@ex.com', bookId: 5002, tokensIn: 200_000, tokensOut: 0 });
  insertChatMsg({ email: 'c@ex.com', bookId: 5002, tokensIn: 200_000, tokensOut: 0 });
  const r = adminUsage.getChatMessages({ email: 'c@ex.com' });
  assert.equal(r.total, 2);
  assert.equal(r.rows[0].sessionKind, 'book');
  assert.equal(r.rows[0].userEmail, 'c@ex.com');
});

test('getChatMessages: ohne email liefert alle Non-Admin-User', () => {
  seedUser('chat1@ex.com');
  seedUser('chat2@ex.com');
  seedBook(5102);
  insertChatMsg({ email: 'chat1@ex.com', bookId: 5102, tokensIn: 1000, tokensOut: 0 });
  insertChatMsg({ email: 'chat2@ex.com', bookId: 5102, tokensIn: 1000, tokensOut: 0 });
  const r = adminUsage.getChatMessages({ limit: 500 });
  const emails = new Set(r.rows.map(x => x.userEmail));
  assert.ok(emails.has('chat1@ex.com'));
  assert.ok(emails.has('chat2@ex.com'));
});

test('listFeatureUsage + featureUsageTotals', () => {
  seedUser('feat@ex.com');
  db.prepare(`INSERT INTO user_feature_usage (user_email, feature_key, last_used, use_count)
              VALUES (?, ?, ?, ?)`).run('feat@ex.com', 'overview', Date.now(), 5);
  db.prepare(`INSERT INTO user_feature_usage (user_email, feature_key, last_used, use_count)
              VALUES (?, ?, ?, ?)`).run('feat@ex.com', 'review', Date.now(), 3);
  const items = adminUsage.listFeatureUsage({});
  const totals = adminUsage.featureUsageTotals({});
  assert.ok(items.length >= 2);
  assert.ok(totals.length >= 2);
  // Top = overview (5 > 3)
  assert.equal(totals[0].featureKey, 'overview');
});

test('listTimeUsage: Schreib- + Lektorat-Sekunden gemerged', () => {
  const today = new Date().toISOString().slice(0, 10);
  seedUser('t@ex.com');
  seedBook(5050, 'time-test');
  // FK: lektorat_time.page_id → pages(page_id). Seeded.
  db.prepare(`INSERT OR IGNORE INTO pages (page_id, book_id, page_name, updated_at)
              VALUES (?, ?, ?, datetime('now'))`).run(9001, 5050, 'p1');
  db.prepare(`INSERT INTO writing_time (user_email, book_id, date, seconds)
              VALUES (?, ?, ?, ?)`).run('t@ex.com', 5050, today, 1800);
  db.prepare(`INSERT INTO lektorat_time (user_email, book_id, page_id, date, seconds)
              VALUES (?, ?, ?, ?, ?)`).run('t@ex.com', 5050, 9001, today, 900);
  const items = adminUsage.listTimeUsage({});
  const row = items.find(r => r.email === 't@ex.com' && r.bookId === 5050);
  assert.ok(row);
  assert.equal(row.writingSeconds, 1800);
  assert.equal(row.lektoratSeconds, 900);
  assert.equal(row.totalSeconds, 2700);
});

test('Privacy: listUsersWithUsage liefert KEIN books.name', () => {
  seedUser('priv@ex.com');
  seedBook(5003, 'Geheim-Buch');
  insertJobRun({ email: 'priv@ex.com', bookId: 5003, tokensIn: 100_000, tokensOut: 0 });
  const rows = adminUsage.listUsersWithUsage({});
  // Stringified Response darf keinen Buchtitel enthalten.
  assert.ok(!JSON.stringify(rows).includes('Geheim-Buch'));
});
