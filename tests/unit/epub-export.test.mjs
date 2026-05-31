import { test } from 'node:test';
import assert from 'node:assert/strict';
import epub from '../../lib/export-builders/epub.js';

const { _resolveEpubMeta, _countUnfetchableImages, _buildFrontmatter, _buildBackmatter, _proseToXhtml, buildEpub, _buildOpfExtraMeta, _buildContentOPF, _applyBreaks } = epub;

test('_applyBreaks: Editor-hr nach Klasse → pagebreak/blankpage/Szenentrenner', () => {
  const html = '<hr class="pagebreak" data-bid="a1">x'
    + '<hr class="blankpage" data-bid="b2">y'
    + '<hr data-bid="c3">z';
  const out = _applyBreaks(html, 'stars');
  assert.equal(out.match(/<hr class="pagebreak" \/>/g).length, 1);
  // Blankpage-Div traegt ein U+00A0, damit Reader die leere Seite nicht kollabieren.
  assert.equal(out.match(/<div class="blankpage">[^<]*<\/div>/g).length, 1);
  // Plain-hr (kein Break-Marker) → konfigurierter Szenentrenner.
  assert.ok(out.includes('<p class="scene-sep">* * *</p>'));
});

test('_applyBreaks: unbekannter sceneSep → line-Default, leeres html durchgereicht', () => {
  assert.equal(_applyBreaks('', 'stars'), '');
  assert.ok(_applyBreaks('<hr data-bid="x">', 'bogus').includes('<hr class="scene-line" />'));
});

test('_applyBreaks: Leerzeile → scene-gap nur bei aktivem Einzug (Belletristik)', () => {
  // indentActive=true: leerer Absatz wird Szenentrenner-Leerzeile.
  const on = _applyBreaks('<p>A</p><p data-bid="x"></p><p>B</p>', 'line', true);
  assert.ok(on.includes('<p class="scene-gap">&#160;</p>'));
  // indentActive=false (Sachbuch-Satz): unangetastet, Absatzabstand trennt selbst.
  const off = _applyBreaks('<p>A</p><p></p><p>B</p>', 'line', false);
  assert.ok(!off.includes('scene-gap'));
});

test('_applyBreaks: scene-gaps kollabieren + führend/abschliessend entfernt', () => {
  const out = _applyBreaks('<p><br></p><p>A</p><p></p><p><br></p><p>B</p><p></p>', 'line', true);
  assert.equal(out.match(/scene-gap/g).length, 1);
  assert.ok(out.startsWith('<p>A</p>'));
  assert.ok(out.endsWith('<p>B</p>'));
});

test('_buildCss: scene-gap-Regel nur im Belletristik-Satz', () => {
  assert.ok(epub._buildCss({}).includes('.scene-gap + p'));
  assert.ok(!epub._buildCss({ epub_paragraph_style: 'spaced' }).includes('.scene-gap'));
});

test('_resolveEpubMeta: opts.author/lang gewinnen vor Domain-Shape', () => {
  const m = _resolveEpubMeta({ created_by: { name: 'Alt' } }, { author: 'Owner Name', lang: 'en' });
  assert.equal(m.author, 'Owner Name');
  assert.equal(m.lang, 'en');
  assert.equal(m.tocTitle, 'Contents');
});

test('_resolveEpubMeta: Fallback auf created_by/owned_by wenn keine opts', () => {
  assert.equal(_resolveEpubMeta({ created_by: { name: 'A' } }, {}).author, 'A');
  assert.equal(_resolveEpubMeta({ owned_by: { name: 'B' } }, {}).author, 'B');
});

test('_resolveEpubMeta: Default de + Inhalt, kein Autor', () => {
  const m = _resolveEpubMeta(null, {});
  assert.equal(m.lang, 'de');
  assert.equal(m.tocTitle, 'Inhalt');
  assert.equal(m.author, '');
});

test('_resolveEpubMeta: tocTitle-Override schlaegt Sprach-Default', () => {
  assert.equal(_resolveEpubMeta(null, { lang: 'en', tocTitle: 'Index' }).tocTitle, 'Index');
});

test('_resolveEpubMeta: nur en-Praefix triggert Contents, sonst Inhalt', () => {
  assert.equal(_resolveEpubMeta(null, { lang: 'en-US' }).tocTitle, 'Contents');
  assert.equal(_resolveEpubMeta(null, { lang: 'de-CH' }).tocTitle, 'Inhalt');
  assert.equal(_resolveEpubMeta(null, { lang: 'fr' }).tocTitle, 'Inhalt');
});

test('_countUnfetchableImages: zaehlt nur non-http/non-data src', () => {
  const chapters = [
    { content: '<p>x</p><img src="https://a.com/x.jpg"><img src="data:image/png;base64,AAA">' },
    { content: '<img src="/local/rel.png"> und <img src="cover.jpg">' },
    { content: '<img SRC = "HTTP://b.com/y.png">' },
  ];
  // 2 unfetchbar: /local/rel.png + cover.jpg. http(s) + data + HTTP zaehlen nicht.
  assert.equal(_countUnfetchableImages(chapters), 2);
});

test('_countUnfetchableImages: leere/keine Bilder -> 0', () => {
  assert.equal(_countUnfetchableImages([{ content: '<p>kein Bild</p>' }, { content: '' }, {}]), 0);
});

test('_proseToXhtml: escaped, Doppel-Umbruch=Absatz, Einzel=<br/>', () => {
  assert.equal(_proseToXhtml('a\n\nb'), '<p>a</p>\n<p>b</p>');
  assert.equal(_proseToXhtml('a\nb'), '<p>a<br/>b</p>');
  assert.equal(_proseToXhtml('<b>&'), '<p>&lt;b&gt;&amp;</p>');
  assert.equal(_proseToXhtml('   '), '');
});

test('_buildFrontmatter: Titelseite immer, Rest konditional, alle __toc:false + beforeToc', () => {
  const f = _buildFrontmatter({ subtitle: 'Sub', year: '2026', dedication: 'Fuer X', imprint: 'Verlag', isbn: '123', copyright: '© 2026' }, { title: 'Buch', author: 'Autor', lang: 'de' });
  assert.ok(f.every(e => e.__toc === false && e.beforeToc === true));
  assert.equal(f[0].filename, 'front_title.xhtml');
  assert.ok(f[0].content.includes('Buch') && f[0].content.includes('Sub') && f[0].content.includes('Autor') && f[0].content.includes('2026'));
  const files = f.map(e => e.filename);
  assert.ok(files.includes('front_imprint.xhtml') && files.includes('front_dedication.xhtml'));
  assert.ok(f.find(e => e.filename === 'front_imprint.xhtml').content.includes('ISBN: 123'));
});

test('_buildFrontmatter: nur Titelseite wenn keine Meta', () => {
  const f = _buildFrontmatter(null, { title: 'B', author: '', lang: 'en' });
  assert.equal(f.length, 1);
  assert.equal(f[0].title, 'Title');
});

test('_buildBackmatter: leere Bio -> [], mit Bio -> Eintrag (+Foto data-uri)', () => {
  assert.deepEqual(_buildBackmatter({ author_bio: '' }, { lang: 'de' }), []);
  const withImg = _buildBackmatter({ author_bio: 'Bio Text' }, { lang: 'de' }, { image: Buffer.from('x'), mime: 'image/jpeg' });
  assert.equal(withImg.length, 1);
  assert.equal(withImg[0].__toc, false);
  assert.ok(withImg[0].content.includes('Über den Autor'));
  assert.ok(withImg[0].content.includes('data:image/jpeg;base64,'));
});

// 1x1 PNG
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('buildEpub: erzeugt Buffer mit Frontmatter/Backmatter-Dateien + Cover', async () => {
  const bundle = {
    scope: 'book',
    book: { id: 1, name: 'Mein Buch', description: 'Desc' },
    groups: [{ chapterId: null, chapter: null, pages: [{ p: { name: 'Seite 1' }, pd: { html: '<p>Inhalt</p>' } }] }],
  };
  const buf = await buildEpub(bundle, {
    lang: 'de',
    author: 'Test Autor',
    meta: { dedication: 'Fuer dich', author_bio: 'Der Autor lebt.', epub_justify: true, subtitle: 'Untertitel', year: '2026' },
    cover: { image: PNG_1x1, mime: 'image/png' },
  });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 0);
  // Zip-Local-Header-Dateinamen liegen unkomprimiert im Buffer.
  const s = buf.toString('latin1');
  assert.ok(s.includes('front_title.xhtml'), 'Titelseite fehlt');
  assert.ok(s.includes('front_dedication.xhtml'), 'Widmung fehlt');
  assert.ok(s.includes('back_author.xhtml'), 'Autor-Seite fehlt');
});

test('_buildOpfExtraMeta: leer ohne keywords/series', () => {
  assert.equal(_buildOpfExtraMeta({}), '');
  assert.equal(_buildOpfExtraMeta({ keywords: '  ,  ' }), '');
});

test('_buildOpfExtraMeta: keywords → dc:subject je Term (escaped), series → collection + calibre', () => {
  const out = _buildOpfExtraMeta({ keywords: 'Fantasy, Abenteuer & Co', series: 'Die <Reihe>', series_index: '2' });
  assert.ok(out.includes('<dc:subject>Fantasy</dc:subject>'));
  assert.ok(out.includes('<dc:subject>Abenteuer &amp; Co</dc:subject>'));
  assert.ok(out.includes('belongs-to-collection') && out.includes('Die &lt;Reihe&gt;'));
  assert.ok(out.includes('group-position">2<'));
  assert.ok(out.includes('calibre:series') && out.includes('calibre:series_index'));
});

test('_buildContentOPF: undefined ohne Extra-Meta, sonst injiziert vor </metadata>', () => {
  assert.equal(_buildContentOPF({}), undefined);
  const opf = _buildContentOPF({ keywords: 'X' });
  assert.ok(opf.includes('<dc:subject>X</dc:subject>'));
  assert.ok(opf.indexOf('<dc:subject>X</dc:subject>') < opf.indexOf('</metadata>'), 'Extra-Meta muss vor </metadata> stehen');
  assert.ok(opf.includes('<%= title %>'), 'ejs-Platzhalter der Lib bleiben erhalten');
});

// content.opf + style.css liegen DEFLATE-komprimiert im Zip — Buffer-Grep findet
// sie nicht. Entpacken via jszip.
async function _unzip(buf) {
  const JSZip = (await import('jszip')).default;
  return JSZip.loadAsync(buf);
}
const _oneGroup = () => ([{ chapterId: null, chapter: null, pages: [{ p: { name: 'S1' }, pd: { html: '<p>x</p>' } }] }]);

test('buildEpub: Kapitelnumerierung prependet Label an TOC-Titel + Ueberschrift', async () => {
  const bundle = {
    scope: 'book', book: { id: 1, name: 'B' },
    groups: [
      { chapterId: 10, chapter: { id: 10, name: 'Anfang' }, pages: [{ p: { name: 'S1' }, pd: { html: '<p>a</p>' } }] },
      { chapterId: 11, chapter: { id: 11, name: 'Mitte' }, pages: [{ p: { name: 'S2' }, pd: { html: '<p>b</p>' } }] },
    ],
  };
  const buf = await buildEpub(bundle, {
    lang: 'de', author: 'A',
    meta: { epub_chapter_numbering: 'arabic', epub_chapter_numbering_mode: 'flat' },
  });
  const zip = await _unzip(buf);
  const nav = await zip.file('OEBPS/toc.xhtml').async('string');
  assert.ok(nav.includes('1. Anfang') && nav.includes('2. Mitte'), 'TOC-Eintraege fehlt Numerierung');
  const ncx = await zip.file('OEBPS/toc.ncx').async('string');
  assert.ok(ncx.includes('<text>1. Anfang</text>'), 'NavMap fehlt Numerierung');
  const entry = await zip.file('OEBPS/entry_0.xhtml').async('string');
  assert.ok(entry.includes('<h1>1. Anfang</h1>'), 'Body-Ueberschrift fehlt Numerierung');
});

test('buildEpub: numbering none (Default) → keine Label-Praefixe', async () => {
  const bundle = {
    scope: 'book', book: { id: 1, name: 'B' },
    groups: [{ chapterId: 10, chapter: { id: 10, name: 'Anfang' }, pages: [{ p: { name: 'S1' }, pd: { html: '<p>a</p>' } }] }],
  };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'A', meta: {} });
  const zip = await _unzip(buf);
  const entry = await zip.file('OEBPS/entry_0.xhtml').async('string');
  assert.ok(entry.includes('<h1>Anfang</h1>') && !/<h1>\d+\.\s/.test(entry), 'Default darf nicht numerieren');
});

test('buildEpub: description-Fallback book→meta, publisher/series in OPF', async () => {
  const bundle = { scope: 'book', book: { id: 1, name: 'Mein Buch', description: 'Buch-Beschreibung' }, groups: _oneGroup() };
  const buf = await buildEpub(bundle, {
    lang: 'de', author: 'A',
    meta: { description: 'Klappentext', publisher: 'Mein Verlag', series: 'Saga', keywords: 'Krimi' },
  });
  const zip = await _unzip(buf);
  const opf = await zip.file('OEBPS/content.opf').async('string');
  assert.ok(opf.includes('<dc:description>Klappentext</dc:description>'), 'meta.description gewinnt vor book.description');
  assert.ok(opf.includes('<dc:publisher>Mein Verlag</dc:publisher>'), 'publisher fehlt');
  assert.ok(opf.includes('belongs-to-collection'), 'series collection fehlt');
  assert.ok(opf.includes('<dc:subject>Krimi</dc:subject>'), 'keyword fehlt');
});

test('buildEpub: ohne meta.description faellt auf book.description', async () => {
  const bundle = { scope: 'book', book: { id: 1, name: 'B', description: 'NurBuchDesc' }, groups: _oneGroup() };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'A', meta: {} });
  const zip = await _unzip(buf);
  const opf = await zip.file('OEBPS/content.opf').async('string');
  assert.ok(opf.includes('<dc:description>NurBuchDesc</dc:description>'));
});

test('buildEpub: epub_css_style sans → sans-serif body font', async () => {
  const bundle = { scope: 'book', book: { id: 1, name: 'B' }, groups: _oneGroup() };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'A', meta: { epub_css_style: 'sans' } });
  const zip = await _unzip(buf);
  const css = await zip.file('OEBPS/style.css').async('string');
  assert.ok(css.includes('font-family: sans-serif'));
});
