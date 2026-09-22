// Abbildungs-Kette: die BEWUSSTEN Klassennamen-Kopien.
//
// Zwei Klassen aus dem Abbildungs-Markup leben ausserhalb ihrer SSoT, weil die
// Konsumenten sie nicht importieren KÖNNEN:
//
//   .figure-credit  — der Bildnachweis. CSS kann keine JS-Konstante lesen, und
//                     die drei Server-Renderer (PDF/DOCX-Walker, EPUB-CSS,
//                     HTML-Export-CSS) schreiben Selektoren als Textliterale.
//   .xref-num       — das Nummern-Badge der Leseansicht. Es MUSS in beiden
//                     Bereinigungsschichten stehen; fehlt es in einer, läuft die
//                     Vorschau-Nummer in die Persistenz.
//
// Sie dürfen existieren — aber nicht driften.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIGURE_CREDIT_CLASS, FIGURE_CREDIT_SEL } from '../../public/js/figure/figure-html.js';
import { XREF_NUM_CLASS, XREF_NUM_SEL } from '../../public/js/xrefs/caption-preview.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

test('SSoT: Klassenname und Selektor passen zueinander', () => {
  assert.equal(FIGURE_CREDIT_SEL, `p.${FIGURE_CREDIT_CLASS}`);
  assert.equal(XREF_NUM_SEL, `span.${XREF_NUM_CLASS}`);
});

// ── .figure-credit: wer den Nachweis darstellen muss ───────────────────────

const CREDIT_CONSUMERS = [
  // Ohne diesen Zweig fiele der Nachweis im PDF und im Custom-DOCX unter den
  // Tisch: der figure-Zweig des Walkers kehrt zurück, ohne die übrigen Kinder
  // der Abbildung zu besuchen.
  ['lib/pdf-render/html-walker.js', FIGURE_CREDIT_SEL],
  // Die drei Leseflächen der App (Notebook, Bucheditor, Share-Reader).
  ['public/css/components/manuscript-content.css', `.${FIGURE_CREDIT_CLASS}`],
  ['lib/export-builders/epub/css.js', FIGURE_CREDIT_SEL],
  ['lib/export-builders/html.js', FIGURE_CREDIT_SEL],
];

for (const [file, needle] of CREDIT_CONSUMERS) {
  test(`${file} kennt den Bildnachweis-Selektor`, () => {
    assert.ok(read(file).includes(needle),
      `${file} muss "${needle}" tragen — sonst verschwindet der Bildnachweis auf diesem Weg`);
  });
}

// ── .xref-num: wer das Badge wieder entfernen muss ─────────────────────────

const STRIP_LAYERS = [
  // Schreib-Chokepoint. Die tragende Schicht: was hier fällt, kann auf keinem
  // Schreibweg in pages.content landen.
  'lib/html-clean.js',
  // Dirty-Vergleichsform. Ohne sie gälte jede Seite mit Abbildung beim blossen
  // Hinsehen als verändert — Autosave, Revision und updated_at-Bump inklusive.
  'public/js/editor/shared/html-clean.js',
];

for (const file of STRIP_LAYERS) {
  test(`${file} strippt das Nummern-Badge`, () => {
    assert.ok(read(file).includes(XREF_NUM_CLASS),
      `${file} muss "${XREF_NUM_CLASS}" entfernen — sonst wandert die Vorschau-Nummer in den Text`);
  });
}

test('beide Strip-Schichten prüfen den Klassennamen auch im Vorab-Test', () => {
  // Beide Module nehmen einen Early-Return, wenn der Rohstring kein Artefakt
  // andeutet. Steht der Klassenname nur im Selektor und nicht in dieser
  // Bedingung, läuft der Filter nie — der Fehler ist von aussen unsichtbar,
  // weil Popover und contenteditable ihn zufällig mit auslösen können.
  for (const file of STRIP_LAYERS) {
    const src = read(file);
    assert.ok(src.includes(`indexOf('${XREF_NUM_CLASS}')`),
      `${file}: ${XREF_NUM_CLASS} fehlt im Vorab-Test (indexOf) — der Filter bliebe wirkungslos`);
  }
});
