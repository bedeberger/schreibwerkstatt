// Reine Rechenkerne des Kapitel-Dashboards (Karte „Kapitel-Bewertung").
// Kein Alpine, kein DOM — die Alpine-Methoden sind nur memoisierte Huellen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeUmfang, computeLektorat, topTypen, computeEntityRanking,
  computeSzenen, computeLektoratSeconds, WORDS_PER_MINUTE,
} from '../../public/js/cards/kapitel-dashboard.js';

const PAGES = [
  { id: 1, name: 'Eins' },
  { id: 2, name: 'Zwei' },
  { id: 3, name: 'Drei' },
];
const TOK = {
  1: { chars: 3000, words: 500, tok: 750 },
  2: { chars: 1000, words: 160, tok: 250 },
  3: { chars: 6000, words: 990, tok: 1500 },
};

test('computeUmfang summiert und leitet Normseiten, Anteil und Lesezeit ab', () => {
  const u = computeUmfang(PAGES, TOK, 50000);
  assert.equal(u.pages, 3);
  assert.equal(u.chars, 10000);
  assert.equal(u.words, 1650);
  assert.equal(u.tok, 2500);
  assert.equal(u.normseiten, 6.7);
  assert.equal(u.avgChars, 3333);
  assert.equal(u.sharePct, 20);
  assert.equal(u.minutes, Math.round(1650 / WORDS_PER_MINUTE));
  assert.equal(u.longest.name, 'Drei');
  assert.equal(u.shortest.name, 'Zwei');
  // Der Sprung in den Editor braucht das Original-Seitenobjekt, nicht nur die ID.
  assert.equal(u.longest.page, PAGES[2]);
});

test('computeUmfang: unbekannter Buchumfang liefert keinen Anteil von null', () => {
  assert.equal(computeUmfang(PAGES, TOK, 0).sharePct, null);
  // Seite ohne Stats-Eintrag zaehlt beim Seiten-Count mit, beim Umfang nicht.
  const u = computeUmfang([...PAGES, { id: 9, name: 'Neu' }], TOK, 50000);
  assert.equal(u.pages, 4);
  assert.equal(u.chars, 10000);
});

test('computeUmfang ohne Seiten bleibt bei Nullen statt NaN', () => {
  const u = computeUmfang([], {}, 1000);
  assert.deepEqual(
    [u.pages, u.chars, u.avgChars, u.minutes, u.longest, u.shortest],
    [0, 0, 0, 0, null, null],
  );
  assert.equal(u.sharePct, 0);
});

const HEAT = {
  chapters: [
    { chapter_id: 7, pages_total: 3, pages_checked: 2, words: 1650, words_checked: 1490 },
    { chapter_id: 8, pages_total: 2, pages_checked: 2, words: 1000, words_checked: 1000 },
  ],
  matrix: {
    7: { fuellwort: { count: 4 }, passiv: { count: 2 } },
    8: { fuellwort: { count: 10 } },
  },
  details: {
    '7:fuellwort': [{ page_id: 1, count: 3 }, { page_id: 3, count: 1 }],
    '7:passiv':    [{ page_id: 1, count: 2 }],
    '8:fuellwort': [{ page_id: 5, count: 10 }],
  },
};

test('computeLektorat verdichtet nur die Kapitel im Scope', () => {
  const l = computeLektorat(HEAT, new Set(['7']));
  assert.equal(l.pagesTotal, 3);
  assert.equal(l.pagesChecked, 2);
  assert.equal(l.pct, 67);
  assert.equal(l.findings, 6);
  // Dichte gegen die GEPRUEFTEN Woerter (1490), nicht gegen alle (1650).
  assert.equal(l.per1k, 4);
  assert.deepEqual(l.typen, [{ typ: 'fuellwort', count: 4 }, { typ: 'passiv', count: 2 }]);
  // Befunde pro Seite ueber alle Typen summiert; fremdes Kapitel bleibt draussen.
  assert.equal(l.byPage.get(1), 5);
  assert.equal(l.byPage.get(3), 1);
  assert.equal(l.byPage.has(5), false);
});

test('computeLektorat ohne ids rechnet ueber das ganze Buch', () => {
  const l = computeLektorat(HEAT, null);
  assert.equal(l.findings, 16);
  assert.equal(l.pagesTotal, 5);
  assert.equal(l.per1k, 6.4);
});

test('computeLektorat: ohne Heatmap null, ohne geprueften Text keine Dichte', () => {
  assert.equal(computeLektorat(null, new Set(['7'])), null);
  const leer = computeLektorat({
    chapters: [{ chapter_id: 7, pages_total: 3, pages_checked: 0, words: 1650, words_checked: 0 }],
    matrix: {}, details: {},
  }, new Set(['7']));
  assert.equal(leer.pct, 0);
  assert.equal(leer.findings, 0);
  // Unbekannt, nicht null: ungeprueft ist nicht fehlerfrei.
  assert.equal(leer.per1k, null);
});

test('topTypen skaliert die Balken auf den haeufigsten Typ', () => {
  const rows = topTypen(computeLektorat(HEAT, new Set(['7', '8'])), 2);
  assert.deepEqual(rows.map(r => [r.typ, r.count, r.pct]), [
    ['fuellwort', 14, 100],
    ['passiv', 2, 14],
  ]);
  assert.deepEqual(topTypen(null), []);
});

const FIGUREN = [
  { id: 'f1', name: 'Anna Meier', kurzname: 'Anna', typ: 'hauptfigur',
    kapitel: [{ chapter_id: 7, haeufigkeit: 9 }, { chapter_id: 9, haeufigkeit: 40 }] },
  { id: 'f2', name: 'Bruno Zaugg', kapitel: [{ chapter_id: 7, haeufigkeit: 3 }] },
  { id: 'f3', name: 'Clara Roth', kapitel: [{ chapter_id: 9, haeufigkeit: 2 }] },
  { id: 'f4', name: 'Ohne Kapitel', kapitel: [] },
];

test('computeEntityRanking zaehlt nur die Auftritte im Scope', () => {
  const r = computeEntityRanking(FIGUREN, new Set(['7']), { limit: 5 });
  assert.equal(r.total, 2);
  assert.deepEqual(r.rows.map(x => [x.id, x.count, x.pct]), [['f1', 9, 100], ['f2', 3, 33]]);
  // Kurzname fuers Label, voller Name fuer den Tooltip.
  assert.equal(r.rows[0].name, 'Anna');
  assert.equal(r.rows[0].fullName, 'Anna Meier');
  assert.equal(r.rows[1].name, 'Bruno Zaugg');
});

test('computeEntityRanking deckelt die Liste und meldet die Gesamtzahl', () => {
  const r = computeEntityRanking(FIGUREN, new Set(['7', '9']), { limit: 1 });
  assert.equal(r.total, 3);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].count, 49);
});

test('computeEntityRanking haengt die Szenenzahl als Zweitwert an', () => {
  const r = computeEntityRanking(FIGUREN, new Set(['7']),
    { limit: 5, extraCounts: new Map([['f1', 4]]) });
  assert.equal(r.rows[0].extra, 4);
  assert.equal(r.rows[1].extra, 0);
});

const SZENEN = [
  { id: 1, chapter_id: 7, titel: 'Ankunft',  wertung: 'stark',   fig_ids: ['f1', 'f2'] },
  { id: 2, chapter_id: 7, titel: 'Streit',   wertung: 'schwach', fig_ids: ['f1'] },
  { id: 3, chapter_id: 7, titel: 'Weg',      wertung: null,      fig_ids: [] },
  { id: 4, chapter_id: 7, titel: 'Entfallen', wertung: 'stark',  fig_ids: ['f1'], stale: 1 },
  { id: 5, chapter_id: 9, titel: 'Fremd',    wertung: 'stark',   fig_ids: ['f3'] },
];

test('computeSzenen zaehlt Wertungen und Figuren, stale bleibt draussen', () => {
  const s = computeSzenen(SZENEN, new Set(['7']));
  assert.equal(s.total, 3);
  assert.deepEqual(s.wertung, { stark: 1, mittel: 0, schwach: 1, ohne: 1 });
  assert.equal(s.figCounts.get('f1'), 2);
  assert.equal(s.figCounts.get('f2'), 1);
  assert.equal(s.figCounts.has('f3'), false);
  assert.deepEqual(s.list.map(x => x.id), [1, 2, 3]);
});

test('computeLektoratSeconds summiert nur die Kapitel im Scope', () => {
  const lt = { per_chapter: [
    { chapter_id: 7, seconds: 600 },
    { chapter_id: 8, seconds: 120 },
    { chapter_id: null, seconds: 999 },
  ] };
  assert.equal(computeLektoratSeconds(lt, new Set(['7', '8'])), 720);
  assert.equal(computeLektoratSeconds(lt, new Set(['7'])), 600);
  assert.equal(computeLektoratSeconds(null, new Set(['7'])), 0);
});
