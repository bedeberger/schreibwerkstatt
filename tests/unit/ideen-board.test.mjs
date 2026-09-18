// Ideen-Board: die pure Gruppierung (Bahnen-Reihenfolge aus dem Baum, Zuordnung
// der Ideen in Bahn × Stufe, Filter).
//
// Gegenstand sind die Aussagen, die man der Anzeige nicht ansieht: dass keine
// Idee still verschwindet, dass der Kapitel-Filter auch Seiten-Ideen erfasst und
// dass die Zahl der ausgeblendeten stimmt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { buildLaneOrder, buildBoard, chapterFilterOptions, statusTotals, LANE_UNKNOWN } =
  await import(path.join(ROOT, 'public', 'js', 'book', 'ideen-board', 'model.js'));

// Baum wie ihn tree/build.js liefert: flach, depth-annotiert, Solo-Seiten als
// Pseudo-Kapitel.
const TREE = [
  { type: 'chapter', id: 'solo-90', solo: true, depth: 1, name: 'Vorwort', pages: [{ id: 90, name: 'Vorwort' }] },
  { type: 'chapter', id: 1, solo: false, depth: 1, name: 'Kapitel 1', pages: [{ id: 10, name: 'Seite A' }, { id: 11, name: 'Seite B' }] },
  { type: 'chapter', id: 2, solo: false, depth: 2, name: 'Kapitel 2', pages: [{ id: 20, name: 'Seite C' }] },
];

const idee = (id, over = {}) => ({
  id, content: `Idee ${id}`, status: 'offen',
  page_id: null, chapter_id: null, lane_chapter_id: null, links: [], ...over,
});

test('Bahnen: Reihenfolge kommt aus dem Baum, Kapitel vor seinen Seiten', () => {
  assert.deepEqual(buildLaneOrder(TREE).map(l => l.key), [
    'page:90',          // Solo-Seite: nur die Seiten-Bahn, kein Pseudo-Kapitel
    'chapter:1', 'page:10', 'page:11',
    'chapter:2', 'page:20',
  ]);
});

test('Bahnen: Solo-Seite bekommt KEINE Kapitel-Bahn', () => {
  const lanes = buildLaneOrder(TREE);
  assert.equal(lanes.some(l => l.key === 'chapter:solo-90'), false);
  assert.equal(lanes.find(l => l.key === 'page:90').chapterId, null);
});

test('Board: Ideen landen in ihrer Bahn und ihrer Stufen-Spalte', () => {
  const laneOrder = buildLaneOrder(TREE);
  const ideen = [
    idee(1, { chapter_id: 1, lane_chapter_id: 1, status: 'offen' }),
    idee(2, { page_id: 10, lane_chapter_id: 1, status: 'in_arbeit' }),
    idee(3, { page_id: 10, lane_chapter_id: 1, status: 'erledigt' }),
  ];
  const { lanes, total, visible } = buildBoard({ ideen, laneOrder });
  assert.equal(total, 3);
  assert.equal(visible, 3);
  assert.deepEqual(lanes.map(l => l.lane.key), ['chapter:1', 'page:10']);
  assert.deepEqual(lanes[0].columns.offen.map(i => i.id), [1]);
  assert.deepEqual(lanes[1].columns.in_arbeit.map(i => i.id), [2]);
  assert.deepEqual(lanes[1].columns.erledigt.map(i => i.id), [3]);
  assert.equal(lanes[1].count, 2);
});

test('Board: leere Seiten-Bahnen erscheinen nicht', () => {
  const { lanes } = buildBoard({
    ideen: [idee(1, { page_id: 20, lane_chapter_id: 2 })],
    laneOrder: buildLaneOrder(TREE),
  });
  // Die Kapitel-Bahn steht ohne eigene Ideen mit: sie ist die Ueberschrift und
  // der Griff, an dem das Kapitel zuklappt. Die uebrigen leeren Bahnen (Kapitel 1
  // samt Seiten, Vorwort) fehlen.
  assert.deepEqual(lanes.map(l => l.lane.key), ['chapter:2', 'page:20']);
  assert.equal(lanes[0].count, 0);
  assert.equal(lanes[0].childLanes, 1);
});

test('Board: ein Kapitel ohne Ideen irgendwo darunter erscheint nicht', () => {
  const { lanes } = buildBoard({
    ideen: [idee(1, { chapter_id: 1, lane_chapter_id: 1 })],
    laneOrder: buildLaneOrder(TREE),
  });
  assert.deepEqual(lanes.map(l => l.lane.key), ['chapter:1']);
});

test('Board: eine Idee, deren Bahn der Baum nicht kennt, faellt in die Sammelbahn', () => {
  // Der Fall ist real: Seite gerade angelegt, Baum noch nicht nachgezogen. Das
  // Board ist eine Pendenzenliste — still verschwinden darf dort nichts.
  const { lanes, visible } = buildBoard({
    ideen: [idee(7, { page_id: 999, lane_chapter_id: null })],
    laneOrder: buildLaneOrder(TREE),
  });
  assert.equal(visible, 1);
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].lane.key, LANE_UNKNOWN);
  assert.equal(lanes[0].lane.kind, 'unknown');
});

test('Board: die Sammelbahn steht zuletzt', () => {
  const { lanes } = buildBoard({
    ideen: [idee(7, { page_id: 999 }), idee(8, { chapter_id: 1, lane_chapter_id: 1 })],
    laneOrder: buildLaneOrder(TREE),
  });
  assert.deepEqual(lanes.map(l => l.lane.key), ['chapter:1', LANE_UNKNOWN]);
});

test('Filter: Kapitel-Filter erfasst auch die Ideen der SEITEN dieses Kapitels', () => {
  // Das ist der Grund fuer `lane_chapter_id`: nach `chapter_id` gefiltert faende
  // „Kapitel 1" nur die Ideen, die direkt am Kapitel haengen.
  const ideen = [
    idee(1, { chapter_id: 1, lane_chapter_id: 1 }),
    idee(2, { page_id: 10, lane_chapter_id: 1 }),
    idee(3, { page_id: 20, lane_chapter_id: 2 }),
  ];
  const board = buildBoard({ ideen, laneOrder: buildLaneOrder(TREE), filterChapterId: '1' });
  assert.equal(board.visible, 2);
  assert.equal(board.hiddenByFilter, 1);
  assert.deepEqual(board.lanes.map(l => l.lane.key), ['chapter:1', 'page:10']);
});

test('Filter: verworfene ausblenden zaehlt sie als ausgeblendet, nicht als weg', () => {
  const ideen = [
    idee(1, { page_id: 10, lane_chapter_id: 1, status: 'offen' }),
    idee(2, { page_id: 10, lane_chapter_id: 1, status: 'verworfen' }),
  ];
  const off = buildBoard({ ideen, laneOrder: buildLaneOrder(TREE), showVerworfen: false });
  assert.equal(off.total, 2);
  assert.equal(off.visible, 1);
  assert.equal(off.hiddenByFilter, 1);

  const on = buildBoard({ ideen, laneOrder: buildLaneOrder(TREE), showVerworfen: true });
  assert.equal(on.visible, 2);
  assert.equal(on.hiddenByFilter, 0);
});

test('Filter: Volltext trifft den Ideentext, ohne Gross-/Kleinschreibung', () => {
  const ideen = [
    idee(1, { page_id: 10, lane_chapter_id: 1, content: 'Beleg für die Zahl nachtragen' }),
    idee(2, { page_id: 10, lane_chapter_id: 1, content: 'Szene kürzen' }),
  ];
  const board = buildBoard({ ideen, laneOrder: buildLaneOrder(TREE), query: '  BELEG ' });
  assert.equal(board.visible, 1);
  assert.equal(board.hiddenByFilter, 1);
});

test('Filter: unbekannter Status faellt nicht aus dem Board', () => {
  const board = buildBoard({
    ideen: [idee(1, { page_id: 10, lane_chapter_id: 1, status: 'quatsch' })],
    laneOrder: buildLaneOrder(TREE),
  });
  assert.equal(board.visible, 1);
  const page = board.lanes.find(l => l.lane.key === 'page:10');
  assert.deepEqual(page.columns.offen.map(i => i.id), [1]);
});

test('Kapitel-Optionen: nur Kapitel mit Ideen, unabhaengig vom Status-Filter', () => {
  // Unabhaengig, weil die eigene Auswahl sonst unter der Hand verschwaende,
  // sobald man `verworfen` ausblendet.
  const ideen = [
    idee(1, { chapter_id: 1, lane_chapter_id: 1, status: 'verworfen' }),
    idee(2, { page_id: 20, lane_chapter_id: 2, status: 'offen' }),
  ];
  assert.deepEqual(chapterFilterOptions(ideen, buildLaneOrder(TREE)),
    [{ value: '1', label: 'Kapitel 1' }, { value: '2', label: 'Kapitel 2' }]);
});

test('Spalten-Zaehler messen den GESAMTEN Bestand, nicht die gefilterte Sicht', () => {
  // Sonst zeigte die Spalte „verworfen" beim Ausblenden eine 0 — das Gegenteil
  // der Wahrheit.
  const ideen = [
    idee(1, { page_id: 10, status: 'offen' }),
    idee(2, { page_id: 10, status: 'verworfen' }),
    idee(3, { page_id: 10, status: 'verworfen' }),
  ];
  assert.deepEqual(statusTotals(ideen), { offen: 1, in_arbeit: 0, erledigt: 0, verworfen: 2 });
});

test('Board: leerer Baum ergibt nur die Sammelbahn, keine Ausnahme', () => {
  const board = buildBoard({ ideen: [idee(1, { page_id: 10 })], laneOrder: [] });
  assert.equal(board.lanes.length, 1);
  assert.equal(board.lanes[0].lane.key, LANE_UNKNOWN);
});

// ── Klappen ────────────────────────────────────────────────────────────────
// Klappen ist Ansicht, kein Filter: es darf weder die Filterzahlen bewegen noch
// eine Pendenz spurlos schlucken. Genau das steht hier.

test('Klappen: ein zugeklapptes Kapitel faltet seine Seiten-Bahnen in die Kapitelzeile', () => {
  const ideen = [
    idee(1, { chapter_id: 1, lane_chapter_id: 1, status: 'offen' }),
    idee(2, { page_id: 10, lane_chapter_id: 1, status: 'in_arbeit' }),
    idee(3, { page_id: 11, lane_chapter_id: 1, status: 'in_arbeit' }),
  ];
  const board = buildBoard({
    ideen, laneOrder: buildLaneOrder(TREE), collapsedChapters: ['chapter:1'],
  });
  assert.deepEqual(board.lanes.map(l => l.lane.key), ['chapter:1']);
  const row = board.lanes[0];
  assert.equal(row.childCollapsed, true);
  assert.equal(row.childLanes, 2);
  assert.equal(row.foldedCount, 2);
  assert.equal(row.folded.in_arbeit, 2);
  // Die eigenen Karten des Kapitels bleiben sichtbar — gefaltet sind die Seiten.
  assert.deepEqual(row.columns.offen.map(i => i.id), [1]);
  assert.equal(row.hidden.in_arbeit, 2);
  assert.equal(row.hidden.offen, 0);
});

test('Klappen: eine zugeklappte Bahn behaelt ihre Zeile und nennt die Zahl', () => {
  const ideen = [
    idee(1, { page_id: 10, lane_chapter_id: 1, status: 'offen' }),
    idee(2, { page_id: 10, lane_chapter_id: 1, status: 'erledigt' }),
  ];
  const board = buildBoard({
    ideen, laneOrder: buildLaneOrder(TREE), collapsedLanes: ['page:10'],
  });
  const row = board.lanes.find(l => l.lane.key === 'page:10');
  assert.equal(row.collapsed, true);
  assert.equal(row.count, 2);
  assert.equal(row.hidden.offen, 1);
  assert.equal(row.hidden.erledigt, 1);
  // Die Karten bleiben im Modell — die Anzeige entscheidet, ob sie rendert.
  assert.deepEqual(row.columns.offen.map(i => i.id), [1]);
});

test('Klappen: bewegt die Filterzahlen NICHT', () => {
  // Eingeklappt ist nicht ausgefiltert. Liefe das zusammen, behauptete die
  // Filterleiste, sie verstecke etwas, das sie nicht meint.
  const ideen = [
    idee(1, { chapter_id: 1, lane_chapter_id: 1 }),
    idee(2, { page_id: 10, lane_chapter_id: 1 }),
  ];
  const laneOrder = buildLaneOrder(TREE);
  const open = buildBoard({ ideen, laneOrder });
  const folded = buildBoard({ ideen, laneOrder, collapsedChapters: ['chapter:1'], collapsedLanes: ['chapter:1'] });
  assert.deepEqual(
    [folded.total, folded.visible, folded.hiddenByFilter],
    [open.total, open.visible, open.hiddenByFilter],
  );
});

test('Klappen: ein Kapitel ohne eigene Ideen bleibt als Griff stehen, wenn es gefaltet ist', () => {
  // Sonst waere das Kapitel nach dem Zuklappen weg — samt der Moeglichkeit, es
  // wieder aufzuklappen.
  const board = buildBoard({
    ideen: [idee(1, { page_id: 20, lane_chapter_id: 2 })],
    laneOrder: buildLaneOrder(TREE),
    collapsedChapters: ['chapter:2'],
  });
  assert.deepEqual(board.lanes.map(l => l.lane.key), ['chapter:2']);
  assert.equal(board.lanes[0].foldedCount, 1);
  assert.equal(board.lanes[0].hidden.offen, 1);
});

test('Klappen: die Sammelbahn laesst sich einklappen', () => {
  const board = buildBoard({
    ideen: [idee(7, { page_id: 999 })],
    laneOrder: buildLaneOrder(TREE),
    collapsedLanes: [LANE_UNKNOWN],
  });
  assert.equal(board.lanes[0].collapsed, true);
  assert.equal(board.lanes[0].hidden.offen, 1);
});
