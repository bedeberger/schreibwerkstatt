// Quelle aus PDF (Quellen-Karte) gegen die ECHTE App.
//
// Der JOB wird gestubbt (page.route): die Stufenfolge DOI → ISBN → Titelseite
// deckt tests/integration/source-pdf-draft.test.js ab, und die App-Suite hat
// weder Modell noch Netz zu Crossref. Echt laufen das Fragment
// (`@include sources-pdf-draft`), der Entwurf im Anlage-Formular und die zwei
// Schreibwege danach — POST /sources und POST /sources/:id/doc mit dem PDF,
// das im Browser zwischen Job und Speichern gehalten wird.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const JOB_ID = 'stub-source-pdf-draft';

function makePdf() {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.text('Paradigmen und ihre Revolutionen');
    doc.end();
  });
}

const DRAFT = {
  csl_type: 'article', citekey: null, authors: [{ family: 'Kuhn', given: 'Thomas S.' }], editors: [],
  title: 'Paradigmen und ihre Revolutionen', container_title: 'Zeitschrift fuer Wissenschaftsgeschichte',
  publisher: null, place: null, year: '1962', edition: null, volume: '7', issue: null, pages: '1-20',
  doi: '10.1234/paradigma.1', isbn: null, issn: null, url: null, accessed_at: null, note: null,
};

async function stubJob(page, result, seen) {
  const json = (route, body) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(body),
  });
  await page.route('**/jobs/source-pdf-draft?**', (route) => {
    seen.push({ url: route.request().url(), type: route.request().headers()['content-type'] });
    return json(route, { jobId: JOB_ID });
  });
  await page.route(`**/jobs/${JOB_ID}`, (route) => json(route, {
    id: JOB_ID, type: 'source-pdf-draft', status: 'done', progress: 100, result,
  }));
}

async function openCard(page) {
  await bootApp(page);
  const bookId = await selectSeededBook(page);
  // Eine Wegwerf-DB fuer die ganze App-Suite: Pool leeren, sonst haengt „neu
  // oder vorhanden" von der Spec-Reihenfolge ab.
  await page.evaluate(async () => {
    const pool = await fetch('/sources/pool?archived=1').then(r => r.json());
    for (const s of Array.isArray(pool) ? pool : []) await fetch(`/sources/${s.id}`, { method: 'DELETE' });
  });
  await page.evaluate((id) => { location.hash = `#book/${id}/quellen`; }, bookId);
  await expect(page.locator('#sources-card')).toBeVisible();
  return bookId;
}

async function choosePdf(page) {
  const buffer = await makePdf();
  await page.locator('#sources-card input[type="file"][accept="application/pdf"]').first()
    .setInputFiles({ name: 'kuhn-1962.pdf', mimeType: 'application/pdf', buffer });
}

test('quelle aus pdf: Entwurf im Formular, Speichern haengt das PDF an', async ({ page }) => {
  const seen = [];
  await stubJob(page, {
    draft: DRAFT, method: 'doi', verified: true, register: 'crossref', doc_name: 'kuhn-1962.pdf',
    existing_source_id: null, existing_linked: false, existing_has_doc: false,
  }, seen);
  const bookId = await openCard(page);

  await choosePdf(page);
  const form = page.locator('.sources-form');
  await expect(form).toBeVisible();
  expect(seen[0].url).toContain(`book_id=${bookId}`);
  expect(seen[0].url).toContain('name=kuhn-1962.pdf');
  expect(seen[0].type).toBe('application/pdf');

  // Herkunft + gemerktes PDF stehen am Formular, die Felder tragen den Entwurf.
  await expect(form.locator('.sources-pdf-origin')).toContainText('DOI');
  await expect(form.locator('.sources-pdf-origin')).toContainText('Crossref');
  await expect(form).toContainText('kuhn-1962.pdf');
  await expect(form.locator('.sources-preview')).toContainText('Kuhn');
  await expect(form.locator('.sources-preview')).toContainText('1962');

  await form.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('.sources-table tbody tr')).toHaveCount(1);

  // Quelle UND Anhang: das PDF ging ueber den echten /sources/:id/doc-Pfad.
  await expect.poll(async () => page.evaluate(async (id) => {
    const rows = await fetch(`/sources?book_id=${id}`).then(r => r.json());
    return rows[0] && { title: rows[0].title, doi: rows[0].doi, has_doc: rows[0].has_doc, doc_name: rows[0].doc_name };
  }, bookId)).toEqual({
    title: 'Paradigmen und ihre Revolutionen', doi: '10.1234/paradigma.1', has_doc: true, doc_name: 'kuhn-1962.pdf',
  });
});

test('quelle aus pdf: vorhandene Quelle verwenden statt Dublette', async ({ page }) => {
  const seen = [];
  const bookId = await openCard(page);
  // Liegt in der Bibliothek, aber nicht in diesem Buch.
  const existingId = await page.evaluate(async () => {
    const r = await fetch('/sources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csl_type: 'article', title: 'Paradigmen und ihre Revolutionen', doi: '10.1234/paradigma.1' }),
    });
    return (await r.json()).id;
  });
  await stubJob(page, {
    draft: DRAFT, method: 'doi', verified: true, register: 'crossref', doc_name: 'kuhn-1962.pdf',
    existing_source_id: existingId, existing_linked: false, existing_has_doc: false,
  }, seen);

  await choosePdf(page);
  const origin = page.locator('.sources-form .sources-pdf-origin');
  await expect(origin).toContainText('schon in deiner Bibliothek');
  await origin.getByRole('button', { name: 'Vorhandene Quelle verwenden' }).click();

  // Zugeordnet statt neu angelegt, PDF haengt an der vorhandenen Quelle, und
  // das Formular zeigt sie zum Pruefen.
  await expect(page.locator('.sources-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.sources-form')).toContainText('kuhn-1962.pdf');
  const state = await page.evaluate(async (id) => {
    const pool = await fetch('/sources/pool?archived=1').then(r => r.json());
    const rows = await fetch(`/sources?book_id=${id}`).then(r => r.json());
    return { pool: pool.length, id: rows[0]?.id, has_doc: rows[0]?.has_doc };
  }, bookId);
  expect(state).toEqual({ pool: 1, id: existingId, has_doc: true });
});

test('quelle aus pdf: Zeitungsartikel mit Datum und Adresse aus dem Druck', async ({ page }) => {
  const seen = [];
  await stubJob(page, {
    draft: {
      ...DRAFT, csl_type: 'newspaper', title: 'Die Stadt wächst', authors: [{ family: 'Meier', given: 'Anna' }],
      container_title: 'Neue Zürcher Zeitung', year: '2024', issued_date: '2024-03-12', volume: null, pages: null,
      doi: null, url: 'https://www.nzz.ch/zuerich/die-stadt-ld.123', accessed_at: '2024-03-15',
    },
    method: 'text', verified: false, register: null, register_skipped: true, url_from_print: true,
    doc_name: 'kuhn-1962.pdf', existing_source_id: null, existing_linked: false, existing_has_doc: false,
  }, seen);
  const bookId = await openCard(page);
  await choosePdf(page);

  const form = page.locator('.sources-form');
  const origin = form.locator('.sources-pdf-origin');
  await expect(origin).toContainText('in keinem Register');
  await expect(origin).toContainText('Fusszeile');
  // Typabhaengiges Formular: das Datumsfeld steht, die Vorschau setzt das Datum.
  await expect(form.getByLabel('Erscheinungsdatum')).toHaveValue('2024-03-12');
  await expect(form.locator('.sources-preview')).toContainText('(2024, 12. März)');

  // Datum in Schweizer Schreibweise nachtippen: Vorschau folgt, gespeichert wird ISO.
  await form.getByLabel('Erscheinungsdatum').fill('13.3.2024');
  await expect(form.locator('.sources-preview')).toContainText('(2024, 13. März)');
  await form.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('.sources-table tbody tr')).toHaveCount(1);

  const saved = await page.evaluate(async (id) => {
    const rows = await fetch(`/sources?book_id=${id}`).then(r => r.json());
    const s = rows[0];
    return { type: s.csl_type, date: s.issued_date, year: s.year, url: s.url, accessed: s.accessed_at };
  }, bookId);
  expect(saved).toEqual({
    type: 'newspaper', date: '2024-03-13', year: '2024',
    url: 'https://www.nzz.ch/zuerich/die-stadt-ld.123', accessed: '2024-03-15',
  });
});
