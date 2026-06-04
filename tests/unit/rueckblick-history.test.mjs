// Unit: Tagebuch-Rückblick Frontend-Methoden — History-Volltextfilter, sortierte
// Facetten + Inline-Belege (book/tagebuch-rueckblick.js). Pure genug für
// node:test, sobald ein minimales window vorhanden ist (uiLocale + innerWidth).
import test from 'node:test';
import assert from 'node:assert/strict';

let selected = null;
globalThis.window = { __app: { uiLocale: 'de', selectPage: (p) => { selected = p; } }, innerWidth: 1000 };

const { tagebuchRueckblickMethods: M } = await import('../../public/js/book/tagebuch-rueckblick.js');

function ctx(overrides = {}) {
  return Object.assign(Object.create(M), {
    rueckblickHistory: [],
    rbHistorySearch: '',
    rueckblickResult: null,
    rbBeleg: { key: null, label: '', belege: [] },
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

test('rbThemen/rbPersonen/rbOrte: nach Häufigkeit absteigend sortiert', () => {
  const c = ctx({ rueckblickResult: {
    themen: [{ label: 'A', haeufigkeit: 1 }, { label: 'B', haeufigkeit: 5 }, { label: 'C', haeufigkeit: 3 }],
    personen: [{ name: 'Anna', haeufigkeit: 2 }, { name: 'Bernd', haeufigkeit: 9 }],
    orte: [],
  } });
  assert.deepEqual(c.rbThemen().map(t => t.label), ['B', 'C', 'A']);
  assert.deepEqual(c.rbPersonen().map(p => p.name), ['Bernd', 'Anna']);
  assert.deepEqual(c.rbOrte(), []);
});

test('toggleBeleg: setzt aktiven Key + dedupte/sortierte Belegtage, erneuter Klick schliesst', () => {
  const c = ctx();
  c.toggleBeleg('personen:Anna', 'Anna', ['2024-03-12', '2024-03-04', '2024-03-12']);
  assert.equal(c.rbBeleg.key, 'personen:Anna');
  assert.equal(c.rbBeleg.label, 'Anna');
  assert.deepEqual(c.rbBeleg.belege, ['2024-03-04', '2024-03-12']);
  // Gleicher Key erneut → schliesst.
  c.toggleBeleg('personen:Anna', 'Anna', ['2024-03-12']);
  assert.equal(c.rbBeleg.key, null);
  // Anderer Key → wechselt.
  c.toggleBeleg('orte:Zürich', 'Zürich', ['2024-03-04']);
  assert.equal(c.rbBeleg.key, 'orte:Zürich');
});

test('gotoBelegTag: schliesst Belege-Leiste + navigiert', () => {
  selected = null;
  globalThis.window.__app.pages = [{ name: '2024-03-04', id: 7 }];
  const c = ctx({ rbBeleg: { key: 'orte:x', label: 'x', belege: ['2024-03-04'] } });
  c.gotoBelegTag('2024-03-04');
  assert.equal(c.rbBeleg.key, null);
  assert.deepEqual(selected, { name: '2024-03-04', id: 7 });
});

test('belegLabel: ISO-Datum → lokalisierter Tag, ungültig → roh', () => {
  const c = ctx();
  const label = c.belegLabel('2024-03-04');
  assert.match(label, /2024/);
  assert.match(label, /03|März|Mär/);
  assert.equal(c.belegLabel('foo'), 'foo');
});
