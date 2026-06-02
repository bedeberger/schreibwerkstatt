// Tests fuer die pure VAD-/Insert-Compute-Helpers in
// editor/notebook/stt-dictation.js (RMS, Segment-Schnitt-Entscheidung,
// Mime-Wahl, Leerzeichen-Heuristik). DOM-/MediaRecorder-Pfade decken die
// E2E-Tests ab.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { sttDictationMethods: m } = await import('../../public/js/editor/notebook/stt-dictation.js');

// --- _computeRms ------------------------------------------------------------

test('_computeRms: Stille (alle 128) -> 0', () => {
  const buf = new Uint8Array(256).fill(128);
  assert.equal(m._computeRms(buf), 0);
});

test('_computeRms: Vollausschlag -> ~1', () => {
  const buf = new Uint8Array(256).fill(255);
  assert.ok(m._computeRms(buf) > 0.99);
});

test('_computeRms: leeres/fehlendes Sample -> 0', () => {
  assert.equal(m._computeRms(new Uint8Array(0)), 0);
  assert.equal(m._computeRms(null), 0);
});

// --- _computeVadCut ---------------------------------------------------------

const VAD = { threshold: 0.02, silenceMs: 800, maxSegmentS: 30 };

test('_computeVadCut: Sprache erkannt -> voiced, kein Cut', () => {
  const d = m._computeVadCut({
    rms: 0.1, ...VAD, now: 1000, segmentStart: 0, lastVoiceTs: 0, hasVoice: false,
  });
  assert.equal(d.voiced, true);
  assert.equal(d.cut, false);
});

test('_computeVadCut: Stille < silenceMs nach Sprache -> kein Cut', () => {
  const d = m._computeVadCut({
    rms: 0.001, ...VAD, now: 1500, segmentStart: 0, lastVoiceTs: 1000, hasVoice: true,
  });
  assert.equal(d.cut, false);
});

test('_computeVadCut: Stille >= silenceMs nach Sprache -> Cut (silence)', () => {
  const d = m._computeVadCut({
    rms: 0.001, ...VAD, now: 1900, segmentStart: 0, lastVoiceTs: 1000, hasVoice: true,
  });
  assert.equal(d.cut, true);
  assert.equal(d.reason, 'silence');
});

test('_computeVadCut: ohne erkannte Sprache nie Cut (reines Stille-Segment)', () => {
  const d = m._computeVadCut({
    rms: 0.001, ...VAD, now: 99999, segmentStart: 0, lastVoiceTs: 0, hasVoice: false,
  });
  assert.equal(d.cut, false);
});

test('_computeVadCut: Segment > maxSegmentS bei laufender Sprache -> Cut (max)', () => {
  const d = m._computeVadCut({
    rms: 0.1, ...VAD, now: 31000, segmentStart: 0, lastVoiceTs: 30000, hasVoice: true,
  });
  assert.equal(d.cut, true);
  assert.equal(d.reason, 'max');
});

// --- _computeSttMime --------------------------------------------------------

test('_computeSttMime: bevorzugt webm/opus', () => {
  assert.equal(m._computeSttMime(() => true), 'audio/webm;codecs=opus');
});

test('_computeSttMime: faellt auf mp4 wenn nur das unterstuetzt wird', () => {
  const mime = m._computeSttMime((c) => c === 'audio/mp4');
  assert.equal(mime, 'audio/mp4');
});

test('_computeSttMime: nichts unterstuetzt -> leerer String', () => {
  assert.equal(m._computeSttMime(() => false), '');
});

// --- _computeSpacedInsert ---------------------------------------------------

test('_computeSpacedInsert: fuegt Leerzeichen nach Wortzeichen ein', () => {
  assert.equal(m._computeSpacedInsert('t', 'Hallo'), ' Hallo');
});

test('_computeSpacedInsert: kein Leerzeichen nach Whitespace', () => {
  assert.equal(m._computeSpacedInsert(' ', 'Hallo'), 'Hallo');
});

test('_computeSpacedInsert: kein Leerzeichen wenn Text mit Satzzeichen beginnt', () => {
  assert.equal(m._computeSpacedInsert('t', ', dann'), ', dann');
  assert.equal(m._computeSpacedInsert('t', '. Punkt'), '. Punkt');
});

test('_computeSpacedInsert: kein prevChar (Zeilenanfang) -> kein Leerzeichen', () => {
  assert.equal(m._computeSpacedInsert('', 'Hallo'), 'Hallo');
});

test('_computeSpacedInsert: trimmt und liefert leer bei Whitespace-only', () => {
  assert.equal(m._computeSpacedInsert('t', '   '), '');
  assert.equal(m._computeSpacedInsert('t', '  Welt  '), ' Welt');
});
