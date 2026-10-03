// Satz-Invarianten des PDF-Renderers, die nur geometrisch (am gerenderten PDF)
// oder am Layouter selbst pruefbar sind: gespiegelte Raender ueber Seitenwechsel,
// Kapitelanfang vs. Sub-Kapitel, Leerseiten, Witwen/Waisen, Notbruch, Noten in
// Ueberschrift und Tabelle, Bild-Hoehenklemme, Listenmarker, Probedruck, Abbruch.

import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const { renderPdfBuffer } = require('../../lib/pdf-render/index.js');
const { defaultConfig } = require('../../lib/pdf-export-defaults.js');
const { layoutRuns, drawLayout, _tokenize, _breakLines } = require('../../lib/pdf-render/justify.js');
const { computeChapterEndSet } = require('../../lib/pdf-render/page-numbers.js');
const { MM_TO_PT } = require('../../lib/pdf-render/layout.js');

const WORDS = 'Es war einmal ein Koenig der hatte drei Toechter und einen sehr grossen Garten hinter dem Schloss'.split(' ');
const text = (n, seed = 1) => Array.from({ length: n }, (_, i) => WORDS[(i * 7 + seed) % WORDS.length]).join(' ') + '.';

function cfgBase(over = {}) {
  const c = defaultConfig();
  c.cover.enabled = false;
  c.toc.enabled = false;
  c.pdfa.enabled = false;
  c.pdfa.standard = 'none';
  c.toc.startOnRecto = false;
  c.chapter.firstChapterOnRecto = false;
  c.extras.dedicationOnRecto = false;
  c.extras.imprintOnVerso = false;
  c.print.padToEvenPages = false;
  Object.assign(c.layout, over);
  return c;
}

async function pageItems(buf) {
  const { getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    out.push(tc.items.filter(i => i.str && i.str.trim()).map(i => ({ s: i.str, x: i.transform[4], y: i.transform[5], h: i.height })));
  }
  return out;
}

const book = { id: 1, name: 'Satzbuch' };
const groupsOf = (html, chapters = null) => chapters || [
  { chapter: { id: 1, name: 'Eins', parent_chapter_id: null }, pages: [{ p: { id: 1, name: 'Eins' }, pd: { html } }] },
];

// ── 1. Gespiegelte Raender ueber den Seitenwechsel ────────────────────────────

test('mirrorMargins: Blockzitat ueber Recto→Verso rueckt auf JEDER Seite relativ zu deren Rand ein', async () => {
  const cfg = cfgBase({ mirrorMargins: true, marginsMm: { top: 20, bottom: 20, left: 35, right: 12 } });
  cfg.layout.headerCenter = '';
  cfg.layout.footerCenter = '';
  // Kapitel beginnt auf Seite 0 (recto); das Zitat ist laenger als eine Seite.
  let html = `<p>${text(40)}</p><blockquote>`;
  for (let i = 0; i < 30; i++) html += `<p>Zitat${i} ${text(30, i)}</p>`;
  html += '</blockquote><p>Danach normal weiter.</p>';
  const buf = await renderPdfBuffer({ book, groups: groupsOf(html), profile: { config: cfg }, coverBuf: null, scope: 'chapter', meta: {} });
  const pages = await pageItems(buf);
  // Seiten mit Zitatzeilen: x der Zeilenanfaenge.
  const recto = 35 * MM_TO_PT, verso = 12 * MM_TO_PT, indent = 18;
  let seenRecto = 0, seenVerso = 0;
  // Titelseite liegt davor — die Paritaet ergibt sich aus dem PDF-Index.
  pages.forEach((items, idx) => {
    const quoteStarts = items.filter(it => /^Zitat\d+/.test(it.s)).map(it => it.x);
    if (!quoteStarts.length) return;
    const expLeft = (idx % 2 === 1 ? verso : recto) + indent;
    for (const x of quoteStarts) {
      assert.ok(Math.abs(x - expLeft) < 1, `Seite ${idx}: Zitat-x=${x.toFixed(1)} erwartet ${expLeft.toFixed(1)}`);
    }
    if (idx % 2 === 1) seenVerso++; else seenRecto++;
  });
  assert.ok(seenRecto >= 1 && seenVerso >= 1, 'Zitat muss ueber beide Seitenparitaeten laufen');
  // Nach dem Zitat: zurueck auf den Rand der aktuellen Seite.
  const last = pages.findIndex(items => items.some(it => it.s.startsWith('Danach')));
  const after = pages[last].find(it => it.s.startsWith('Danach'));
  assert.ok(Math.abs(after.x - (last % 2 === 1 ? verso : recto)) < 1, `Einzug nach dem Zitat nicht zurueckgenommen (x=${after.x})`);
});

test('mirrorMargins: Kopf-/Fusszeile sitzt auf Verso am gespiegelten Rand', async () => {
  const cfg = cfgBase({ mirrorMargins: true, marginsMm: { top: 20, bottom: 20, left: 35, right: 12 } });
  cfg.layout.headerLeft = 'KOPF';
  cfg.layout.headerCenter = '';
  cfg.layout.showHeaderOnChapterStart = true;
  let html = '';
  for (let i = 0; i < 40; i++) html += `<p>${text(40, i)}</p>`;
  const buf = await renderPdfBuffer({ book, groups: groupsOf(html), profile: { config: cfg }, coverBuf: null, scope: 'chapter', meta: {} });
  const pages = await pageItems(buf);
  let checked = 0;
  pages.forEach((items, idx) => {
    const k = items.find(it => it.s === 'KOPF');
    if (!k) return;
    const exp = idx % 2 === 1 ? 12 * MM_TO_PT : 35 * MM_TO_PT;
    assert.ok(Math.abs(k.x - exp) < 1, `Seite ${idx}: Kopfzeile x=${k.x.toFixed(1)} erwartet ${exp.toFixed(1)}`);
    checked++;
  });
  assert.ok(checked >= 2);
});

// ── 2. Sub-Kapitel mitten auf der Seite ist kein Kapitelanfang ───────────────

test('computeChapterEndSet: nur seiteneroeffnende Kapitel begrenzen', () => {
  const range = { start: 0, count: 6 };
  const set = computeChapterEndSet({
    chapterFirstPage: [
      { pageIdx: 0, opensPage: true },
      { pageIdx: 2, opensPage: false }, // Sub-Kapitel mitten auf Seite 2
      { pageIdx: 4, opensPage: true },
    ],
    range, blankPageIdxs: new Set(),
  });
  assert.deepEqual([...set].sort(), [3, 5], 'Seite 1 ist kein Kapitelende');
});

test('Sub-Kapitel mitten auf der Seite unterdrueckt dort NICHT die Kopfzeile', async () => {
  const cfg = cfgBase();
  cfg.layout.headerCenter = 'LAUFKOPF';
  cfg.chapter.breakBeforeSubchapter = false;
  const groups = [
    { chapter: { id: 1, name: 'Haupt', parent_chapter_id: null }, pages: [{ p: { id: 1, name: 'Haupt' }, pd: { html: `<p>${text(60)}</p>`.repeat(6) } }] },
    { chapter: { id: 2, name: 'Unterkapitel', parent_chapter_id: 1 }, pages: [{ p: { id: 2, name: 'Unterkapitel' }, pd: { html: `<p>${text(30)}</p>` } }] },
  ];
  const buf = await renderPdfBuffer({ book, groups, profile: { config: cfg }, coverBuf: null, scope: 'book', meta: {} });
  const pages = await pageItems(buf);
  const subPage = pages.findIndex(items => items.some(it => it.s === 'Unterkapitel'));
  assert.ok(subPage > 0);
  const items = pages[subPage];
  // Das Sub-Kapitel steht unterhalb von Fliesstext (mitten auf der Seite) …
  assert.ok(items.some(it => /Koenig|einmal|Garten/.test(it.s) && it.y > items.find(x => x.s === 'Unterkapitel').y));
  // … und die Kopfzeile bleibt.
  assert.ok(items.some(it => it.s === 'LAUFKOPF'), 'Kopfzeile darf auf der Seite eines Sub-Kapitels mitten im Text nicht fehlen');
});

// ── 3. Leerseiten ohne Kopf-/Fusszeile ───────────────────────────────────────

test('blankpage-Block und right-page-Leerseite tragen keine Seitenzahl/Kopfzeile', async () => {
  const cfg = cfgBase();
  cfg.layout.headerCenter = 'KOPFZEILE';
  cfg.layout.footerCenter = '{page}';
  cfg.layout.showHeaderOnChapterStart = true;
  cfg.layout.showFooterOnChapterStart = true;
  cfg.chapter.breakBefore = 'right-page';
  const groups = [
    { chapter: { id: 1, name: 'A', parent_chapter_id: null }, pages: [{ p: { id: 1, name: 'A' }, pd: { html: '<p>Vorher.</p><hr class="blankpage"><p>Nachher.</p>' } }] },
    { chapter: { id: 2, name: 'B', parent_chapter_id: null }, pages: [{ p: { id: 2, name: 'B' }, pd: { html: '<p>Zweites Kapitel.</p>' } }] },
    // C faellt auf eine Verso-Seite → right-page schiebt eine Leerseite ein.
    { chapter: { id: 3, name: 'C', parent_chapter_id: null }, pages: [{ p: { id: 3, name: 'C' }, pd: { html: '<p>Drittes Kapitel.</p>' } }] },
  ];
  const buf = await renderPdfBuffer({ book, groups, profile: { config: cfg }, coverBuf: null, scope: 'book', meta: {} });
  const pages = await pageItems(buf);
  const empties = pages.map((items, i) => [i, items]).filter(([i, items]) => i > 0 && !items.some(it => /Vorher|Nachher|Zweites|Drittes|^[ABC]$|Satzbuch/.test(it.s)));
  assert.ok(empties.length >= 2, `erwartet: Leerseite des Blocks + right-page-Leerseite (${empties.length})`);
  for (const [i, items] of empties) {
    assert.deepEqual(items.map(it => it.s), [], `Seite ${i} muss ganz leer sein`);
  }
});

// ── 4. Witwen/Waisen im Layouter ─────────────────────────────────────────────

function stubDoc() {
  const doc = new PDFDocument({ size: [300, 400], margin: 40, bufferPages: true });
  doc.on('data', () => {});
  for (const k of ['body', 'body-bold', 'body-italic', 'body-bolditalic']) doc.registerFont(k, 'Helvetica');
  return doc;
}

test('Witwe: passt nur die Schlusszeile nicht mehr, wandern ZWEI Zeilen auf die Folgeseite', () => {
  const doc = stubDoc();
  const opts = { sizePt: 10, lineHeight: 1.2, align: 'justify', widowOrphan: true };
  const lay = layoutRuns(doc, [{ text: text(120) }], opts);
  const n = lay.lines.length;
  assert.ok(n >= 5);
  // Platz fuer genau n-1 Zeilen.
  doc.y = doc.page.maxY() - ((n - 2) * lay.advance + lay.fitHeight) - 0.5;
  drawLayout(doc, lay, opts);
  assert.equal(doc.bufferedPageRange().count, 2);
  const linesOnSecond = Math.round((doc.y - doc.page.margins.top) / lay.advance);
  assert.equal(linesOnSecond, 2, 'zwei Zeilen auf der Folgeseite, keine einzelne');
});

test('Waise: passt nur die erste Zeile, beginnt der Absatz auf der Folgeseite', () => {
  const doc = stubDoc();
  const opts = { sizePt: 10, lineHeight: 1.2, align: 'justify', widowOrphan: true };
  const lay = layoutRuns(doc, [{ text: text(60) }], opts);
  doc.y = doc.page.maxY() - lay.fitHeight - 1;
  drawLayout(doc, lay, opts);
  const linesOnSecond = Math.round((doc.y - doc.page.margins.top) / lay.advance);
  assert.equal(linesOnSecond, lay.lines.length, 'ganzer Absatz auf der Folgeseite');
});

// ── 5. Ueberlange Woerter ────────────────────────────────────────────────────

test('Notbruch: eine lange URL ragt nie ueber den Rand und bricht bevorzugt an / ? &', () => {
  const doc = stubDoc();
  doc.font('body').fontSize(10);
  const url = 'https://example.com/ein/sehr/langer/pfad/der/nicht/umbrechen/will?param=wert&noch=einer&und=nochmehr';
  const lines = _breakLines(doc, _tokenize([{ text: 'Siehe ' + url + ' danach' }]), {
    sizePt: 10, hyphenate: null, totalWidth: 150, firstIndent: 0, spaceWidth: doc.widthOfString(' '),
  });
  assert.ok(lines.length >= 3);
  for (const l of lines) assert.ok(l.width <= 150 + 0.01, `Zeile zu breit: ${l.width}`);
  const joined = lines.map(l => l.items.filter(i => !i.space).map(i => i.word).join(' ')).join('|');
  assert.ok(/[/?&]\|/.test(joined), `kein Bruch an einer Notbruch-Stelle: ${joined}`);
  assert.equal(joined.replace(/\|/g, '').replace(/ /g, ''), ('Siehe' + url + 'danach'));
});

test('Notbruch: Zeichenkette ohne Bruchstelle wird hart nach Zeichen geteilt', () => {
  const doc = stubDoc();
  doc.font('body').fontSize(10);
  const lines = _breakLines(doc, _tokenize([{ text: 'x'.repeat(200) }]), {
    sizePt: 10, hyphenate: null, totalWidth: 100, firstIndent: 0, spaceWidth: doc.widthOfString(' '),
  });
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(l.width <= 100.01);
});

// ── 6. Noten in Ueberschrift und Tabelle ─────────────────────────────────────

const SRC = { id: 7, csl_type: 'book', title: 'Die Verwandlung', year: '1915', authors: [{ family: 'Kafka', given: 'Franz' }], editors: [], publisher: 'Kurt Wolff', place: 'Leipzig' };
const fnBib = () => ({
  enabled: false, notesMode: 'footnotes', notesTitle: 'Anmerkungen', title: 'Quellen', style: 'apa7', lang: 'de', scope: 'cited',
  numbers: new Map(), suffixes: new Map(), sourcesById: new Map([[7, SRC]]), entries: [],
});
const chip = (loc) => `<span class="cite" data-src="7" data-loc="${loc}">(x)</span>`;

test('Fussnote in Ueberschrift und Tabellenzelle geht nicht verloren', async () => {
  const html = `<h2>Kopfzeile mit Beleg${chip('11')}</h2><p>${text(20)}</p>`
    + `<table><tr><th>A</th><th>B</th></tr><tr><td>Zelle${chip('22')}</td><td>2</td></tr></table>`;
  const meta = {};
  const buf = await renderPdfBuffer({ book, groups: groupsOf(html), profile: { config: cfgBase() }, coverBuf: null, scope: 'chapter', meta, bibliography: fnBib() });
  const pages = await pageItems(buf);
  const all = pages.flat();
  const notes = all.filter(it => /Kafka|Ebd/.test(it.s));
  assert.ok(notes.length >= 2, `beide Noten muessen im Apparat stehen (${notes.map(n => n.s).join(' / ')})`);
  // Marker hochgestellt: kleiner als der Text seiner Zeile.
  const heading = all.find(it => it.s.includes('Kopfzeile'));
  const marker = all.find(it => it.s.trim() === '1' && Math.abs(it.y - heading.y) < heading.h);
  assert.ok(marker && marker.h < heading.h, 'Notenziffer in der Ueberschrift steht hochgestellt');
});

// ── 7. Bild hoeher als der Satzspiegel ───────────────────────────────────────

test('Bild hoeher als der Satzspiegel wird geklemmt und gezaehlt, kein Leerumbruch', async () => {
  const png = await sharp({ create: { width: 400, height: 4000, channels: 3, background: '#4477aa' } }).png().toBuffer();
  const html = `<p>Davor.</p><figure><img src="data:image/png;base64,${png.toString('base64')}"><figcaption>Legende.</figcaption></figure><p>Danach.</p>`;
  const meta = {};
  const buf = await renderPdfBuffer({ book, groups: groupsOf(html), profile: { config: cfgBase() }, coverBuf: null, scope: 'chapter', meta });
  assert.equal(meta.oversizeImages, 1);
  const pages = await pageItems(buf);
  // Titelseite + Seite mit „Davor." + Seite mit Bild/Legende — nicht mehr.
  const imgPage = pages.findIndex(items => items.some(it => it.s.includes('Legende')));
  assert.ok(imgPage > 0);
  assert.ok(pages.length <= imgPage + 2, `zu viele Seiten (${pages.length})`);
});

// ── 8. Listenmarker im haengenden Einzug ─────────────────────────────────────

test('Listenmarker steht im Einzug links vom Text; Folgezeilen buendig mit dem Text', async () => {
  const html = `<p>Davor.</p><ul><li>${text(50)}${chip('3')}</li><li>Kurz<ul><li>Verschachtelt</li></ul></li></ul>`;
  const buf = await renderPdfBuffer({ book, groups: groupsOf(html), profile: { config: cfgBase() }, coverBuf: null, scope: 'chapter', meta: {}, bibliography: fnBib() });
  const items = (await pageItems(buf)).flat();
  const davor = items.find(it => it.s.startsWith('Davor'));
  // pdf.js fasst Marker und Text einer Zeile oft zu einem Eintrag zusammen —
  // geprueft wird darum ueber die Zeilenanfaenge.
  const firstLine = items.find(it => it.s.startsWith('\u2022'));
  assert.ok(firstLine, 'Marker gezeichnet');
  assert.ok(firstLine.x > davor.x - 0.5, 'Marker sitzt im Einzug, nicht links vom Satzspiegel');
  const below = items.filter(it => it.y < firstLine.y - 1 && it.y > firstLine.y - 40 && !it.s.startsWith('\u2022'));
  const cont = below.sort((a, b) => b.y - a.y)[0];
  assert.ok(cont && cont.x > firstLine.x + 5, `Folgezeile buendig mit dem Text, rechts vom Marker (${cont && cont.x} vs ${firstLine.x})`);
  const nested = items.find(it => /Verschachtelt/.test(it.s));
  assert.ok(nested.x > firstLine.x + 10, 'verschachtelte Liste rueckt weiter ein');
});

// ── 9. Probedruck + Abbruch + Tagging ────────────────────────────────────────

test('sample: kein Inhaltsverzeichnis, kein Cover', async () => {
  const cfg = cfgBase();
  cfg.toc.enabled = true;
  cfg.toc.title = 'INHALTSVERZ';
  const html = `<p>${text(30)}</p>`;
  const full = await renderPdfBuffer({ book, groups: groupsOf(html), profile: { config: cfg }, coverBuf: null, scope: 'book', meta: {} });
  const sample = await renderPdfBuffer({ book, groups: groupsOf(html), profile: { config: cfg }, coverBuf: null, scope: 'book', meta: {}, sample: true });
  const has = async (b) => (await pageItems(b)).flat().some(it => it.s.includes('INHALTSVERZ'));
  assert.equal(await has(full), true);
  assert.equal(await has(sample), false);
});

test('signal: abgebrochener Render wirft AbortError', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    renderPdfBuffer({ book, groups: groupsOf(`<p>${text(10)}</p>`), profile: { config: cfgBase() }, coverBuf: null, scope: 'book', meta: {}, signal: ac.signal }),
    (e) => e.name === 'AbortError',
  );
});

test('kein /MarkInfo-Marked ohne Strukturbaum', async () => {
  const buf = await renderPdfBuffer({ book, groups: groupsOf('<p>x</p>'), profile: { config: cfgBase() }, coverBuf: null, scope: 'book', meta: {} });
  assert.equal(/\/Marked\s+true/.test(buf.toString('latin1')), false);
});

test('Schrift-Fallback: nicht verfuegbares Gewicht rendert und wird gemeldet', async () => {
  const cfg = cfgBase();
  cfg.font.title = { ...cfg.font.title, family: 'Lora', weight: 900 };
  const meta = {};
  const buf = await renderPdfBuffer({ book, groups: groupsOf('<p>x</p>'), profile: { config: cfg }, coverBuf: null, scope: 'book', meta });
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
  const fb = meta.fontFallbacks.find(f => f.role === 'title');
  assert.ok(fb, `title-Fallback fehlt: ${JSON.stringify(meta.fontFallbacks)}`);
  assert.equal(fb.requested, 'Lora 900 normal');
  assert.match(fb.used, /^Lora 700 normal$/);
});
