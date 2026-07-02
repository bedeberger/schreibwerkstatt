// Gate gegen Icon-Grössen-Drift auf Icon-only Action-/Close-Buttons.
//
// Hintergrund: <svg.icon> ist per Default 1em, skaliert also mit der font-size
// des Buttons. Die Close-/Action-Buttons der App setzen aber je eigene
// font-sizes (Card-Close 18px, Toast 16px, Find 15px, Synonym/Figur ~17.6px,
// Heatmap 13px …) → die Glyphen sind unterschiedlich gross, besonders sichtbar
// mobil (@media (pointer: coarse) bläst den Tap-Target auf 40px, das Glyph aber
// bleibt seiner font-size ausgeliefert). components/icon-btn.css normalisiert
// darum die Glyph-Grösse (`> .icon { width/height: var(--icon-size-action) }`).
//
// Invariante (der eigentliche Bug): ein Button, der mobil auf 40px Tap-Target
// wächst, dessen Glyph aber seiner eigenen font-size ausgeliefert bleibt, sieht
// im vergrösserten Target fehlgrossgross aus. Also MUSS jeder Button im
// @media (pointer: coarse)-Tap-Target-Block auch eine normalisierte Glyph-Grösse
// haben: coarse-Set ⊆ Normalisierungs-Set. Die Umkehrung gilt bewusst NICHT —
// ein Button darf glyph-normalisiert sein, ohne 40px-Target zu brauchen (z.B.
// `.search-clear--icon`, absolut im Suchfeld positioniert, wo 40px die Box
// sprengen würde). Wer einen enlarge-Button ohne Glyph-Norm einträgt: CI rot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const ICON_BTN_CSS = REPO_ROOT + 'public/css/components/icon-btn.css';
const TYPOGRAPHY_CSS = REPO_ROOT + 'public/css/tokens/typography.css';

// Kommentare strippen — sie enthalten selbst Klassen-artige Tokens
// (`.icon`, `.test.mjs` in Datei-Refs), die die Selektor-Extraktion vergiften.
const css = readFileSync(ICON_BTN_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Klassennamen aus einer Selektor-Liste ziehen (`.foo > .icon,` bzw. `.foo,`),
// die Glyph-Klasse `.icon` selbst rausfiltern.
function classesFromSelectorList(list) {
  return new Set(
    (list.match(/\.[a-zA-Z][\w-]*/g) || [])
      .map((s) => s.slice(1))
      .filter((c) => c !== 'icon'),
  );
}

// Block 1: die Glyph-Normalisierungs-Regel (`… > .icon { width: var(--icon-size-action) … }`)
const normMatch = css.match(/([^{}]*>\s*\.icon[^{}]*)\{\s*width:\s*var\(--icon-size-action\)/);
assert.ok(normMatch, 'Glyph-Normalisierungs-Regel mit var(--icon-size-action) fehlt in icon-btn.css');
const normClasses = classesFromSelectorList(normMatch[1]);

// Block 2: der @media (pointer: coarse) Tap-Target-Block
const coarseMatch = css.match(/@media\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\{\s*min-width:\s*40px/);
assert.ok(coarseMatch, '@media (pointer: coarse) Tap-Target-Block fehlt in icon-btn.css');
const coarseClasses = classesFromSelectorList(coarseMatch[1]);

test('Icon-only-Button-Listen: Tap-Target-Set ⊆ Glyph-Normalisierung', () => {
  const enlargedWithoutNorm = [...coarseClasses].filter((c) => !normClasses.has(c));
  assert.deepEqual(
    enlargedWithoutNorm,
    [],
    `Diese Buttons bekommen mobil einen 40px-Tap-Target, aber KEINE normalisierte Glyph-Grösse (Icon sieht im vergrösserten Target fehlgross aus): ${enlargedWithoutNorm.join(', ')}`,
  );
  assert.ok(normClasses.size >= coarseClasses.size, 'Normalisierungs-Set muss das Tap-Target-Set umfassen');
  assert.ok(normClasses.size >= 10, 'Erwartet mindestens die bekannten Icon-only-Buttons in der Normalisierungs-Liste');
});

test('--icon-size-action Token ist definiert', () => {
  const typo = readFileSync(TYPOGRAPHY_CSS, 'utf8');
  assert.match(typo, /--icon-size-action:\s*\d+px/, '--icon-size-action muss in tokens/typography.css definiert sein');
});
