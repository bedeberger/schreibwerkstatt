'use strict';
// Integration: PATCH /chat/message/:id/feedback (Daumen hoch/runter, alle Chats).
// Nur der Besitzer der Session darf setzen (fremde Nachricht → 404 wie bei den
// Vorschlags-Routen), das Buch muss er weiterhin lesen duerfen (→ 403), nur
// Assistant-Nachrichten, nur 1/-1/null. GET /chat/session/:id liefert den Wert.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const OWNER = 'fb-owner@test.dev';
const OTHER = 'fb-other@test.dev';
const BOOK = 9511;
const NOW = '2026-01-01T00:00:00.000Z';

let ctx; let db; let server; let baseUrl; let bookAccess;
let sessionId; let userMsgId; let answerId;

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  bookAccess = require('../../db/book-access');
  const appUsers = require('../../db/app-users');
  for (const email of [OWNER, OTHER]) {
    if (!appUsers.getUser(email)) appUsers.createUser({ email });
  }
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Feedbackbuch', ?, ?)").run(BOOK, NOW, NOW);
  bookAccess.grantAccess(BOOK, OWNER, 'editor', OWNER);
  sessionId = db.prepare(
    "INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at) VALUES (?, 'book', ?, ?, ?)"
  ).run(BOOK, OWNER, NOW, NOW).lastInsertRowid;
  const ins = db.prepare('INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)');
  userMsgId = ins.run(sessionId, 'user', 'Wer ist Anna?', NOW).lastInsertRowid;
  answerId = ins.run(sessionId, 'assistant', 'Anna ist die Erzählerin.', NOW).lastInsertRowid;

  const chatRouter = require('../../routes/chat');
  const app = express();
  // Test-Login: E-Mail aus dem Header, damit beide User dieselbe App nutzen.
  app.use((req, _res, next) => { req.session = { user: { email: req.headers['x-test-user'] } }; next(); });
  app.use('/chat', chatRouter);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

async function patch(id, body, user = OWNER) {
  const r = await fetch(`${baseUrl}/chat/message/${id}/feedback`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const feedbackOf = (id) => db.prepare('SELECT feedback, feedback_at FROM chat_messages WHERE id = ?').get(id);

test('Besitzer setzt 👍, Wert landet in der DB und in GET /chat/session/:id', async () => {
  const r = await patch(answerId, { feedback: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, feedback: 1 });
  const row = feedbackOf(answerId);
  assert.equal(row.feedback, 1);
  assert.match(row.feedback_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);

  const s = await fetch(`${baseUrl}/chat/session/${sessionId}`, { headers: { 'x-test-user': OWNER } });
  const data = await s.json();
  assert.equal(data.messages.find(m => m.id === answerId).feedback, 1);
});

test('Wechsel auf 👎 und Zuruecknehmen mit null', async () => {
  assert.equal((await patch(answerId, { feedback: -1 })).status, 200);
  assert.equal(feedbackOf(answerId).feedback, -1);
  assert.equal((await patch(answerId, { feedback: null })).status, 200);
  assert.equal(feedbackOf(answerId).feedback, null);
});

test('Ungueltiger Wert → 400 FEEDBACK_INVALID', async () => {
  for (const feedback of [0, 2, '1', true]) {
    const r = await patch(answerId, { feedback });
    assert.equal(r.status, 400, `feedback=${JSON.stringify(feedback)}`);
    assert.equal(r.json.error_code, 'FEEDBACK_INVALID');
  }
  const r = await patch(answerId, {});
  assert.equal(r.status, 400);
});

test('User-Nachricht → 400 FEEDBACK_NOT_ASSISTANT', async () => {
  const r = await patch(userMsgId, { feedback: 1 });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'FEEDBACK_NOT_ASSISTANT');
  assert.equal(feedbackOf(userMsgId).feedback, null);
});

test('Fremder User → 404, auch mit Buchzugang; nichts geschrieben', async () => {
  let r = await patch(answerId, { feedback: 1 }, OTHER);
  assert.equal(r.status, 404);
  assert.equal(r.json.error_code, 'MESSAGE_NOT_FOUND');
  bookAccess.grantAccess(BOOK, OTHER, 'editor', OWNER);
  r = await patch(answerId, { feedback: 1 }, OTHER);
  assert.equal(r.status, 404);
  assert.equal(feedbackOf(answerId).feedback, null);
});

test('Besitzer ohne Buchzugang mehr → 403', async () => {
  bookAccess.revokeAccess(BOOK, OWNER);
  const r = await patch(answerId, { feedback: 1 });
  assert.equal(r.status, 403);
  assert.equal(feedbackOf(answerId).feedback, null);
  bookAccess.grantAccess(BOOK, OWNER, 'editor', OWNER);
});

test('Unbekannte/ungueltige ID → 404 bzw. 400', async () => {
  assert.equal((await patch(999999, { feedback: 1 })).status, 404);
  assert.equal((await patch('abc', { feedback: 1 })).status, 400);
});
