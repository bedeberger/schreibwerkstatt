'use strict';
// Beta-Leser-Feedback: verankerte Threads + Owner-Reply + Resolve auf
// share_comments (Migration 200). Eigene Test-DB pro Lauf.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const tmp = path.join('/tmp', `share-threads-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const { db } = require('../../db/connection');
require('../../db/migrations').runMigrations(); // Tabellen anlegen, bevor Module ihre Statements preparen
const appUsers = require('../../db/app-users');
const schema = require('../../db/schema');
const sl = require('../../db/share-links');
const { renderTemplate } = require('../../lib/mailer-templates');

const OWNER = 'owner@share.test';

function seedLink() {
  if (!appUsers.getUser(OWNER)) appUsers.createUser({ email: OWNER, displayName: 'Owner Olga' });
  schema.upsertBookByName(1, 'Testbuch');
  db.prepare('INSERT OR IGNORE INTO pages (page_id, book_id, page_name) VALUES (10, 1, ?)').run('Seite A');
  return sl.createShareLink({ kind: 'page', pageId: 10, bookId: 1, ownerEmail: OWNER });
}

test('verankerter Reader-Kommentar speichert Anker-Felder', () => {
  const link = seedLink();
  const c = sl.insertComment({
    token: link.token, readerName: 'Bea', readerToken: 'r12345678abc',
    body: 'Dialog stockt.', ipHash: 'h',
    anchorBid: 'a1b2c3d4', anchorQuote: 'der Dialog', anchorStart: 5, anchorEnd: 15,
  });
  assert.equal(c.anchor_bid, 'a1b2c3d4');
  assert.equal(c.anchor_quote, 'der Dialog');
  assert.equal(c.parent_id, null);
  assert.equal(c.author_email, null);
  assert.equal(c.reader_token, 'r12345678abc');
});

test('Owner-Reply trägt author_email + erbt Thread; Resolve setzt Marker', () => {
  const link = seedLink();
  const root = sl.insertComment({ token: link.token, readerName: 'Bea', body: 'Frage?', ipHash: 'h' });
  const reply = sl.insertOwnerReply({ token: link.token, parentId: root.id, authorEmail: OWNER, body: 'Antwort.' });
  assert.equal(reply.parent_id, root.id);
  assert.equal(reply.author_email, OWNER);
  assert.equal(reply.author_display_name, 'Owner Olga');

  assert.equal(sl.setCommentResolved(root.id, OWNER, true), true);
  assert.ok(sl.getCommentById(root.id).resolved_at);
  assert.equal(sl.setCommentResolved(root.id, OWNER, false), true);
  assert.equal(sl.getCommentById(root.id).resolved_at, null);
});

test('Resolve nur durch Owner + nur auf Root', () => {
  const link = seedLink();
  const root = sl.insertComment({ token: link.token, body: 'x', ipHash: 'h' });
  const reply = sl.insertOwnerReply({ token: link.token, parentId: root.id, authorEmail: OWNER, body: 'y' });
  assert.equal(sl.setCommentResolved(root.id, 'fremd@x.test', true), false, 'fremder User darf nicht');
  assert.equal(sl.setCommentResolved(reply.id, OWNER, true), false, 'Reply ist kein Root');
});

test('unread_count zählt nur Reader-Kommentare, nicht Owner-Antworten', () => {
  const link = seedLink();
  const root = sl.insertComment({ token: link.token, body: 'a', ipHash: 'h' });
  sl.insertComment({ token: link.token, body: 'b', ipHash: 'h' });
  sl.insertOwnerReply({ token: link.token, parentId: root.id, authorEmail: OWNER, body: 'owner-reply' });
  const row = sl.listSharesByOwnerAndBook(OWNER, 1).find(r => r.token === link.token);
  assert.equal(row.comment_count, 3, 'alle drei zählen für comment_count');
  assert.equal(row.unread_count, 2, 'Owner-Reply ist nie unread');
});

test('CASCADE: Root-Delete entfernt seine Antworten', () => {
  const link = seedLink();
  const root = sl.insertComment({ token: link.token, body: 'root', ipHash: 'h' });
  sl.insertOwnerReply({ token: link.token, parentId: root.id, authorEmail: OWNER, body: 'reply' });
  assert.equal(sl.listCommentsByToken(link.token).length, 2);
  sl.deleteComment(root.id, OWNER);
  assert.equal(sl.listCommentsByToken(link.token).length, 0, 'Reply kaskadiert mit Root');
});

test('Mail-Template share-comment-owner rendert Quote + Subject (de/en)', () => {
  const de = renderTemplate('share-comment-owner', {
    targetName: 'Seite A', bookName: 'Testbuch', readerName: 'Bea',
    snippet: 'Dialog stockt', anchorQuote: 'der Dialog', appUrl: 'https://x.de',
  }, 'de');
  assert.match(de.subject, /Seite A/);
  assert.ok(de.html.includes('der Dialog'));
  assert.ok(de.html.includes('https://x.de'));

  const en = renderTemplate('share-comment-owner', {
    targetName: 'Page A', bookName: 'Book', snippet: 'x', isReply: true,
  }, 'en');
  assert.match(en.subject, /Page A/);
  assert.ok(/replied/i.test(en.html), 'anonyme Reply-Variante');
});
