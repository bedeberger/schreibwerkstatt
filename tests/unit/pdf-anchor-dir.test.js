'use strict';
// Abbildungs-/Tabellenverzeichnis im PDF: der PLAN. Er entscheidet, was im
// Verzeichnis steht und welcher Anker welche Seitenzahl bekommt — die
// Seitenzahl selbst trägt der Stempel-Pass nach dem Body nach.
//
// Die tragende Zusage: Eintrag i des Verzeichnisses zeigt auf Anker i. Ginge
// die Zuordnung verloren, nennte das Verzeichnis zu jeder Abbildung eine
// fremde Seite — und das fiele niemandem auf, weil beide Zahlen plausibel
// aussehen.
const test = require('node:test');
const assert = require('node:assert');
const { buildAnchorDirPlan } = require('../../lib/pdf-render/anchor-dir');

// Form von lib/xref-render.js#buildXrefContext.
function ctx({ figures = [], tables = [] } = {}) {
  const toMap = (list) => new Map(list.map(([bid, number, title]) => [bid, { number, title }]));
  return { figure: toMap(figures), table: toMap(tables) };
}

test('Plan: ein Abschnitt je Typ, Einträge in Leserichtung', () => {
  const plan = buildAnchorDirPlan(ctx({
    figures: [['aaaaaaaa', '1.1', 'Der Käfer'], ['bbbbbbbb', '1.2', 'Die Wanze']],
    tables: [['cccccccc', '1.1', 'Umsatz']],
  }), 'de');
  assert.equal(plan.length, 2);
  assert.equal(plan[0].kind, 'figure');
  assert.equal(plan[0].title, 'Abbildungsverzeichnis');
  assert.equal(plan[1].title, 'Tabellenverzeichnis');
  assert.deepEqual(plan[0].entries.map(e => [e.label, e.title, e.bid]), [
    ['Abb. 1.1', 'Der Käfer', 'aaaaaaaa'],
    ['Abb. 1.2', 'Die Wanze', 'bbbbbbbb'],
  ]);
  assert.deepEqual(plan[1].entries.map(e => [e.label, e.bid]), [['Tab. 1.1', 'cccccccc']]);
});

test('Plan: die bid-Zuordnung überspringt unnummerierte Anker mit', () => {
  // Ein Anker ohne Nummer fällt aus dem Verzeichnis (directoryEntries filtert
  // ihn), und die bid-Liste MUSS denselben Filter fahren. Täte sie es nicht,
  // verschöbe sich ab dem ersten Lückenanker jede Zuordnung um eins.
  const plan = buildAnchorDirPlan(ctx({
    figures: [
      ['aaaaaaaa', '1.1', 'Erste'],
      ['bbbbbbbb', null, 'Ohne Nummer'],
      ['cccccccc', '1.2', 'Zweite'],
    ],
  }), 'de');
  assert.deepEqual(plan[0].entries.map(e => [e.label, e.title, e.bid]), [
    ['Abb. 1.1', 'Erste', 'aaaaaaaa'],
    ['Abb. 1.2', 'Zweite', 'cccccccc'],
  ]);
});

test('Plan: ohne Nummern kein Verzeichnis', () => {
  // Nummerierung im Buch aus → buildXrefContext setzt alle `number` auf null.
  const plan = buildAnchorDirPlan(ctx({
    figures: [['aaaaaaaa', null, 'Der Käfer']],
    tables: [['cccccccc', null, 'Umsatz']],
  }), 'de');
  assert.deepEqual(plan, []);
});

test('Plan: nur der nummerierte Typ erscheint', () => {
  // Fachbuch, das Tabellen nummeriert und Abbildungen nicht.
  const plan = buildAnchorDirPlan(ctx({
    figures: [['aaaaaaaa', null, 'Der Käfer']],
    tables: [['cccccccc', '2.1', 'Umsatz']],
  }), 'de');
  assert.equal(plan.length, 1);
  assert.equal(plan[0].kind, 'table');
});

test('Plan: englische Buchsprache setzt Titel und Wort', () => {
  const plan = buildAnchorDirPlan(ctx({ figures: [['aaaaaaaa', '1.1', 'The beetle']] }), 'en');
  assert.equal(plan[0].title, 'List of Figures');
  assert.equal(plan[0].entries[0].label, 'Fig. 1.1');
});

test('Plan: ohne Kontext leer (Kapitel-/Seiten-Export)', () => {
  assert.deepEqual(buildAnchorDirPlan(null, 'de'), []);
});

test('Plan: Einträge starten ohne Seite', () => {
  // pageIdx -1 heisst „noch nicht gerendert"; der Stempel-Pass überspringt
  // solche Zeilen, statt eine Null zu drucken.
  const plan = buildAnchorDirPlan(ctx({ figures: [['aaaaaaaa', '1.1', 'X']] }), 'de');
  assert.equal(plan[0].entries[0].pageIdx, -1);
});
