'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const tmp = path.join('/tmp', `hubspot-db-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-1234567890abcdef';

const schema = require('../../db/schema');
const contentStore = require('../../lib/content-store');
const hubspot = require('../../db/hubspot');

function bootstrap() {
  schema.upsertBookByName(7777, 'Hub-Test-Buch');
  return 7777;
}

test('Connection upsert + getConnection roundtrips Token decrypted', () => {
  const bookId = bootstrap();
  const conn = hubspot.upsertConnection({
    bookId, token: 'pat-eu1-secret-xyz', blogId: '111', authorId: '222',
  });
  assert.ok(conn.id);
  assert.equal(conn.blogId, '111');
  assert.equal(conn.authorId, '222');
  // Public-Variante darf Token nie liefern.
  assert.equal(conn.token, undefined);

  const full = hubspot.getConnection(bookId);
  assert.equal(full.token, 'pat-eu1-secret-xyz');
  assert.equal(full.blogId, '111');

  // Update überschreibt Token + Felder.
  hubspot.upsertConnection({ bookId, token: 'pat-eu1-other', blogId: '999', authorId: '888' });
  const updated = hubspot.getConnection(bookId);
  assert.equal(updated.token, 'pat-eu1-other');
  assert.equal(updated.blogId, '999');
  assert.equal(updated.authorId, '888');
});

test('Link upsert respects UNIQUE(hub_id, hubspot_post_id)', async () => {
  const bookId = bootstrap();
  hubspot.upsertConnection({ bookId, token: 'pat-x', blogId: '1', authorId: '2' });
  const conn = hubspot.getConnection(bookId);

  const page1 = await contentStore.createPage({ book_id: bookId, name: 'P1', html: '<p>x</p>' }, null);
  const page2 = await contentStore.createPage({ book_id: bookId, name: 'P2', html: '<p>y</p>' }, null);

  hubspot.upsertLink({
    pageId: page1.id, hubId: conn.id, hubspotPostId: '88001',
    hubspotState: 'DRAFT', lastPushedAt: '2026-01-01T00:00:00.000Z',
  });
  const link = hubspot.getLinkByPage(page1.id);
  assert.equal(link.hubspot_post_id, '88001');
  assert.equal(link.hubspot_state, 'DRAFT');

  // Anderer Page-Eintrag, gleiche Post-ID am gleichen Hub → UNIQUE-Verletzung.
  assert.throws(
    () => hubspot.upsertLink({ pageId: page2.id, hubId: conn.id, hubspotPostId: '88001' }),
    /UNIQUE/,
  );

  // getLinkByPost findet via (hub_id, hubspot_post_id).
  const byPost = hubspot.getLinkByPost(conn.id, '88001');
  assert.equal(byPost.page_id, page1.id);
});

test('deleteConnection cascades to links', async () => {
  const bookId = bootstrap();
  hubspot.upsertConnection({ bookId, token: 'pat-x', blogId: '1', authorId: '2' });
  const conn = hubspot.getConnection(bookId);
  const page = await contentStore.createPage({ book_id: bookId, name: 'PX', html: '<p>z</p>' }, null);
  hubspot.upsertLink({ pageId: page.id, hubId: conn.id, hubspotPostId: '99001' });
  assert.ok(hubspot.getLinkByPage(page.id));
  hubspot.deleteConnection(bookId);
  assert.equal(hubspot.getLinkByPage(page.id), null);
  assert.equal(hubspot.getConnectionPublic(bookId), null);
});

test('markInitialImportDone + touchPush set timestamps', () => {
  const bookId = bootstrap();
  hubspot.upsertConnection({ bookId, token: 'pat-x', blogId: '1', authorId: '2' });
  const conn = hubspot.getConnection(bookId);
  assert.equal(conn.initialImportDoneAt, null);

  hubspot.markInitialImportDone(conn.id);
  const after = hubspot.getConnection(bookId);
  assert.match(after.initialImportDoneAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(after.lastImportAt, /^\d{4}-\d{2}-\d{2}T/);

  hubspot.touchPush(conn.id);
  const after2 = hubspot.getConnection(bookId);
  assert.match(after2.lastPushAt, /^\d{4}-\d{2}-\d{2}T/);
});
