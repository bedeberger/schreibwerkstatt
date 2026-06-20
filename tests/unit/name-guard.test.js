'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  detectNameVariants,
  damerauLevenshtein,
  isInflectedForm,
  extractAnchors,
  thresholdFor,
  classifyConfidence,
} = require('../../lib/name-guard');

test('damerauLevenshtein: Grundfaelle + Transposition + Early-Exit', () => {
  assert.equal(damerauLevenshtein('stefan', 'stefan'), 0);
  assert.equal(damerauLevenshtein('stefan', 'stefann'), 1); // Einfuegung
  assert.equal(damerauLevenshtein('stefan', 'sefan'), 1);   // Loeschung
  assert.equal(damerauLevenshtein('stefan', 'setfan'), 1);  // Transposition t<->e
  assert.equal(damerauLevenshtein('müller', 'mueller'), 2); // ü -> ue
  // Early-Exit liefert > max, nicht die echte Distanz
  assert.ok(damerauLevenshtein('abcdef', 'xyzuvw', 1) > 1);
});

test('isInflectedForm: deutsche Flexion vs. echter Tippfehler', () => {
  assert.equal(isInflectedForm('stefans', 'stefan'), true);  // Genitiv
  assert.equal(isInflectedForm('annas', 'anna'), true);
  assert.equal(isInflectedForm('müllern', 'müller'), true);  // Dativ Plural
  assert.equal(isInflectedForm('linden', 'linde'), true);    // -n
  assert.equal(isInflectedForm('stefan', 'stefan'), true);   // identisch
  // Tippfehler ist KEINE Flexion:
  assert.equal(isInflectedForm('stefann', 'stefan'), false); // verdoppeltes n
  assert.equal(isInflectedForm('steffan', 'stefan'), false);
});

test('thresholdFor: Kurznamen kriegen kein Fuzzy', () => {
  assert.equal(thresholdFor(3), 0);
  assert.equal(thresholdFor(4), 1);
  assert.equal(thresholdFor(7), 1);
  assert.equal(thresholdFor(8), 2);
});

test('extractAnchors: mehrteilige Namen, Partikel + Kurznamen raus', () => {
  const anchors = extractAnchors(['Hans Müller', 'Graf von Stein', 'Tom', 'Anna-Lena']);
  const lowers = anchors.map(a => a.lower).sort();
  assert.ok(lowers.includes('hans'));
  assert.ok(lowers.includes('müller'));
  assert.ok(lowers.includes('stein'));
  assert.ok(lowers.includes('anna'));   // aus Anna-Lena gesplittet
  assert.ok(lowers.includes('lena'));
  assert.ok(!lowers.includes('von'));   // Partikel
  assert.ok(!lowers.includes('tom'));   // Kurzname < 4
});

test('detectNameVariants: Tippfehler eines bekannten Namens wird erkannt', () => {
  const text = ('Stefan ging nach Hause. ').repeat(20) + 'Stefann kam zurueck. Stefann lachte.';
  const { clusters } = detectNameVariants({ names: ['Stefan'], text });
  assert.equal(clusters.length, 1);
  const c = clusters[0];
  assert.equal(c.canonical, 'Stefan');
  assert.equal(c.canonicalCount, 20);
  assert.equal(c.variants.length, 1);
  assert.equal(c.variants[0].form, 'Stefann');
  assert.equal(c.variants[0].count, 2);
  assert.equal(c.variants[0].distance, 1);
  assert.equal(c.confidence, 'hoch'); // 20 kanonisch, 2 Variante, Distanz 1
});

test('detectNameVariants: Flexionsformen sind keine Treffer', () => {
  const text = 'Stefan rief. Stefans Hund bellte. Wir gaben Stefan das Buch. Stefans Auto.';
  const { clusters } = detectNameVariants({ names: ['Stefan'], text });
  assert.equal(clusters.length, 0, 'Stefans (Genitiv) darf nicht gemeldet werden');
});

test('detectNameVariants: bekannte Namen werden nicht gegeneinander gemeldet', () => {
  const text = 'Anna und Anne trafen sich. Anna lachte, Anne weinte.';
  const { clusters } = detectNameVariants({ names: ['Anna', 'Anne'], text });
  assert.equal(clusters.length, 0, 'zwei kanonische Namen sind keine Varianten voneinander');
});

test('detectNameVariants: Kurznamen erzeugen kein Rauschen', () => {
  // "von" ist Distanz 1 von "Tom", aber Tom (<4) bekommt kein Fuzzy.
  const text = 'Tom ging von hier nach dort. Tom kam von weit.';
  const { clusters } = detectNameVariants({ names: ['Tom'], text });
  assert.equal(clusters.length, 0);
});

test('detectNameVariants: Ortsname-Variante mit ue/ü', () => {
  const text = ('Zürich ist schön. ').repeat(10) + 'In Zuerich regnete es.';
  const { clusters } = detectNameVariants({ names: ['Zürich'], text });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].variants[0].form, 'Zuerich');
  assert.equal(clusters[0].variants[0].distance, 2);
});

test('detectNameVariants: Ignore-Liste unterdrueckt Variante', () => {
  const text = ('Müller kam. ').repeat(10) + 'Mueller ging. Mueller blieb.';
  const base = detectNameVariants({ names: ['Müller'], text });
  assert.equal(base.clusters.length, 1);
  const ignored = detectNameVariants({ names: ['Müller'], text, ignores: [{ canonical: 'Müller', variant: 'Mueller' }] });
  assert.equal(ignored.clusters.length, 0);
});

test('detectNameVariants: gleich haeufige Variante ist niedrig-konfident', () => {
  const text = 'Kathrin kam. Katrin ging.';
  const { clusters } = detectNameVariants({ names: ['Kathrin'], text });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].confidence, 'niedrig');
});

test('detectNameVariants: leere Eingaben', () => {
  assert.deepEqual(detectNameVariants({ names: [], text: 'irgendwas' }).clusters, []);
  assert.deepEqual(detectNameVariants({ names: ['Stefan'], text: '' }).clusters, []);
  assert.deepEqual(detectNameVariants({}).clusters, []);
});
