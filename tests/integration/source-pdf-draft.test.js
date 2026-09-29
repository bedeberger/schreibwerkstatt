'use strict';
// Integration: Quelle aus PDF (routes/jobs/source-pdf-draft.js).
//
// Geprueft wird die Stufenfolge DOI → ISBN → Titelseite + Register-Suche und
// die Schranke dazwischen: eine Kennung zaehlt nur, wenn der Titel des
// Registertreffers im PDF steht. Register ueber ein gestubbtes `fetch` — kein
// Fremd-Dienst im Test. Der Buffer ist hier kein PDF (readPdfMeta liefert dann
// leere Metadaten); das Metadaten-Lesen deckt tests/unit/source-pdf-ident ab.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
test.before(() => { ctx = bootstrap(); });
test.after(() => { ctx.cleanup(); });

const USER = 'tester@test.dev';
const BOOK_ID = 950;

let _origFetch;
let fetched;
test.beforeEach(() => {
  ctx.mockAi.reset();
  ctx.dbSeed.reset();
  ctx.dbSeed.setBook({ books: [{ id: BOOK_ID, name: 'Arbeit' }] });
  _origFetch = globalThis.fetch;
  fetched = [];
  globalThis.fetch = async () => { throw new Error('kein Netz im Test'); };
  const { db } = require('../../db/connection');
  db.prepare('DELETE FROM book_source_links').run();
  db.prepare('DELETE FROM sources').run();
});
test.afterEach(() => { globalThis.fetch = _origFetch; });

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

/** Register-Stub: `routes` bildet einen URL-Teilstring auf eine Antwort ab. */
function stubRegisters(routes) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    fetched.push(u);
    for (const [part, body] of Object.entries(routes)) {
      if (u.includes(part)) return typeof body === 'number' ? jsonResponse({}, body) : jsonResponse(body);
    }
    return jsonResponse({}, 404);
  };
}

let aiCalls;
function onRead(werk) {
  aiCalls = 0;
  ctx.mockAi.on(e => e.schemaKeys.includes('werk'), () => { aiCalls++; return werk === undefined ? {} : { werk }; });
}

function runJob(text) {
  const jobId = ctx.shared.createJob('source-pdf-draft', BOOK_ID, USER, 'job.label.sourcePdfDraft', null, String(Math.random()));
  const p = ctx.sourcePdfDraft.runSourcePdfDraftJob(jobId, BOOK_ID, USER, {
    text, buffer: Buffer.from('kein pdf'), name: 'aufsatz.pdf',
  });
  return p.then(() => waitForJob(ctx.shared, jobId));
}

const CROSSREF_KUHN = {
  message: {
    type: 'journal-article', DOI: '10.1234/paradigma.1',
    title: ['Paradigmen und ihre Revolutionen'],
    author: [{ family: 'Kuhn', given: 'Thomas S.' }],
    'container-title': ['Zeitschrift fuer Wissenschaftsgeschichte'],
    issued: { 'date-parts': [[1962]] }, volume: '7', page: '1-20',
  },
};

test('DOI im Textkopf → Crossref-Entwurf, kein KI-Call', async () => {
  stubRegisters({ 'api.crossref.org/works/10.1234': CROSSREF_KUHN });
  onRead({ typ: 'aufsatz', titel: 'x', autoren: [], jahr: '', container: '' });

  const job = await runJob('Zeitschrift fuer Wissenschaftsgeschichte 7 (1962)\n'
    + 'https://doi.org/10.1234/paradigma.1\nParadigmen und ihre Revolutionen\nThomas S. Kuhn\nAbstract …');
  assert.equal(job.status, 'done');
  const r = job.result;
  assert.equal(r.method, 'doi');
  assert.equal(r.verified, true);
  assert.equal(r.register, 'crossref');
  assert.equal(r.draft.title, 'Paradigmen und ihre Revolutionen');
  assert.equal(r.draft.doi, '10.1234/paradigma.1');
  assert.equal(r.draft.csl_type, 'article');
  assert.equal(r.doc_name, 'aufsatz.pdf');
  assert.equal(aiCalls, 0);
});

test('fremder DOI (Titel steht nicht im PDF) wird verworfen → Titelseite', async () => {
  stubRegisters({ 'api.crossref.org/works/10.1234': CROSSREF_KUHN });
  onRead({ typ: 'aufsatz', titel: 'Normalwissenschaft als Raetsel', autoren: ['Ada Beispiel'], jahr: '2001', container: '' });

  const job = await runJob('Normalwissenschaft als Raetsel\nAda Beispiel\n'
    + 'Vgl. den Begleitartikel doi:10.1234/paradigma.1.');
  assert.equal(job.status, 'done');
  const r = job.result;
  assert.equal(aiCalls, 1);
  assert.equal(r.method, 'text');            // Register-Suche findet nichts
  assert.equal(r.verified, false);
  assert.equal(r.draft.title, 'Normalwissenschaft als Raetsel');
  assert.deepEqual(r.draft.authors, [{ family: 'Beispiel', given: 'Ada' }]);
  assert.equal(r.draft.year, '2001');
  assert.equal(r.draft.doi, null);           // der fremde DOI landet nicht im Entwurf
});

test('ISBN im Impressum → OpenLibrary-Entwurf', async () => {
  stubRegisters({
    'openlibrary.org/api/books': {
      'ISBN:9783518281451': {
        title: 'Die Struktur wissenschaftlicher Revolutionen',
        authors: [{ name: 'Thomas S. Kuhn' }],
        publishers: [{ name: 'Suhrkamp' }], publish_places: [{ name: 'Frankfurt am Main' }],
        publish_date: '1976',
      },
    },
  });
  onRead({ typ: 'buch', titel: 'x', autoren: [], jahr: '', container: '' });

  const job = await runJob('Thomas S. Kuhn\nDie Struktur wissenschaftlicher Revolutionen\n'
    + 'Suhrkamp\nISBN 978-3-518-28145-1');
  const r = job.result;
  assert.equal(r.method, 'isbn');
  assert.equal(r.register, 'openlibrary');
  assert.equal(r.draft.publisher, 'Suhrkamp');
  assert.equal(r.draft.isbn, '9783518281451');
  assert.equal(aiCalls, 0);
});

test('Titelseite + Registertreffer → verified, Registerfelder gewinnen', async () => {
  stubRegisters({
    'openlibrary.org/search.json': {
      docs: [{
        title: 'Die Struktur wissenschaftlicher Revolutionen', author_name: ['Thomas S. Kuhn'],
        first_publish_year: 1962, publisher: ['Suhrkamp'], isbn: ['9783518281451'],
      }],
    },
  });
  onRead({ typ: 'buch', titel: 'Die Struktur wissenschaftlicher Revolutionen', autoren: ['Thomas S. Kuhn'], jahr: '', container: '' });

  const job = await runJob('Thomas S. Kuhn\nDie Struktur wissenschaftlicher Revolutionen\nZweite Auflage');
  const r = job.result;
  assert.equal(r.method, 'register');
  assert.equal(r.verified, true);
  assert.equal(r.register, 'openlibrary');
  assert.equal(r.draft.isbn, '9783518281451');
  assert.equal(r.draft.year, '1962');
});

test('Werk liegt schon in der Bibliothek → existing_source_id, Zuordnung gemeldet', async () => {
  const { createSource, linkSource } = require('../../db/sources');
  const s = createSource(USER, { csl_type: 'article', title: 'Paradigmen und ihre Revolutionen', doi: '10.1234/PARADIGMA.1' });
  stubRegisters({ 'api.crossref.org/works/10.1234': CROSSREF_KUHN });
  onRead({ typ: 'aufsatz', titel: 'x', autoren: [], jahr: '', container: '' });

  let job = await runJob('Paradigmen und ihre Revolutionen\n10.1234/paradigma.1');
  assert.equal(job.result.existing_source_id, s.id);   // DOI-Vergleich ohne Gross/Klein
  assert.equal(job.result.existing_linked, false);

  linkSource(BOOK_ID, s.id, USER);
  job = await runJob('Paradigmen und ihre Revolutionen\n10.1234/paradigma.1');
  assert.equal(job.result.existing_linked, true);
});

test('kein Text und keine Kennung → sprechender Fehler', async () => {
  onRead({ typ: 'buch', titel: 'x', autoren: [], jahr: '', container: '' });
  const job = await runJob('');
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.sourcePdfNoText');
  assert.equal(aiCalls, 0);
});

test('KI-Antwort ohne `werk` ist ein Fehler, leeres Werk auch', async () => {
  onRead(undefined);
  let job = await runJob('Irgendein Text ohne Kennung.');
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.sourcePdfMissing');

  ctx.mockAi.reset();
  onRead({ typ: 'sonstiges', titel: '', autoren: [], jahr: '', container: '' });
  job = await runJob('Irgendein Text ohne Kennung.');
  assert.equal(job.error, 'job.error.sourcePdfNoWork');
});

test('Zeitungsartikel: Datum von der Titelseite, keine Registersuche, Adresse aus der Fusszeile', async () => {
  stubRegisters({});
  onRead({
    typ: 'zeitungsartikel', titel: 'Die Stadt wächst', autoren: ['Anna Meier'],
    jahr: '', datum: '12. März 2024', container: 'Neue Zürcher Zeitung',
  });
  const foot = '\n12.03.24, 14:05 Die Stadt wächst | NZZ\nhttps://www.nzz.ch/zuerich/die-stadt-ld.123 1/2\n';
  const job = await runJob(`Neue Zürcher Zeitung\nDie Stadt wächst\nAnna Meier\n12. März 2024${foot}Text${foot}`);
  assert.equal(job.status, 'done');
  const r = job.result;
  assert.equal(r.draft.csl_type, 'newspaper');
  assert.equal(r.draft.issued_date, '2024-03-12');
  assert.equal(r.draft.year, '2024');
  assert.equal(r.draft.container_title, 'Neue Zürcher Zeitung');
  assert.equal(r.register_skipped, true);
  assert.equal(r.verified, false);
  assert.deepEqual(fetched, [], 'kein Register-Request fuer einen Zeitungsartikel');
  assert.equal(r.url_from_print, true);
  assert.equal(r.draft.url, 'https://www.nzz.ch/zuerich/die-stadt-ld.123');
  // Kein echtes PDF im Test → kein Erstellungsdatum → Abrufdatum bleibt leer
  // statt „heute" zu behaupten.
  assert.equal(r.draft.accessed_at, null);
});

test('Registertreffer mit Adresse: die Druck-Adresse ueberschreibt sie nicht', async () => {
  stubRegisters({ 'api.crossref.org/works/10.1234': { message: { ...CROSSREF_KUHN.message, URL: 'https://doi.org/10.1234/paradigma.1' } } });
  onRead({ typ: 'aufsatz', titel: 'x', autoren: [], jahr: '', container: '' });
  const foot = '\nhttps://www.zeitschrift.example/artikel 1/2\n';
  const job = await runJob(`Paradigmen und ihre Revolutionen\n10.1234/paradigma.1${foot}x${foot}`);
  assert.equal(job.result.draft.url, 'https://doi.org/10.1234/paradigma.1');
  assert.equal(job.result.url_from_print, false);
});
