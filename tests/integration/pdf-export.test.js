'use strict';
// Integration test: Custom-PDF-Export — HTTP-Layer von routes/pdf-export.js
// (Profil-CRUD) und routes/jobs/pdf-export.js (Job-Start + Download).
//   - Profil-Besitz: fremdes Profil → 403
//   - Font-Whitelist (Familie) auf JEDEM Persistier-Weg (POST, Klon, PUT) → 400;
//     fehlendes Gewicht/Kursiv einer erlaubten Familie wird akzeptiert
//   - Doppelter Name → 409 PROFILE_NAME_TAKEN
//   - Job-POST: Buch-ACL VOR jeder Bestandsfrage (kein Existenz-Orakel fuer
//     Fassung/Profil auf fremden Buechern), unaufloesbare Einheit → 404
//   - /file: fremder User 403, unbekannt 404, abgelaufen/verdraengt 410,
//     entzogener Buchzugriff 403, zweiter Download geht
//   - sample-Flag: eigener Dedup-Schluessel, Antwort traegt sample:true
// Faehrt die echten Router unter Express hoch (Fake-Session liefert den User).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
let sessionUser = 'autor@test.dev';

const OWNER = 'autor@test.dev';
const STRANGER = 'eindringling@test.dev';
const NOW = '2026-01-01T00:00:00.000Z';

function startServer() {
  return new Promise((resolve, reject) => {
    const pdfExportRouter = require('../../routes/pdf-export');
    const { pdfExportRouter: pdfJobRouter } = require('../../routes/jobs/pdf-export');
    const app = express();
    app.use((req, _res, next) => {
      req.session = { user: { email: sessionUser } };
      next();
    });
    app.use('/pdf-export', pdfExportRouter);
    app.use('/jobs', pdfJobRouter);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, opts);
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch (_) {}
  return { status: res.status, json, buf, headers: res.headers };
}

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  await startServer();
});
test.after(() => {
  if (server) server.close();
  require('../../routes/jobs/pdf-export').pdfResults.clear();
  ctx.cleanup();
});

test.beforeEach(() => {
  sessionUser = OWNER;
  for (const t of ['pdf_export_profile', 'pages', 'chapters', 'book_access', 'books']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

// Buch + ACL + ein Kapitel mit einer (leeren) Seite. Leer, damit ein
// gestarteter Job sofort an BOOK_EMPTY endet statt Fonts zu laden.
function seedBook(bookId, user = OWNER) {
  const { grantAccess } = require('../../db/book-access');
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Testbuch', ?, ?)").run(bookId, NOW, NOW);
  grantAccess(bookId, user, 'editor', user);
  const chapterId = db.prepare(
    `INSERT INTO chapters (book_id, chapter_name, position, updated_at) VALUES (?, 'Kapitel 1', 0, ?)`
  ).run(bookId, NOW).lastInsertRowid;
  const pageId = db.prepare(
    `INSERT INTO pages (book_id, page_name, chapter_id, position, updated_at) VALUES (?, 'Seite 1', ?, 0, ?)`
  ).run(bookId, chapterId, NOW).lastInsertRowid;
  return { chapterId, pageId };
}

async function createProfile(name = 'Satz', config) {
  const { status, json } = await api('POST', '/pdf-export/profiles', { name, ...(config ? { config } : {}) });
  assert.equal(status, 201, JSON.stringify(json));
  return json;
}

// ── Profile ─────────────────────────────────────────────────────────────────

test('Profil eines anderen Users: GET/PUT/DELETE → 403', async () => {
  const p = await createProfile('Meins');
  sessionUser = STRANGER;
  assert.equal((await api('GET', `/pdf-export/profiles/${p.id}`)).status, 403);
  assert.equal((await api('PUT', `/pdf-export/profiles/${p.id}`, { name: 'X' })).status, 403);
  assert.equal((await api('DELETE', `/pdf-export/profiles/${p.id}`)).status, 403);
  // Klonen eines fremden Profils verrät nicht mal, dass es existiert.
  const clone = await api('POST', '/pdf-export/profiles', { name: 'Klon', clone_from: p.id });
  assert.equal(clone.status, 404);
  assert.equal(clone.json.error_code, 'CLONE_SOURCE_NOT_FOUND');
});

test('POST mit nicht freigegebener Familie → 400 FONT_NOT_ALLOWED', async () => {
  const bad = await api('POST', '/pdf-export/profiles', {
    name: 'Comic', config: { font: { body: { family: 'Comic Sans MS', weight: 400 } } },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error_code, 'FONT_NOT_ALLOWED');
  assert.equal(bad.json.params.role, 'body');

  // Nichts davon wurde angelegt.
  assert.equal((await api('GET', '/pdf-export/profiles')).json.profiles.length, 0);
});

test('Erlaubte Familie ohne passenden Schnitt/Gewicht wird akzeptiert (Renderer-Fallback)', async () => {
  // Inter hat keinen Kursivschnitt (Widmung ist kursiv), Lora kein 900.
  const r = await api('POST', '/pdf-export/profiles', {
    name: 'Fallback',
    config: { font: { dedication: { family: 'Inter', weight: 400, italic: true }, title: { family: 'Lora', weight: 900 } } },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const put = await api('PUT', `/pdf-export/profiles/${r.json.id}`, { config: r.json.config });
  assert.equal(put.status, 200, JSON.stringify(put.json));
});

test('PUT prüft alle Rollen gegen die Whitelist', async () => {
  const p = await createProfile('Satz');
  const cfg = { ...p.config, font: { ...p.config.font, footer: { ...p.config.font.footer, family: 'Papyrus' } } };
  const r = await api('PUT', `/pdf-export/profiles/${p.id}`, { config: cfg });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'FONT_NOT_ALLOWED');
  assert.equal(r.json.params.role, 'footer');
});

test('Doppelter Profilname → 409 PROFILE_NAME_TAKEN (POST und PUT)', async () => {
  await createProfile('Doppelt');
  const dup = await api('POST', '/pdf-export/profiles', { name: 'Doppelt' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error_code, 'PROFILE_NAME_TAKEN');

  const other = await createProfile('Anders');
  const ren = await api('PUT', `/pdf-export/profiles/${other.id}`, { name: 'Doppelt' });
  assert.equal(ren.status, 409);
  assert.equal(ren.json.error_code, 'PROFILE_NAME_TAKEN');
});

test('Name-Race: der UNIQUE-Index wirft SQLITE_CONSTRAINT_UNIQUE (Route mappt auf 409)', async () => {
  // Der Vorab-Check in der Route deckt den Normalfall; zwischen Check und
  // INSERT schützt nur der Index. Die Route mappt genau diesen Code auf 409.
  const schema = require('../../db/schema');
  await createProfile('Race');
  assert.throws(
    () => schema.createPdfExportProfile(0, OWNER, 'Race', {}),
    (e) => e.code === 'SQLITE_CONSTRAINT_UNIQUE',
  );
});

test('Profil-Timestamps sind ISO+Z', async () => {
  const p = await createProfile('Zeit');
  assert.match(p.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(p.updated_at, /Z$/);
});

// ── Job-Start: ACL vor Bestand ──────────────────────────────────────────────

test('Job-POST auf fremdes Buch → 403, auch für nicht existierende Fassung/Profil', async () => {
  const BOOK = 9101;
  const { chapterId, pageId } = seedBook(BOOK, OWNER);
  sessionUser = STRANGER;
  const p = await createProfile('Fremd');

  // Fassung existiert nicht — trotzdem 403, nicht SNAPSHOT_NOT_FOUND.
  const snap = await api('POST', '/jobs/pdf-export', { entityId: BOOK, profile_id: p.id, snapshot_id: 999999 });
  assert.equal(snap.status, 403);
  // Profil existiert nicht — 403 vor PROFILE_NOT_FOUND.
  const prof = await api('POST', '/jobs/pdf-export', { scope: 'book', entityId: BOOK, profile_id: 999999 });
  assert.equal(prof.status, 403);
  // Kapitel/Seite des fremden Buchs.
  const ch = await api('POST', '/jobs/pdf-export', { scope: 'chapter', entityId: chapterId, profile_id: p.id });
  assert.equal(ch.status, 403);
  const pg = await api('POST', '/jobs/pdf-export', { scope: 'page', entityId: pageId, profile_id: p.id });
  assert.equal(pg.status, 403);
});

test('Job-POST: nicht auflösbares Kapitel/Seite → 404, eigenes Buch ohne Fassung → 404 SNAPSHOT_NOT_FOUND', async () => {
  const BOOK = 9102;
  seedBook(BOOK, OWNER);
  const p = await createProfile('Eigen');
  const ch = await api('POST', '/jobs/pdf-export', { scope: 'chapter', entityId: 987654, profile_id: p.id });
  assert.equal(ch.status, 404);
  assert.equal(ch.json.error_code, 'NOT_FOUND');
  const pg = await api('POST', '/jobs/pdf-export', { scope: 'page', entityId: 987654, profile_id: p.id });
  assert.equal(pg.status, 404);
  const snap = await api('POST', '/jobs/pdf-export', { entityId: BOOK, profile_id: p.id, snapshot_id: 999999 });
  assert.equal(snap.status, 404);
  assert.equal(snap.json.error_code, 'SNAPSHOT_NOT_FOUND');
});

test('Job-POST mit fremdem Profil auf eigenem Buch → 403', async () => {
  const BOOK = 9103;
  seedBook(BOOK, OWNER);
  sessionUser = STRANGER;
  const foreign = await createProfile('Fremdprofil');
  sessionUser = OWNER;
  const r = await api('POST', '/jobs/pdf-export', { scope: 'book', entityId: BOOK, profile_id: foreign.id });
  assert.equal(r.status, 403);
  assert.equal(r.json.error_code, 'FORBIDDEN');
});

test('sample:true wird akzeptiert und bekommt eigenen Dedup-Schlüssel', async () => {
  const BOOK = 9104;
  seedBook(BOOK, OWNER);
  const p = await createProfile('Probe');
  const { jobs } = require('../../routes/jobs/shared');
  const r = await api('POST', '/jobs/pdf-export', { scope: 'book', entityId: BOOK, profile_id: p.id, sample: true });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.sample, true);
  const job = jobs.get(r.json.jobId);
  assert.ok(job);
  assert.match(job.dedupId, /:sample$/);

  // Umschlag kennt keine Probeseiten — Flag wird ignoriert.
  const cover = await api('POST', '/jobs/pdf-export', { target: 'cover', entityId: BOOK, profile_id: p.id, sample: true });
  assert.equal(cover.status, 202);
  assert.equal(cover.json.sample, false);
  assert.doesNotMatch(jobs.get(cover.json.jobId).dedupId, /:sample/);
});

// ── Download ────────────────────────────────────────────────────────────────

function fakeDoneJob(bookId, user = OWNER) {
  const { createJob, completeJob } = require('../../routes/jobs/shared');
  const id = createJob('pdf-export', bookId, user, 'job.label.pdfExportProfile', { profile: 'x' }, `test:${Math.random()}`);
  completeJob(id, { ready: true });
  return id;
}

test('/file: Eigentümer lädt zweimal, fremder User 403, unbekannt 404, ohne Ergebnis 410', async () => {
  const BOOK = 9105;
  seedBook(BOOK, OWNER);
  const { pdfResults } = require('../../routes/jobs/pdf-export');
  const id = fakeDoneJob(BOOK);
  pdfResults.set(id, { buffer: Buffer.from('%PDF-1.4 test'), mime: 'application/pdf', filename: 'buch-probe.pdf' });

  const a = await api('GET', `/jobs/pdf-export/${id}/file`);
  assert.equal(a.status, 200);
  assert.equal(a.buf.toString(), '%PDF-1.4 test');
  assert.match(a.headers.get('content-disposition'), /buch-probe\.pdf/);
  // Zweiter Download geht (kein Löschen beim ersten Abholen).
  assert.equal((await api('GET', `/jobs/pdf-export/${id}/file`)).status, 200);

  sessionUser = STRANGER;
  assert.equal((await api('GET', `/jobs/pdf-export/${id}/file`)).status, 403);

  sessionUser = OWNER;
  assert.equal((await api('GET', '/jobs/pdf-export/does-not-exist/file')).status, 404);

  // Verdrängt/abgelaufen → 410.
  pdfResults.delete(id);
  const gone = await api('GET', `/jobs/pdf-export/${id}/file`);
  assert.equal(gone.status, 410);
  assert.equal(gone.json.error_code, 'RESULT_EXPIRED');
});

test('/file: entzogener Buchzugriff → 403, auch für den Job-Eigentümer', async () => {
  const BOOK = 9106;
  seedBook(BOOK, OWNER);
  const { pdfResults } = require('../../routes/jobs/pdf-export');
  const id = fakeDoneJob(BOOK);
  pdfResults.set(id, { buffer: Buffer.from('%PDF'), mime: 'application/pdf', filename: 'x.pdf' });
  db.prepare('DELETE FROM book_access WHERE book_id = ?').run(BOOK);
  assert.equal((await api('GET', `/jobs/pdf-export/${id}/file`)).status, 403);
});
