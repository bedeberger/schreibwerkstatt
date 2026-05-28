// Unit-Tests für den Filter der Ereignisse-Karte
// (`applyEreignisseFilters` aus public/js/cards/ereignisse-card.js).
//
// Filter kombinieren `suche`, `figurId`, `subtyp`, `kapitel`, `seite`. Seiten-
// Filter greift nur in Kombination mit Kapitel (sonst „alle Seiten dieses Buchs"
// → unsinnig). Subtyp-Default ist 'sonstiges' (Events ohne `subtyp`-Feld matchen
// also nur, wenn als 'sonstiges' gefiltert wird). Mapping Subtyp → Lucide-Icon
// wird ebenfalls hier getestet (`subtypIcon`).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { applyEreignisseFilters, subtypIcon } = await import('../../public/js/cards/ereignisse-card.js');

const EVENTS = [
  {
    id: 1, ereignis: 'Hochzeit auf dem Hügel', subtyp: 'hochzeit',
    figuren: [{ id: 'fA' }, { id: 'fB' }],
    kapitel: ['Kapitel 1'], seiten: ['1', '2'],
  },
  {
    id: 2, ereignis: 'Tod des Vaters', subtyp: 'tod',
    figuren: [{ id: 'fA' }],
    kapitel: 'Kapitel 1', seite: '3',
  },
  {
    id: 3, ereignis: 'Reise nach Norden', subtyp: 'reise',
    figuren: [{ id: 'fB' }, { id: 'fC' }],
    kapitel: ['Kapitel 2'], seiten: ['10'],
  },
  {
    id: 4, ereignis: 'Anonymer Vorfall', /* kein subtyp */
    figuren: [],
    kapitel: ['Kapitel 2'], seiten: ['11'],
  },
];

// ── kein Filter ─────────────────────────────────────────────────────────────

test('ohne Filter: alle Events durchgereicht', () => {
  const out = applyEreignisseFilters(EVENTS, {});
  assert.equal(out.length, 4);
});

test('kein Crash bei undefiniertem events-Argument', () => {
  assert.deepEqual(applyEreignisseFilters(undefined, {}), []);
  assert.deepEqual(applyEreignisseFilters(null, { suche: 'x' }), []);
});

// ── Such-Filter ─────────────────────────────────────────────────────────────

test('Such-Filter matcht ereignis case-insensitive', () => {
  const out = applyEreignisseFilters(EVENTS, { suche: 'HOCHZEIT' });
  assert.deepEqual(out.map(e => e.id), [1]);
});

test('Such-Filter matcht Teilstring', () => {
  const out = applyEreignisseFilters(EVENTS, { suche: 'reise' });
  assert.deepEqual(out.map(e => e.id), [3]);
});

test('Such-Filter ohne Match → leer', () => {
  const out = applyEreignisseFilters(EVENTS, { suche: 'xxxxxx' });
  assert.equal(out.length, 0);
});

// ── Figur-Filter ────────────────────────────────────────────────────────────

test('Figur-Filter matcht über figuren[].id', () => {
  const out = applyEreignisseFilters(EVENTS, { figurId: 'fA' });
  assert.deepEqual(out.map(e => e.id).sort(), [1, 2]);
});

test('Figur-Filter ignoriert Events ohne figuren-Array', () => {
  const out = applyEreignisseFilters(EVENTS, { figurId: 'fX' });
  assert.equal(out.length, 0);
});

// ── Subtyp-Filter ───────────────────────────────────────────────────────────

test('Subtyp-Filter: exakter Match', () => {
  const out = applyEreignisseFilters(EVENTS, { subtyp: 'tod' });
  assert.deepEqual(out.map(e => e.id), [2]);
});

test("Subtyp-Filter 'sonstiges' matcht Events ohne subtyp-Feld", () => {
  const out = applyEreignisseFilters(EVENTS, { subtyp: 'sonstiges' });
  assert.deepEqual(out.map(e => e.id), [4]);
});

test('Subtyp-Filter ohne Match → leer', () => {
  const out = applyEreignisseFilters(EVENTS, { subtyp: 'geburt' });
  assert.equal(out.length, 0);
});

// ── Kapitel-Filter (Multi-Kapitel Array + Legacy-String) ───────────────────

test('Kapitel-Filter matcht Array-Form', () => {
  const out = applyEreignisseFilters(EVENTS, { kapitel: 'Kapitel 2' });
  assert.deepEqual(out.map(e => e.id).sort(), [3, 4]);
});

test('Kapitel-Filter matcht auch String-Form (Legacy)', () => {
  const out = applyEreignisseFilters(EVENTS, { kapitel: 'Kapitel 1' });
  assert.deepEqual(out.map(e => e.id).sort(), [1, 2]);
});

// ── Seiten-Filter (nur gemeinsam mit Kapitel) ──────────────────────────────

test('Seiten-Filter greift nur in Kombination mit Kapitel', () => {
  const ohneKapitel = applyEreignisseFilters(EVENTS, { seite: '1' });
  assert.equal(ohneKapitel.length, 4, 'ohne kapitel: seite ignoriert');
  const mitKapitel = applyEreignisseFilters(EVENTS, { kapitel: 'Kapitel 1', seite: '1' });
  assert.deepEqual(mitKapitel.map(e => e.id), [1]);
});

test('Seiten-Filter Array vs. String', () => {
  const arr = applyEreignisseFilters(EVENTS, { kapitel: 'Kapitel 1', seite: '2' });
  assert.deepEqual(arr.map(e => e.id), [1]); // seiten: ['1','2']
  const str = applyEreignisseFilters(EVENTS, { kapitel: 'Kapitel 1', seite: '3' });
  assert.deepEqual(str.map(e => e.id), [2]); // seite: '3'
});

// ── Kombination ─────────────────────────────────────────────────────────────

test('Kombi: Subtyp + Figur', () => {
  const out = applyEreignisseFilters(EVENTS, { subtyp: 'hochzeit', figurId: 'fA' });
  assert.deepEqual(out.map(e => e.id), [1]);
});

test('Kombi: Subtyp + Kapitel + Such-Filter', () => {
  const out = applyEreignisseFilters(EVENTS, {
    subtyp: 'reise',
    kapitel: 'Kapitel 2',
    suche: 'norden',
  });
  assert.deepEqual(out.map(e => e.id), [3]);
});

// ── subtypIcon-Mapping ─────────────────────────────────────────────────────

test('subtypIcon: vollständige Whitelist auf Lucide-IDs gemappt', () => {
  const map = {
    geburt:           'baby',
    tod:              'skull',
    hochzeit:         'heart',
    reise:            'plane',
    konflikt:         'swords',
    wendepunkt:       'git-fork',
    entdeckung:       'compass',
    verlust:          'heart-crack',
    sieg:             'trophy',
    extern_politisch: 'landmark',
    extern_natur:     'mountain',
    extern_kulturell: 'book-open',
    sonstiges:        'more-horizontal',
  };
  for (const [subtyp, icon] of Object.entries(map)) {
    assert.equal(subtypIcon(subtyp), icon, `${subtyp} → ${icon}`);
  }
});

test('subtypIcon: unbekannter Subtyp → sonstiges-Fallback', () => {
  assert.equal(subtypIcon('schwurbel'),  'more-horizontal');
  assert.equal(subtypIcon(undefined),    'more-horizontal');
  assert.equal(subtypIcon(null),         'more-horizontal');
  assert.equal(subtypIcon(''),           'more-horizontal');
});
