import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectDate, scoreSample, parseMonthToken } = require('../../lib/import-parsers/date-detect');

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

test('detectDate: ungültige Datums-Werte zurückweisen', () => {
  // Februar 30 ist akzeptiert (Regex 1-31, kein Kalender-Check) — bewusst, weil
  // Eingabe sonst zu viele Edge-Cases. Tag > 31 jedoch nicht.
  assert.equal(detectDate('2024-03-32.docx', {}), null);
  assert.equal(detectDate('2024-13-05.docx', {}), null);
});
