// Unit tests fuer lib/blog-title.js: die Titel-Regeln beider Blog-Syncs.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const {
  splitDatePrefix, outgoingTitle, wpTitleText, importedPageName, planPulledTitle,
} = await import('../../lib/blog-title.js');

test('splitDatePrefix: mit und ohne Praefix', () => {
  assert.deepEqual(splitDatePrefix('2025-01-02: Titel: mit Doppelpunkt'), { date: '2025-01-02', rest: 'Titel: mit Doppelpunkt' });
  assert.deepEqual(splitDatePrefix('2025-01-02'), { date: '2025-01-02', rest: '' });
  assert.deepEqual(splitDatePrefix('  Nur Titel '), { date: null, rest: 'Nur Titel' });
});

test('outgoingTitle: Werkstatt-Titel gewinnt, sonst Seitenname ohne Datum', () => {
  assert.equal(outgoingTitle('2025-01-02: Arbeitstitel', { titel: ' Schlagzeile ' }), 'Schlagzeile');
  assert.equal(outgoingTitle('2025-01-02: Arbeitstitel', null), 'Arbeitstitel');
  assert.equal(outgoingTitle('2025-01-02', { titel: '' }), '');
});

test('wpTitleText: raw bevorzugt, rendered dekodiert', () => {
  assert.equal(wpTitleText({ raw: 'A & B', rendered: 'A &amp; B' }), 'A & B');
  assert.equal(wpTitleText({ rendered: 'Kafka&#8217;s &amp; Co &#8211; <em>neu</em>' }), 'Kafka’s & Co – neu');
  assert.equal(wpTitleText(null), '');
});

test('importedPageName: Datum aus dem Post, Fallback ohne Titel', () => {
  assert.equal(importedPageName('Titel', '2025-03-04T10:00:00'), '2025-03-04: Titel');
  assert.equal(importedPageName('Titel', ''), 'Titel');
  assert.equal(importedPageName('', '2025-03-04', 'slug'), '2025-03-04: slug');
});

test('planPulledTitle: ohne Werkstatt → Seitenname, lokaler Datums-Praefix bleibt', () => {
  assert.deepEqual(
    planPulledTitle({ currentName: '2026-01-01: Alt', hl: null, remoteTitle: 'Neu', postDay: '2026-02-02' }),
    { headlinePatch: {}, name: '2026-01-01: Neu' },
  );
  assert.deepEqual(
    planPulledTitle({ currentName: 'Alt', hl: null, remoteTitle: 'Neu', postDay: '2026-02-02' }),
    { headlinePatch: {}, name: '2026-02-02: Neu' },
  );
  // unveraendert → kein Rename
  assert.deepEqual(
    planPulledTitle({ currentName: '2026-01-01: Gleich', hl: null, remoteTitle: 'Gleich', postDay: '2026-02-02' }),
    { headlinePatch: {} },
  );
});

test('planPulledTitle: mit Werkstatt-Titel → Werkstatt, Seitenname bleibt', () => {
  assert.deepEqual(
    planPulledTitle({ currentName: '2026-01-01: Arbeit', hl: { titel: 'Schlagzeile' }, remoteTitle: 'In WP geaendert' }),
    { headlinePatch: { titel: 'In WP geaendert' } },
  );
  assert.deepEqual(
    planPulledTitle({ currentName: 'x', hl: { titel: 'Gleich' }, remoteTitle: 'Gleich' }),
    { headlinePatch: {} },
  );
});

test('planPulledTitle: leerer Remote-Titel aendert nichts', () => {
  assert.deepEqual(planPulledTitle({ currentName: 'A', hl: null, remoteTitle: '  ' }), { headlinePatch: {} });
});
