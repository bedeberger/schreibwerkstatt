// Unit: Tagebuch-Rückblick Frontend-Methoden — History-Volltextfilter +
// Belege-Popover (book/tagebuch-rueckblick.js). Pure genug für node:test, sobald
// ein minimales window vorhanden ist (uiLocale + innerWidth).
import test from 'node:test';
import assert from 'node:assert/strict';

let selected = null;
globalThis.window = { __app: { uiLocale: 'de', selectPage: (p) => { selected = p; } }, innerWidth: 1000 };

const { tagebuchRueckblickMethods: M } = await import('../../public/js/book/tagebuch-rueckblick.js');

function ctx(overrides = {}) {
  return Object.assign(Object.create(M), {
    rueckblickHistory: [],
    rbHistorySearch: '',
    rbPopover: { open: false, label: '', belege: [], x: 0, y: 0 },
    ...overrides,
  });
}

const HISTORY = [
  { id: 1, zeitraum: '2024-03', created_at: '2024-04-01T00:00:00Z',
    result_json: { zusammenfassung: 'Ein Monat voller Wanderungen.', themen: [{ label: 'Natur' }], personen: [{ name: 'Anna' }], orte: [{ name: 'Zürich' }], bemerkenswerteTage: [] } },
  { id: 2, zeitraum: '2023', created_at: '2024-01-01T00:00:00Z',
    result_json: { zusammenfassung: 'Berufliche Veränderungen.', themen: [{ label: 'Arbeit' }], personen: [{ name: 'Bernd' }], orte: [], bemerkenswerteTage: [] } },
];

test('filteredRueckblickHistory: leere Suche → alle', () => {
  const c = ctx({ rueckblickHistory: HISTORY });
  assert.equal(c.filteredRueckblickHistory().length, 2);
});

test('filteredRueckblickHistory: trifft Zusammenfassung, Person, Ort, Thema (case-insensitiv)', () => {
  const c = ctx({ rueckblickHistory: HISTORY });
  c.rbHistorySearch = 'wanderung';
  assert.deepEqual(c.filteredRueckblickHistory().map(e => e.id), [1]);
  c.rbHistorySearch = 'ANNA';
  assert.deepEqual(c.filteredRueckblickHistory().map(e => e.id), [1]);
  c.rbHistorySearch = 'zürich';
  assert.deepEqual(c.filteredRueckblickHistory().map(e => e.id), [1]);
  c.rbHistorySearch = 'arbeit';
  assert.deepEqual(c.filteredRueckblickHistory().map(e => e.id), [2]);
  c.rbHistorySearch = 'xyz-nope';
  assert.equal(c.filteredRueckblickHistory().length, 0);
});

test('filteredRueckblickHistory: trifft Zeitraum-Roh-Wert', () => {
  const c = ctx({ rueckblickHistory: HISTORY });
  c.rbHistorySearch = '2023';
  assert.deepEqual(c.filteredRueckblickHistory().map(e => e.id), [2]);
});

// Fake-Anker mit getBoundingClientRect (kein DOM in node:test → kein closest/
// querySelector, _placeBelegePopover fällt auf popH=0 = "unter dem Element").
function fakeAnchor(rect) {
  return { getBoundingClientRect: () => rect };
}

test('openBelegePopover: dedup + sortiert, öffnet mit Label', () => {
  const c = ctx();
  c.openBelegePopover({ currentTarget: fakeAnchor({ left: 100, top: 200, bottom: 224, right: 180 }) },
    'Anna', ['2024-03-12', '2024-03-04', '2024-03-12']);
  assert.equal(c.rbPopover.open, true);
  assert.equal(c.rbPopover.label, 'Anna');
  assert.deepEqual(c.rbPopover.belege, ['2024-03-04', '2024-03-12']);
});

test('_placeBelegePopover: unter dem Element (linke Kante), am rechten Rand geclampt', () => {
  const c = ctx();
  c.rbPopover = { open: true, label: '', belege: [], x: 0, y: 0 };
  // Anker links → x = rect.left, y = rect.bottom + GAP(6). popH=0 → kein Flip.
  c._placeBelegePopover(fakeAnchor({ left: 120, top: 200, bottom: 224, right: 200 }));
  assert.equal(c.rbPopover.x, 120);
  assert.equal(c.rbPopover.y, 230);
  // Anker am rechten Rand → x in den Viewport gezogen (vw - popW(240) - EDGE(8)).
  c._placeBelegePopover(fakeAnchor({ left: 990, top: 10, bottom: 34, right: 998 }));
  assert.equal(c.rbPopover.x, 1000 - 240 - 8);
});

test('gotoBelegTag: schliesst Popover + navigiert', () => {
  selected = null;
  globalThis.window.__app.pages = [{ name: '2024-03-04', id: 7 }];
  const c = ctx({ rbPopover: { open: true, label: 'x', belege: ['2024-03-04'], x: 0, y: 0 } });
  c.gotoBelegTag('2024-03-04');
  assert.equal(c.rbPopover.open, false);
  assert.deepEqual(selected, { name: '2024-03-04', id: 7 });
});

test('belegLabel: ISO-Datum → lokalisierter Tag, ungültig → roh', () => {
  const c = ctx();
  const label = c.belegLabel('2024-03-04');
  assert.match(label, /2024/);
  assert.match(label, /03|März|Mär/);
  assert.equal(c.belegLabel('foo'), 'foo');
});
