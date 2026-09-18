'use strict';
// `_sharesHyphenGlyph` (lib/pdf-render/fonts.js) — das Prädikat, an dem die
// Silbentrennung für eine Schrift abgeschaltet wird.
//
// Hintergrund: fontkit behandelt den Soft-Hyphen (U+00AD) als
// `default ignorable` und merkt sich diesen Entscheid pro GLYPH-ID statt pro
// Codepoint. Legt eine Schrift Soft-Hyphen und Bindestrich (U+002D) auf
// denselben Glyph, gilt nach dem ersten Soft-Hyphen auch jeder echte
// Bindestrich als ignorierbar — getrennte Wörter zerfallen dann still in zwei
// Teile. Gemessen wurde das an der ganzen Schrift-Whitelist: betroffen sind
// genau die zwölf Schnitte von «Source Serif 4» und «Source Sans 3»
// (alle Gewichte UND Kursiven), alle übrigen Familien führen zwei Glyphen.
//
// Der Test arbeitet mit Stub-Schriften statt echten TTFs: das Prädikat ist eine
// reine Eigenschaftsabfrage, und ein Test, der Google-Fonts lädt, wäre in CI
// vom Netz abhängig. Die Zuordnung Familie → betroffen ist eine Messung, keine
// Invariante — sie gehört nicht in ein Gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const { _sharesHyphenGlyph } = require('../../lib/pdf-render/fonts');

const SHY = 0x00ad;
const HYPHEN = 0x002d;

// Minimaler fontkit-Ersatz: liefert je Codepoint ein Objekt mit `id`.
function stubFont(map) {
  return { glyphForCodePoint: (cp) => (cp in map ? { id: map[cp] } : null) };
}

test('geteilter Glyph wird erkannt (Muster Source Serif 4 / Source Sans 3)', () => {
  assert.equal(_sharesHyphenGlyph(stubFont({ [SHY]: 178, [HYPHEN]: 178 })), true);
});

test('getrennte Glyphen sind unauffällig (Muster EB Garamond)', () => {
  assert.equal(_sharesHyphenGlyph(stubFont({ [SHY]: 229, [HYPHEN]: 228 })), false);
});

test('Schrift ohne Soft-Hyphen-Glyph ist unauffällig', () => {
  // Muster Lora/Spectral/Inter: die cmap kennt U+00AD gar nicht. Dort greift
  // fontkits Ersetzung durch den Leerzeichen-Glyph, und der Bindestrich bleibt
  // unangetastet.
  assert.equal(_sharesHyphenGlyph(stubFont({ [HYPHEN]: 162 })), false);
});

test('Schrift ohne Bindestrich-Glyph ist unauffällig', () => {
  assert.equal(_sharesHyphenGlyph(stubFont({ [SHY]: 178 })), false);
});

test('Glyph-ID 0 (.notdef) zählt nicht als Treffer', () => {
  // Beide auf .notdef hiesse: die Schrift kennt keines der beiden Zeichen.
  // Das ist kein Trennungs-Befund, sondern ein Schriftproblem anderer Art —
  // und `0 === 0` darf die Trennung nicht buchweit abschalten.
  assert.equal(_sharesHyphenGlyph(stubFont({ [SHY]: 0, [HYPHEN]: 0 })), false);
});

test('eine Schrift, die den Lookup verweigert, ist kein Befund', () => {
  const throwing = { glyphForCodePoint() { throw new Error('kaputt'); } };
  assert.equal(_sharesHyphenGlyph(throwing), false);
  // Und ein Objekt ganz ohne die Methode ebenfalls nicht.
  assert.equal(_sharesHyphenGlyph({}), false);
});
