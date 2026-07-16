// SSoT-Contract der pure TTS-Segmentierung (public/js/tts-segment.js). Direkt
// importiert vom Share-Reader-Dock (share-reader/tts.js) UND — via Delegation —
// vom Notebook-Dock (editor/notebook/tts-proof.js). Die tiefergehenden
// Zerlege-Faelle deckt tts-proof.test.mjs ab; hier wird die geteilte
// Import-Oberflaeche + das Zusammenspiel der Schritte fixiert.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTtsSentences, coalesceTtsRanges, splitLongRange, chunkTtsRanges,
  normalizeForSpeech, TTS_MIN_CHUNK_CHARS, TTS_MAX_CHUNK_CHARS,
} from '../../public/js/tts-segment.js';

test('Named-Exports vorhanden (Reader-Import-Oberflaeche)', () => {
  assert.equal(typeof computeTtsSentences, 'function');
  assert.equal(typeof coalesceTtsRanges, 'function');
  assert.equal(typeof splitLongRange, 'function');
  assert.equal(typeof chunkTtsRanges, 'function');
  assert.equal(typeof normalizeForSpeech, 'function');
  assert.ok(TTS_MIN_CHUNK_CHARS > 0 && TTS_MAX_CHUNK_CHARS > TTS_MIN_CHUNK_CHARS);
});

test('computeTtsSentences trennt Saetze, chunkTtsRanges deckt den Text luecklos ab', () => {
  const text = 'Erster Satz. Zweiter Satz! Dritter Satz?';
  const sents = computeTtsSentences(text, 'de');
  assert.equal(sents.length, 3);
  const chunks = chunkTtsRanges(sents, text);
  // Contiguous + vollstaendig (getrimmt) — kein verlorener Buchstabe.
  const joined = chunks.map(([s, e]) => text.slice(s, e)).join('');
  assert.equal(joined.replace(/\s+/g, ' ').trim(), text.replace(/\s+/g, ' ').trim());
});

test('normalizeForSpeech ersetzt Guillemets, laesst Offsets-Laenge stabil', () => {
  const src = '«Hallo», ‹sagte› er.';
  const out = normalizeForSpeech(src);
  assert.equal(out, '"Hallo", \'sagte\' er.');
  assert.equal(out.length, src.length); // 1:1-Ersetzung -> Highlight-Offsets bleiben gueltig
});
