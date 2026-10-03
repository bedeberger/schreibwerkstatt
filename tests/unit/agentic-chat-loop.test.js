'use strict';
// Geteilter agentischer Loop (routes/jobs/agentic-chat.js) mit gemocktem
// callAIWithTools: Reihenfolge final_answer ↔ andere Werkzeuge, Budget-Abbruch,
// pause_turn (serverseitige Web-Suche), leere Antwort, Kosten-Deckel pro Antwort,
// toolsForIter-Hook und web_search-Queries in context_info.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('agentic-loop');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const ai = require('../../lib/ai');
const { createJob, jobs } = require('../../routes/jobs/shared');
const { makeAgenticChatJob, EMPTY_ANSWER_MARKER } = require('../../routes/jobs/agentic-chat');

const USER = 'loop@example.com';
const BOOK = 81001;
appUsers.createUser({ email: USER });
db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Loop', datetime('now'), datetime('now'))`).run(BOOK);

function newSession() {
  // title gesetzt → kein KI-Titel-Call am Ende.
  const id = db.prepare(`INSERT INTO chat_sessions (book_id, kind, user_email, title, created_at, last_message_at)
                         VALUES (?, 'book', ?, 'T', datetime('now'), datetime('now'))`).run(BOOK, USER).lastInsertRowid;
  db.prepare(`INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, 'user', 'Frage?', datetime('now'))`).run(id);
  return id;
}

const FINAL = { name: 'final_answer' };
const TOOLS = [{ name: 'side_effect' }, { name: 'lookup' }, FINAL];

function res(over) {
  return {
    text: '', toolUses: [], rawContentBlocks: [], stopReason: 'end_turn',
    tokensIn: 100, tokensOut: 10, truncated: false, model: 'claude-sonnet-4-6', ...over,
  };
}
const tu = (name, input = {}, id = name + Math.random()) => ({ id, name, input });

// Mock-Sequenz: jede Runde liefert das nächste Ergebnis; Aufrufe werden protokolliert.
function mockCalls(seq) {
  const calls = [];
  ai.callAIWithTools = async (messages, system, tools) => {
    calls.push({ messages: structuredClone(messages), tools: tools.map(t => t.name) });
    const next = seq.shift();
    if (!next) throw new Error('Mock-Sequenz erschöpft');
    return typeof next === 'function' ? next(calls.length) : next;
  };
  return calls;
}

function makeJob(over = {}) {
  const executed = [];
  let captured = null;
  const run = makeAgenticChatJob({
    startLabel: 'Test', errLabel: 'Test',
    callProvider: 'claude',
    resolveProvider: () => 'claude',
    loadSession: (sid) => db.prepare(`SELECT cs.*, b.name AS book_name FROM chat_sessions cs JOIN books b ON b.book_id = cs.book_id WHERE cs.id = ?`).get(sid),
    async prepare() {
      return {
        systemPrompt: [{ text: 'sys' }], tools: TOOLS, maxToolIter: 4, tokenBudget: 1_000_000,
        forceFinalInstruction: 'FORCE', ctx: { effects: [] },
        ...(over.prep || {}),
      };
    },
    async executeTool(name, input, ctx) {
      executed.push(name);
      if (name === 'side_effect') ctx.effects.push(input.v);
      return { ok: true, name };
    },
    consumeFinalAnswer: ({ finalUse }) => JSON.stringify({ antwort: finalUse.input?.antwort ?? '' }),
    parseFinal: (finalText) => {
      const o = JSON.parse(finalText);
      return o.antwort;
    },
    buildContextInfo: (args) => { captured = args; return { stop: args.stopReason, effects: args.ctx.effects, webQueries: args.webQueries }; },
    buildSummary: () => 'summary',
  });
  return { run, executed, ctx: () => captured };
}

async function runJob(job, sessionId) {
  const jobId = createJob('book-chat', BOOK, USER, 'x');
  await job.run(jobId, sessionId, 1, 'Frage?', USER);
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', `Job nicht done: ${j.error}`);
  const msg = db.prepare(`SELECT content, context_info FROM chat_messages WHERE id = ?`).get(j.result.assistant_message_id);
  return { result: j.result, content: msg.content, ci: JSON.parse(msg.context_info) };
}

test('(a) final_answer neben anderen Werkzeugen: die anderen laufen zuerst (Seiteneffekte bleiben)', async () => {
  mockCalls([res({
    stopReason: 'tool_use',
    toolUses: [tu('final_answer', { antwort: 'fertig' }), tu('side_effect', { v: 42 })],
  })]);
  const job = makeJob();
  const out = await runJob(job, newSession());
  assert.deepEqual(job.executed, ['side_effect']);
  assert.deepEqual(out.ci.effects, [42]);
  assert.equal(out.content, 'fertig');
  assert.equal(out.ci.stop, 'final_answer');
});

test('(b) Budget-Überschreitung in derselben Runde verwirft final_answer nicht', async () => {
  mockCalls([res({
    stopReason: 'tool_use', tokensIn: 5_000_000,
    toolUses: [tu('final_answer', { antwort: 'trotzdem da' })],
  })]);
  const out = await runJob(makeJob({ prep: { tokenBudget: 1000 } }), newSession());
  assert.equal(out.content, 'trotzdem da');
});

test('(b) Budget-Überschreitung ohne final_answer → contextExceeded-Marker', async () => {
  mockCalls([res({ stopReason: 'tool_use', tokensIn: 5_000_000, toolUses: [tu('lookup')] })]);
  const out = await runJob(makeJob({ prep: { tokenBudget: 1000 } }), newSession());
  assert.equal(out.content, '__i18n:chat.errors.contextExceeded__');
  assert.equal(out.ci.stop, 'context_budget');
});

test('(c) pause_turn: Assistant-Inhalt anhängen und weiterlaufen, kein Abschluss', async () => {
  const paused = [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'Mauerfall Datum' } }];
  const calls = mockCalls([
    res({ stopReason: 'pause_turn', rawContentBlocks: paused, text: 'Zwischenstand' }),
    res({ stopReason: 'tool_use', toolUses: [tu('final_answer', { antwort: 'nach Pause' })] }),
  ]);
  const out = await runJob(makeJob(), newSession());
  assert.equal(out.content, 'nach Pause');
  assert.equal(calls.length, 2);
  const last = calls[1].messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.deepEqual(last.content, paused);
  // web_search-Queries landen in context_info (webQueries-Feld des Loops).
  assert.deepEqual(out.ci.webQueries, ['Mauerfall Datum']);
});

test('(d) leere antwort aus final_answer → i18n-Marker statt roher JSON-Hülle', async () => {
  mockCalls([res({ stopReason: 'tool_use', toolUses: [tu('final_answer', { antwort: '   ' })] })]);
  const out = await runJob(makeJob(), newSession());
  assert.equal(out.content, EMPTY_ANSWER_MARKER);
});

test('(d) leere Prosa-Antwort → i18n-Marker', async () => {
  mockCalls([res({ stopReason: 'end_turn', text: '' })]);
  const out = await runJob(makeJob(), newSession());
  assert.equal(out.content, EMPTY_ANSWER_MARKER);
});

test('Kosten-Deckel: kumulierte Input-Tokens erreicht → Synthese nur mit final_answer', async () => {
  const calls = mockCalls([
    res({ stopReason: 'tool_use', tokensIn: 600, toolUses: [tu('lookup')] }),
    res({ stopReason: 'tool_use', tokensIn: 600, toolUses: [tu('final_answer', { antwort: 'synthetisiert' })] }),
  ]);
  const out = await runJob(makeJob({ prep: { inputTokenCap: 500, inputCapInstruction: 'BUDGET' } }), newSession());
  assert.equal(out.content, 'synthetisiert');
  assert.equal(out.ci.stop, 'input_cap');
  assert.deepEqual(calls[1].tools, ['final_answer']);
  assert.equal(calls[1].messages.at(-1).content, 'BUDGET');
});

test('Iterationsdeckel: Synthese-Turn mit forceFinalInstruction', async () => {
  const seq = [];
  for (let i = 0; i < 2; i++) seq.push(res({ stopReason: 'tool_use', toolUses: [tu('lookup')] }));
  seq.push(res({ stopReason: 'end_turn', text: 'Prosa-Synthese' }));
  const calls = mockCalls(seq);
  const out = await runJob(makeJob({ prep: { maxToolIter: 2 } }), newSession());
  assert.equal(out.content, 'Prosa-Synthese');
  assert.equal(out.ci.stop, 'max_iter');
  assert.equal(calls[2].messages.at(-1).content, 'FORCE');
});

test('toolsForIter: Werkzeugliste pro Runde aus dem Hook, Synthese bleibt bei final_answer', async () => {
  const seen = [];
  const calls = mockCalls([
    res({ stopReason: 'tool_use', toolUses: [tu('lookup')] }),
    res({ stopReason: 'tool_use', toolUses: [tu('final_answer', { antwort: 'ok' })] }),
  ]);
  const toolsForIter = ({ iter, webSearches }) => {
    seen.push({ iter, webSearches });
    return iter === 0 ? [TOOLS[1], FINAL] : [FINAL];
  };
  await runJob(makeJob({ prep: { toolsForIter } }), newSession());
  assert.deepEqual(calls[0].tools, ['lookup', 'final_answer']);
  assert.deepEqual(calls[1].tools, ['final_answer']);
  assert.deepEqual(seen.map(s => s.iter), [0, 1]);
  assert.equal(seen[0].webSearches, 0);
});
