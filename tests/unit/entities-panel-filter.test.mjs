// Unit-Tests fuer Entity-Linking-Panel-Selektoren.
//
// selectScenesForView / selectEventsForView teilen Eintraege in
//   - onPage: gleiche page_id
//   - inChapter: gleiche chapter_id UND page_id leer
// Sortierung deterministisch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { selectScenesForView, selectEventsForView, selectFigurenForPage } = await import('../../public/js/editor/notebook/entities.js');

// ── Szenen ─────────────────────────────────────────────────────────────────

test('selectScenesForView: leere Liste', () => {
  const out = selectScenesForView([], 1, 10);
  assert.deepEqual(out, { onPage: [], inChapter: [] });
});

test('selectScenesForView: trennt page-gebundene von kapitel-gebundenen Szenen', () => {
  const scenes = [
    { id: 1, page_id: 7, chapter_id: 10, titel: 'A', sort_order: 1 },
    { id: 2, page_id: 7, chapter_id: 10, titel: 'B', sort_order: 0 },
    { id: 3, page_id: null, chapter_id: 10, titel: 'C', sort_order: 0 },
    { id: 4, page_id: 8, chapter_id: 10, titel: 'D', sort_order: 0 },
    { id: 5, page_id: null, chapter_id: 11, titel: 'E', sort_order: 0 },
  ];
  const out = selectScenesForView(scenes, 7, 10);
  assert.deepEqual(out.onPage.map(s => s.id), [2, 1], 'onPage sortiert nach sort_order');
  assert.deepEqual(out.inChapter.map(s => s.id), [3], 'inChapter nur same chapter UND page_id leer');
});

test('selectScenesForView: page_id null/undefined → kein onPage', () => {
  const scenes = [{ id: 1, page_id: 5, chapter_id: 10, titel: 'A' }];
  const out = selectScenesForView(scenes, null, 10);
  assert.deepEqual(out.onPage, []);
});

test('selectScenesForView: chapter_id null → kein inChapter', () => {
  const scenes = [{ id: 1, page_id: null, chapter_id: 10, titel: 'A' }];
  const out = selectScenesForView(scenes, 5, null);
  assert.deepEqual(out.inChapter, []);
});

test('selectScenesForView: leere page_id-Werte als ungebunden behandeln', () => {
  const scenes = [
    { id: 1, page_id: '', chapter_id: 10, titel: 'A' },
    { id: 2, page_id: null, chapter_id: 10, titel: 'B' },
  ];
  const out = selectScenesForView(scenes, 5, 10);
  assert.equal(out.inChapter.length, 2);
});

// ── Ereignisse ─────────────────────────────────────────────────────────────

test('selectEventsForView: flatten + sort + figure-attach', () => {
  const figuren = [
    {
      id: 1, name: 'Anna', kurzname: 'A',
      lebensereignisse: [
        { datum: '1990-01-02', datum_year: 1990, datum_month: 1, datum_day: 2,
          ereignis: 'Geburt', page_id: 7, chapter_id: 10 },
        { datum: '2010-05-04', datum_year: 2010, datum_month: 5, datum_day: 4,
          ereignis: 'Reise', page_id: null, chapter_id: 10 },
      ],
    },
    {
      id: 2, name: 'Bob', kurzname: 'B',
      lebensereignisse: [
        { datum: '1985-12-12', datum_year: 1985, datum_month: 12, datum_day: 12,
          ereignis: 'Geburt', page_id: 7, chapter_id: 10 },
      ],
    },
  ];
  const out = selectEventsForView(figuren, 7, 10);
  assert.equal(out.onPage.length, 2);
  // Sortierung nach Datum-Komponenten — Bob (1985) vor Anna (1990).
  assert.equal(out.onPage[0].figure_name, 'Bob');
  assert.equal(out.onPage[1].figure_name, 'Anna');
  assert.equal(out.inChapter.length, 1);
  assert.equal(out.inChapter[0].ereignis, 'Reise');
  assert.equal(out.inChapter[0].figure_id, 1);
  assert.equal(out.inChapter[0].figure_kurzname, 'A');
});

test('selectEventsForView: Ereignis ohne page_id und ohne chapter_id wird ignoriert', () => {
  const figuren = [
    { id: 1, name: 'X', lebensereignisse: [
      { datum: 'irgendwann', ereignis: 'Loose', page_id: null, chapter_id: null },
    ]},
  ];
  const out = selectEventsForView(figuren, 5, 10);
  assert.equal(out.onPage.length, 0);
  assert.equal(out.inChapter.length, 0);
});

test('selectEventsForView: leere Figuren-Liste', () => {
  assert.deepEqual(selectEventsForView([], 1, 1), { onPage: [], inChapter: [] });
});

test('selectEventsForView: Fallback-Sort lexikographisch ueber datum-String wenn keine struct. Felder', () => {
  const figuren = [
    { id: 1, name: 'X', lebensereignisse: [
      { datum: '2020-06-01', ereignis: 'B', page_id: 1, chapter_id: 1 },
      { datum: '2020-01-15', ereignis: 'A', page_id: 1, chapter_id: 1 },
    ]},
  ];
  const out = selectEventsForView(figuren, 1, 1);
  assert.deepEqual(out.onPage.map(e => e.ereignis), ['A', 'B']);
});

// ── Figuren auf Seite ──────────────────────────────────────────────────────

test('selectFigurenForPage: matched Figuren nach Name (case-insensitiv, ganze Woerter)', () => {
  const figuren = [
    { id: 1, name: 'Anna' },
    { id: 2, name: 'Bob' },
    { id: 3, name: 'Carol' },
  ];
  const text = 'Heute trafen anna und Bob den Hund.';
  const out = selectFigurenForPage(figuren, text);
  assert.deepEqual(out.map(f => f.id), [1, 2]);
});

test('selectFigurenForPage: kein Teilstring-Match (Anna ≠ Annabelle)', () => {
  const figuren = [{ id: 1, name: 'Anna' }];
  const out = selectFigurenForPage(figuren, 'Annabelle ging spazieren.');
  assert.equal(out.length, 0);
});

test('selectFigurenForPage: leere Inputs', () => {
  assert.deepEqual(selectFigurenForPage([], 'Hallo'), []);
  assert.deepEqual(selectFigurenForPage([{ id: 1, name: 'A' }], ''), []);
  assert.deepEqual(selectFigurenForPage(null, 'Hallo'), []);
});

test('selectFigurenForPage: deterministisch nach name sortiert', () => {
  const figuren = [
    { id: 3, name: 'Zoe' },
    { id: 1, name: 'Anna' },
    { id: 2, name: 'Mike' },
  ];
  const out = selectFigurenForPage(figuren, 'Zoe, Anna und Mike sind hier.');
  assert.deepEqual(out.map(f => f.name), ['Anna', 'Mike', 'Zoe']);
});

test('selectFigurenForPage: Figur ohne id wird uebersprungen', () => {
  const figuren = [
    { id: null, name: 'NoId' },
    { id: 1, name: 'Anna' },
  ];
  const out = selectFigurenForPage(figuren, 'NoId und Anna kommen.');
  assert.deepEqual(out.map(f => f.id), [1]);
});
