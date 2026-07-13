// Regression: pdfkit verschluckt im continued+justify-Modus führende Whitespaces
// eines Folge-Fragments. _normalizeRunWhitespace lagert den Trenn-Whitespace
// zwischen zwei Runs (Fliesstext → Link/bold/italic → Fliesstext) in ein eigenes,
// stil-neutrales Space-Fragment aus, damit das Leerzeichen erhalten bleibt.

import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _normalizeRunWhitespace } = require('../../lib/pdf-render/runs.js');

test('führender Whitespace nach Link-Run wird zu neutralem Space-Fragment', () => {
  const runs = [
    { text: 'Text mit einem ' },
    { text: 'Hyperlink', underline: true, link: 'https://example.com' },
    { text: ' danach weiter.' },
  ];
  const out = _normalizeRunWhitespace(runs);
  assert.deepEqual(out, [
    { text: 'Text mit einem ' },
    { text: 'Hyperlink', underline: true, link: 'https://example.com' },
    { text: ' ' },
    { text: 'danach weiter.' },
  ]);
  // Das ausgelagerte Space-Fragment trägt keinerlei Styling.
  const space = out[2];
  assert.equal(space.underline, undefined);
  assert.equal(space.link, undefined);
  assert.equal(space.bold, undefined);
});

test('gilt genauso für bold und italic', () => {
  for (const style of ['bold', 'italic']) {
    const runs = [
      { text: 'ein ' },
      { text: 'Wort', [style]: true },
      { text: ' danach.' },
    ];
    const out = _normalizeRunWhitespace(runs);
    assert.equal(out.length, 4);
    assert.equal(out[1].text, 'Wort');
    assert.equal(out[1][style], true);
    assert.deepEqual(out[2], { text: ' ' });
    assert.equal(out[3].text, 'danach.');
    assert.equal(out[3][style], undefined);
  }
});

test('kein Doppelraum, wenn Vorgänger bereits auf Whitespace endet', () => {
  const runs = [
    { text: 'einem ' },
    { text: ' danach.' },
  ];
  const out = _normalizeRunWhitespace(runs);
  // Vorgänger endet auf Space → kein zusätzliches Fragment, nur Rest-Text.
  assert.deepEqual(out, [{ text: 'einem ' }, { text: 'danach.' }]);
});

test('erster Run bleibt unangetastet (kein Vorgänger)', () => {
  const runs = [{ text: ' führt' }, { text: 'weiter' }];
  const out = _normalizeRunWhitespace(runs);
  assert.deepEqual(out[0], { text: ' führt' });
});

test('\\n-Segmentbrüche bleiben erhalten und lösen kein Space-Splitting aus', () => {
  const runs = [
    { text: 'Zeile' },
    { text: '\n' },
    { text: ' zweite' },
  ];
  const out = _normalizeRunWhitespace(runs);
  assert.deepEqual(out, [
    { text: 'Zeile' },
    { text: '\n' },
    { text: ' zweite' },
  ]);
});

test('Runs ohne führenden Whitespace bleiben unverändert', () => {
  const runs = [
    { text: 'a ' },
    { text: 'b', bold: true },
    { text: ' c' },
  ];
  const out = _normalizeRunWhitespace(runs);
  // 'a ' endet auf Space → 'b' unverändert; ' c' → Split zu ' ' + 'c'
  assert.deepEqual(out, [
    { text: 'a ' },
    { text: 'b', bold: true },
    { text: ' ' },
    { text: 'c' },
  ]);
});
