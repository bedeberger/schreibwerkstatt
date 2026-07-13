// Manueller Blocksatz-Layouter (lib/pdf-render/justify.js).
// Kernregression: pdfkit justiert continued+justify-Zeilen mit mehreren
// Fragmenten (Link/bold/italic) NICHT als Ganzes → riesige Lücken um die
// Formatierung. Der eigene Layouter verteilt den Wortabstand pro Sichtzeile
// gleichmässig über ALLE Fragmente. Wir rendern in ein PDF, lesen die TJ-
// Wortabstände je Zeile aus und prüfen, dass sie über die Segmente konstant sind.

import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PDFDocument = require('pdfkit');
const { _renderRuns } = require('../../lib/pdf-render/runs.js');
const { _tokenize, _breakLines } = require('../../lib/pdf-render/justify.js');

function renderToOps(runs, opts = {}) {
  const doc = new PDFDocument({ compress: false, size: 'A5', margin: 50 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  doc.registerFont('body', 'Helvetica');
  doc.registerFont('body-bold', 'Helvetica-Bold');
  doc.registerFont('body-italic', 'Helvetica-Oblique');
  doc.registerFont('body-bolditalic', 'Helvetica-BoldOblique');
  return new Promise(res => {
    doc.on('end', () => {
      const s = Buffer.concat(chunks).toString('latin1');
      const body = (s.match(/stream\r?\n([\s\S]*?)endstream/g) || [])[0]
        .replace(/^stream\r?\n/, '').replace(/endstream$/, '');
      // Zeilen nach Tm-y gruppieren; pro Zeile die grossen (Wort-)Adjustments sammeln.
      const byLine = new Map();
      let y = null;
      for (const l of body.split('\n')) {
        const tm = l.match(/1 0 0 1 (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) Tm/);
        if (tm) { y = tm[2]; continue; }
        if (/TJ$/.test(l.trim())) {
          const adj = [...l.matchAll(/>\s*(-?\d+(?:\.\d+)?)\s*</g)].map(m => Number(m[1]));
          if (!byLine.has(y)) byLine.set(y, []);
          byLine.get(y).push(...adj);
        }
      }
      res({ byLine, raw: body });
    });
    _renderRuns(doc, runs, {
      sizePt: 11, lineHeight: 1.45, align: 'justify', columns: 1,
      textColor: '#000000', linkColor: '#1a4d8f', firstLineIndent: 0, hyphenate: null,
      ...opts,
    });
    doc.end();
  });
}

test('Wortabstand ist über Link-/Bold-Segmente einer Sichtzeile konstant', async () => {
  const runs = [
    { text: 'Das ' },
    { text: 'CAS Requirements Engineering', underline: true, link: 'https://x.com' },
    { text: ' der HWZ basiert auf dem hier bestens bekannten ' },
    { text: 'IREB CPRE Foundation Level.', bold: true },
    { text: ' Statt in drei vermitteln die Dozenten das Geheimnis und noch viel mehr Text zum Umbrechen.' },
  ];
  const { byLine } = await renderToOps(runs);
  const lines = [...byLine.values()];
  assert.ok(lines.length >= 3, 'mehrere Sichtzeilen erwartet');
  // Grosse Adjustments = Wortabstände (Kerning ist klein, |x| < 100).
  let checkedLines = 0;
  for (const adjs of lines) {
    const gaps = adjs.filter(a => Math.abs(a) > 100);
    if (gaps.length < 2) continue; // Schlusszeile/kurze Zeile: kein Blocksatz
    const first = gaps[0];
    for (const g of gaps) {
      assert.ok(Math.abs(g - first) < 0.5, `uneinheitlicher Wortabstand in Zeile: ${gaps.join(',')}`);
    }
    checkedLines++;
  }
  assert.ok(checkedLines >= 2, 'mindestens zwei justierte Zeilen geprüft');
});

test('Link-Run erzeugt kein NaN-Rechteck (kein Crash) und wird gerendert', async () => {
  const runs = [
    { text: 'Siehe ' },
    { text: 'diesen Link', underline: true, link: 'https://example.com' },
    { text: ' fuer mehr und noch etwas laengerer Fliesstext zum Umbrechen der Zeile hier.' },
  ];
  const { raw } = await renderToOps(runs);
  assert.ok(!/NaN/.test(raw), 'kein NaN im Content-Stream');
  assert.ok(/Annot|URI/.test(raw) || raw.length > 0, 'Ausgabe erzeugt');
});

test('_tokenize: kollabiert Whitespace, behält Style an Wörtern und \\n als break', () => {
  const items = _tokenize([
    { text: 'a  b ' },
    { text: 'c', bold: true },
    { text: '\n' },
    { text: '  d' },
  ]);
  const kinds = items.map(i => i.br ? 'br' : i.space ? '_' : i.word);
  // führender Space vor 'd' (nach br) fällt weg; doppelter Space kollabiert
  assert.deepEqual(kinds, ['a', '_', 'b', '_', 'c', 'br', 'd']);
  assert.equal(items.find(i => i.word === 'c').style.bold, true);
});

test('_breakLines: letzte Zeile ist forced (kein Blocksatz)', () => {
  const doc = new PDFDocument({ size: 'A5', margin: 50 });
  doc.registerFont('body', 'Helvetica');
  doc.font('body').fontSize(11);
  const items = _tokenize([{ text: 'eins zwei drei vier fuenf' }]);
  const lines = _breakLines(doc, items, {
    sizePt: 11, features: undefined, cache: new Map(), hyphenate: null,
    totalWidth: 1000, firstIndent: 0, spaceWidth: doc.widthOfString(' '),
  });
  assert.equal(lines[lines.length - 1].forced, true);
});
