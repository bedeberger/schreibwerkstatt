// Phase 11: resolveProvider Reihenfolge — User-Override > Global > Default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-resolve-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  return {
    dir,
    appUsers: require_('../../db/app-users'),
    appSettings: require_('../../lib/app-settings'),
    ai: require_('../../lib/ai'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

test('resolveProvider: Default = claude bei leerer DB', () => {
  const ctx = _bootstrap();
  try {
    assert.equal(ctx.ai.resolveProvider({ userEmail: 'nobody@example.com' }), 'claude');
  } finally { ctx.teardown(); }
});

test('resolveProvider: global ai.provider greift wenn kein Override', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.provider', 'ollama');
    ctx.appUsers.createUser({ email: 'u@example.com' });
    assert.equal(ctx.ai.resolveProvider({ userEmail: 'u@example.com' }), 'ollama');
  } finally { ctx.teardown(); }
});

test('resolveProvider: Override gewinnt ueber Global', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.provider', 'ollama');
    ctx.appUsers.createUser({ email: 'u@example.com' });
    ctx.appUsers.setAiProviderOverride('u@example.com', 'claude');
    assert.equal(ctx.ai.resolveProvider({ userEmail: 'u@example.com' }), 'claude');
  } finally { ctx.teardown(); }
});

test('resolveProvider: NULL-Override faellt auf Global', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.provider', 'llama');
    ctx.appUsers.createUser({ email: 'u@example.com' });
    ctx.appUsers.setAiProviderOverride('u@example.com', 'claude');
    ctx.appUsers.setAiProviderOverride('u@example.com', null);
    assert.equal(ctx.ai.resolveProvider({ userEmail: 'u@example.com' }), 'llama');
  } finally { ctx.teardown(); }
});

test('setAiProviderOverride wirft bei ungueltigem Wert', () => {
  const ctx = _bootstrap();
  try {
    ctx.appUsers.createUser({ email: 'u@example.com' });
    assert.throws(() => ctx.appUsers.setAiProviderOverride('u@example.com', 'gpt5'));
  } finally { ctx.teardown(); }
});

test('getContextConfigFor: claude liefert 200k Default, ollama 32k', () => {
  const ctx = _bootstrap();
  try {
    const c = ctx.ai.getContextConfigFor('claude');
    assert.equal(c.contextWindow, 200000);
    const o = ctx.ai.getContextConfigFor('ollama');
    assert.equal(o.contextWindow, 32000);
    assert.ok(o.inputBudgetTokens > 0);
    assert.ok(o.inputBudgetTokens < c.inputBudgetTokens);
  } finally { ctx.teardown(); }
});

test('Synonym-Cache: provider trennt Eintraege', () => {
  const ctx = _bootstrap();
  try {
    const schema = require_('../../db/schema');
    schema.saveSynonymCache('a@b', 'k1', [{ wort: 'X' }], 'claude');
    schema.saveSynonymCache('a@b', 'k1', [{ wort: 'Y' }], 'ollama');
    const claude = schema.loadSynonymCache('a@b', 'k1', 'claude');
    const ollama = schema.loadSynonymCache('a@b', 'k1', 'ollama');
    assert.equal(claude[0].wort, 'X');
    assert.equal(ollama[0].wort, 'Y');
  } finally { ctx.teardown(); }
});

test('Lektorat-Cache: provider trennt Eintraege', () => {
  const ctx = _bootstrap();
  try {
    const schema = require_('../../db/schema');
    const db = require_('../../db/connection').db;
    const now = new Date().toISOString();
    const bookId = db.prepare(`INSERT INTO books (name, slug, description, owner_email, created_at, updated_at) VALUES ('B','b','','a@b',?,?)`).run(now, now).lastInsertRowid;
    const pageId = db.prepare(`INSERT INTO pages (book_id, page_name, body_html, updated_at, local_updated_at) VALUES (?, 'P', '<p>x</p>', ?, ?)`).run(bookId, now, now).lastInsertRowid;
    schema.saveLektoratCache(bookId, 'a@b', pageId, 'ctx1', { fehler: ['A'] }, 'claude');
    schema.saveLektoratCache(bookId, 'a@b', pageId, 'ctx1', { fehler: ['B'] }, 'ollama');
    assert.deepEqual(schema.loadLektoratCache(bookId, 'a@b', pageId, 'ctx1', 'claude').fehler, ['A']);
    assert.deepEqual(schema.loadLektoratCache(bookId, 'a@b', pageId, 'ctx1', 'ollama').fehler, ['B']);
  } finally { ctx.teardown(); }
});
