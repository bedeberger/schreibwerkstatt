// Geocode-Proxy: Nominatim-Antwort (Fremd-Input) → flaches Kandidaten-Array.
// Verwirft Eintraege ohne gueltige Koordinaten, parst Strings zu Number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseNominatimResults, parsePhotonResults } = require('../../routes/geocode.js');

test('parseNominatimResults: mappt lat/lon-Strings zu Number + displayName', () => {
  const out = parseNominatimResults([
    { lat: '47.3769', lon: '8.5417', display_name: 'Zürich, Schweiz' },
  ]);
  assert.deepEqual(out, [{ lat: 47.3769, lng: 8.5417, displayName: 'Zürich, Schweiz' }]);
});

test('parseNominatimResults: verwirft Eintraege ohne gueltige Koordinaten', () => {
  const out = parseNominatimResults([
    { lat: 'abc', lon: '8.5', display_name: 'kaputt' },
    { lat: '1.0', lon: null, display_name: 'kaputt2' },
    { lat: '46.9', lon: '7.4', display_name: 'Bern' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].displayName, 'Bern');
});

test('parseNominatimResults: Nicht-Array → leeres Array', () => {
  assert.deepEqual(parseNominatimResults(null), []);
  assert.deepEqual(parseNominatimResults({}), []);
  assert.deepEqual(parseNominatimResults('x'), []);
});

test('parseNominatimResults: fehlender display_name → leerer String', () => {
  const out = parseNominatimResults([{ lat: '1', lon: '2' }]);
  assert.equal(out[0].displayName, '');
});

test('parsePhotonResults: [lon,lat]-Reihenfolge → {lat,lng} + zusammengesetzter displayName', () => {
  const out = parsePhotonResults({
    type: 'FeatureCollection',
    features: [
      { geometry: { type: 'Point', coordinates: [8.5417, 47.3769] },
        properties: { name: 'Zürich', state: 'Zürich', country: 'Schweiz' } },
    ],
  });
  assert.deepEqual(out, [{ lat: 47.3769, lng: 8.5417, displayName: 'Zürich, Zürich, Schweiz' }]);
});

test('parsePhotonResults: verwirft Features ohne gueltige Koordinaten', () => {
  const out = parsePhotonResults({
    features: [
      { geometry: { coordinates: ['x', 47] }, properties: { name: 'kaputt' } },
      { geometry: { coordinates: [7.4] }, properties: { name: 'kaputt2' } },
      { properties: { name: 'ohne geometry' } },
      { geometry: { coordinates: [7.4474, 46.948], type: 'Point' }, properties: { name: 'Bern' } },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].displayName, 'Bern');
});

test('parsePhotonResults: keine FeatureCollection → leeres Array', () => {
  assert.deepEqual(parsePhotonResults(null), []);
  assert.deepEqual(parsePhotonResults({}), []);
  assert.deepEqual(parsePhotonResults({ features: 'x' }), []);
});
