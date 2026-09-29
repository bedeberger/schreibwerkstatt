// Zeitungs-/Magazinartikel und Erscheinungsdatum (`csl_type = 'newspaper'`,
// `issued_date`): Formatierung in allen drei Stilen, die Datum-vor-Jahr-Regel
// im Formular-Payload, und die Grenze zum Fachaufsatz — dort bleibt es beim
// Jahr, auch wenn ein Import ein Datum mitgebracht hat.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { formatFull, formatShort } from '../../public/js/sources/format.js';
import { SOURCE_TYPES, TEXT_FIELDS as FORM_FIELDS, draftToPayload, draftFromSource, fieldsForType } from '../../public/js/sources/fields.js';

const require = createRequire(import.meta.url);
const { CSL_TYPES, TEXT_FIELDS: DB_FIELDS } = require('../../db/sources/shared.js');

const NEWS = {
  csl_type: 'newspaper', title: 'Die Stadt wächst', year: '2024', issued_date: '2024-03-12',
  authors: [{ family: 'Meier', given: 'Anna' }], container_title: 'Neue Zürcher Zeitung', pages: '5',
};

test('APA 7: Datum in der Jahresklammer, Zeitung kursiv', () => {
  assert.equal(formatFull(NEWS, { style: 'apa7', lang: 'de' }),
    'Meier, A. (2024, 12. März). Die Stadt wächst. Neue Zürcher Zeitung, 5.');
  assert.equal(formatFull(NEWS, { style: 'apa7', lang: 'en' }),
    'Meier, A. (2024, March 12). Die Stadt wächst. Neue Zürcher Zeitung, 5.');
});

test('Chicago Author-Date: Jahr hinter dem Namen, volles Datum hinter der Zeitung', () => {
  assert.equal(formatFull(NEWS, { style: 'chicago-ad', lang: 'en' }),
    'Meier, Anna. 2024. “Die Stadt wächst.” Neue Zürcher Zeitung, March 12, 2024, 5.');
});

test('Numerisch: Datum ersetzt das Jahr', () => {
  assert.equal(formatFull(NEWS, { style: 'numeric', lang: 'de' }),
    'Meier, Anna: Die Stadt wächst. In: Neue Zürcher Zeitung, 12. März 2024, S. 5.');
});

test('Nur Monat: „März 2024", Jahres-Buchstabe bleibt am Jahr', () => {
  const m = { ...NEWS, issued_date: '2024-03' };
  assert.match(formatFull(m, { style: 'numeric', lang: 'de' }), /Zeitung, März 2024, S\. 5/);
  assert.match(formatFull(m, { style: 'apa7', lang: 'de', suffix: 'b' }), /\(2024b, März\)/);
  assert.equal(formatShort(m, { style: 'apa7', lang: 'de', suffix: 'b' }), '(Meier, 2024b)');
});

test('Fachaufsatz mit Datum: alle Stile nennen nur das Jahr', () => {
  const art = { ...NEWS, csl_type: 'article', volume: '7' };
  for (const style of ['apa7', 'chicago-ad', 'numeric']) {
    const out = formatFull(art, { style, lang: 'de' });
    assert.ok(!out.includes('März'), `${style}: ${out}`);
    assert.ok(out.includes('2024'), style);
  }
});

test('Website mit Datum: Datum wird gesetzt', () => {
  const web = { ...NEWS, csl_type: 'website', container_title: 'Blog der Stadt', pages: null };
  assert.match(formatFull(web, { style: 'apa7', lang: 'de' }), /\(2024, 12\. März\)/);
  assert.match(formatFull(web, { style: 'chicago-ad', lang: 'de' }), /Blog der Stadt, 12\. März 2024/);
});

test('Datum ohne Jahr (Vorschau vor dem Speichern): Jahr wird abgeleitet', () => {
  const raw = { ...NEWS, year: '', issued_date: '12.3.2024' };
  assert.match(formatFull(raw, { style: 'apa7', lang: 'de' }), /^Meier, A\. \(2024, 12\. März\)/);
  assert.equal(formatShort(raw, { style: 'apa7', lang: 'de' }), '(Meier, 2024)');
});

test('Formular-Payload: Datum wird ISO, Jahr folgt dem Datum; Unlesbares bleibt roh', () => {
  const d = draftFromSource({ ...NEWS, year: '1999', issued_date: '12.3.2024' });
  const p = draftToPayload(d);
  assert.equal(p.issued_date, '2024-03-12');
  assert.equal(p.year, '2024');
  const bad = draftToPayload({ ...d, issued_date: 'irgendwann' });
  assert.equal(bad.issued_date, 'irgendwann');   // Server lehnt mit INVALID_VALUE ab
  assert.equal(bad.year, '1999');
});

test('Typ- und Feldlisten: Formular == DB-Schicht, Zeitung zeigt das Datum', () => {
  assert.deepEqual(SOURCE_TYPES, CSL_TYPES);
  assert.deepEqual(FORM_FIELDS, DB_FIELDS);
  const keys = fieldsForType('newspaper').map(f => f.key);
  assert.deepEqual(keys.slice(0, 4), ['title', 'year', 'issued_date', 'container_title']);
  assert.ok(!fieldsForType('article').some(f => f.key === 'issued_date'), 'Fachaufsatz ohne Datumsfeld');
});
