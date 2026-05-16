'use strict';
// Phase 4c (BookStack-Exit, docs/bookstack-exit.md): app_settings + Helper-API.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(os.tmpdir(), `app-settings-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-crypto-derive';

require('../../db/migrations');
const { db } = require('../../db/connection');
const settings = require('../../lib/app-settings');

test.after(() => {
  try { db.close(); } catch {}
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
});

test('schema_version >= 108', () => {
  const v = db.prepare('SELECT version FROM schema_version').get().version;
  assert.ok(v >= 108);
});

test('app_settings + app_settings_audit existieren', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert.ok(tables.includes('app_settings'));
  assert.ok(tables.includes('app_settings_audit'));
});

test('DEFAULTS greift fuer nicht gesetzte Keys', () => {
  assert.equal(settings.get('ai.provider'), 'claude');
  assert.equal(settings.get('cron.timezone'), 'Europe/Zurich');
  assert.equal(settings.get('jobs.max_concurrent'), 1);
});

test('Unbekannter Key liefert undefined', () => {
  assert.equal(settings.get('does.not.exist'), undefined);
});

test('set + get Roundtrip (non-encrypted)', () => {
  settings.set('ai.provider', 'ollama', { updatedBy: 'tester@x' });
  assert.equal(settings.get('ai.provider'), 'ollama');
});

test('set + get Roundtrip mit Default ueberschrieben', () => {
  settings.set('jobs.max_concurrent', 4, { updatedBy: 'tester@x' });
  assert.equal(settings.get('jobs.max_concurrent'), 4);
  // Wieder loeschen → Default kommt zurueck
  settings.remove('jobs.max_concurrent');
  assert.equal(settings.get('jobs.max_concurrent'), 1);
});

test('Encrypted Keys werden in DB verschluesselt persistiert', () => {
  settings.set('ai.claude.api_key', 'sk-ant-secret-value', { updatedBy: 'tester@x' });
  const row = db.prepare("SELECT value_json, encrypted FROM app_settings WHERE key = 'ai.claude.api_key'").get();
  assert.equal(row.encrypted, 1);
  assert.match(row.value_json, /^enc:v1:/);
  // Lesen entschluesselt transparent
  assert.equal(settings.get('ai.claude.api_key'), 'sk-ant-secret-value');
});

test('Encrypted-Sentinel __unchanged__: kein Update', () => {
  settings.set('ai.claude.api_key', 'sk-ant-original', { updatedBy: 'tester@x' });
  settings.set('ai.claude.api_key', '__unchanged__', { updatedBy: 'tester@x' });
  assert.equal(settings.get('ai.claude.api_key'), 'sk-ant-original');
});

test('changed-Event feuert bei set', () => {
  let captured = null;
  const fn = ev => { captured = ev; };
  settings.on('changed', fn);
  settings.set('cron.timezone', 'UTC', { updatedBy: 'tester@x' });
  assert.equal(captured?.key, 'cron.timezone');
  assert.equal(captured?.updatedBy, 'tester@x');
  settings.off('changed', fn);
});

test('listForAdmin maskiert encrypted Werte', () => {
  settings.set('ai.claude.api_key', 'sk-ant-fullkey-1234', { updatedBy: 'tester@x' });
  const list = settings.listForAdmin();
  const apiKey = list.find(s => s.key === 'ai.claude.api_key');
  assert.ok(apiKey);
  assert.equal(apiKey.value, '__masked__');
  assert.match(apiKey.masked, /\*\*\*1234$/);
  assert.equal(apiKey.encrypted, 1);
});

test('listForAdmin enthaelt auch Default-Keys ohne DB-Row', () => {
  const list = settings.listForAdmin();
  const cronStale = list.find(s => s.key === 'cron.stale_days');
  assert.ok(cronStale);
  assert.equal(cronStale.isDefault, true);
  assert.equal(cronStale.value, 7);
});

test('audit-Tabelle erhaelt Hashes bei jedem set', () => {
  const before = db.prepare("SELECT COUNT(*) AS c FROM app_settings_audit WHERE key = 'ai.provider'").get().c;
  settings.set('ai.provider', 'llama', { updatedBy: 'audit-tester@x' });
  const after = db.prepare("SELECT COUNT(*) AS c FROM app_settings_audit WHERE key = 'ai.provider'").get().c;
  assert.ok(after > before, 'audit-Eintrag fehlt');
  const row = db.prepare("SELECT new_hash, updated_by FROM app_settings_audit WHERE key = 'ai.provider' ORDER BY id DESC LIMIT 1").get();
  assert.ok(row.new_hash);
  assert.equal(row.updated_by, 'audit-tester@x');
});

test('isEncryptedKey: bekannte Keys werden erkannt', () => {
  assert.equal(settings.isEncryptedKey('ai.claude.api_key'), true);
  assert.equal(settings.isEncryptedKey('app.bookstack.token_secret'), true);
  assert.equal(settings.isEncryptedKey('ai.provider'), false);
});

test('bootstrapFromEnv: spiegelt nicht-gesetzte Keys aus ENV', () => {
  // Setze ENV-Werte → Bootstrap soll sie in DB schreiben
  process.env.OLLAMA_HOST = 'http://test-ollama:11434';
  process.env.STALE_DAYS = '14';
  // Sicherstellen: Keys aktuell nicht in DB
  settings.remove('ai.ollama.host');
  settings.remove('cron.stale_days');
  const mirrored = settings.bootstrapFromEnv();
  assert.ok(mirrored >= 2, `erwartet >=2 gespiegelt, got ${mirrored}`);
  assert.equal(settings.get('ai.ollama.host'), 'http://test-ollama:11434');
  assert.equal(settings.get('cron.stale_days'), 14);
});

test('bootstrapFromEnv: ueberschreibt bestehende DB-Werte NICHT', () => {
  settings.set('ai.ollama.host', 'http://manual-set:11434', { updatedBy: 'admin' });
  process.env.OLLAMA_HOST = 'http://env-different:11434';
  settings.bootstrapFromEnv();
  assert.equal(settings.get('ai.ollama.host'), 'http://manual-set:11434');
});

test('bootstrapFromEnv: ungesetzte ENV → kein Eintrag', () => {
  delete process.env.NONEXISTENT_TEST_VAR;
  settings.remove('jobs.book_chat.token_budget');
  delete process.env.BOOK_CHAT_TOKEN_BUDGET;
  settings.bootstrapFromEnv();
  // Default greift
  assert.equal(settings.get('jobs.book_chat.token_budget'), 0);
  // Aber DB-Row darf nicht gesetzt sein
  assert.equal(settings.has('jobs.book_chat.token_budget'), false);
});
