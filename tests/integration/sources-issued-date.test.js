'use strict';
// Integration: Erscheinungsdatum + Zeitungsartikel am echten /sources-Router.
// Geprueft wird der Schreibpfad (db/sources/shared.js ueber lib/issued-date.js):
// Eingabe wird ISO, das Jahr folgt dem Datum auch beim PUT, Unlesbares ist ein
// 400 statt eines still verworfenen Felds, und `newspaper` passiert den CHECK
// der Migration 294.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
const USER = 'autor@test.dev';
const NOW = '2026-01-01T00:00:00.000Z';

async function api(method, urlPath, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${urlPath}`, opts);
  let json = null;
  try { json = await res.json(); } catch (_) { /* leer */ }
  return { status: res.status, json };
}

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  await new Promise((resolve) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: USER } }; next(); });
    app.use('/sources', require('../../routes/sources'));
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

test.beforeEach(() => {
  for (const t of ['source_citations', 'book_source_links', 'sources', 'book_access', 'books']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  const { grantAccess } = require('../../db/book-access');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(9601, 'B', NOW, NOW);
  grantAccess(9601, USER, 'editor', USER);
});

test('POST: Zeitungsartikel, Datum in Schweizer Schreibweise → ISO, Jahr abgeleitet', async () => {
  const { status, json } = await api('POST', '/sources', {
    book_id: 9601, csl_type: 'newspaper', title: 'Die Stadt wächst',
    container_title: 'NZZ', issued_date: '12.3.2024', year: '1999',
  });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.csl_type, 'newspaper');
  assert.equal(json.issued_date, '2024-03-12');
  assert.equal(json.year, '2024');          // Datum fuehrt, Jahr folgt
});

test('PUT: nur das Jahr geaendert — das gesetzte Datum gewinnt weiter', async () => {
  const { json: src } = await api('POST', '/sources', {
    book_id: 9601, csl_type: 'newspaper', title: 'T', issued_date: '2024-03-12',
  });
  const { json } = await api('PUT', `/sources/${src.id}`, { year: '2020' });
  assert.equal(json.year, '2024');
  const { json: cleared } = await api('PUT', `/sources/${src.id}`, { issued_date: null, year: '2020' });
  assert.equal(cleared.issued_date, null);
  assert.equal(cleared.year, '2020');
});

test('Unlesbares Datum → 400 INVALID_VALUE, nichts angelegt', async () => {
  const { status, json } = await api('POST', '/sources', {
    book_id: 9601, csl_type: 'newspaper', title: 'T', issued_date: 'irgendwann im Frühling',
  });
  assert.equal(status, 400);
  assert.equal(json.error_code, 'INVALID_VALUE');
  assert.equal(json.params.field, 'issued_date');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sources').get().n, 0);
});
