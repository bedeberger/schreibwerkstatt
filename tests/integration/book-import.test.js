'use strict';

// Integration: Buch-Migration Round-Trip. Quell-Buch seeden -> Bundle bauen
// (wie routes/book-migration.js) -> Import-Job laufen lassen -> Ziel-Buch
// vergleichen. Deckt den realen Import-Pfad (JSZip + Validate + Content-Store-
// Anlage) gegen die Test-DB ab.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctxBoot;
let contentStore, bookBundle, bookImport, shared;

const OWNER = 'autor@test.dev';
const reqCtx = { session: { user: { email: OWNER } } };

before(() => {
  ctxBoot = bootstrap();
  contentStore = require('../../lib/content-store');
  bookBundle = require('../../lib/book-bundle');
  bookImport = require('../../routes/jobs/book-import');
  shared = ctxBoot.shared;
});

after(() => { ctxBoot.cleanup(); });

beforeEach(() => { ctxBoot.dbSeed.reset(); });

async function buildBundleBuffer(bookId) {
  const tree = await contentStore.bookTree(bookId, reqCtx);
  const book = await contentStore.loadBook(bookId, reqCtx);
  const metas = [];
  for (const p of (tree.topPages || [])) metas.push(p);
  (function walk(chs) { for (const c of chs) { for (const p of (c.pages || [])) metas.push(p); walk(c.subchapters || []); } })(tree.chapters || []);
  const details = await contentStore.loadPagesBatch(metas, reqCtx, { batchSize: 15, onError: () => null });
  const htmlById = new Map();
  for (const d of details) if (d && d.id) htmlById.set(d.id, d.html || '');
  const nodes = bookBundle.treeToNodes(tree, htmlById);
  const manifest = bookBundle.buildManifest({ sourceBookId: bookId, exportedAt: '2026-05-30T00:00:00Z' });
  const bookJson = bookBundle.buildBookJson({ book, settings: { language: 'de', region: 'CH', buchtyp: 'roman' }, nodes });
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('book.json', JSON.stringify(bookJson));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function runImport(buffer) {
  const jobId = shared.createJob('book-import', 0, OWNER, 'job.label.bookImport', {}, `t:${Math.random()}`);
  bookImport.importBuffers.set(jobId, { buffer });
  await bookImport.runBookImportJob(jobId, { userEmail: OWNER });
  return shared.jobs.get(jobId);
}

test('Round-Trip: Export-Bundle -> Import erzeugt strukturgleiches Buch', async () => {
  ctxBoot.dbSeed.setBook({
    books: [{ id: 900, name: 'Quellbuch' }],
    chapters: [
      { id: 9001, book_id: 900, name: 'Kapitel A', position: 0 },
      { id: 9002, book_id: 900, name: 'Kapitel B', position: 1 },
    ],
    pages: [
      { id: 90001, book_id: 900, name: 'Intro', chapter_id: null, position: 0 },
      { id: 90002, book_id: 900, name: 'A1', chapter_id: 9001, position: 0 },
      { id: 90003, book_id: 900, name: 'A2', chapter_id: 9001, position: 1 },
      { id: 90004, book_id: 900, name: 'B1', chapter_id: 9002, position: 0 },
    ],
    pageBodies: {
      90001: '<p>Vorwort-Text</p>',
      90002: '<p>Erste Seite</p>',
      90003: '<p>Zweite Seite</p>',
      90004: '<p>Kapitel B Seite</p>',
    },
  });

  const buffer = await buildBundleBuffer(900);
  const job = await runImport(buffer);

  assert.equal(job.status, 'done', job.error || '');
  const newBookId = job.result.bookId;
  assert.ok(newBookId && newBookId !== 900);
  assert.equal(job.result.pagesCreated, 4);
  assert.equal(job.result.chaptersCreated, 2);

  // Ziel-Buch laden + Struktur vergleichen.
  const tree = await contentStore.bookTree(newBookId, reqCtx);
  const flat = contentStore.flattenTree(tree);
  const names = flat.map(f => f.page.name).sort();
  assert.deepEqual(names, ['A1', 'A2', 'B1', 'Intro']);

  const chapterNames = (tree.chapters || []).map(c => c.name).sort();
  assert.deepEqual(chapterNames, ['Kapitel A', 'Kapitel B']);

  // HTML einer Seite verifizieren (durch _cleanHtmlSafe gelaufen -> data-bid,
  // aber Textinhalt erhalten).
  const a1 = flat.find(f => f.page.name === 'A1');
  const full = await contentStore.loadPage(a1.page.id, reqCtx);
  assert.match(full.html, /Erste Seite/);

  // Owner gesetzt.
  const { db } = require('../../db/connection');
  const owner = db.prepare('SELECT owner_email FROM books WHERE book_id = ?').get(newBookId);
  assert.equal(owner.owner_email, OWNER);

  // Settings uebernommen.
  const settings = ctxBoot.dbSchema.getBookSettings(newBookId);
  assert.equal(settings.buchtyp, 'roman');
});

test('Re-Import erzeugt ein zweites unabhaengiges Buch', async () => {
  ctxBoot.dbSeed.setBook({
    books: [{ id: 901, name: 'Quelle2' }],
    chapters: [{ id: 9011, book_id: 901, name: 'K', position: 0 }],
    pages: [{ id: 90011, book_id: 901, name: 'S', chapter_id: 9011, position: 0 }],
    pageBodies: { 90011: '<p>Inhalt</p>' },
  });
  const buffer = await buildBundleBuffer(901);
  const j1 = await runImport(buffer);
  const j2 = await runImport(buffer);
  assert.equal(j1.status, 'done');
  assert.equal(j2.status, 'done');
  assert.notEqual(j1.result.bookId, j2.result.bookId);
});

test('Kaputtes Manifest -> Job-Error badManifest', async () => {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ format: 'andere-app', version: 1 }));
  zip.file('book.json', JSON.stringify({ book: { name: 'X' }, tree: [{ type: 'page', name: 'p' }] }));
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const job = await runImport(buffer);
  assert.equal(job.status, 'error');
});
