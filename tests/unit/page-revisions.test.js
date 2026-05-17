'use strict';
// page_revisions CRUD + Retention.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const tmp = path.join('/tmp', `page-revisions-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const { db } = require('../../db/connection');
require('../../db/migrations');
const { upsertBookByName } = require('../../db/books');
const pageRevisions = require('../../db/page-revisions');

function _seedPage(bookId, pageId, name = 'Seite') {
  db.prepare(
    'INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (?, ?, ?, ?)'
  ).run(pageId, bookId, name, new Date().toISOString());
}

test('page_revisions: insert + listForPage + countForPage', () => {
  upsertBookByName(901, 'Test-Buch P2 A');
  _seedPage(901, 90101, 'Erste Seite');

  pageRevisions.insert({
    pageId: 90101, bookId: 901,
    bodyHtml: '<p>Hallo Welt</p>',
    source: 'main', userEmail: 'a@x.test',
  });
  pageRevisions.insert({
    pageId: 90101, bookId: 901,
    bodyHtml: '<p>Hallo schoene Welt</p>',
    source: 'focus', userEmail: 'a@x.test',
  });
  pageRevisions.insert({
    pageId: 90101, bookId: 901,
    bodyHtml: '<p>Hallo schoenere Welt</p>',
    source: 'chat-apply', userEmail: 'b@x.test',
  });

  assert.equal(pageRevisions.countForPage(90101), 3);

  const list = pageRevisions.listForPage(90101);
  assert.equal(list.length, 3);
  // DESC: jueng­ste zuerst.
  assert.equal(list[0].source, 'chat-apply');
  assert.equal(list[2].source, 'main');
  // chars-Spalte ist gefuellt (HTML→Text + Length).
  assert.ok(list[0].chars > 0);
});

test('page_revisions: Dedup gegen juengste Revision', () => {
  upsertBookByName(905, 'Test-Buch P2 Dedup');
  _seedPage(905, 90501);

  const id1 = pageRevisions.insert({
    pageId: 90501, bookId: 905,
    bodyHtml: '<p>identisch</p>',
    source: 'main', userEmail: 'a@x.test',
  });
  assert.ok(id1);

  // Identischer Body → skip, gibt null zurueck.
  const id2 = pageRevisions.insert({
    pageId: 90501, bookId: 905,
    bodyHtml: '<p>identisch</p>',
    source: 'focus', userEmail: 'a@x.test',
  });
  assert.equal(id2, null);
  assert.equal(pageRevisions.countForPage(90501), 1);

  // Geaenderter Body → neue Row.
  const id3 = pageRevisions.insert({
    pageId: 90501, bookId: 905,
    bodyHtml: '<p>anders</p>',
    source: 'main', userEmail: 'a@x.test',
  });
  assert.ok(id3);
  assert.equal(pageRevisions.countForPage(90501), 2);

  // Wieder zurueck auf alten Body → KEIN Dedup (juengste = "anders").
  const id4 = pageRevisions.insert({
    pageId: 90501, bookId: 905,
    bodyHtml: '<p>identisch</p>',
    source: 'main', userEmail: 'a@x.test',
  });
  assert.ok(id4);
  assert.equal(pageRevisions.countForPage(90501), 3);
});

test('page_revisions: invalid source wirft', () => {
  upsertBookByName(902, 'Test-Buch P2 B');
  _seedPage(902, 90201);
  assert.throws(() => pageRevisions.insert({
    pageId: 90201, bookId: 902, bodyHtml: '<p>x</p>', source: 'haxxor',
  }), /invalid source/);
});

test('page_revisions: pruneOverLimit haelt jueng­ste N pro Seite', () => {
  // Voriger Test-State darf nicht reinleaken — prune ist global.
  db.prepare('DELETE FROM page_revisions').run();
  upsertBookByName(903, 'Test-Buch P2 C');
  _seedPage(903, 90301);
  _seedPage(903, 90302);

  // 5 Revisions auf Seite A, 3 auf Seite B.
  for (let i = 1; i <= 5; i++) {
    pageRevisions.insert({
      pageId: 90301, bookId: 903,
      bodyHtml: `<p>v${i}</p>`, source: 'main',
    });
  }
  for (let i = 1; i <= 3; i++) {
    pageRevisions.insert({
      pageId: 90302, bookId: 903,
      bodyHtml: `<p>w${i}</p>`, source: 'main',
    });
  }
  assert.equal(pageRevisions.countForPage(90301), 5);
  assert.equal(pageRevisions.countForPage(90302), 3);

  // Limit 2: A behaelt 2 (entfernt 3), B behaelt 2 (entfernt 1).
  const removed = pageRevisions.pruneOverLimit(2);
  assert.equal(removed, 4);
  assert.equal(pageRevisions.countForPage(90301), 2);
  assert.equal(pageRevisions.countForPage(90302), 2);

  // Es ueberleben die jueng­sten zwei Eintraege pro Seite.
  const a = pageRevisions.listForPage(90301);
  assert.equal(a.length, 2);
  // Body der jueng­sten zwei (v5, v4) muss erhalten sein.
  const aBodies = a.map(r => pageRevisions.get(r.id).body_html).sort();
  assert.deepEqual(aBodies, ['<p>v4</p>', '<p>v5</p>']);
});

test('page_revisions: FK-CASCADE bei Page-Delete', () => {
  upsertBookByName(904, 'Test-Buch P2 D');
  _seedPage(904, 90401);
  pageRevisions.insert({
    pageId: 90401, bookId: 904, bodyHtml: '<p>x</p>', source: 'main',
  });
  assert.equal(pageRevisions.countForPage(90401), 1);
  db.prepare('DELETE FROM pages WHERE page_id = ?').run(90401);
  assert.equal(pageRevisions.countForPage(90401), 0);
});
