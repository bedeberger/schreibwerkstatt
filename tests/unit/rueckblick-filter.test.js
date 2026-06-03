'use strict';
// Unit: Tagebuch-Rückblick Datums-Filter (rueckblick-dates.js, pure).

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseZeitraum, entryDate, matchesZeitraum } = require('../../routes/jobs/rueckblick-dates');

test('parseZeitraum: Monat + Jahr + ungültig', () => {
  assert.deepEqual(parseZeitraum('2024-03'), { year: 2024, month: 3 });
  assert.deepEqual(parseZeitraum('2024'), { year: 2024, month: null });
  assert.equal(parseZeitraum('2024-13'), null, 'Monat > 12 ungültig');
  assert.equal(parseZeitraum('foo'), null);
  assert.equal(parseZeitraum(''), null);
});

test('entryDate: ISO-Tagebuchname → iso/year/month/monthKey', () => {
  assert.deepEqual(entryDate('2024-03-15'), { iso: '2024-03-15', year: 2024, month: 3, monthKey: '2024-03' });
});

test('entryDate: nicht-datierter Name → null', () => {
  assert.equal(entryDate('Über mich'), null);
  assert.equal(entryDate(''), null);
});

test('matchesZeitraum: Monats-Zeitraum trifft nur denselben Monat', () => {
  const z = parseZeitraum('2024-03');
  assert.equal(matchesZeitraum(entryDate('2024-03-04'), z), true);
  assert.equal(matchesZeitraum(entryDate('2024-03-31'), z), true, 'Monatsgrenze inklusive');
  assert.equal(matchesZeitraum(entryDate('2024-04-01'), z), false, 'nächster Monat raus');
  assert.equal(matchesZeitraum(entryDate('2023-03-15'), z), false, 'anderes Jahr raus');
});

test('matchesZeitraum: Jahres-Zeitraum trifft alle Monate des Jahres', () => {
  const z = parseZeitraum('2024');
  assert.equal(matchesZeitraum(entryDate('2024-01-01'), z), true);
  assert.equal(matchesZeitraum(entryDate('2024-12-31'), z), true);
  assert.equal(matchesZeitraum(entryDate('2025-01-01'), z), false);
});

test('matchesZeitraum: null-Eintrag (kein Datum) trifft nie', () => {
  const z = parseZeitraum('2024');
  assert.equal(matchesZeitraum(entryDate('kein datum'), z), false);
  assert.equal(matchesZeitraum(null, z), false);
});
