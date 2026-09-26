'use strict';
// db/motifs/links.js#resolveFigureIds gegen das ECHTE migrierte Schema.
//
// `fig_id` ist nur innerhalb eines Katalogs (Buch, User) eindeutig: im selben
// Buch trägt der Katalog eines anderen Users (oder ein Alt-Eintrag ohne User)
// dieselben IDs `fig_1`, `fig_2`, … Ohne User-Filter verknüpfte das Speichern
// eines Motivs die gleichnamige ID des fremden Katalogs — eine andere Figur.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { useTmpDb } = require('./_helpers/tmp-db');
const tmpDb = useTmpDb('motif-fig-resolve');

require('../../db/migrations');
const { db } = require('../../db/connection');
const motifsDb = require('../../db/motifs');

const A = 'a@x.de';
const B = 'b@x.de';

function seed() {
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['figures', 'books', 'app_users']) db.prepare(`DELETE FROM ${t}`).run();
  db.exec('PRAGMA foreign_keys = ON');
  const now = new Date().toISOString();
  for (const e of [A, B]) {
    db.prepare('INSERT INTO app_users (email, display_name, created_at) VALUES (?,?,?)').run(e, e, now);
  }
  db.prepare('INSERT INTO books (book_id, name, owner_email, created_at, updated_at) VALUES (1, ?, ?, ?, ?)').run('Buch 1', A, now, now);
  const ins = db.prepare('INSERT INTO figures (id, book_id, fig_id, name, user_email, updated_at) VALUES (?, 1, ?, ?, ?, ?)');
  ins.run(10, 'fig_1', 'Daniel', null, now); // Alt-Eintrag ohne User, niedrigere id
  ins.run(11, 'fig_1', 'Stefan', A, now);
  ins.run(12, 'fig_1', 'Fremd', B, now);
}

test('fig_id wird im Katalog des Users aufgelöst, nicht im erstbesten des Buchs', () => {
  seed();
  assert.deepEqual(motifsDb.resolveFigureIds(1, A, ['fig_1']), [11]);
  assert.deepEqual(motifsDb.resolveFigureIds(1, B, ['fig_1']), [12]);
});

test('INTEGER-Fallback bleibt im Katalog des Users', () => {
  seed();
  assert.deepEqual(motifsDb.resolveFigureIds(1, A, ['11']), [11]);
  assert.deepEqual(motifsDb.resolveFigureIds(1, A, ['12']), []);
  assert.deepEqual(motifsDb.resolveFigureIds(1, A, ['10']), []);
});

