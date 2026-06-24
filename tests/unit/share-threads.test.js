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

test('Reader-Self-Service: eigenen Root erledigt-markieren/wieder-öffnen (nur via reader_token)', () => {
  const link = seedLink();
  const RT = 'r12345678mine';
  const root = sl.insertComment({ token: link.token, readerToken: RT, body: 'meine Anmerkung', ipHash: 'h' });

  assert.equal(sl.setReaderCommentResolved(root.id, link.token, RT, true), true);
  assert.ok(sl.getCommentById(root.id).resolved_at, 'resolved gesetzt');
  assert.equal(sl.setReaderCommentResolved(root.id, link.token, RT, false), true);
  assert.equal(sl.getCommentById(root.id).resolved_at, null, 'wieder geöffnet');

  // Fremdes reader_token greift nicht; Owner-Reply (author_email gesetzt) auch nicht.
  assert.equal(sl.setReaderCommentResolved(root.id, link.token, 'r_fremd_xxxxx', true), false);
  const reply = sl.insertOwnerReply({ token: link.token, parentId: root.id, authorEmail: OWNER, body: 'x' });
  assert.equal(sl.setReaderCommentResolved(reply.id, link.token, RT, true), false, 'Owner-Reply ist nicht mein Root');
});

test('Reader-Self-Service: eigenen Kommentar löschen, Fremd-/Owner-Beitrag nicht', () => {
  const link = seedLink();
  const RT = 'r12345678mine';
  const own = sl.insertComment({ token: link.token, readerToken: RT, body: 'lösch mich', ipHash: 'h' });
  const other = sl.insertComment({ token: link.token, readerToken: 'r_other_xxxxx', body: 'fremd', ipHash: 'h' });

  assert.ok(sl.getReaderComment(own.id, link.token, RT), 'eigener Beitrag erkannt');
  assert.equal(sl.getReaderComment(other.id, link.token, RT), undefined, 'fremder Beitrag nicht meiner');
  assert.equal(sl.commentHasReplies(own.id), false);

  assert.equal(sl.deleteReaderComment(own.id, link.token, RT), true);
  assert.equal(sl.deleteReaderComment(other.id, link.token, RT), false, 'fremder Beitrag bleibt');
  assert.equal(sl.getCommentById(other.id).body, 'fremd');
});

test('Reader-Self-Service: commentHasReplies blockt Cascade-Löschen', () => {
  const link = seedLink();
  const RT = 'r12345678mine';
  const root = sl.insertComment({ token: link.token, readerToken: RT, body: 'root', ipHash: 'h' });
  sl.insertOwnerReply({ token: link.token, parentId: root.id, authorEmail: OWNER, body: 'autor-antwort' });
  // Die Route blockt bei Antworten — hier verifizieren wir nur das Prädikat.
  assert.equal(sl.commentHasReplies(root.id), true, 'Root mit Owner-Reply hat Antworten');
});

test('reader_email wird gespeichert + von updateReaderIdentity nachgezogen', () => {
  const link = seedLink();
  const RT = 'r12345678mail';
  const c = sl.insertComment({ token: link.token, readerToken: RT, readerName: 'Bea', readerEmail: 'bea@leser.test', body: 'a', ipHash: 'h' });
  assert.equal(sl.getCommentById(c.id).reader_email, 'bea@leser.test');
  // Zweiter Beitrag ohne Mail; Identity-Update zieht Name + Mail über reader_token.
  const c2 = sl.insertComment({ token: link.token, readerToken: RT, body: 'b', ipHash: 'h' });
  const changed = sl.updateReaderIdentity(link.token, RT, 'Beatrix', 'neu@leser.test');
  assert.equal(changed, 2, 'beide eigenen Beiträge aktualisiert');
  assert.equal(sl.getCommentById(c2.id).reader_email, 'neu@leser.test');
  assert.equal(sl.getCommentById(c2.id).reader_name, 'Beatrix');
  // Leeren entfernt die Mail wieder.
  sl.updateReaderIdentity(link.token, RT, 'Beatrix', null);
  assert.equal(sl.getCommentById(c.id).reader_email, null);
});

test('editReaderComment setzt Body + edited_at, nur für eigenen Beitrag', () => {
  const link = seedLink();
  const RT = 'r12345678edit';
  const own = sl.insertComment({ token: link.token, readerToken: RT, body: 'tippfehlre', ipHash: 'h' });
  assert.equal(sl.getCommentById(own.id).edited_at, null);
  assert.equal(sl.editReaderComment(own.id, link.token, RT, 'tippfehler korrigiert'), true);
  const edited = sl.getCommentById(own.id);
  assert.equal(edited.body, 'tippfehler korrigiert');
  assert.ok(edited.edited_at, 'edited_at gesetzt');
  // Fremdes Token / Owner-Beitrag nicht editierbar.
  assert.equal(sl.editReaderComment(own.id, link.token, 'r_fremd_xxxxx', 'hack'), false);
  const reply = sl.insertOwnerReply({ token: link.token, parentId: own.id, authorEmail: OWNER, body: 'autor' });
  assert.equal(sl.editReaderComment(reply.id, link.token, RT, 'hack'), false, 'Owner-Reply nicht über reader_token editierbar');
});

test('resolveThreadRootId: Reply-auf-Reply hängt unter denselben Root (flacher Thread)', () => {
  const link = seedLink();
  const root = sl.insertComment({ token: link.token, body: 'root', ipHash: 'h' });
  const reply = sl.insertOwnerReply({ token: link.token, parentId: root.id, authorEmail: OWNER, body: 'r1' });
  assert.equal(sl.resolveThreadRootId(root.id, link.token), root.id, 'Root → sich selbst');
  assert.equal(sl.resolveThreadRootId(reply.id, link.token), root.id, 'Reply → Root');
  assert.equal(sl.resolveThreadRootId(999999, link.token), null, 'unbekannt → null');
  assert.equal(sl.resolveThreadRootId(root.id, 'falschestoken12345'), null, 'falscher Link → null');
});

test('Reader-Reply-Mail: nur bei hinterlegter Mail + Owner-Antwort', async () => {
  const notify = require('../../lib/notify');
  notify._resetThrottleForTests();
  const sent = [];
  const mailer = require('../../lib/mailer');
  const origSend = mailer.send;
  mailer.send = async (opts) => { sent.push(opts); };
  try {
    const link = sl.getShareLinkByToken(seedLink().token);
    const root = sl.insertComment({ token: link.token, readerToken: 'r12345678rr', readerEmail: 'leser@x.test', body: 'frage', ipHash: 'h' });
    const reply = sl.insertOwnerReply({ token: link.token, parentId: root.id, authorEmail: OWNER, body: 'antwort' });
    await notify.maybeNotifyReaderReply(link, reply, sl.getCommentById(root.id));
    assert.equal(sent.length, 1, 'eine Mail an den Leser');
    assert.equal(sent[0].to, 'leser@x.test');
    assert.equal(sent[0].template, 'share-reply-reader');
    // Ohne hinterlegte Mail: keine Benachrichtigung.
    notify._resetThrottleForTests();
    sent.length = 0;
    const root2 = sl.insertComment({ token: link.token, body: 'ohne mail', ipHash: 'h' });
    const reply2 = sl.insertOwnerReply({ token: link.token, parentId: root2.id, authorEmail: OWNER, body: 'x' });
    await notify.maybeNotifyReaderReply(link, reply2, sl.getCommentById(root2.id));
    assert.equal(sent.length, 0, 'keine Mail ohne Adresse');
  } finally {
    mailer.send = origSend;
  }
});

test('Mail-Template share-reply-reader rendert Reply + Subject (de/en)', () => {
  const de = renderTemplate('share-reply-reader', {
    targetName: 'Seite A', bookName: 'Testbuch', authorName: 'Owner Olga',
    snippet: 'Danke fürs Feedback', anchorQuote: 'der Dialog', appUrl: 'https://x.de/share/abc',
  }, 'de');
  assert.match(de.subject, /Seite A/);
  assert.ok(de.html.includes('Danke fürs Feedback'));
  assert.ok(de.html.includes('https://x.de/share/abc'));
  const en = renderTemplate('share-reply-reader', { targetName: 'Page A', bookName: 'Book', snippet: 'x' }, 'en');
  assert.match(en.subject, /Page A/);
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
