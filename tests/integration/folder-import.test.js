'use strict';
// Integration test: Folder-Import-Job. Baut ein In-Memory-ZIP mit Tagebuch-
// Struktur (YYYY/Monat/Tagesdatei.docx + .odt), startet den Worker direkt und
// prueft das Ergebnis ueber den Content-Store.

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
let folderImport;
let contentStore;

test.before(() => {
  ctx = bootstrap();
  folderImport = require('../../routes/jobs/folder-import');
  contentStore = require('../../lib/content-store');
});
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => { ctx.mockAi.reset(); });

async function makeDocx(text) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.folder('_rels').file('.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.folder('word').file('document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makeOdt(text) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text');
  zip.file('content.xml',
    `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>${text}</text:p></office:text></office:body></office:document-content>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function buildArchive(entries) {
  const zip = new JSZip();
  for (const [path, buf] of entries) zip.file(path, buf);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('folder-import (merge): docx + odt aus YYYY/Monat → Kapitel pro Jahr, Seiten pro Tag', async () => {
  const userEmail = 'tester@test.dev';

  // Buch + Owner-ACL anlegen
  const book = await contentStore.createBook(
    { name: 'Tagebuch', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  // ZIP-Archiv mit 3 Jahres-Buckets
  const buffer = await buildArchive([
    ['2023/12/2023-12-30.docx', await makeDocx('Silvester-Vorabend.')],
    ['2023/12/2023-12-31.docx', await makeDocx('Silvester.')],
    ['2024/01/2024-01-01.odt',  await makeOdt('Neujahr.')],
    ['2024/03/05.docx',         await makeDocx('Maerz-Eintrag.')],
  ]);

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'Tagebuch' },
    'merge:' + book.id,
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id,
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'done', `Job-Status: ${job.status}, err: ${job.error || '-'}`);
  assert.equal(job.result.pagesCreated, 4);
  assert.equal(job.result.chaptersCreated, 2);
  assert.equal(job.result.bookId, book.id);

  // Content-Store-Check: 2 Kapitel (2023, 2024), 4 Seiten gesamt
  const chapters = await contentStore.listChapters(book.id, { session: { user: { email: userEmail } } });
  const yearNames = chapters.map(c => c.name).sort();
  assert.deepEqual(yearNames, ['2023', '2024']);

  const pages = await contentStore.listPages(book.id, { session: { user: { email: userEmail } } });
  const pageNames = pages.map(p => p.name).sort();
  assert.deepEqual(pageNames, ['2023-12-30', '2023-12-31', '2024-01-01', '2024-03-05']);
});

test('folder-import: leeres Archiv → failJob mit emptyArchive', async () => {
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook(
    { name: 'Empty', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  const buffer = await buildArchive([
    ['random.txt', Buffer.from('hi')],
  ]);

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'Empty' },
    'merge:' + book.id + ':empty',
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id,
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'error');
  assert.match(String(job.error || ''), /emptyArchive/i);
});

test('folder-import: unbekannte Extension wird skipped', async () => {
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook(
    { name: 'Mixed', owner_email: userEmail },
    { session: { user: { email: userEmail } } },
  );
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_at) VALUES (?, ?, 'owner', datetime('now'))`).run(book.id, userEmail);

  const buffer = await buildArchive([
    ['2024/01/2024-01-01.docx', await makeDocx('Neujahr.')],
    ['2024/01/notes.txt', Buffer.from('plain text')],
  ]);

  const jobId = ctx.shared.createJob(
    'folder-import', book.id, userEmail,
    'job.label.folderImport', { name: 'Mixed' },
    'merge:' + book.id + ':mixed',
  );
  folderImport.importBuffers.set(jobId, { buffer, mode: 'merge', bookName: '', bookId: book.id });

  await folderImport.runFolderImportJob(jobId, {
    userEmail, mode: 'merge', bookName: '', bookId: book.id,
  });

  const job = ctx.shared.jobs.get(jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.result.pagesCreated, 1);
  assert.ok(job.result.skipped.some(s => s.path.endsWith('notes.txt') && s.reason === 'UNSUPPORTED_EXT'));
});
