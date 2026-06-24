// Unit-Tests für die pure vertikale Verankerung der Kommentar-Karten
// (comment-card-layout.js, SSoT von Bucheditor- + Share-Reader-Leiste). Reine
// Geometrie ohne DOM — die Messung (y/h) liefert der Aufrufer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveCardPositions } from '../../public/js/comment-card-layout.js';

test('leere/ungültige Eingabe → leeres Layout', () => {
  assert.deepEqual(resolveCardPositions({ items: [] }).bottom, 0);
  assert.deepEqual([...resolveCardPositions({ items: [] }).tops.entries()], []);
  assert.equal(resolveCardPositions({}).bottom, 0);
  assert.equal(resolveCardPositions().bottom, 0);
});

test('ohne Kollision bleiben Karten auf ihrer Anker-Höhe', () => {
  const { tops, bottom } = resolveCardPositions({
    items: [{ id: 'a', y: 0, h: 50 }, { id: 'b', y: 200, h: 50 }],
    gap: 10,
  });
  assert.equal(tops.get('a'), 0);
  assert.equal(tops.get('b'), 200);
  assert.equal(bottom, 250);
});

test('überlappende Karten werden greedy nach unten geschoben (mind. gap Abstand)', () => {
  const { tops } = resolveCardPositions({
    items: [{ id: 'a', y: 0, h: 50 }, { id: 'b', y: 20, h: 50 }, { id: 'c', y: 30, h: 50 }],
    gap: 10,
  });
  assert.equal(tops.get('a'), 0);
  assert.equal(tops.get('b'), 60);  // 0 + 50 + 10
  assert.equal(tops.get('c'), 120); // 60 + 50 + 10
});

test('Eingabe-Reihenfolge egal: Sortierung nach y', () => {
  const { tops } = resolveCardPositions({
    items: [{ id: 'c', y: 30, h: 50 }, { id: 'a', y: 0, h: 50 }, { id: 'b', y: 20, h: 50 }],
    gap: 10,
  });
  assert.equal(tops.get('a'), 0);
  assert.equal(tops.get('b'), 60);
  assert.equal(tops.get('c'), 120);
});

test('Pin: aktive Karte sitzt auf ihrer echten Höhe, Nachbarn weichen aus', () => {
  const { tops } = resolveCardPositions({
    items: [{ id: 'a', y: 100, h: 50 }, { id: 'b', y: 110, h: 50 }, { id: 'c', y: 120, h: 50 }],
    activeId: 'b',
    gap: 10,
  });
  assert.equal(tops.get('b'), 110);     // gepinnt auf Ankerhöhe
  assert.equal(tops.get('a'), 50);      // darüber: 110 - 10 - 50
  assert.equal(tops.get('c'), 170);     // darunter: 110 + 50 + 10
});

test('Pin oben mit zu wenig Platz darüber: Sweep klemmt überlappungsfrei ab 0', () => {
  // Pin will auf y=20, darüber zwei Karten à 50 → passen nicht über 20.
  const { tops, bottom } = resolveCardPositions({
    items: [{ id: 'a', y: 0, h: 50 }, { id: 'x', y: 5, h: 50 }, { id: 'p', y: 20, h: 50 }],
    activeId: 'p',
    gap: 10,
  });
  const sorted = [tops.get('a'), tops.get('x'), tops.get('p')].sort((m, n) => m - n);
  // Überlappungsfrei: jede Folge-Karte >= vorherige + Höhe + gap.
  assert.ok(sorted[0] >= 0);
  assert.ok(sorted[1] >= sorted[0] + 50 + 10);
  assert.ok(sorted[2] >= sorted[1] + 50 + 10);
  assert.equal(bottom, sorted[2] + 50);
});

test('nicht lokalisierbare Karten (y == null) hängen unten an', () => {
  const { tops, bottom } = resolveCardPositions({
    items: [{ id: 'a', y: 0, h: 50 }, { id: 'gone', y: null, h: 40 }],
    gap: 10,
  });
  assert.equal(tops.get('a'), 0);
  assert.equal(tops.get('gone'), 60); // unter a: 0 + 50 + 10
  assert.equal(bottom, 100);          // 60 + 40
});

test('Eingabe wird nicht mutiert', () => {
  const items = [{ id: 'a', y: 0, h: 50 }];
  resolveCardPositions({ items });
  assert.deepEqual(items, [{ id: 'a', y: 0, h: 50 }]);
});
