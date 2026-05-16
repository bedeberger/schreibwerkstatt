'use strict';
// Test bootstrap. Order matters: env -> mocks -> require pipeline modules.

const fs = require('fs');
const os = require('os');
const path = require('path');

function bootstrap() {
  const dbFile = path.join(os.tmpdir(), `lektorat-test-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbFile;
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

  // Phase 4c-E: ENV fuer migrierte Keys ist tot. Migrationen laufen, dann
  // app_settings-Overrides fuer Test-Budget direkt in die DB — bevor lib/ai
  // (via mock-ai) seine Context-/Token-Defaults aus app_settings liest.
  require('../../../db/connection');
  require('../../../db/migrations');
  const { db } = require('../../../db/connection');
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value_json, encrypted, updated_at, updated_by)
    VALUES (?, ?, 0, datetime('now'), 'test')
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `);
  // Tight token budget so multi-pass kicks in at ~20K chars instead of 600K.
  upsert.run('ai.claude.context_window', JSON.stringify(10000));
  upsert.run('ai.claude.max_tokens_out', JSON.stringify(2000));
  upsert.run('ai.provider', JSON.stringify('claude'));
  upsert.run('jobs.max_concurrent', JSON.stringify(1));

  const mockAi = require('./mock-ai');
  const mockBs = require('./mock-bookstack');
  mockAi.install();
  mockBs.install();

  // Now safe to require pipeline modules — they'll pick up the mocked deps.
  const komplett = require('../../../routes/jobs/komplett');
  const review = require('../../../routes/jobs/review');
  const kapitel = require('../../../routes/jobs/kapitel');
  const lektorat = require('../../../routes/jobs/lektorat');
  const synonyme = require('../../../routes/jobs/synonyme');
  const shared = require('../../../routes/jobs/shared');
  const dbSchema = require('../../../db/schema');

  function cleanup() {
    try { fs.unlinkSync(dbFile); } catch (_) {}
    try { fs.unlinkSync(`${dbFile}-wal`); } catch (_) {}
    try { fs.unlinkSync(`${dbFile}-shm`); } catch (_) {}
  }

  return { mockAi, mockBs, komplett, review, kapitel, lektorat, synonyme, shared, dbSchema, dbFile, cleanup };
}

async function waitForJob(shared, jobId, { timeoutMs = 5000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = shared.jobs.get(jobId);
    if (job && (job.status === 'done' || job.status === 'error' || job.status === 'cancelled')) return job;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`waitForJob: timeout after ${timeoutMs}ms`);
}

module.exports = { bootstrap, waitForJob };
