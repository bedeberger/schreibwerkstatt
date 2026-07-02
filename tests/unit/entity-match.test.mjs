import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  placeTokens, locationSimilarity, matchLocations, dedupeLocationsWithinRun, matchScenes,
} = require('../../lib/entity-match.js');

test('placeTokens strips parens/slashes/connectors', () => {
  assert.deepEqual(placeTokens('Mathys AG (Bettlach)'), ['mathys', 'ag', 'bettlach']);
  assert.deepEqual(placeTokens('EPA / Nordmann Solothurn'), ['epa', 'nordmann', 'solothurn']);
  assert.deepEqual(placeTokens('EPA und Nordmann (Solothurn)'), ['epa', 'nordmann', 'solothurn']);
  assert.deepEqual(placeTokens('Dieters Bar/Etablissement in Olten'), ['dieters', 'bar', 'etablissement', 'olten']);
});

test('locationSimilarity: subset variants match (Mathys AG)', () => {
  const a = { name: 'Mathys AG (Bettlach)', typ: 'GEBAEUDE' };
  const b = { name: 'Mathys AG Produktionsstätte Bettlach', typ: 'GEBAEUDE' };
  const c = { name: 'Mathys AG (Produktionsstätte)', typ: 'GEBAEUDE' };
  assert.ok(locationSimilarity(a, b) >= 0.9);
  assert.ok(locationSimilarity(c, b) >= 0.9);
});

test('locationSimilarity: overlap variants match (Dieters Bar, Frohheim, EPA)', () => {
  assert.ok(locationSimilarity(
    { name: 'Dieters Bar (Innenstadt Olten)', typ: 'GEBAEUDE' },
    { name: 'Dieters Bar/Etablissement in Olten', typ: 'GEBAEUDE' }) > 0);
  assert.ok(locationSimilarity(
    { name: 'Frohheim-Schule Olten', typ: 'GEBAEUDE' },
    { name: 'Frohheim-Schulhaus Olten', typ: 'GEBAEUDE' }) > 0);
  assert.ok(locationSimilarity(
    { name: 'EPA / Nordmann Solothurn', typ: 'GEBAEUDE' },
    { name: 'EPA und Nordmann (Solothurn)', typ: 'GEBAEUDE' }) >= 0.9);
});

test('locationSimilarity: different city does NOT match (only shared generic token)', () => {
  assert.equal(locationSimilarity(
    { name: 'Bahnhof Olten', typ: 'GEBAEUDE' },
    { name: 'Bahnhof Bern', typ: 'GEBAEUDE' }), 0);
});

test('locationSimilarity: different typ never matches', () => {
  assert.equal(locationSimilarity(
    { name: 'Olten', typ: 'STADT' },
    { name: 'Olten Bahnhof', typ: 'GEBAEUDE' }), 0);
});

test('locationSimilarity: no shared token → 0', () => {
  assert.equal(locationSimilarity(
    { name: 'Schreinerei Grütter', typ: 'GEBAEUDE' },
    { name: 'Solothurn', typ: 'STADT' }), 0);
});

test('matchLocations: fresh variant revives existing stale row (cross-run)', () => {
  const existing = [
    { id: 10, name: 'Mathys AG (Produktionsstätte)', typ: 'GEBAEUDE' },
    { id: 11, name: 'Solothurn', typ: 'STADT' },
  ];
  const incoming = [
    { name: 'Mathys AG Produktionsstätte Bettlach', typ: 'GEBAEUDE' },
    { name: 'Solothurn', typ: 'STADT' },
  ];
  const m = matchLocations(existing, incoming);
  assert.equal(m.get(0), 10);   // fuzzy → same row, no new dup
  assert.equal(m.get(1), 11);   // exact
});

test('matchLocations: greedy, each existing used at most once', () => {
  const existing = [{ id: 1, name: 'Frohheim-Schule Olten', typ: 'GEBAEUDE' }];
  const incoming = [
    { name: 'Frohheim-Schule Olten', typ: 'GEBAEUDE' },     // exact → wins row 1
    { name: 'Frohheim-Schulhaus Olten', typ: 'GEBAEUDE' },  // fuzzy but row 1 taken → new
  ];
  const m = matchLocations(existing, incoming);
  assert.equal(m.get(0), 1);
  assert.equal(m.has(1), false);
});

test('dedupeLocationsWithinRun: merges subset variants, unions figuren/kapitel', () => {
  const orte = [
    { name: 'Mathys AG (Bettlach)', typ: 'GEBAEUDE', figuren_namen: ['Der Vater'], kapitel: ['K1'], beschreibung: 'kurz' },
    { name: 'Mathys AG Produktionsstätte Bettlach', typ: 'GEBAEUDE', figuren_namen: ['Mario'], kapitel: ['K2'], beschreibung: 'eine viel längere Beschreibung' },
  ];
  const out = dedupeLocationsWithinRun(orte);
  assert.equal(out.length, 1);
  assert.deepEqual([...out[0].figuren_namen].sort(), ['Der Vater', 'Mario']);
  assert.equal(out[0].kapitel.length, 2);
  assert.equal(out[0].beschreibung, 'eine viel längere Beschreibung');
  assert.equal(out[0].name, 'Mathys AG Produktionsstätte Bettlach');  // längerer/spezifischerer Name
});

test('dedupeLocationsWithinRun: keeps distinct places (overlap-only, not subset)', () => {
  // Innerhalb eines Laufs konservativ: NUR Token-Teilmenge merged, Overlap allein nicht.
  const orte = [
    { name: 'Dieters Bar (Innenstadt Olten)', typ: 'GEBAEUDE' },
    { name: 'Dieters Bar/Etablissement in Olten', typ: 'GEBAEUDE' },
  ];
  assert.equal(dedupeLocationsWithinRun(orte).length, 2);
});

test('matchScenes: token-subset title within same chapter matches', () => {
  const existing = [
    { id: 5, chapter_id: 1, titel: 'Ankunft in Olten' },
    { id: 6, chapter_id: 2, titel: 'Abschied' },
  ];
  const incoming = [
    { chapterId: 1, titel: 'Ankunft in Olten am Bahnhof' },  // superset → match 5
    { chapterId: 2, titel: 'Abschied' },                      // exact → match 6
  ];
  const m = matchScenes(existing, incoming);
  assert.equal(m.get(0), 5);
  assert.equal(m.get(1), 6);
});

test('matchScenes: same title different chapter does NOT match', () => {
  const existing = [{ id: 5, chapter_id: 1, titel: 'Der Streit' }];
  const incoming = [{ chapterId: 2, titel: 'Der Streit' }];
  assert.equal(matchScenes(existing, incoming).size, 0);
});
