// Kennungssuche der Quellen-Erfassung aus PDF (lib/source-pdf-ident.js) plus
// das Metadaten-Lesen (lib/pdf-extract.js#readPdfMeta) an einem echten, mit
// pdfkit erzeugten PDF. Kein Netz: der Register-Lookup ist Sache des Jobs
// (tests/integration/source-pdf-draft.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findDoiCandidates, findIsbnCandidates, isbnChecksumOk, titleInText, metaSearchStrings,
} = require('../../lib/source-pdf-ident.js');
const { readPdfMeta, extractPdfText } = require('../../lib/pdf-extract.js');

test('DOI: Satzzeichen und Satzklammer fallen weg, DOI-eigene Klammern bleiben', () => {
  assert.deepEqual(findDoiCandidates(['Siehe (doi:10.1000/xyz.123).']), ['10.1000/xyz.123']);
  assert.deepEqual(
    findDoiCandidates(['https://doi.org/10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0']),
    ['10.1002/(SICI)1097-4571(199806)49:8'],  // `<` beendet den Treffer, die Klammern sind balanciert
  );
  assert.deepEqual(findDoiCandidates(['DOI 10.1234/abc, 10.1234/ABC; 10.5555/zz']), ['10.1234/abc', '10.5555/zz']);
});

test('DOI: Metadaten vor Text, hoechstens drei Kandidaten', () => {
  const got = findDoiCandidates(['doi:10.1111/meta', 'Text 10.2222/a 10.3333/b 10.4444/c']);
  assert.deepEqual(got, ['10.1111/meta', '10.2222/a', '10.3333/b']);
});

test('ISBN: nur mit Pruefziffer, Bindestriche egal', () => {
  assert.equal(isbnChecksumOk('9783518281451'), true);
  assert.equal(isbnChecksumOk('9783518281452'), false);
  assert.equal(isbnChecksumOk('3518281453'), true);
  assert.equal(isbnChecksumOk('080442957X'), true);
  const text = 'Impressum\nISBN 978-3-518-28145-1\nISBN-10: 3-518-28145-3\nISBN 123-4567890 (Telefon)';
  assert.deepEqual(findIsbnCandidates(text), ['9783518281451', '3518281453']);
});

test('ISBN: das Literaturverzeichnis hinten wird nicht durchsucht', () => {
  const text = 'x '.repeat(15000) + 'ISBN 978-3-518-28145-1';
  assert.deepEqual(findIsbnCandidates(text), []);
});

test('titleInText: Titel muss im Textanfang stehen', () => {
  const text = 'Thomas S. Kuhn\nDie Struktur wissenschaftlicher\nRevolutionen\nSuhrkamp';
  assert.equal(titleInText('Die Struktur wissenschaftlicher Revolutionen', text), true);
  assert.equal(titleInText('Ein ganz anderes Werk ueber Paradigmen', text), false);
  assert.equal(titleInText('', text), false);
});

test('metaSearchStrings: nur einschlaegige Info-Felder plus XMP', () => {
  const got = metaSearchStrings(
    { Title: '10.9999/title-ist-kein-doi-feld', Subject: 'doi:10.1/s', doi: '10.1/d', Producer: 'x' },
    '<prism:doi>10.1/x</prism:doi>',
  );
  assert.deepEqual(got, ['doi:10.1/s', '10.1/d', '<prism:doi>10.1/x</prism:doi>']);
});

function makePdf({ info = {}, lines = [] }) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ info });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (const l of lines) doc.text(l);
    doc.end();
  });
}

test('readPdfMeta: DOI aus dem Info-Dictionary wird gefunden', async () => {
  const buf = await makePdf({
    info: { Title: 'Paradigmen', Subject: 'doi:10.4321/meta.42' },
    lines: ['Paradigmen im Wandel', 'Ein Aufsatz ohne DOI im Text.'],
  });
  const { info, xmp } = await readPdfMeta(buf);
  assert.equal(info.Title, 'Paradigmen');
  const { text } = await extractPdfText(buf);
  assert.deepEqual(findDoiCandidates([...metaSearchStrings(info, xmp), text]), ['10.4321/meta.42']);
});

test('readPdfMeta: kein PDF → leer statt Wurf', async () => {
  assert.deepEqual(await readPdfMeta(Buffer.from('kein pdf')), { info: {}, xmp: '' });
});

const { findPrintedUrl, pdfDateToIso } = require('../../lib/source-pdf-ident.js');

test('findPrintedUrl: Adresse aus der wiederholten Fusszeile, nicht aus dem Fliesstext', () => {
  const foot = '\n12.03.24, 14:05 Die Stadt wächst | NZZ\nhttps://www.nzz.ch/zuerich/die-stadt-ld.123 1/3\n';
  const text = `Text${foot}Laut https://example.org/studie.pdf steigt die Zahl.${foot}Ende${foot}`;
  assert.equal(findPrintedUrl(text), 'https://www.nzz.ch/zuerich/die-stadt-ld.123');
});

test('findPrintedUrl: einseitiger Druck — die einzige URL in Kopf oder Fuss', () => {
  assert.equal(findPrintedUrl('https://blog.example.org/beitrag\n' + 'x '.repeat(400)), 'https://blog.example.org/beitrag');
  assert.equal(findPrintedUrl('x '.repeat(400) + '\nhttps://blog.example.org/beitrag 1/1'), 'https://blog.example.org/beitrag');
});

test('findPrintedUrl: Link im Fliesstext, gekuerzte Adresse und doi.org zaehlen nicht', () => {
  assert.equal(findPrintedUrl('x '.repeat(300) + 'siehe https://example.org/studie ' + 'x '.repeat(300)), null);
  assert.equal(findPrintedUrl('https://www.nzz.ch/zuerich/die-sta… 1/2 https://www.nzz.ch/zuerich/die-sta… 2/2'), null);
  assert.equal(findPrintedUrl('https://doi.org/10.1/x … https://doi.org/10.1/x'), null);
  // Zwei verschiedene Adressen am Rand: nicht entscheidbar → keine.
  assert.equal(findPrintedUrl('https://a.example.org/x ' + 'y '.repeat(400) + ' https://b.example.org/y'), null);
});

test('pdfDateToIso: PDF-Datum → Tag, Unlesbares → null', () => {
  assert.equal(pdfDateToIso("D:20240312140500+01'00'"), '2024-03-12');
  assert.equal(pdfDateToIso('20240312'), '2024-03-12');
  assert.equal(pdfDateToIso('D:20241399'), null);
  assert.equal(pdfDateToIso(undefined), null);
});
