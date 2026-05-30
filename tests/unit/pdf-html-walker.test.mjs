import { test } from 'node:test';
import assert from 'node:assert';
import { parseHtmlToBlocks } from '../../lib/pdf-render/html-walker.js';

test('Heading + Paragraph + Inline-Stil', () => {
  const blocks = parseHtmlToBlocks('<h1>Kapitel 1</h1><p>Text mit <strong>fett</strong> und <em>kursiv</em>.</p>');
  assert.deepEqual(blocks[0], { kind: 'heading', level: 1, text: 'Kapitel 1' });
  assert.equal(blocks[1].kind, 'paragraph');
  const runs = blocks[1].runs;
  assert.equal(runs[0].text, 'Text mit ');
  assert.equal(runs[1].bold, true);
  assert.equal(runs[1].text, 'fett');
  assert.equal(runs[3].italic, true);
});

test('div.poem wird als poem-Block erkannt mit pro-Absatz-Linie', () => {
  const blocks = parseHtmlToBlocks(
    '<div class="poem"><p>Wenn nicht mehr Zahlen und Figuren</p><p>Sind Schlüssel aller Kreaturen</p></div>'
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'poem');
  assert.equal(blocks[0].lines.length, 2);
  assert.equal(blocks[0].lines[0][0].italic, true);
});

test('div.poem behält Strophen-Trenner (leere Absätze) als leere Zeilen', () => {
  const blocks = parseHtmlToBlocks(
    '<div class="poem"><p>Strophe eins A</p><p>Strophe eins B</p><p><br></p><p>Strophe zwei A</p><p>Strophe zwei B</p></div>'
  );
  assert.equal(blocks[0].kind, 'poem');
  assert.equal(blocks[0].lines.length, 5);
  assert.equal(blocks[0].lines[2].length, 0);
  assert.equal(blocks[0].lines[3][0].text, 'Strophe zwei A');
});

test('div.poem kollabiert führende/doppelte/schliessende Leerzeilen', () => {
  const blocks = parseHtmlToBlocks(
    '<div class="poem"><p><br></p><p>A</p><p><br></p><p><br></p><p>B</p><p><br></p></div>'
  );
  assert.equal(blocks[0].lines.length, 3);
  assert.equal(blocks[0].lines[0][0].text, 'A');
  assert.equal(blocks[0].lines[1].length, 0);
  assert.equal(blocks[0].lines[2][0].text, 'B');
});

test('Listen mit ordered/unordered + verschachtelte Inline-Styles', () => {
  const blocks = parseHtmlToBlocks('<ol><li>Eins</li><li>Zwei mit <em>kursiv</em></li></ol>');
  assert.equal(blocks[0].kind, 'list');
  assert.equal(blocks[0].ordered, true);
  assert.equal(blocks[0].items.length, 2);
});

test('Tabellen werden geskippt aber Inhalt als paragraph fallback', () => {
  const blocks = parseHtmlToBlocks('<table><tr><td>Zelle</td></tr></table>');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'paragraph');
});

test('Links bekommen underline + link', () => {
  const blocks = parseHtmlToBlocks('<p>Siehe <a href="https://x">hier</a>.</p>');
  const link = blocks[0].runs.find(r => r.link);
  assert.equal(link?.link, 'https://x');
  assert.equal(link?.underline, true);
});

test('hr und img werden als eigene Block-Typen erkannt', () => {
  const blocks = parseHtmlToBlocks('<hr><img src="/foo.png" alt="x">');
  assert.equal(blocks[0].kind, 'hr');
  assert.equal(blocks[1].kind, 'image');
  assert.equal(blocks[1].src, '/foo.png');
});

test('hr.pagebreak/blankpage werden erkannt (sonst hr)', () => {
  const blocks = parseHtmlToBlocks('<hr class="pagebreak"><hr class="blankpage"><hr>');
  assert.equal(blocks[0].kind, 'pagebreak');
  assert.equal(blocks[1].kind, 'blankpage');
  assert.equal(blocks[2].kind, 'hr');
});
