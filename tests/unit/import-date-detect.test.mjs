import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectDate, detectDateInText, firstLineFromHtml, scoreSample, parseMonthToken } = require('../../lib/import-parsers/date-detect');

test('detectDate: YYYY-MM-DD im Filename', () => {
  assert.deepEqual(detectDate('2024-03-05.docx', {}), { iso: '2024-03-05', pattern: 'YYYY-MM-DD' });
});

test('detectDate: DD.MM.YYYY im Filename', () => {
  assert.deepEqual(detectDate('05.03.2024.odt', {}), { iso: '2024-03-05', pattern: 'DD-MM-YYYY' });
});

test('detectDate: YYYYMMDD kompakt', () => {
  assert.deepEqual(detectDate('20240305.docx', {}), { iso: '2024-03-05', pattern: 'YYYYMMDD' });
});

test('detectDate: DD_monthname mit Jahr-Kontext', () => {
  assert.deepEqual(detectDate('05_Maerz.docx', { year: 2024 }), { iso: '2024-03-05', pattern: 'DD-monthname' });
});

test('detectDate: nur Tag mit Pfad-Kontext', () => {
  assert.deepEqual(detectDate('05.docx', { year: 2024, month: 3 }), { iso: '2024-03-05', pattern: 'DD-only' });
});

test('detectDate: kein Datum ableitbar', () => {
  assert.equal(detectDate('notes.docx', {}), null);
});

test('parseMonthToken: deutsche Monatsnamen', () => {
  assert.equal(parseMonthToken('Januar'), 1);
  assert.equal(parseMonthToken('Jan'), 1);
  assert.equal(parseMonthToken('Dezember'), 12);
});

test('parseMonthToken: englische Monatsnamen', () => {
  assert.equal(parseMonthToken('January'), 1);
  assert.equal(parseMonthToken('december'), 12);
});

test('parseMonthToken: Zahl-String', () => {
  assert.equal(parseMonthToken('03'), 3);
  assert.equal(parseMonthToken('12'), 12);
  assert.equal(parseMonthToken('13'), null);
});

test('scoreSample: 100% confidence bei einheitlichem Format', () => {
  const s = scoreSample([
    { filename: '2024-03-05.docx', year: 2024, month: 3 },
    { filename: '2024-03-06.docx', year: 2024, month: 3 },
    { filename: '2024-03-07.docx', year: 2024, month: 3 },
  ]);
  assert.equal(s.confidence, 1);
  assert.equal(s.pattern, 'YYYY-MM-DD');
});

test('scoreSample: 0 bei keinem Treffer', () => {
  const s = scoreSample([
    { filename: 'foo.docx', year: 2024 },
    { filename: 'bar.docx', year: 2024 },
  ]);
  assert.equal(s.confidence, 0);
  assert.equal(s.pattern, null);
});

test('firstLineFromHtml: erste nicht-leere Text-Zeile', () => {
  assert.equal(firstLineFromHtml('<h1>Titel</h1><p>Inhalt</p>'), 'Titel');
  assert.equal(firstLineFromHtml('<p></p><p>05.03.2024</p><p>Eintrag</p>'), '05.03.2024');
  assert.equal(firstLineFromHtml('  <p>  &nbsp;  </p><p>Echte Zeile</p>'), 'Echte Zeile');
  assert.equal(firstLineFromHtml(''), '');
});

test('detectDateInText: ISO-Datum in erster Zeile', () => {
  assert.deepEqual(detectDateInText('2024-03-05', {}), { iso: '2024-03-05', pattern: 'YYYY-MM-DD' });
});

test('detectDateInText: DD.MM.YYYY in erster Zeile', () => {
  assert.deepEqual(detectDateInText('05.03.2024', {}), { iso: '2024-03-05', pattern: 'DD-MM-YYYY' });
});

test('detectDateInText: monthname mit Jahr-Kontext', () => {
  assert.deepEqual(detectDateInText('5. März', { year: 2024 }), { iso: '2024-03-05', pattern: 'DD-monthname' });
});

test('detectDateInText: ignoriert DD-only (vermeidet "Tag 5" → 5.M.JJJJ Spukfalle)', () => {
  // detectDateInText soll nur Patterns nehmen, die ein Jahr oder Monatsnamen
  // enthalten — eine einzelne Zahl ist zu vieldeutig fuer Text.
  assert.equal(detectDateInText('5', { year: 2024, month: 3 }), null);
});

test('parseMonthToken: Monatsname mit Jahr im selben String ("November 2020")', () => {
  assert.equal(parseMonthToken('November 2020'), 11);
  assert.equal(parseMonthToken('2020 November'), 11);
  assert.equal(parseMonthToken('Maerz 2024'), 3);
});

test('parseMonthToken: rein-numerische Monatszahl', () => {
  assert.equal(parseMonthToken('11'), 11);
  assert.equal(parseMonthToken('2'), 2);
  // gemischter String mit Zahl darf KEINEN Monat zurueckgeben (sonst Konflikt
  // mit DD-anywhere-Pfad: "Persoenliches 16" wuerde sonst 16 als Monat sehen)
  assert.equal(parseMonthToken('Persoenliches 16'), null);
});

test('detectDate: DD-anywhere fuer Filename mit Tag-Tag in Mitte', () => {
  // Tagebücher/2020/November 2020/Persönliches 16.docx
  const r = detectDate('Persönliches 16.docx', { year: 2020, month: 11 });
  assert.deepEqual(r, { iso: '2020-11-16', pattern: 'DD-anywhere' });
});

test('detectDate: DD-anywhere null wenn mehrere Zahlen-Kandidaten', () => {
  // Ambig: 5 oder 12? Nicht raten.
  const r = detectDate('Datei 5 und 12.docx', { year: 2020, month: 11 });
  assert.equal(r, null);
});

test('detectDate: DD-anywhere null ohne Monats-Kontext', () => {
  const r = detectDate('Persoenliches 16.docx', { year: 2020 });
  assert.equal(r, null);
});

test('detectDate: ungültige Datums-Werte zurückweisen', () => {
  // Februar 30 ist akzeptiert (Regex 1-31, kein Kalender-Check) — bewusst, weil
  // Eingabe sonst zu viele Edge-Cases. Tag > 31 jedoch nicht.
  assert.equal(detectDate('2024-03-32.docx', {}), null);
  assert.equal(detectDate('2024-13-05.docx', {}), null);
});
