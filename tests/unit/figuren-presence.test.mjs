// Unit-Tests für die Figuren-Präsenz-Aggregation (pure, ohne Alpine).
// Deckt Matrix-Aufbau, Screen-Time, Auftritt/Abgang, interne Abwesenheits-Lücke,
// Wendepunkt-Verankerung und die Befund-Heuristiken ab.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { computePresence, computeFindings } = await import('../../public/js/book/figuren-presence.js');

// 6 Kapitel in Lese-Reihenfolge.
const CH = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'];

function fig(id, typ, kapitel, extra = {}) {
  return { id, name: id, typ, stale: false, kapitel, lebensereignisse: [], arc: null, ...extra };
}
// Auftritt-Helper: Kapitelname → {chapter_id, name, haeufigkeit}. chapter_id = Index+1.
function k(name, hae = 1) { return { chapter_id: CH.indexOf(name) + 1, name, haeufigkeit: hae }; }

test('Matrix: haeufigkeit, total, first/last-Index', () => {
  const data = computePresence([fig('A', 'hauptfigur', [k('K1', 2), k('K3', 1), k('K6', 3)])], CH);
  const row = data.rows[0];
  assert.deepEqual(row.haeByCol, [2, 0, 1, 0, 0, 3]);
  assert.equal(row.total, 6);
  assert.equal(row.firstIdx, 0);
  assert.equal(row.lastIdx, 5);
  assert.equal(data.maxCell, 3);
});

test('Interne Abwesenheits-Lücke = längster Null-Lauf zwischen erstem und letztem Auftritt', () => {
  const data = computePresence([fig('A', 'hauptfigur', [k('K1'), k('K5')])], CH);
  const row = data.rows[0];
  // K2,K3,K4 = 3 Kapitel Lücke; K6 zählt nicht (nach letztem Auftritt).
  assert.equal(row.maxGap.len, 3);
  assert.equal(CH[row.maxGap.fromIdx], 'K2');
  assert.equal(CH[row.maxGap.toIdx], 'K4');
});

test('stale-Figuren + Figuren ohne Auftritt fallen raus', () => {
  const data = computePresence([
    fig('A', 'hauptfigur', [k('K1')]),
    fig('S', 'nebenfigur', [k('K2')], { stale: true }),
    fig('Z', 'randfigur', []),
  ], CH);
  assert.deepEqual(data.rows.map(r => r.id), ['A']);
});

test('Zeilen-Sortierung: Typ-Tier, dann Gesamtpräsenz absteigend', () => {
  const data = computePresence([
    fig('Neben', 'nebenfigur', [k('K1', 9)]),
    fig('HauptKlein', 'hauptfigur', [k('K1', 1)]),
    fig('HauptGross', 'hauptfigur', [k('K1', 5)]),
  ], CH);
  assert.deepEqual(data.rows.map(r => r.id), ['HauptGross', 'HauptKlein', 'Neben']);
});

test('Wendepunkt-Events werden per chapter_id auf Spalten gemappt', () => {
  const a = fig('A', 'hauptfigur', [k('K1'), k('K4')], {
    lebensereignisse: [
      { subtyp: 'wendepunkt', chapter_id: 4 },   // → Spalte 3
      { subtyp: 'geburt', chapter_id: 1 },        // kein Wendepunkt
      { subtyp: 'wendepunkt', chapter_id: null }, // ohne Kapitel → ignoriert
    ],
  });
  const row = computePresence([a], CH).rows[0];
  assert.ok(row.wpCols.has(3));
  assert.equal(row.wpCols.size, 1);
  assert.equal(row.wendepunktCount, 1);
});

test('Befund gap: Hauptfigur mit langer Lücke, Nebenfigur nicht', () => {
  const data = computePresence([
    fig('Haupt', 'hauptfigur', [k('K1'), k('K6')]),   // 4 Kapitel Lücke
    fig('Neben', 'nebenfigur', [k('K1'), k('K6')]),   // gleiche Lücke, aber kein Core-Typ
  ], CH);
  const gaps = data.findings.filter(f => f.kind === 'gap');
  assert.deepEqual(gaps.map(f => f.figName), ['Haupt']);
  assert.equal(gaps[0].len, 4);
});

test('Befund lateEntrance / earlyExit für Core-Typen', () => {
  const late = computePresence([fig('A', 'hauptfigur', [k('K5'), k('K6')])], CH).findings;
  assert.ok(late.some(f => f.kind === 'lateEntrance' && f.chapter === 'K5'));
  const early = computePresence([fig('B', 'antagonist', [k('K1'), k('K2')])], CH).findings;
  assert.ok(early.some(f => f.kind === 'earlyExit' && f.chapter === 'K2'));
});

test('Befund flatArc: Hauptfigur ohne deklarierte UND belegte Wendepunkte', () => {
  const flat = computePresence([fig('A', 'hauptfigur', [k('K1'), k('K2'), k('K3')])], CH).findings;
  assert.ok(flat.some(f => f.kind === 'flatArc'));
  // Mit deklariertem Wendepunkt → kein flatArc.
  const withArc = computePresence([
    fig('B', 'hauptfigur', [k('K1'), k('K2'), k('K3')], { arc: { wendepunkte: ['Krise'] } }),
  ], CH).findings;
  assert.ok(!withArc.some(f => f.kind === 'flatArc'));
});

test('Befund coPresenceGap: Haupt- und Antagonist teilen kein Kapitel', () => {
  const data = computePresence([
    fig('Held', 'hauptfigur', [k('K1'), k('K2')]),
    fig('Böse', 'antagonist', [k('K5'), k('K6')]),
  ], CH);
  const co = data.findings.filter(f => f.kind === 'coPresenceGap');
  assert.equal(co.length, 1);
  assert.equal(co[0].figName, 'Held');
  assert.equal(co[0].otherName, 'Böse');
  // Teilen sie ein Kapitel → kein Befund.
  const shared = computePresence([
    fig('Held', 'hauptfigur', [k('K1'), k('K3')]),
    fig('Böse', 'antagonist', [k('K3'), k('K6')]),
  ], CH).findings.filter(f => f.kind === 'coPresenceGap');
  assert.equal(shared.length, 0);
});

test('computeFindings ist ohne Auftrittsdaten leer (leere Kapitelachse)', () => {
  assert.deepEqual(computeFindings([], []), []);
});
