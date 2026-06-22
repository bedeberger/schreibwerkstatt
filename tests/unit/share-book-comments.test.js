'use strict';
// Unit-Test für listCommentsByOwnerBook / markOwnerSeenForBook (db/share-links):
// Aggregation aller Link-Kommentare eines Owners zu einem Buch (Basis der
// Kommentar-Leiste der Leseansicht).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Eigene Test-DB pro Lauf (Statement-Cache-Kollision bei paralleler Suite).
process.env.DB_PATH = path.join('/tmp', `share-book-comments-${process.pid}-${Date.now()}.db`);

const schema = require('../../db/schema');
const appUsers = require('../../db/app-users');
const shareLinks = require('../../db/share-links');

test('listCommentsByOwnerBook aggregiert Link-Kommentare pro Owner + Buch', () => {
  const owner = 'owner@x.test';
  const other = 'other@x.test';
  appUsers.createUser({ email: owner, displayName: 'Owner' });
  appUsers.createUser({ email: other, displayName: 'Other' });
  schema.upsertBookByName(701, 'Buch 701');
  schema.upsertBookByName(702, 'Buch 702');

  const link = shareLinks.createShareLink({ kind: 'book', bookId: 701, ownerEmail: owner });
  const otherLink = shareLinks.createShareLink({ kind: 'book', bookId: 702, ownerEmail: other });

  // Verankerter Leser-Kommentar + Owner-Antwort am selben Buch.
  const root = shareLinks.insertComment({
    token: link.token, readerName: 'Anna', body: 'Schöne Stelle',
    anchorBid: 'aa11bb22', anchorQuote: 'Hallo Welt', anchorStart: 0, anchorEnd: 10,
  });
  shareLinks.insertOwnerReply({ token: link.token, parentId: root.id, authorEmail: owner, body: 'Danke!' });
  // Fremder Link/Buch — darf nicht auftauchen.
  shareLinks.insertComment({ token: otherLink.token, readerName: 'Bob', body: 'Anderes Buch' });

  const rows = shareLinks.listCommentsByOwnerBook(owner, 701);
  assert.equal(rows.length, 2, 'Root + Antwort des eigenen Buchs');
  assert.ok(rows.every(r => r.share_token === link.token));
  const rootRow = rows.find(r => r.parent_id === null);
  assert.equal(rootRow.anchor_bid, 'aa11bb22');
  assert.equal(rootRow.anchor_quote, 'Hallo Welt');
  const reply = rows.find(r => r.parent_id === root.id);
  assert.equal(reply.author_email, owner);
  assert.equal(reply.author_display_name, 'Owner');

  // Owner sieht nicht die Kommentare eines fremden Buchs.
  assert.equal(shareLinks.listCommentsByOwnerBook(owner, 702).length, 0);
  // Fremder Owner sieht das Buch 701 nicht.
  assert.equal(shareLinks.listCommentsByOwnerBook(other, 701).length, 0);
});

test('markOwnerSeenForBook setzt owner_last_seen_at für alle Links des Buchs', () => {
  const owner = 'seen@x.test';
  appUsers.createUser({ email: owner, displayName: 'Seen' });
  schema.upsertBookByName(710, 'Buch 710');
  const a = shareLinks.createShareLink({ kind: 'book', bookId: 710, ownerEmail: owner });
  const b = shareLinks.createShareLink({ kind: 'book', bookId: 710, ownerEmail: owner });
  assert.equal(shareLinks.getShareLinkByToken(a.token).owner_last_seen_at, null);

  shareLinks.markOwnerSeenForBook(owner, 710);

  assert.ok(shareLinks.getShareLinkByToken(a.token).owner_last_seen_at);
  assert.ok(shareLinks.getShareLinkByToken(b.token).owner_last_seen_at);
});
