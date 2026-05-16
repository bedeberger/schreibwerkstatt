// Phase 1: lib/dev-seed.js — Devmode-Seed bei LOCAL_DEV_MODE + localdb-Backend
// und leerer books-Tabelle. Pflicht-Guards: jeder einzeln verhindert den Seed.
// IDs >= 1_000_001 (Phase-0-Wasserzeichen).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _isolatedDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dev-seed-test-'));
  const dbFile = join(dir, 'test.db');
  process.env.DB_PATH = dbFile;
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'dev-seed-test-secret';
  // Force fresh module-load gegen die neue DB-Datei.
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/dev-seed') || key.includes('/lib/app-settings')) {
      delete require_.cache[key];
    }
  }
  require_('../../db/connection');
  const { runMigrations } = require_('../../db/migrations');
  runMigrations();
  return {
    dir,
    appSettings: require_('../../lib/app-settings'),
    devSeed: require_('../../lib/dev-seed'),
    db: require_('../../db/connection').db,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

test('Devmode-Seed: kein Seed ohne LOCAL_DEV_MODE', () => {
  const ctx = _isolatedDb();
  try {
    delete process.env.LOCAL_DEV_MODE;
    ctx.appSettings.set('app.backend', 'localdb', { updatedBy: 'test' });
    const r = ctx.devSeed.runDevSeedIfNeeded();
    assert.equal(r, null);
    const count = ctx.db.prepare('SELECT COUNT(*) AS c FROM books').get().c;
    assert.equal(count, 0);
  } finally { ctx.cleanup(); }
});

test('Devmode-Seed: kein Seed bei LOCAL_DEV_SEED=false', () => {
  const ctx = _isolatedDb();
  try {
    process.env.LOCAL_DEV_MODE = 'true';
    process.env.LOCAL_DEV_SEED = 'false';
    ctx.appSettings.set('app.backend', 'localdb', { updatedBy: 'test' });
    const r = ctx.devSeed.runDevSeedIfNeeded();
    assert.equal(r, null);
    const count = ctx.db.prepare('SELECT COUNT(*) AS c FROM books').get().c;
    assert.equal(count, 0);
  } finally {
    delete process.env.LOCAL_DEV_SEED;
    delete process.env.LOCAL_DEV_MODE;
    ctx.cleanup();
  }
});

test('Devmode-Seed: kein Seed bei app.backend=bookstack', () => {
  const ctx = _isolatedDb();
  try {
    process.env.LOCAL_DEV_MODE = 'true';
    ctx.appSettings.set('app.backend', 'bookstack', { updatedBy: 'test' });
    const r = ctx.devSeed.runDevSeedIfNeeded();
    assert.equal(r, null);
    const count = ctx.db.prepare('SELECT COUNT(*) AS c FROM books').get().c;
    assert.equal(count, 0);
  } finally {
    delete process.env.LOCAL_DEV_MODE;
    ctx.cleanup();
  }
});

test('Devmode-Seed: vollstaendiger Seed bei allen Guards + leerer DB', () => {
  const ctx = _isolatedDb();
  try {
    process.env.LOCAL_DEV_MODE = 'true';
    ctx.appSettings.set('app.backend', 'localdb', { updatedBy: 'test' });
    const r = ctx.devSeed.runDevSeedIfNeeded();
    assert.ok(r);
    assert.ok(r.bookId >= 1_000_001, `bookId ${r.bookId} muss >= 1_000_001 sein (Phase-0-Wasserzeichen)`);
    assert.equal(r.chapters, 2);
    assert.equal(r.pages, 5);

    const book = ctx.db.prepare('SELECT name, owner_email FROM books WHERE book_id = ?').get(r.bookId);
    assert.equal(book.name, 'Devmode-Testbuch');
    assert.equal(book.owner_email, 'dev@local');

    const chapterCount = ctx.db.prepare('SELECT COUNT(*) AS c FROM chapters WHERE book_id = ?').get(r.bookId).c;
    assert.equal(chapterCount, 2);

    const pages = ctx.db.prepare('SELECT page_id, page_name, body_html FROM pages WHERE book_id = ? ORDER BY position').all(r.bookId);
    assert.equal(pages.length, 5);
    for (const p of pages) {
      assert.ok(p.page_id >= 1_000_001);
      assert.ok(p.body_html && p.body_html.length > 100, 'jede Page hat echten Prosa-Body');
    }
  } finally {
    delete process.env.LOCAL_DEV_MODE;
    ctx.cleanup();
  }
});

test('Devmode-Seed: idempotent (zweiter Call no-op)', () => {
  const ctx = _isolatedDb();
  try {
    process.env.LOCAL_DEV_MODE = 'true';
    ctx.appSettings.set('app.backend', 'localdb', { updatedBy: 'test' });
    const r1 = ctx.devSeed.runDevSeedIfNeeded();
    assert.ok(r1);
    const r2 = ctx.devSeed.runDevSeedIfNeeded();
    assert.equal(r2, null);
    const bookCount = ctx.db.prepare('SELECT COUNT(*) AS c FROM books').get().c;
    assert.equal(bookCount, 1, 'kein zweites Buch nach Re-Call');
  } finally {
    delete process.env.LOCAL_DEV_MODE;
    ctx.cleanup();
  }
});
