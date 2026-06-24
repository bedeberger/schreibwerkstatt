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

// ── Kurz-Satz-Buendelung (XTTS-Halluzinations-Schutz) ──────────────────────
const coalesce = (ranges, text, minLen) =>
  ttsProofMethods._coalesceTtsRanges(ranges, text, minLen);

test('kurze Folgesaetze werden bis zur Schwelle gebuendelt', () => {
  const text = 'Ja. Nein. Vielleicht doch nicht.';
  const ranges = split(text, 'de');
  const chunks = coalesce(ranges, text, 20);
  // Alle drei Fragmente sind < 20 Zeichen -> ein einziger Chunk.
  assert.equal(chunks.length, 1);
  assert.equal(text.slice(...chunks[0]).trim(), text.trim());
});

test('normale Saetze (>= Schwelle) bleiben einzeln', () => {
  const a = 'Am frühen Morgen ging die alte Frau langsam über den Marktplatz.';
  const b = 'Der Brunnen plätscherte leise und beruhigend in der Stille des Hofs.';
  const text = `${a} ${b}`;
  const ranges = split(text, 'de');
  const chunks = coalesce(ranges, text, 60);
  assert.equal(chunks.length, 2);
  assert.equal(text.slice(...chunks[0]).trim(), a);
  assert.equal(text.slice(...chunks[1]).trim(), b);
});

test('zu kurzer Rest am Ende wird in den Vorgaenger gezogen', () => {
  const a = 'Am frühen Morgen ging die alte Frau langsam über den Marktplatz.';
  const text = `${a} Ja.`;
  const ranges = split(text, 'de');
  const chunks = coalesce(ranges, text, 60);
  // „Ja." allein wuerde halluzinieren -> an den langen Vorsatz angehaengt.
  assert.equal(chunks.length, 1);
  assert.equal(text.slice(...chunks[0]).trim(), text.trim());
});

test('Buendelung verliert keinen Inhalt und bleibt monoton', () => {
  const text = 'A. Bee. Cee dee. Eff gee haa ii. Jott. Kah ell emm enn oo pee.';
  const ranges = split(text, 'de');
  const chunks = coalesce(ranges, text, 30);
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i][0] >= chunks[i - 1][1], `Chunk ${i} ueberlappt`);
  }
  const covered = chunks.map(r => text.slice(...r)).join('');
  assert.equal(covered.replace(/\s/g, ''), text.replace(/\s/g, ''));
});

test('eine einzelne Range bleibt unveraendert', () => {
  const text = 'Nur ein Satz hier.';
  const ranges = split(text, 'de');
  assert.deepEqual(coalesce(ranges, text, 60), ranges);
});

// ── Lang-Satz-Splitting (Stall-/„Absturz"-Schutz bei Monster-Saetzen) ──────
const splitLong = (range, text, maxLen) =>
  ttsProofMethods._splitLongRange(range, text, maxLen);
const chunk = (ranges, text, minLen, maxLen) =>
  ttsProofMethods._chunkTtsRanges(ranges, text, minLen, maxLen);

test('zu langer Satz wird an Klauselgrenzen unter maxLen zerlegt', () => {
  const text = 'Er schmollte jeweils und bestrafte Sandra, indem er ihre Verabredungen platzen liess; er interagierte mehr mit seinen Kollegen, die heimlich litten - was aber niemand benennen konnte.';
  const parts = splitLong([0, text.length], text, 60);
  assert.ok(parts.length >= 3, 'lange Range muss mehrfach geteilt werden');
  for (const r of parts) {
    assert.ok(text.slice(...r).trim().length <= 60, `Teilstueck zu lang: ${text.slice(...r)}`);
  }
  // contiguous + verlustfrei
  for (let i = 1; i < parts.length; i++) assert.equal(parts[i][0], parts[i - 1][1]);
  assert.equal(parts.map(r => text.slice(...r)).join(''), text);
});

test('Intra-Wort-Bindestriche werden nicht als Klauselgrenze genutzt', () => {
  // „Midlife-Krise"/„Usego-Gebäude" duerfen nicht mitten im Wort getrennt werden;
  // nur freistehende Striche ( - ) zaehlen. Ueber maxLen erzwingt das einen Split.
  const text = 'Das Usego-Gebäude und die Midlife-Krise und der Hebammen-Job des Mannes blieben unbenannt im Raum.';
  const parts = splitLong([0, text.length], text, 50);
  for (const r of parts) {
    const t = text.slice(...r);
    assert.ok(!/\w-$/.test(t.trim()), `Schnitt mitten im Bindestrich-Wort: ${JSON.stringify(t)}`);
  }
  assert.equal(parts.map(r => text.slice(...r)).join(''), text);
});

test('_chunkTtsRanges deckelt lange UND buendelt kurze Saetze', () => {
  const long = 'Er schmollte jeweils und bestrafte Sandra, indem er ihre Verabredungen platzen liess; er interagierte mehr mit den Kollegen, die heimlich litten, was niemand benennen konnte.';
  const text = `Ja. ${long}`;
  const ranges = split(text, 'de');
  const chunks = chunk(ranges, text, 60, 80);
  for (const r of chunks) {
    assert.ok(text.slice(...r).trim().length <= 80, `Chunk ueber maxLen: ${text.slice(...r)}`);
  }
  // verlustfrei + monoton
  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i][0] >= chunks[i - 1][1]);
  assert.equal(
    chunks.map(r => text.slice(...r)).join('').replace(/\s/g, ''),
    text.replace(/\s/g, ''),
  );
});

test('_coalesceTtsRanges mit maxLen buendelt nie ueber die Grenze', () => {
  const a = 'Am Morgen ging sie los.';
  const b = 'Der Brunnen war still.';
  const c = 'Ja.';
  const text = `${a} ${b} ${c}`;
  // ohne maxLen wuerde „Ja." an b angehaengt; mit knappem maxLen darf das nicht passieren
  const chunks = ttsProofMethods._coalesceTtsRanges(split(text, 'de'), text, 60, 25);
  for (const r of chunks) {
    assert.ok(text.slice(...r).trim().length <= 25, `ueber maxLen: ${text.slice(...r)}`);
  }
});

test('Satzzeichen bleiben im gesendeten Chunk erhalten (Betonung)', () => {
  const text = 'Ja! Was nun? Er ging. Am Ende blieb nur die Stille des Abends zurück.';
  const ranges = split(text, 'de');
  const chunks = coalesce(ranges, text, 60);
  // Kurze Fragmente werden gebuendelt -> ein Chunk; alle inneren + finalen
  // Satzzeichen muessen wortwoertlich drinbleiben, sonst fehlt XTTS die Prosodie.
  const sent = chunks.map(r => text.slice(...r).trim());
  const all = sent.join(' ');
  assert.ok(all.includes('Ja!'), 'Ausrufezeichen fehlt');
  assert.ok(all.includes('Was nun?'), 'Fragezeichen fehlt');
  assert.ok(all.includes('Er ging.'), 'Punkt fehlt');
  assert.ok(/[.!?]$/.test(sent[sent.length - 1]), 'finales Satzzeichen fehlt');
});
