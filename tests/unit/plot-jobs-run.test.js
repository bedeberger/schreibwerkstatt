'use strict';
// Plot-Brainstorm + Plot-Consistency einmal komplett mit gemocktem callAI:
// Kontext-Laden gegen eine echte (Wegwerf-)DB, Prompt-Inhalt (Sprache, Hybrid-
// Blöcke, Beat-Substanz), Normalisierung + Persistenz, Delta-Check im Folgelauf.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('plot-jobs-run');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const plot = require('../../db/plot');
const appSettings = require('../../lib/app-settings');
const ai = require('../../lib/ai');

// callAI vor dem ersten Laden von routes/jobs/shared ersetzen (dort destrukturiert).
const calls = [];
let nextAnswer = null;
ai.callAI = async (prompt, system, onProgress, maxTokens, signal, provider, schema) => {
  calls.push({ prompt: String(prompt), system: String(system), maxTokens, schema });
  return { text: JSON.stringify(nextAnswer), tokensIn: 100, tokensOut: 50, truncated: false, model: 'mock' };
};
ai.parseJSON = ai.parseJSON || ((t) => JSON.parse(t));

const { createJob, jobs } = require('../../routes/jobs/shared');
const { runPlotBrainstormJob, runPlotConsistencyJob } = require('../../routes/jobs/plot');

const USER = 'plotrun@example.com';
const BOOK = 81202;
appUsers.createUser({ email: USER });
db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Plotbuch', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(BOOK);
appSettings.set('ai.provider', 'claude');

const shared = plot.createAct(BOOK, USER, { name: 'Akt 1' });
const thread = plot.createThread(BOOK, USER, { name: 'Mara' });
const own = plot.createAct(BOOK, USER, { name: 'Akt 1', threadId: thread.id });
const b1 = plot.createBeat(BOOK, shared.id, USER, { titel: 'Auftakt', beschreibung: 'Ein Fremder kommt ins Dorf.', intensitaet: 2 });
const b2 = plot.createBeat(BOOK, own.id, USER, { titel: 'Maras Flucht', threadId: thread.id, intensitaet: 4 });

test('Brainstorm: Zielakt per ID, Sprachregel aus der Buch-Locale, Output-Budget mit Denk-Reserve', async () => {
  nextAnswer = { vorschlaege: [{ label: 'Mara stellt sich', begruendung: 'Wendepunkt.' }] };
  const jobId = createJob('plot-brainstorm', BOOK, USER, 'x');
  await runPlotBrainstormJob(jobId, BOOK, own.id, thread.id, USER);
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', j.error);
  assert.equal(j.result.vorschlaege.length, 1);
  const { prompt, maxTokens } = calls.at(-1);
  assert.ok(prompt.includes('ZIEL-AKT: "Akt 1" (eigener Akt von Strang „Mara")'));
  assert.ok(prompt.includes('AUSGABESPRACHE'));
  assert.ok(prompt.includes('«Ein Fremder kommt ins Dorf.»'));
  assert.ok(maxTokens >= 8000);
});

test('Consistency: Normalisierung + Persistenz; Folgelauf bekommt den Vorlauf (Delta)', async () => {
  nextAnswer = {
    konflikte: [
      { beat: 'Auftakt', beat_id: b1.id, schwere: 'mittel', typ: 'status', problem: 'Steht schon im Buch.', vorschlag: 'Status nachziehen.',
        aktion: { art: 'status', wert: 'im_buch', typ: null, ziel_beat_id: null } },
      { beat: 'Maras Flucht', beat_id: b2.id, schwere: 'stark', typ: 'setup_payoff', problem: 'Flucht ohne Anlass.', vorschlag: 'Kante ziehen.',
        aktion: { art: 'relation', wert: null, typ: 'fuehrt-zu', ziel_beat_id: b2.id } },
    ],
    erledigt: ['soll ohne Vorlauf verschwinden'],
    fazit: 'Solide.',
  };
  const jobId = createJob('plot-consistency', BOOK, USER, 'x');
  await runPlotConsistencyJob(jobId, BOOK, USER);
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', j.error);
  const [k1, k2] = j.result.konflikte;
  assert.deepEqual(k1.aktion, { art: 'status', wert: 'im_buch' });
  assert.equal(k1.typ, 'status');
  assert.equal(k2.aktion, null, 'Selbst-Kante verworfen');
  assert.ok(!('seit_letztem_lauf' in k1));
  assert.deepEqual(j.result.erledigt, []);
  const first = calls.at(-1);
  assert.ok(first.prompt.includes('=== STRANG „Mara" — EIGENE AKTSTRUKTUR'));
  assert.ok(!first.prompt.includes('VORLAUF'));
  assert.ok(!first.schema.properties.konflikte.items.properties.seit_letztem_lauf);
  const stored = plot.getPlotConsistencyRun(j.result.runId);
  assert.deepEqual(stored.result.erledigt, []);
  assert.equal(stored.result.konflikte[0].typ, 'status');

  // Beat nach dem Lauf ändern → taucht im Vorlauf als „geändert" auf.
  db.prepare(`UPDATE plot_beats SET beschreibung = 'neu', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', '+1 second') WHERE id = ?`).run(b1.id);
  nextAnswer = {
    konflikte: [{ beat: 'Maras Flucht', beat_id: b2.id, schwere: 'stark', typ: 'setup_payoff', problem: 'Flucht ohne Anlass.', vorschlag: 'x',
      aktion: { art: 'keine', wert: null, typ: null, ziel_beat_id: null }, seit_letztem_lauf: 'bestehend' }],
    erledigt: ['Status von „Auftakt" nachgezogen'],
    fazit: 'Besser.',
  };
  const jobId2 = createJob('plot-consistency', BOOK, USER, 'x');
  await runPlotConsistencyJob(jobId2, BOOK, USER);
  const j2 = jobs.get(jobId2);
  assert.equal(j2.status, 'done', j2.error);
  assert.equal(j2.result.konflikte[0].seit_letztem_lauf, 'bestehend');
  assert.deepEqual(j2.result.erledigt, ['Status von „Auftakt" nachgezogen']);
  assert.equal(j2.result.vorlaufRunId, j.result.runId);
  const second = calls.at(-1);
  assert.ok(second.prompt.includes('VORLAUF'));
  assert.ok(second.prompt.includes(`[#${b1.id}] Auftakt (status): «Steht schon im Buch.»`));
  assert.ok(second.prompt.includes(`Seitdem inhaltlich geänderte oder neue Beats: [#${b1.id}] Auftakt`));
  assert.ok(second.schema.properties.konflikte.items.required.includes('seit_letztem_lauf'));
});
