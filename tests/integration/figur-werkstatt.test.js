'use strict';
// Integration test: Figuren-Werkstatt Brainstorm + Consistency-Jobs.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
let werkstatt;
let draftFigDb;
test.before(() => {
  ctx = bootstrap();
  werkstatt = require('../../routes/jobs/figur-werkstatt');
  draftFigDb = require('../../db/draft-figures');
});
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.mockAi.reset();
  ctx.mockBs.reset();
});

function sampleMindmap(name = 'Anna') {
  return {
    meta: { name: 'figur-werkstatt', version: '1' },
    format: 'node_tree',
    data: {
      id: 'root', topic: name,
      children: [
        { id: 'steckbrief', topic: 'Steckbrief', children: [
          { id: 'aussehen',    topic: 'Aussehen' },
          { id: 'hintergrund', topic: 'Hintergrund' },
        ]},
        { id: 'stimme', topic: 'Stimme', children: [] },
      ],
    },
  };
}

function brainstormResponse() {
  return {
    vorschlaege: [
      { label: 'Verwitwet, schweigsam',          begruendung: 'verstärkt Konflikt-Achse' },
      { label: 'Adoptiert, sucht Wurzeln',       begruendung: 'gibt Want und Need Spannung' },
      { label: 'Aus Bergdorf, Stadtmüde',        begruendung: 'passt zum 1920er-Setting' },
    ],
  };
}

function consistencyResponse() {
  return {
    konflikte: [
      { feld: 'Beruf',   schwere: 'stark',   problem: 'Beruf passt nicht zur Epoche', vorschlag: 'auf Modistin ändern' },
      { feld: 'Konflikt', schwere: 'mittel', problem: 'doppelt sich mit Boris',        vorschlag: 'differenzieren' },
    ],
    fazit: 'Solider Kern, zwei Stellen klären.',
  };
}

// ── Brainstorm ─────────────────────────────────────────────────────────────

test('Brainstorm: Mindmap-Knoten → Vorschläge ins Job-Result', async () => {
  const BOOK_ID = 6101;
  const userEmail = 'autor@test.dev';
  ctx.mockBs.setBook({ chapters: [], pages: [], pageBodies: {} });
  // book row needed (FK)
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'Werkstatt-Buch');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', archetype: 'protagonist', mindmap: sampleMindmap('Anna'),
  });

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('vorschlaege'),
    brainstormResponse(),
  );

  const jobId = ctx.shared.createJob(
    'werkstatt-brainstorm', BOOK_ID, userEmail,
    'job.label.werkstattBrainstorm', { figur: 'Anna' },
    `${draft.id}|hintergrund`,
  );
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runBrainstormJob(jobId, draft.id, 'hintergrund', userEmail),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.vorschlaege.length, 3);
  assert.equal(job.result.vorschlaege[0].label, 'Verwitwet, schweigsam');
  assert.equal(job.result.knotenId, 'hintergrund');
  assert.equal(job.result.knotenPfad, 'Anna > Steckbrief > Hintergrund');
});

test('Brainstorm: KI ohne vorschlaege-Array → failJob', async () => {
  const BOOK_ID = 6102;
  const userEmail = 'autor@test.dev';
  ctx.mockBs.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', mindmap: sampleMindmap(),
  });

  ctx.mockAi.on(() => true, { fazit: 'falsche Form' });

  const jobId = ctx.shared.createJob('werkstatt-brainstorm', BOOK_ID, userEmail, 'l');
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runBrainstormJob(jobId, draft.id, 'aussehen', userEmail),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.werkstatt.vorschlaegeMissing');
});

test('Brainstorm: unbekannter Knoten → failJob mit knotenMissing', async () => {
  const BOOK_ID = 6103;
  const userEmail = 'autor@test.dev';
  ctx.mockBs.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', mindmap: sampleMindmap(),
  });

  const jobId = ctx.shared.createJob('werkstatt-brainstorm', BOOK_ID, userEmail, 'l');
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runBrainstormJob(jobId, draft.id, 'unbekannt-xyz', userEmail),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.werkstatt.knotenMissing');
  assert.equal(ctx.mockAi.log.length, 0, 'KI sollte nicht angefragt werden');
});

test('Brainstorm: fremde draft → failJob forbidden', async () => {
  const BOOK_ID = 6104;
  ctx.mockBs.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, 'owner@test.dev', {
    name: 'Anna', mindmap: sampleMindmap(),
  });

  const jobId = ctx.shared.createJob('werkstatt-brainstorm', BOOK_ID, 'eindringling@test.dev', 'l');
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runBrainstormJob(jobId, draft.id, 'aussehen', 'eindringling@test.dev'),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.forbidden');
});

// ── Consistency ─────────────────────────────────────────────────────────────

test('Consistency: Konflikte mit Severity-Skala + Fazit', async () => {
  const BOOK_ID = 6201;
  const userEmail = 'autor@test.dev';
  ctx.mockBs.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', archetype: 'protagonist', mindmap: sampleMindmap(),
  });

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('konflikte') && e.schemaKeys.includes('fazit'),
    consistencyResponse(),
  );

  const jobId = ctx.shared.createJob('werkstatt-consistency', BOOK_ID, userEmail, 'l', null, draft.id);
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runConsistencyJob(jobId, draft.id, userEmail),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.konflikte.length, 2);
  assert.equal(job.result.konflikte[0].schwere, 'stark');
  assert.equal(job.result.konflikte[1].schwere, 'mittel');
  assert.match(job.result.fazit, /Solider Kern/);
});

test('Consistency: ungültige Severity → fallback "mittel"', async () => {
  const BOOK_ID = 6202;
  const userEmail = 'autor@test.dev';
  ctx.mockBs.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', mindmap: sampleMindmap(),
  });

  ctx.mockAi.on(() => true, {
    konflikte: [{ feld: 'X', schwere: 'megakritisch', problem: 'p', vorschlag: 'v' }],
    fazit: 'ok',
  });

  const jobId = ctx.shared.createJob('werkstatt-consistency', BOOK_ID, userEmail, 'l', null, draft.id);
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runConsistencyJob(jobId, draft.id, userEmail),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.result.konflikte[0].schwere, 'mittel');
});

test('Consistency: leeres konflikte-Array + Fazit ist gültig', async () => {
  const BOOK_ID = 6203;
  const userEmail = 'autor@test.dev';
  ctx.mockBs.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', mindmap: sampleMindmap(),
  });

  ctx.mockAi.on(() => true, { konflikte: [], fazit: 'Stimmig.' });

  const jobId = ctx.shared.createJob('werkstatt-consistency', BOOK_ID, userEmail, 'l', null, draft.id);
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runConsistencyJob(jobId, draft.id, userEmail),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.result.konflikte.length, 0);
  assert.equal(job.result.fazit, 'Stimmig.');
});

test('Consistency: KI ohne fazit → failJob', async () => {
  const BOOK_ID = 6204;
  const userEmail = 'autor@test.dev';
  ctx.mockBs.setBook({ chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', mindmap: sampleMindmap(),
  });

  ctx.mockAi.on(() => true, { konflikte: [] });

  const jobId = ctx.shared.createJob('werkstatt-consistency', BOOK_ID, userEmail, 'l', null, draft.id);
  ctx.shared.enqueueJob(jobId, () =>
    werkstatt.runConsistencyJob(jobId, draft.id, userEmail),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.werkstatt.fazitMissing');
});

// ── _findKnotenPfad ─────────────────────────────────────────────────────────

test('_findKnotenPfad: liefert "Wurzel > … > Knoten"-Pfad', () => {
  const tree = sampleMindmap('Anna').data;
  assert.equal(werkstatt._findKnotenPfad(tree, 'root'),       'Anna');
  assert.equal(werkstatt._findKnotenPfad(tree, 'steckbrief'), 'Anna > Steckbrief');
  assert.equal(werkstatt._findKnotenPfad(tree, 'aussehen'),   'Anna > Steckbrief > Aussehen');
  assert.equal(werkstatt._findKnotenPfad(tree, 'stimme'),     'Anna > Stimme');
  assert.equal(werkstatt._findKnotenPfad(tree, 'unbekannt'),  null);
});
