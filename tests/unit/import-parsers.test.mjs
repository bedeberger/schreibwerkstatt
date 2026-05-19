import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import JSZip from 'jszip';

const require = createRequire(import.meta.url);
const { parseOdt } = require('../../lib/import-parsers/odt');
const { parseAbw } = require('../../lib/import-parsers/abw');
const { parseImportFile, extOf, SUPPORTED_EXTS } = require('../../lib/import-parsers/dispatch');

async function buildOdt(contentXml) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text');
  zip.file('content.xml', contentXml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('parseOdt: einfacher Absatz', async () => {
  const xml = `<?xml version="1.0"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body><office:text>
    <text:p>Hallo Welt.</text:p>
  </office:text></office:body>
</office:document-content>`;
  const buf = await buildOdt(xml);
  const r = await parseOdt(buf);
  assert.equal(r.html, '<p>Hallo Welt.</p>');
});

test('parseOdt: Überschrift mit outline-level', async () => {
  const xml = `<?xml version="1.0"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body><office:text>
    <text:h text:outline-level="2">Titel</text:h>
    <text:p>Inhalt</text:p>
  </office:text></office:body>
</office:document-content>`;
  const buf = await buildOdt(xml);
  const r = await parseOdt(buf);
  assert.equal(r.html, '<h2>Titel</h2><p>Inhalt</p>');
});

test('parseOdt: Liste', async () => {
  const xml = `<?xml version="1.0"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body><office:text>
    <text:list><text:list-item><text:p>Eins</text:p></text:list-item><text:list-item><text:p>Zwei</text:p></text:list-item></text:list>
  </office:text></office:body>
</office:document-content>`;
  const buf = await buildOdt(xml);
  const r = await parseOdt(buf);
  assert.equal(r.html, '<ul><li>Eins</li><li>Zwei</li></ul>');
});

test('parseOdt: fetter Span via Style-Lookup', async () => {
  const xml = `<?xml version="1.0"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0">
  <office:automatic-styles>
    <style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
  </office:automatic-styles>
  <office:body><office:text>
    <text:p>Ein <text:span text:style-name="T1">fettes</text:span> Wort.</text:p>
  </office:text></office:body>
</office:document-content>`;
  const buf = await buildOdt(xml);
  const r = await parseOdt(buf);
  assert.match(r.html, /<strong>fettes<\/strong>/);
});

test('parseOdt: leeres Body liefert Default-Absatz', async () => {
  const xml = `<?xml version="1.0"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body><office:text></office:text></office:body>
</office:document-content>`;
  const buf = await buildOdt(xml);
  const r = await parseOdt(buf);
  assert.equal(r.html, '<p></p>');
});

test('parseOdt: missing content.xml wirft', async () => {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(parseOdt(buf), /ODT missing content.xml/);
});

test('extOf: lowercase + leer', () => {
  assert.equal(extOf('foo.DOCX'), 'docx');
  assert.equal(extOf('bar.odt'), 'odt');
  assert.equal(extOf('noext'), '');
});

test('parseImportFile: unsupported ext liefert null', async () => {
  const r = await parseImportFile('x.txt', Buffer.from('hi'));
  assert.equal(r, null);
});

test('SUPPORTED_EXTS: docx + odt + abw + doc', () => {
  assert.equal(SUPPORTED_EXTS.has('docx'), true);
  assert.equal(SUPPORTED_EXTS.has('odt'), true);
  assert.equal(SUPPORTED_EXTS.has('abw'), true);
  assert.equal(SUPPORTED_EXTS.has('doc'), true);
  assert.equal(SUPPORTED_EXTS.has('rtf'), false);
  assert.equal(SUPPORTED_EXTS.has('txt'), false);
});

test('parseAbw: Heading + Absatz + fetter <c>', async () => {
  const abw = `<?xml version="1.0"?>
<abiword version="1.0">
  <styles>
    <s type="P" name="Heading 1" props="font-size:18pt"/>
  </styles>
  <section>
    <p style="Heading 1">Titel</p>
    <p>05.03.2024</p>
    <p>Erster <c props="font-weight:bold">fetter</c> Absatz.</p>
  </section>
</abiword>`;
  const r = await parseAbw(Buffer.from(abw, 'utf8'));
  assert.match(r.html, /<h1>Titel<\/h1>/);
  assert.match(r.html, /<p>05\.03\.2024<\/p>/);
  assert.match(r.html, /<strong>fetter<\/strong>/);
});

test('parseAbw: kursiv via font-style:italic', async () => {
  const abw = `<?xml version="1.0"?>
<abiword><section>
  <p>Ein <c props="font-style:italic">kursives</c> Wort.</p>
</section></abiword>`;
  const r = await parseAbw(Buffer.from(abw, 'utf8'));
  assert.match(r.html, /<em>kursives<\/em>/);
});

test('parseAbw: leeres section liefert Default', async () => {
  const r = await parseAbw(Buffer.from('<abiword><section></section></abiword>', 'utf8'));
  assert.equal(r.html, '<p></p>');
});

test('parseImportFile: .abw wird dispatched', async () => {
  const abw = `<abiword><section><p>Hallo.</p></section></abiword>`;
  const r = await parseImportFile('foo.abw', Buffer.from(abw, 'utf8'));
  assert.match(r.html, /<p>Hallo\.<\/p>/);
});
