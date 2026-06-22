// Unit-Tests für die Thread-Gruppierung der Kommentar-Leiste (Leseansicht).
// Pure Logik ohne Browser/DOM — die Anker-/Seiten-Filterung (locateRange) ist
// DOM-gebunden und wird im Smoke/E2E geprüft.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupThreads } from '../../public/js/editor/comment-threads.js';

const rows = [
  { id: 1, parent_id: null, body: 'A', created_at: '2026-01-01T10:00:00Z', anchor_bid: 'aa11bb22' },
  { id: 2, parent_id: 1,    body: 'A-reply-2', created_at: '2026-01-01T12:00:00Z', author_email: 'me@x' },
  { id: 3, parent_id: 1,    body: 'A-reply-1', created_at: '2026-01-01T11:00:00Z' },
  { id: 4, parent_id: null, body: 'B', created_at: '2026-01-02T10:00:00Z', anchor_bid: null },
];

test('groupThreads: nur Roots werden zu Threads, Antworten hängen am Root', () => {
  const threads = groupThreads(rows);
  assert.equal(threads.length, 2);
  assert.deepEqual(threads.map(t => t.root.id), [1, 4]);
});

test('groupThreads: Antworten chronologisch aufsteigend sortiert', () => {
  const threads = groupThreads(rows);
  const a = threads.find(t => t.root.id === 1);
  assert.deepEqual(a.replies.map(r => r.id), [3, 2]); // 11:00 vor 12:00
});

test('groupThreads: Root ohne Antworten hat leeres replies-Array', () => {
  const threads = groupThreads(rows);
  const b = threads.find(t => t.root.id === 4);
  assert.deepEqual(b.replies, []);
});

test('groupThreads: Root-Reihenfolge bleibt wie geliefert (Aufrufer sortiert on-page)', () => {
  const reversed = [...rows].reverse();
  const threads = groupThreads(reversed);
  assert.deepEqual(threads.map(t => t.root.id), [4, 1]);
});

test('groupThreads: leere/ungültige Eingabe → leeres Array', () => {
  assert.deepEqual(groupThreads([]), []);
  assert.deepEqual(groupThreads(null), []);
  assert.deepEqual(groupThreads(undefined), []);
});

test('groupThreads: verwaiste Antwort (Root nicht vorhanden) erzeugt keinen Thread', () => {
  const orphan = [{ id: 9, parent_id: 999, body: 'x', created_at: '2026-01-01T10:00:00Z' }];
  assert.deepEqual(groupThreads(orphan), []);
});
