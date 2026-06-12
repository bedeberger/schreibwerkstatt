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

const { applyEreignisseFilters, subtypIcon, buildTimelineItems, timelineBounds } = await import('../../public/js/cards/ereignisse-card.js');

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

// --- vis-timeline-Items (Jahres-Zeitstrahl) ---

test('buildTimelineItems: nur datierte Events landen auf der Achse, id = Listen-Index', () => {
  const items = buildTimelineItems([
    { datum_year: 1990, ereignis: 'A' },   // 0 → Punkt
    { story_tag: 'Tag 3', ereignis: 'B' }, // 1 → übersprungen (kein Jahr)
    {},                                     // 2 → übersprungen
    { datum_year: 1995, ereignis: 'C' },   // 3 → Punkt
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(i => i.id), [0, 3]);
  assert.equal(items[0].type, 'point');
  assert.equal(items[0].content, 'A');
  assert.equal(items[0].start.getFullYear(), 1990);
});

test('buildTimelineItems: Spanne mit Ende-Jahr → Range-Item', () => {
  const [item] = buildTimelineItems([
    { datum_year: 1980, datum_ende_year: 1985, ereignis: 'Krieg' },
  ]);
  assert.equal(item.type, 'range');
  assert.equal(item.start.getFullYear(), 1980);
  assert.equal(item.end.getFullYear(), 1985);
});

test('buildTimelineItems: instantaner Subtyp ignoriert Ende-Jahr → Punkt', () => {
  // Geburt mit Ende = „Jetzt" der Geschichte darf keine 50-Jahre-Spanne werden.
  const [item] = buildTimelineItems([
    { datum_year: 1970, datum_ende_year: 2022, subtyp: 'geburt', ereignis: 'Geburt' },
  ]);
  assert.equal(item.type, 'point');
  assert.equal(item.end, undefined);
});

test('buildTimelineItems: Ende <= Start fällt auf Punkt zurück', () => {
  const [item] = buildTimelineItems([
    { datum_year: 1980, datum_ende_year: 1980, ereignis: 'X' },
  ]);
  assert.equal(item.type, 'point');
  assert.equal(item.end, undefined);
});

test('buildTimelineItems: extern-Flag aus typ', () => {
  const [a, b] = buildTimelineItems([
    { datum_year: 1990, typ: 'extern', ereignis: 'Welt' },
    { datum_year: 1991, typ: 'persoenlich', ereignis: 'Privat' },
  ]);
  assert.equal(a.extern, true);
  assert.equal(b.extern, false);
});

test('buildTimelineItems: subtyp wird durchgereicht (Achsen-Farbcodierung)', () => {
  const [a, b] = buildTimelineItems([
    { datum_year: 1990, subtyp: 'geburt', ereignis: 'A' },
    { datum_year: 1991, /* kein subtyp */ ereignis: 'B' },
  ]);
  assert.equal(a.subtyp, 'geburt');
  assert.equal(b.subtyp, 'sonstiges', 'fehlender Subtyp → sonstiges-Fallback');
});

test('buildTimelineItems: frühes Jahr (<100) wird nicht auf 1900+ gemappt', () => {
  const [item] = buildTimelineItems([{ datum_year: 50, ereignis: 'Antike' }]);
  assert.equal(item.start.getFullYear(), 50);
});

test('buildTimelineItems: leere/fehlende Liste → []', () => {
  assert.deepEqual(buildTimelineItems([]), []);
  assert.deepEqual(buildTimelineItems(undefined), []);
});

// --- timelineBounds (Sprung-Buttons: früheste/späteste Achsenzeit) ---

test('timelineBounds: min = frühester Start, max = spätestes Ende/Start', () => {
  const items = buildTimelineItems([
    { datum_year: 1990, ereignis: 'A' },
    { datum_year: 1980, datum_ende_year: 1985, ereignis: 'Spanne' },
    { datum_year: 2000, ereignis: 'C' },
  ]);
  const b = timelineBounds(items);
  assert.equal(new Date(b.min).getFullYear(), 1980, 'min = frühester Start');
  assert.equal(new Date(b.max).getFullYear(), 2000, 'max = spätester Start/Ende');
});

test('timelineBounds: Spannen-Ende zählt für max', () => {
  const items = buildTimelineItems([
    { datum_year: 1990, ereignis: 'A' },
    { datum_year: 1995, datum_ende_year: 2010, ereignis: 'lange Spanne' },
  ]);
  const b = timelineBounds(items);
  assert.equal(new Date(b.max).getFullYear(), 2010);
});

test('timelineBounds: leere/fehlende Liste → null', () => {
  assert.equal(timelineBounds([]), null);
  assert.equal(timelineBounds(undefined), null);
});
