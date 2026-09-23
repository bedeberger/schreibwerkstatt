// Lektorat-Effort + Denk-Status.
//
// Auf Modellen mit adaptivem Denken (Sonnet 5+, Opus 4.7+) waehlt die API ohne
// Effort-Feld 'high': das Seiten-Lektorat denkt dann pro Pass Zehntausende Tokens
// stumm, der Stream liefert minutenlang nur Pings, und der Job steht sichtbar bei
// 10 %. `applyLektoratEffort` bindet deshalb `ai.claude.effort.lektorat` — aber nur
// dort; Sonnet 4.6 (kein Thinking) bleibt unberuehrt. Der Denk-Block selbst wird
// ueber `tok.onThinking` gemeldet, damit die Statuszeile ihn anzeigen kann.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'lektorat-effort-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/') || key.includes('/routes/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  return {
    appSettings: require_('../../lib/app-settings'),
    cfg: require_('../../lib/ai/config'),
    logCtx: require_('../../lib/log-context'),
    split: require_('../../routes/jobs/lektorat-split'),
    jobsAi: require_('../../routes/jobs/shared/ai'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

const quietLogger = { info() {}, warn() {}, error() {} };

test('applyLektoratEffort: Sonnet 5 bekommt den Default-Effort medium im Job-Bag', () => {
  const { split, cfg, logCtx, teardown } = _bootstrap();
  try {
    logCtx.runWithContext({ job: 'check' }, () => {
      assert.equal(split.applyLektoratEffort('claude', 'claude-sonnet-5', quietLogger), ':e=medium');
      assert.deepEqual(logCtx.getContext().aiJob, { provider: 'claude', effort: 'medium' });
      assert.deepEqual(cfg._claudeOutputConfigParams('claude-sonnet-5'), { output_config: { effort: 'medium' } });
    });
  } finally { teardown(); }
});

test('applyLektoratEffort: Sonnet 4.6 und fremde Provider bleiben ohne Effort', () => {
  const { split, logCtx, teardown } = _bootstrap();
  try {
    logCtx.runWithContext({ job: 'check' }, () => {
      assert.equal(split.applyLektoratEffort('claude', 'claude-sonnet-4-6', quietLogger), '');
      assert.equal(split.applyLektoratEffort('openai-compat', 'claude-sonnet-5', quietLogger), '');
      assert.equal(logCtx.getContext().aiJob, undefined);
    });
  } finally { teardown(); }
});

test('applyLektoratEffort: leerer Setting-Wert = kein Effort-Feld', () => {
  const { split, appSettings, logCtx, teardown } = _bootstrap();
  try {
    appSettings.set('ai.claude.effort.lektorat', '', { updatedBy: 'test' });
    logCtx.runWithContext({ job: 'check' }, () => {
      assert.equal(split.applyLektoratEffort('claude', 'claude-sonnet-5', quietLogger), '');
      assert.equal(logCtx.getContext().aiJob, undefined);
    });
  } finally { teardown(); }
});

test('aiCall meldet den Thinking-Block über tok.onThinking (an bei Block-Start, aus beim ersten Text)', async () => {
  const origFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const { jobsAi, teardown } = _bootstrap();
  globalThis.fetch = async () => new Response([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
    'data: {"type":"ping"}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"{\\"fehler\\":[]}"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
    'data: [DONE]',
    '',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const events = [];
    const tok = { in: 0, out: 0, ms: 0, onThinking: (_id, on) => events.push(on) };
    const res = await jobsAi.aiCall('no-job', tok, 'prompt', 'sys', null, null, 3000, 0.2, 1000, 'claude');
    assert.deepEqual(res, { fehler: [] });
    assert.deepEqual(events, [true, false]);
  } finally {
    globalThis.fetch = origFetch;
    teardown();
  }
});
