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

test('motif-brainstorm: Delta-Cache — HIT bei unverändertem Buch, force + Katalog', async () => {
  const B2 = 990202;
  ctx.mockAi.reset();
  ctx.dbSeed.reset();
  ctx.dbSeed.setBook({
    books: [{ id: B2, name: 'Cache-Buch' }],
    chapters: [{ id: 5201, book_id: B2, name: 'Kapitel 1' }],
    pages: [{ id: 6201, book_id: B2, chapter_id: 5201, name: 'Seite A' }],
    pageBodies: { 6201: '<p>Der Regen fiel; Schuld lastete auf ihr wie Wasser.</p>' },
  });
  motifsDb.deleteBrainstormCache(B2, USER); // sauberer Start

  ctx.mockAi.on({ systemIncludes: 'MOTIVE' }, {
    vorschlaege: [
      { typ: 'motiv', name: 'Regen', beschreibung: 'Nässe', trigger_terms: ['Regen'] },
      { typ: 'thema', name: 'Schuld', beschreibung: 'Kern', trigger_terms: [] },
    ],
  });

  async function run(force) {
    const jobId = shared.createJob('motif-brainstorm', B2, USER, 'job.label.motivBrainstorm', null, B2);
    shared.enqueueJob(jobId, () => motifBrainstorm.runMotifBrainstormJob(jobId, B2, USER, { force }));
    return waitForJob(shared, jobId);
  }

  // 1) Erster Lauf: Cache-MISS → genau 1 KI-Call.
  ctx.mockAi.log.length = 0;
  let job = await run(false);
  assert.equal(job.status, 'done');
  assert.equal(ctx.mockAi.log.length, 1, 'erster Lauf ruft die KI');
  assert.deepEqual(job.result.vorschlaege.map(x => x.name), ['Regen', 'Schuld']);

  // 2) Re-Run ohne Änderung: Cache-HIT → kein KI-Call, identisches Ergebnis.
  ctx.mockAi.log.length = 0;
  job = await run(false);
  assert.equal(ctx.mockAi.log.length, 0, 'unveränderter Re-Run trifft den Cache');
  assert.deepEqual(job.result.vorschlaege.map(x => x.name), ['Regen', 'Schuld']);

  // 3) Katalog-Änderung bustet den Cache NICHT (Katalog absichtlich nicht in der
  //    Signatur), aber die Dedup filtert das jetzt katalogisierte Motiv frisch raus.
  motifsDb.createMotif(B2, USER, { name: 'Regen' });
  ctx.mockAi.log.length = 0;
  job = await run(false);
  assert.equal(ctx.mockAi.log.length, 0, 'Katalog-Änderung trifft weiter den Cache');
  assert.deepEqual(job.result.vorschlaege.map(x => x.name), ['Schuld'], 'katalogisiertes Motiv rausgefiltert');

  // 4) force → Cache verworfen → erneuter KI-Call.
  ctx.mockAi.log.length = 0;
  job = await run(true);
  assert.equal(ctx.mockAi.log.length, 1, 'force erzwingt einen frischen KI-Call');
});
