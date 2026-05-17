// page_revisions Retention via cache-cleanup-Policy
// `per-page-limit` aus app.page_revision_limit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'page-revisions-cleanup-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  return {
    dir,
    db: require_('../../db/connection').db,
    appSettings: require_('../../lib/app-settings'),
    pageRevisions: require_('../../db/page-revisions'),
    cleanup: require_('../../lib/cache-cleanup'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function _seedBookAndPage(ctx) {
  const now = new Date().toISOString();
  const bookId = ctx.db.prepare(`
    INSERT INTO books (name, slug, description, owner_email, created_at, updated_at)
    VALUES ('Test', 'test', '', 'a@b', ?, ?)
  `).run(now, now).lastInsertRowid;
  const pageId = ctx.db.prepare(`
    INSERT INTO pages (book_id, page_name, body_html, updated_at, local_updated_at)
    VALUES (?, 'P', '<p>x</p>', ?, ?)
  `).run(bookId, now, now).lastInsertRowid;
  return { bookId, pageId };
}

function _seedRevisions(ctx, pageId, bookId, count) {
  for (let i = 0; i < count; i++) {
    ctx.pageRevisions.insert({
      pageId, bookId,
      bodyHtml: `<p>rev ${i}</p>`,
      source: 'main',
    });
  }
}

test('per-page-limit policy: behaelt die N juengsten Revisions pro Page', () => {
  const ctx = _bootstrap();
  try {
    const { bookId, pageId } = _seedBookAndPage(ctx);
    ctx.appSettings.set('app.page_revision_limit', 3, { updatedBy: 'test' });
    _seedRevisions(ctx, pageId, bookId, 10);
    assert.equal(ctx.pageRevisions.countForPage(pageId), 10);

    const summary = ctx.cleanup.runCacheCleanup();
    const entry = summary.tables.find(t => t.table === 'page_revisions');
    assert.ok(entry, 'page_revisions in summary');
    assert.equal(entry.kind, 'per-page-limit');
    assert.equal(entry.setting, 'app.page_revision_limit');
    assert.equal(entry.removed, 7);
    assert.equal(ctx.pageRevisions.countForPage(pageId), 3);
  } finally { ctx.teardown(); }
});

test('per-page-limit policy: pruning ist pro page_id getrennt', () => {
  const ctx = _bootstrap();
  try {
    const { bookId, pageId: p1 } = _seedBookAndPage(ctx);
    const now = new Date().toISOString();
    const p2 = ctx.db.prepare(`
      INSERT INTO pages (book_id, page_name, body_html, updated_at, local_updated_at)
      VALUES (?, 'P2', '<p>y</p>', ?, ?)
    `).run(bookId, now, now).lastInsertRowid;

    ctx.appSettings.set('app.page_revision_limit', 2, { updatedBy: 'test' });
    _seedRevisions(ctx, p1, bookId, 5);
    _seedRevisions(ctx, p2, bookId, 5);

    ctx.cleanup.runCacheCleanup();
    assert.equal(ctx.pageRevisions.countForPage(p1), 2);
    assert.equal(ctx.pageRevisions.countForPage(p2), 2);
  } finally { ctx.teardown(); }
});

test('per-page-limit policy: kein Throw bei leerer Tabelle', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('app.page_revision_limit', 5, { updatedBy: 'test' });
    const summary = ctx.cleanup.runCacheCleanup();
    const entry = summary.tables.find(t => t.table === 'page_revisions');
    assert.equal(entry.removed, 0);
  } finally { ctx.teardown(); }
});

test('per-page-limit policy: invalides Setting → error in summary, kein Crash', () => {
  const ctx = _bootstrap();
  try {
    const { bookId, pageId } = _seedBookAndPage(ctx);
    _seedRevisions(ctx, pageId, bookId, 3);
    ctx.appSettings.set('app.page_revision_limit', -1, { updatedBy: 'test' });
    const summary = ctx.cleanup.runCacheCleanup();
    const entry = summary.tables.find(t => t.table === 'page_revisions');
    assert.ok(entry.error, 'error in summary entry');
    assert.equal(ctx.pageRevisions.countForPage(pageId), 3, 'nichts geloescht bei Fehler');
  } finally { ctx.teardown(); }
});
