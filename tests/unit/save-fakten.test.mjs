// Unit: saveFaktenToDb — Welt-Fakten-Persistenz aus der Komplettanalyse.
// Full-Replace pro (book, user), Chapter-Bridge via chNameToId, leere Fakten
// skippen, kein Bridge bei unbekanntem/Gesamtbuch-Kapitel.
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Frische Test-DB pro Lauf (parallel-isoliert), bevor db/schema geladen wird.
process.env.DB_PATH = path.join('/tmp', `save-fakten-test-${process.pid}-${Date.now()}.db`);
const schema = require('../../db/schema');
const db = schema.db;

const BOOK = 700;
const USER = 'fakten@test.dev';

function setup() {
  schema.upsertBookByName(BOOK, 'Fakten-Buch');
  db.prepare('INSERT OR IGNORE INTO chapters (chapter_id, book_id, chapter_name) VALUES (?, ?, ?)')
    .run(7001, BOOK, 'Kapitel 1');
}

test('saveFaktenToDb: Bridge bei Match, kein Bridge bei Unbekannt/Gesamtbuch, leere skippen', () => {
  setup();
  const chNameToId = { 'Kapitel 1': 7001 };
  schema.saveFaktenToDb(BOOK, [
    { kapitel: 'Kapitel 1', fakten: [
      { kategorie: 'magie', subjekt: 'Stab', fakt: 'leuchtet blau', seite: 'S1' },
      { fakt: '   ' }, // leer → skip
    ] },
    { kapitel: 'Unbekannt', fakten: [{ fakt: 'globaler Fakt' }] },
    { kapitel: 'Gesamtbuch', fakten: [{ fakt: 'single-pass Fakt' }] },
  ], USER, chNameToId);

  const rows = db.prepare('SELECT fakt FROM world_facts WHERE book_id = ? AND user_email = ? ORDER BY sort_order').all(BOOK, USER);
  assert.deepEqual(rows.map(r => r.fakt), ['leuchtet blau', 'globaler Fakt', 'single-pass Fakt']);

  // Nur der Kapitel-1-Fakt hat einen Bridge-Eintrag.
  const bridges = db.prepare(`
    SELECT wf.fakt, wfc.chapter_id FROM world_fact_chapters wfc
    JOIN world_facts wf ON wf.id = wfc.fact_id WHERE wf.book_id = ?`).all(BOOK);
  assert.equal(bridges.length, 1);
  assert.equal(bridges[0].fakt, 'leuchtet blau');
  assert.equal(bridges[0].chapter_id, 7001);
});

test('saveFaktenToDb: Full-Replace ersetzt vorherigen Stand, keine Dubletten', () => {
  setup();
  const chNameToId = { 'Kapitel 1': 7001 };
  schema.saveFaktenToDb(BOOK, [{ kapitel: 'Kapitel 1', fakten: [
    { fakt: 'a' }, { fakt: 'b' }, { fakt: 'c' },
  ] }], USER, chNameToId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM world_facts WHERE book_id=? AND user_email=?').get(BOOK, USER).n, 3);

  // Zweiter Lauf mit nur einem Fakt → ersetzt komplett.
  schema.saveFaktenToDb(BOOK, [{ kapitel: 'Kapitel 1', fakten: [{ fakt: 'nur einer' }] }], USER, chNameToId);
  const rows = db.prepare('SELECT fakt FROM world_facts WHERE book_id=? AND user_email=?').all(BOOK, USER);
  assert.deepEqual(rows.map(r => r.fakt), ['nur einer']);
  // Alte Bridges weg (CASCADE).
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM world_fact_chapters').get().n, 1);
});

test('saveFaktenToDb: kategorie auf Whitelist normalisiert (Whitelist behalten, Rest → sonstiges)', () => {
  setup();
  schema.saveFaktenToDb(BOOK, [{ kapitel: 'Kapitel 1', fakten: [
    { kategorie: 'figur',  fakt: 'bekannt' },          // Whitelist → bleibt
    { kategorie: ' ORT ',  fakt: 'trim+lowercase' },   // → 'ort'
    { kategorie: 'magie',  fakt: 'unbekannt' },         // nicht WL → 'sonstiges'
    { fakt: 'ohne kategorie' },                         // fehlt → 'sonstiges'
  ] }], USER, { 'Kapitel 1': 7001 });

  const rows = db.prepare('SELECT kategorie, fakt FROM world_facts WHERE book_id=? AND user_email=? ORDER BY sort_order').all(BOOK, USER);
  assert.deepEqual(rows.map(r => [r.fakt, r.kategorie]), [
    ['bekannt', 'figur'],
    ['trim+lowercase', 'ort'],
    ['unbekannt', 'sonstiges'],
    ['ohne kategorie', 'sonstiges'],
  ]);
});

test('saveFaktenToDb: leeres chapterFakten → 0 Rows', () => {
  setup();
  schema.saveFaktenToDb(BOOK, [], USER, {});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM world_facts WHERE book_id=? AND user_email=?').get(BOOK, USER).n, 0);
});
