'use strict';
// Server-Bucketing der Rückblick-Heatmap-Coverage (routes/jobs/rueckblick-dates.js
// #buildRueckblickCoverage). Pure Funktion — kein DB-Bootstrap nötig. Reuse von
// entryDate gegen gemischte Page-Namen, Jahr- vs. Monats-Rückblick-Match.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRueckblickCoverage } = require('../../routes/jobs/rueckblick-dates');

test('buildRueckblickCoverage: datierte Einträge → Monats-/Jahres-Buckets', () => {
  const pages = [
    { page_name: '2024-03-01' },
    { page_name: '2024-03-15' },
    { page_name: '2024-05-02' },
    { page_name: 'Vorwort' }, // undatiert → ignoriert
  ];
  const cov = buildRueckblickCoverage(pages, []);
  assert.equal(cov.months['2024-03'].entries, 2);
  assert.equal(cov.months['2024-05'].entries, 1);
  assert.equal(cov.years['2024'].entries, 3);
  assert.equal(cov.minYear, 2024);
  assert.equal(cov.maxYear, 2024);
  assert.equal(cov.months['2024-03'].rueckblick, null);
});

test('buildRueckblickCoverage: Jahres- vs. Monats-Rückblick-Match', () => {
  const pages = [{ page_name: '2024-03-01' }];
  const rbRows = [
    { zeitraum: '2024-03', id: 7, created_at: 'X' },
    { zeitraum: '2024', id: 9, created_at: 'Y' },
  ];
  const cov = buildRueckblickCoverage(pages, rbRows);
  assert.deepEqual(cov.months['2024-03'].rueckblick, { id: 7, created_at: 'X' });
  assert.deepEqual(cov.years['2024'].rueckblick, { id: 9, created_at: 'Y' });
});

test('buildRueckblickCoverage: verwaister Rückblick erweitert die Jahr-Range', () => {
  const pages = [{ page_name: '2024-03-01' }];
  const rbRows = [{ zeitraum: '2020-06', id: 1, created_at: 'Z' }];
  const cov = buildRueckblickCoverage(pages, rbRows);
  assert.equal(cov.minYear, 2020);
  assert.equal(cov.maxYear, 2024);
  assert.equal(cov.months['2020-06'].entries, 0);
  assert.deepEqual(cov.months['2020-06'].rueckblick, { id: 1, created_at: 'Z' });
});

test('buildRueckblickCoverage: leer', () => {
  assert.deepEqual(buildRueckblickCoverage([], []), { months: {}, years: {}, minYear: null, maxYear: null });
});
