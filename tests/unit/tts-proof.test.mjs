// Unit-Tests fuer die pure Satz-Segmentierung des Proof-Listening (TTS).
// `_computeTtsSentences` nutzt kein `this` und ist ohne Browser testbar.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ttsProofMethods } from '../../public/js/editor/notebook/tts-proof.js';

const split = (text, locale) => ttsProofMethods._computeTtsSentences(text, locale);

test('leerer / Whitespace-Text -> keine Segmente', () => {
  assert.deepEqual(split(''), []);
  assert.deepEqual(split('   \n  '), []);
  assert.deepEqual(split(null), []);
});

test('einzelner Satz -> eine Range ueber den ganzen Text', () => {
  const text = 'Das ist ein Satz.';
  const ranges = split(text, 'de');
  assert.equal(ranges.length, 1);
  const [s, e] = ranges[0];
  assert.equal(text.slice(s, e).trim(), 'Das ist ein Satz.');
});

test('mehrere Saetze werden getrennt', () => {
  const text = 'Erster Satz. Zweiter Satz! Dritter Satz?';
  const ranges = split(text, 'de');
  assert.equal(ranges.length, 3);
  assert.equal(text.slice(...ranges[0]).trim(), 'Erster Satz.');
  assert.equal(text.slice(...ranges[1]).trim(), 'Zweiter Satz!');
  assert.equal(text.slice(...ranges[2]).trim(), 'Dritter Satz?');
});

test('Ranges sind monoton aufsteigend und nicht ueberlappend', () => {
  const text = 'A. B. C. D.';
  const ranges = split(text, 'de');
  for (let i = 1; i < ranges.length; i++) {
    assert.ok(ranges[i][0] >= ranges[i - 1][1], `Range ${i} startet nicht vor Ende der vorigen`);
  }
});

test('Ranges decken den gesamten Text ab (kein verlorener Buchstabe)', () => {
  // Intl.Segmenter liefert zusammenhaengende Segmente; jeder Nicht-Whitespace-
  // Inhalt muss in genau einer Range landen — sonst wuerde ein Satz nie
  // vorgelesen. (Abkuerzungs-Handling ist runtime-abhaengig und best-effort,
  // darum hier keine Annahme ueber die exakte Satz-Anzahl.)
  const text = 'Ich mag Obst, z. B. Äpfel und Birnen. Und Gemüse.';
  const ranges = split(text, 'de');
  assert.ok(ranges.length >= 1);
  const covered = ranges.map(r => text.slice(...r)).join('');
  assert.equal(covered.replace(/\s/g, ''), text.replace(/\s/g, ''));
});

test('Text ohne Satzendezeichen -> eine Range', () => {
  const ranges = split('nur ein fragment ohne punkt', 'de');
  assert.equal(ranges.length, 1);
});
