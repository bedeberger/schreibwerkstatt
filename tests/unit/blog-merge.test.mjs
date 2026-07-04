// Unit tests for lib/blog-merge.js: die vier Last-Write-Wins-Faelle des Blog-Pulls.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { newer, classifyPull } = await import('../../lib/blog-merge.js');

test('newer: fehlendes a nie neuer', () => {
  assert.equal(newer('', '2024-01-01T00:00:00.000Z'), false);
  assert.equal(newer(null, '2024-01-01T00:00:00.000Z'), false);
});

test('newer: vorhandenes a, fehlendes b -> a neuer', () => {
  assert.equal(newer('2024-01-01T00:00:00.000Z', ''), true);
  assert.equal(newer('2024-01-01T00:00:00.000Z', null), true);
});

test('newer: lexikografischer ISO-Vergleich', () => {
  assert.equal(newer('2024-02-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'), true);
  assert.equal(newer('2024-01-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z'), false);
  assert.equal(newer('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'), false);
});

test('classifyPull: kein Link -> create', () => {
  assert.equal(classifyPull({ hasLink: false }), 'create');
});

test('classifyPull: WP neuer, App unveraendert -> update', () => {
  const action = classifyPull({
    hasLink: true,
    wpModifiedAt: '2024-03-01T00:00:00.000Z',
    linkModifiedAt: '2024-02-01T00:00:00.000Z',
    pageUpdatedAt: '2024-02-01T00:00:00.000Z',
    lastPulledAt: '2024-02-15T00:00:00.000Z',
  });
  assert.equal(action, 'update');
});

test('classifyPull: App neuer als letzter Pull, WP unveraendert -> skip (gehoert in Push)', () => {
  const action = classifyPull({
    hasLink: true,
    wpModifiedAt: '2024-02-01T00:00:00.000Z',
    linkModifiedAt: '2024-02-01T00:00:00.000Z',
    pageUpdatedAt: '2024-03-01T00:00:00.000Z',
    lastPulledAt: '2024-02-15T00:00:00.000Z',
  });
  assert.equal(action, 'skip');
});

test('classifyPull: beide Seiten neuer -> conflict', () => {
  const action = classifyPull({
    hasLink: true,
    wpModifiedAt: '2024-03-01T00:00:00.000Z',
    linkModifiedAt: '2024-02-01T00:00:00.000Z',
    pageUpdatedAt: '2024-03-05T00:00:00.000Z',
    lastPulledAt: '2024-02-15T00:00:00.000Z',
  });
  assert.equal(action, 'conflict');
});

test('classifyPull: beide unveraendert -> skip (no-op)', () => {
  const action = classifyPull({
    hasLink: true,
    wpModifiedAt: '2024-02-01T00:00:00.000Z',
    linkModifiedAt: '2024-02-01T00:00:00.000Z',
    pageUpdatedAt: '2024-02-01T00:00:00.000Z',
    lastPulledAt: '2024-02-15T00:00:00.000Z',
  });
  assert.equal(action, 'skip');
});
