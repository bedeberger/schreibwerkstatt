import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseDatum } = require('../../lib/datum-parse.js');

test('leerer Input liefert leeres Label', () => {
  assert.deepEqual(parseDatum(null), { label: '' });
  assert.deepEqual(parseDatum(''), { label: '' });
  assert.deepEqual(parseDatum('   '), { label: '' });
});

test('reines Jahr', () => {
  assert.equal(parseDatum('1850').year, 1850);
  assert.equal(parseDatum('1850').label, '1850');
  assert.equal(parseDatum('ca. 1850').year, 1850);
  assert.equal(parseDatum('anno 1850').year, 1850);
});

test('ISO-Datum', () => {
  const r = parseDatum('1850-05-12');
  assert.equal(r.year, 1850);
  assert.equal(r.month, 5);
  assert.equal(r.day, 12);
});

test('ISO ohne Tag', () => {
  const r = parseDatum('1850-05');
  assert.equal(r.year, 1850);
  assert.equal(r.month, 5);
  assert.equal(r.day, undefined);
});

test('DD.MM.YYYY', () => {
  const r = parseDatum('12.03.1850');
  assert.equal(r.day, 12);
  assert.equal(r.month, 3);
  assert.equal(r.year, 1850);
});

test('DD.MM. ohne Jahr', () => {
  const r = parseDatum('12.03.');
  assert.equal(r.day, 12);
  assert.equal(r.month, 3);
  assert.equal(r.year, undefined);
});

test('Monatsname DE: "Mai 1850"', () => {
  const r = parseDatum('Mai 1850');
  assert.equal(r.month, 5);
  assert.equal(r.year, 1850);
  assert.equal(r.day, undefined);
});

test('Monatsname DE mit Tag: "12. März 1850"', () => {
  const r = parseDatum('12. März 1850');
  assert.equal(r.day, 12);
  assert.equal(r.month, 3);
  assert.equal(r.year, 1850);
});

test('Monatsname EN: "May 1850"', () => {
  const r = parseDatum('May 1850');
  assert.equal(r.month, 5);
  assert.equal(r.year, 1850);
});

test('Monatsname EN mit Tag: "May 5, 1850"', () => {
  const r = parseDatum('May 5, 1850');
  assert.equal(r.month, 5);
  assert.equal(r.day, 5);
  assert.equal(r.year, 1850);
});

test('Story-Tag: "Tag 3"', () => {
  const r = parseDatum('Tag 3');
  assert.equal(r.story_tag, 3);
  assert.equal(r.year, undefined);
});

test('Story-Tag EN: "Day 12"', () => {
  const r = parseDatum('Day 12');
  assert.equal(r.story_tag, 12);
});

test('vor Christus: "500 v. Chr."', () => {
  const r = parseDatum('500 v. Chr.');
  assert.equal(r.year, -500);
});

test('vor Christus EN: "300 BCE"', () => {
  const r = parseDatum('300 BCE');
  assert.equal(r.year, -300);
});

test('nur Monat ohne Jahr: "Mai"', () => {
  const r = parseDatum('Mai');
  assert.equal(r.month, 5);
  assert.equal(r.year, undefined);
});

test('nicht parsbar: Freitext bleibt nur Label', () => {
  const r = parseDatum('vor der Reise');
  assert.equal(r.label, 'vor der Reise');
  assert.equal(r.year, undefined);
  assert.equal(r.month, undefined);
  assert.equal(r.day, undefined);
  assert.equal(r.story_tag, undefined);
});

test('Label wird stets erhalten', () => {
  assert.equal(parseDatum('  1850  ').label, '1850');
  assert.equal(parseDatum('Mai 1850').label, 'Mai 1850');
});

test('abgekürzter Monatsname mit Punkt: "Dez. 1849"', () => {
  const r = parseDatum('Dez. 1849');
  assert.equal(r.month, 12);
  assert.equal(r.year, 1849);
});

test('Day-Heuristik wählt keinen Wert >31', () => {
  const r = parseDatum('Mai 1850');
  assert.equal(r.day, undefined);
});

test('Tag aus Vier-stelligem Jahr nicht missdeuten', () => {
  // "1850" darf nicht als Tag 18 oder 50 interpretiert werden
  const r = parseDatum('Juli 1850');
  assert.equal(r.day, undefined);
  assert.equal(r.year, 1850);
  assert.equal(r.month, 7);
});
