'use strict';
// db/chat-quality.js: Wiederholungs-Erkennung (gleiche Frage, gleicher User,
// gleiches Buch + Chat-Art, binnen 24 h), Feedback-Schreibpfad und die
// Auswertung je Chat-Art fuer das Admin-Usage.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('chat-quality');

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const cq = require('../../db/chat-quality');

const USER = 'cq@example.com';
const OTHER = 'cq-other@example.com';
const BOOK = 83001;
const BOOK2 = 83002;
appUsers.createUser({ email: USER });
appUsers.createUser({ email: OTHER });
for (const b of [BOOK, BOOK2]) {
  db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'CQ', datetime('now'), datetime('now'))`).run(b);
}

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const H = 60 * 60 * 1000;

function session(kind = 'book', { book = BOOK, user = USER } = {}) {
  return db.prepare(`INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at)
                     VALUES (?, ?, ?, ?, ?)`).run(book, kind, user, iso(0), iso(0)).lastInsertRowid;
}
function msg(sid, role, content, msAgo = 0, extra = {}) {
  return db.prepare(`INSERT INTO chat_messages (session_id, role, content, created_at, feedback, job_id)
                     VALUES (?, ?, ?, ?, ?, ?)`)
    .run(sid, role, content, iso(msAgo), extra.feedback ?? null, extra.jobId ?? null).lastInsertRowid;
}

test('normalizeQuestion: Kleinschreibung + Whitespace-Folgen', () => {
  assert.equal(cq.normalizeQuestion('  Wer ist\n\tANNA?  '), 'wer ist anna?');
  assert.equal(cq.normalizeQuestion(null), '');
});

test('findRepeatOf: gleiche Frage binnen 24 h, andere Session derselben Chat-Art', () => {
  const s1 = session('book');
  const s2 = session('book');
  const first = msg(s1, 'user', 'Wer ist Anna?', 3 * H);
  const now = msg(s2, 'user', 'wer  ist anna?', 0);
  assert.equal(cq.findRepeatOf({ messageId: now, userEmail: USER, bookId: BOOK, kind: 'book', content: 'wer  ist anna?', now: NOW }), first);
});

test('findRepeatOf: ausserhalb 24 h, andere Chat-Art, anderes Buch, anderer User → null', () => {
  const sOld = session('book');
  msg(sOld, 'user', 'Wie alt ist Bruno?', 25 * H);
  const sPage = session('research');
  msg(sPage, 'user', 'Wie alt ist Bruno?', H);
  const sBook2 = session('book', { book: BOOK2 });
  msg(sBook2, 'user', 'Wie alt ist Bruno?', H);
  const sOther = session('book', { user: OTHER });
  msg(sOther, 'user', 'Wie alt ist Bruno?', H);
  const s = session('book');
  const id = msg(s, 'user', 'Wie alt ist Bruno?', 0);
  assert.equal(cq.findRepeatOf({ messageId: id, userEmail: USER, bookId: BOOK, kind: 'book', content: 'Wie alt ist Bruno?', now: NOW }), null);
});

test('findRepeatOf: die eigene Nachricht und Assistant-Antworten zaehlen nicht', () => {
  const s = session('book');
  msg(s, 'assistant', 'Was ist der Plot?', H);
  const id = msg(s, 'user', 'Was ist der Plot?', 0);
  assert.equal(cq.findRepeatOf({ messageId: id, userEmail: USER, bookId: BOOK, kind: 'book', content: 'Was ist der Plot?', now: NOW }), null);
});

test('recordRepeat: vermerkt repeat_of im context_info der neuen User-Nachricht', () => {
  const s = session('book');
  const first = msg(s, 'user', 'Wo spielt Kapitel 3?', 2 * H);
  const second = msg(s, 'user', 'Wo spielt  Kapitel 3?', 0);
  assert.equal(cq.recordRepeat({ messageId: second, userEmail: USER, bookId: BOOK, kind: 'book', content: 'Wo spielt  Kapitel 3?', now: NOW }), first);
  const ci = JSON.parse(db.prepare('SELECT context_info FROM chat_messages WHERE id = ?').get(second).context_info);
  assert.equal(ci.repeat_of, first);
  // Erste Nachricht bleibt unberuehrt.
  assert.equal(db.prepare('SELECT context_info FROM chat_messages WHERE id = ?').get(first).context_info, null);
});

test('setFeedback: nur Assistant-Nachrichten, null nimmt zurueck', () => {
  const s = session('book');
  const u = msg(s, 'user', 'Frage');
  const a = msg(s, 'assistant', 'Antwort');
  assert.equal(cq.setFeedback(u, 1), 0);
  assert.equal(cq.setFeedback(a, -1), 1);
  let row = db.prepare('SELECT feedback, feedback_at FROM chat_messages WHERE id = ?').get(a);
  assert.equal(row.feedback, -1);
  assert.match(row.feedback_at, /Z$/);
  cq.setFeedback(a, null);
  row = db.prepare('SELECT feedback FROM chat_messages WHERE id = ?').get(a);
  assert.equal(row.feedback, null);
  assert.throws(() => db.prepare('UPDATE chat_messages SET feedback = 2 WHERE id = ?').run(a), /CHECK/);
});

test('getOwnedMessage: fremder User sieht die Nachricht nicht', () => {
  const s = session('book');
  const a = msg(s, 'assistant', 'Antwort');
  assert.equal(cq.getOwnedMessage(a, USER).book_id, BOOK);
  assert.equal(cq.getOwnedMessage(a, OTHER), null);
});

test('chatQualityStats: Antworten, Feedback, Wiederholungen, Fehlerquote je Chat-Art', () => {
  db.prepare('DELETE FROM chat_messages').run();
  db.prepare('DELETE FROM job_runs').run();
  const s = session('research');
  msg(s, 'user', 'A', 0);
  msg(s, 'assistant', 'a1', 0, { feedback: 1 });
  msg(s, 'assistant', 'a2', 0, { feedback: 1 });
  msg(s, 'assistant', 'a3', 0, { feedback: -1 });
  const rep = msg(s, 'user', 'A', 0);
  db.prepare(`UPDATE chat_messages SET context_info = json_object('repeat_of', 1) WHERE id = ?`).run(rep);
  const sO = session('research', { user: OTHER });
  msg(sO, 'assistant', 'o1', 0, { feedback: -1 });

  const ins = db.prepare(`INSERT INTO job_runs (job_id, type, user_email, status, queued_at) VALUES (?, ?, ?, ?, ?)`);
  ins.run('j1', 'research-chat', USER, 'done', iso(0));
  ins.run('j2', 'research-chat', USER, 'error', iso(0));
  ins.run('j3', 'research-chat', USER, 'cancelled', iso(0));
  ins.run('j4', 'book-chat', USER, 'error', iso(0));
  ins.run('j5', 'research-chat', OTHER, 'error', iso(0));
  ins.run('j6', 'check', USER, 'error', iso(0));

  const range = { fromIso: iso(H), toIso: iso(-H) };
  const all = cq.chatQualityStats(range);
  const research = all.find(r => r.kind === 'research');
  assert.equal(research.answers, 4);
  assert.equal(research.questions, 2);
  assert.equal(research.repeats, 1);
  assert.equal(research.feedbackUp, 2);
  assert.equal(research.feedbackDown, 2);
  assert.equal(research.errors, 2);
  assert.equal(research.cancelled, 1);
  assert.equal(research.errorRate, 2 / 3);
  const book = all.find(r => r.kind === 'book');
  assert.equal(book.errors, 1);
  assert.equal(book.errorRate, 1);
  assert.ok(!all.some(r => r.kind === 'check'), 'Nicht-Chat-Jobs gehoeren nicht in die Auswertung');

  const filtered = cq.chatQualityStats({ ...range, excludedEmails: new Set([OTHER]) });
  const r2 = filtered.find(r => r.kind === 'research');
  assert.equal(r2.answers, 3);
  assert.equal(r2.feedbackDown, 1);
  assert.equal(r2.errors, 1);
  assert.equal(r2.upShare, 2 / 3);
});
