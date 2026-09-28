// Verzeichnis-Export (public/js/sources/export.js): Lesefassungen im Stil,
// Linksammlung ohne Adresslose, und der Rundlauf der Austauschformate durch
// den eigenen Import (lib/bib-parse.js) — ein Export, den der Import nicht
// wieder auf dieselbe Quelle abbildet, waere fuer den Austausch wertlos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { exportSources, exportFileMeta, EXPORT_FORMATS } from '../../public/js/sources/export.js';

const require = createRequire(import.meta.url);
const { parseBib } = require('../../lib/bib-parse.js');

const SOURCES = [
  {
    id: 1, csl_type: 'book', title: 'The Scrum Guide', year: '2020', url: 'https://scrumguides.org',
    authors: [{ family: 'Schwaber', given: 'Ken' }, { family: 'Sutherland', given: 'Jeff' }],
    publisher: 'Scrum.org', tags: ['ZHAW', 'CAS AITPM'],
  },
  {
    id: 2, csl_type: 'article', title: 'Agile Führung', year: '2021', doi: '10.1000/xyz',
    authors: [{ family: 'Müller', given: 'Anna' }], container_title: 'HBR',
    volume: '3', issue: '2', pages: '44-46', tags: [],
  },
  {
    id: 3, csl_type: 'report', title: 'IT-Report <2022>', year: '2022',
    authors: [{ literal: 'Bundesamt für Statistik' }], publisher: 'BFS', place: 'Neuchâtel',
  },
];

test('Liste: alphabetisch im Stil, HTML mit Kursiv, Links und escapetem Feldtext', () => {
  const r = exportSources(SOURCES, { format: 'list', style: 'apa7', lang: 'de' });
  assert.equal(r.count, 3);
  const lines = r.text.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Bundesamt für Statistik/);
  assert.match(lines[2], /^Schwaber, K\., & Sutherland, J\. \(2020\)/);
  assert.match(r.html, /^<ul><li>/);
  assert.match(r.html, /<em>The Scrum Guide<\/em>/);
  assert.match(r.html, /<a href="https:\/\/doi\.org\/10\.1000\/xyz">/);
  assert.ok(r.html.includes('IT-Report &lt;2022&gt;'), 'Feldtext wird escapet');
  assert.ok(!r.html.includes('<2022>'));
});

test('Liste im numerischen Stil: nummeriert und als <ol>', () => {
  const r = exportSources(SOURCES, { format: 'list', style: 'numeric' });
  assert.match(r.text.split('\n')[0], /^\[1\] /);
  assert.match(r.html, /^<ol>/);
});

test('Markdown: Aufzaehlung, Kursiv als *…*, Adressen als Autolink', () => {
  const r = exportSources(SOURCES, { format: 'markdown' });
  const lines = r.text.split('\n');
  assert.ok(lines.every(l => l.startsWith('- ')));
  assert.ok(r.text.includes('*The Scrum Guide*'));
  assert.ok(r.text.includes('<https://scrumguides.org>'));
});

test('Linksammlung: nur Quellen mit DOI/URL, DOI vor URL, Rest als skipped', () => {
  const r = exportSources(SOURCES, { format: 'links' });
  assert.equal(r.count, 2);
  assert.equal(r.skipped, 1);
  assert.ok(r.text.includes('- Agile Führung (Müller, 2021): https://doi.org/10.1000/xyz'));
  assert.match(r.html, /<a href="https:\/\/scrumguides\.org">The Scrum Guide<\/a>/);
});

test('DOI und abweichende URL: Lesefassungen tragen beide Adressen, gleiche URL nur einmal', () => {
  const both = { ...SOURCES[1], url: 'https://hbr.org/agile' };
  const list = exportSources([both], { format: 'list', style: 'apa7' });
  assert.ok(list.text.endsWith('https://doi.org/10.1000/xyz https://hbr.org/agile'));
  assert.match(list.html, /<a href="https:\/\/hbr\.org\/agile">/);
  const md = exportSources([both], { format: 'markdown' });
  assert.ok(md.text.includes('<https://doi.org/10.1000/xyz> <https://hbr.org/agile>'));
  const links = exportSources([both], { format: 'links' });
  assert.ok(links.text.endsWith(': https://doi.org/10.1000/xyz · https://hbr.org/agile'));
  assert.match(links.html, / · <a href="https:\/\/hbr\.org\/agile">https:\/\/hbr\.org\/agile<\/a>/);
  const same = { ...SOURCES[1], url: 'https://doi.org/10.1000/xyz' };
  const once = exportSources([same], { format: 'list' }).text;
  assert.equal(once.split('https://doi.org/10.1000/xyz').length, 2, 'identische Adresse nicht doppelt');
});

test('BibTeX-Rundlauf durch den Import: Felder, Personen, Gattung, eindeutige Schluessel', () => {
  const twin = { ...SOURCES[1], id: 4, title: 'Agile Führung II' };   // gleicher Autor + Jahr
  const r = exportSources([...SOURCES, twin], { format: 'bibtex' });
  assert.ok(r.text.includes('keywords = {ZHAW, CAS AITPM}'));
  const back = parseBib('bibtex', r.text);
  assert.equal(back.length, 4);
  const keys = back.map(b => b.citekey);
  assert.equal(new Set(keys).size, 4, 'Schluessel innerhalb der Datei eindeutig');

  const scrum = back.find(b => b.title === 'The Scrum Guide');
  assert.equal(scrum.csl_type, 'book');
  assert.deepEqual(scrum.authors, [{ family: 'Schwaber', given: 'Ken' }, { family: 'Sutherland', given: 'Jeff' }]);
  assert.equal(scrum.url, 'https://scrumguides.org');
  const art = back.find(b => b.title === 'Agile Führung');
  assert.equal(art.csl_type, 'article');
  assert.equal(art.container_title, 'HBR');
  assert.equal(art.doi, '10.1000/xyz');
  const bfs = back.find(b => b.csl_type === 'report');
  assert.deepEqual(bfs.authors, [{ literal: 'Bundesamt für Statistik' }]);
  assert.equal(bfs.place, 'Neuchâtel');
});

test('RIS-Rundlauf durch den Import', () => {
  const r = exportSources(SOURCES, { format: 'ris' });
  assert.ok(r.text.includes('KW  - ZHAW'));
  const back = parseBib('ris', r.text);
  assert.equal(back.length, 3);
  const art = back.find(b => b.csl_type === 'article');
  assert.equal(art.container_title, 'HBR');
  assert.equal(art.pages, '44-46');
  assert.equal(art.volume, '3');
  const scrum = back.find(b => b.title === 'The Scrum Guide');
  assert.equal(scrum.publisher, 'Scrum.org');
});

test('CSL-JSON: gueltiges JSON, CSL-Typen, Jahr als date-parts, Schlagworte als keyword', () => {
  const items = JSON.parse(exportSources(SOURCES, { format: 'csl-json' }).text);
  const art = items.find(i => i.title === 'Agile Führung');
  assert.equal(art.type, 'article-journal');
  assert.deepEqual(art.issued, { 'date-parts': [[2021]] });
  assert.equal(items.find(i => i.title === 'The Scrum Guide').keyword, 'ZHAW, CAS AITPM');
});

test('Leere Auswahl liefert leeren Text, jedes Format hat Datei-Metadaten', () => {
  for (const format of EXPORT_FORMATS) {
    const r = exportSources([], { format });
    assert.equal(r.count, 0);
    assert.ok(exportFileMeta(format).ext, format);
  }
});
