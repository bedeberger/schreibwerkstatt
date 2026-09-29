// Erscheinungsdatum: ESM-Original (public/js/sources/issued-date.js) und
// CJS-Spiegel (lib/issued-date.js) muessen jede Eingabe gleich lesen — der
// Schreibpfad normalisiert mit dem Spiegel, Formular und Formatierer mit dem
// Original. Laufen sie auseinander, zeigt die Vorschau ein anderes Datum als
// das, was gespeichert wird.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '../../public/js/sources/issued-date.js';

const require = createRequire(import.meta.url);
const cjs = require('../../lib/issued-date.js');

const CASES = {
  '': null, '  ': null, 'x': null, 'o. J.': null,
  '2024': '2024', '2024-03': '2024-03', '2024-3-5': '2024-03-05', '2024-03-12': '2024-03-12',
  '2024/03/12/': '2024-03-12', '2024/03//': '2024-03', '2024///': '2024',
  '2015-05-27T00:00:00Z': '2015-05-27',
  '12.3.2024': '2024-03-12', '12. 3. 2024': '2024-03-12', '29.2.2024': '2024-02-29',
  '31.2.2024': null, '29.2.2023': null, '2024-13': null, '0999': null,
  '12. März 2024': '2024-03-12', '12. Maerz 2024': '2024-03-12', '1. Dez. 2020': '2020-12-01',
  '12 March 2024': '2024-03-12', 'March 12, 2024': '2024-03-12', 'Sept. 3, 2021': '2021-09-03',
  'März 2024': '2024-03', 'May 1999': '1999-05', 'Blau 2024': null,
};

test('parseIssuedDate: erwartete Werte', () => {
  for (const [input, want] of Object.entries(CASES)) {
    assert.equal(esm.parseIssuedDate(input), want, `ESM ${JSON.stringify(input)}`);
  }
});

test('parseIssuedDate: CJS-Spiegel == ESM-Original', () => {
  for (const input of Object.keys(CASES)) {
    assert.equal(cjs.parseIssuedDate(input), esm.parseIssuedDate(input), JSON.stringify(input));
  }
  for (const iso of ['2024', '2024-03', '2024-03-12', 'x']) {
    assert.deepEqual(cjs.issuedParts(iso), esm.issuedParts(iso));
  }
});
