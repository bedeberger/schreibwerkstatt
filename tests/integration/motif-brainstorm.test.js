'use strict';
// Integration: Motiv-Brainstorm-Job (motif-brainstorm) gegen Mock-AI. Prüft, dass
// die KI-Vorschläge normalisiert werden (unbekannter typ → motiv), Dubletten zum
// Katalog + In-Batch-Dubletten gefiltert und trigger_terms übernommen werden.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx, motifsDb, motifBrainstorm, shared;
const BOOK = 990201;
const USER = 'test@example.com';

test.before(() => {
  ctx = bootstrap();
  motifsDb = require('../../db/motifs');
  motifBrainstorm = require('../../routes/jobs/motif-brainstorm');
  shared = ctx.shared;
});
test.after(() => { ctx.cleanup(); });

test('motif-brainstorm: normalisiert + filtert Katalog-/Batch-Dubletten', async () => {
  ctx.mockAi.reset();
  ctx.dbSeed.reset();
  ctx.dbSeed.setBook({
    books: [{ id: BOOK, name: 'Brainstorm-Buch' }],
    chapters: [{ id: 5101, book_id: BOOK, name: 'Kapitel 1' }],
    pages: [{ id: 6101, book_id: BOOK, chapter_id: 5101, name: 'Seite A' }],
    pageBodies: { 6101: '<p>Der Regen fiel; Schuld lastete auf ihr wie Wasser.</p>' },
  });

  // Katalog: „Wasser" existiert schon → Vorschlag dazu muss rausgefiltert werden.
  motifsDb.createMotif(BOOK, USER, { name: 'Wasser' });

  ctx.mockAi.on({ systemIncludes: 'MOTIVE' }, {
    vorschlaege: [
      { typ: 'thema', name: 'Schuld & Vergebung', beschreibung: 'Kernthema', trigger_terms: [] },
      { typ: 'motiv', name: 'Regen', beschreibung: 'Nässe', trigger_terms: ['Regen', 'Fluss'] },
      { typ: 'unsinn', name: 'Spiegel', beschreibung: 'Reflexion', trigger_terms: ['Spiegel'] }, // typ → motiv
      { typ: 'motiv', name: 'Wasser', beschreibung: 'dup zum Katalog', trigger_terms: [] },        // gefiltert
      { typ: 'motiv', name: 'Regen', beschreibung: 'in-batch dup', trigger_terms: [] },            // gefiltert
      { typ: 'motiv', name: '', beschreibung: 'kein Name', trigger_terms: [] },                    // gefiltert
    ],
  });

  const jobId = shared.createJob('motif-brainstorm', BOOK, USER, 'job.label.motivBrainstorm', null, BOOK);
  shared.enqueueJob(jobId, () => motifBrainstorm.runMotifBrainstormJob(jobId, BOOK, USER));
  const job = await waitForJob(shared, jobId);
  assert.equal(job.status, 'done');

  const v = job.result.vorschlaege;
  assert.deepEqual(v.map(x => x.name), ['Schuld & Vergebung', 'Regen', 'Spiegel']);
  assert.equal(v.find(x => x.name === 'Spiegel').typ, 'motiv'); // unbekannter typ normalisiert
  assert.equal(v.find(x => x.name === 'Schuld & Vergebung').typ, 'thema');
  assert.deepEqual(v.find(x => x.name === 'Regen').trigger_terms, ['Regen', 'Fluss']);

  // Lauf wird historisiert: runId im Payload + Eintrag in motif_brainstorm_runs.
  assert.ok(job.result.runId > 0, 'runId im Job-Payload');
  const runs = motifsDb.listBrainstormRuns(BOOK, USER);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].vorschlag_count, 3);
  const detail = motifsDb.getBrainstormRun(job.result.runId);
  assert.deepEqual(detail.result.vorschlaege.map(x => x.name), ['Schuld & Vergebung', 'Regen', 'Spiegel']);
});
