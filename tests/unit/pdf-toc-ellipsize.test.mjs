// TOC-Einträge sind einzeilig: zu breite Titel werden mit Ellipse gekürzt statt
// umzubrechen (pdfkit honoriert `lineBreak:false` nicht, sobald `width` gesetzt
// ist). Testet den reinen Kürzungs-Helper mit einem Stub-Doc, dessen
// widthOfString proportional zur Zeichenzahl misst (1 Zeichen = 10 pt, '…' = 10).

import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';

process.env.DB_PATH = path.join('/tmp', `pdf-toc-ellipsize-${process.pid}-${Date.now()}.db`);
await import('../../db/schema.js');
const { _ellipsize } = await import('../../lib/pdf-render/pages.js');

// Monospace-Stub: jede Position 10 pt breit (auch '…').
const doc = { widthOfString: (s) => String(s).length * 10 };

test('kurzer Titel bleibt unverändert (passt in die Spalte)', () => {
  assert.equal(_ellipsize(doc, 'Kapitel 1', 1000), 'Kapitel 1');
});

test('zu breiter Titel wird gekürzt und endet mit Ellipse', () => {
  // maxW=100 → 10 Zeichen inkl. '…'. "Ein langer Titel" (16) kürzen bis
  // cut+'…' ≤ 100 → 9 Zeichen + '…'.
  const out = _ellipsize(doc, 'Ein langer Titel', 100);
  assert.ok(out.endsWith('…'), `erwartet Ellipse am Ende, war "${out}"`);
  assert.ok(doc.widthOfString(out) <= 100, 'Ergebnis muss in maxW passen');
  assert.equal(out, 'Ein lange…');
});

test('trailing Whitespace vor der Ellipse wird entfernt', () => {
  // Grenzfall: Schnitt landet auf einem Space → soll nicht "wort …" ergeben.
  const out = _ellipsize(doc, 'abcde fghij', 70); // 7 Zeichen inkl. '…' → 6 Zeichen cut
  assert.ok(!/\s…$/.test(out), `kein Space vor Ellipse, war "${out}"`);
  assert.ok(out.endsWith('…'));
});

test('maxW <= 0 liefert leeren String (keine negative Spalte rendern)', () => {
  assert.equal(_ellipsize(doc, 'egal', 0), '');
  assert.equal(_ellipsize(doc, 'egal', -5), '');
});

test('nullish Titel wird als leerer String behandelt', () => {
  assert.equal(_ellipsize(doc, null, 100), '');
  assert.equal(_ellipsize(doc, undefined, 100), '');
});
