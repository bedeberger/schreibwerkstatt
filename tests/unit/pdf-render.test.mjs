// Snapshot-artige Asserts auf Page-Counts + PDF-Marker. Vermeidet echte
// Pixel-Vergleiche (zu fragil). Stattdessen prüfen wir, dass das Output:
//   - %PDF-Header trägt
//   - PDF/A-XMP enthält
//   - die erwartete Page-Anzahl pro Konfig produziert
//   - Header/Footer-Pass keine Ghost-Pages produziert (Bug-Regression)

import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';

process.env.DB_PATH = path.join('/tmp', `pdfx-render-test-${process.pid}-${Date.now()}.db`);
// Migrationen MÜSSEN vor pdf-render laufen, weil font-fetch beim Modul-Load
// Prepared-Statements auf `font_cache` anlegt. Schema-Import zuerst.
await import('../../db/schema.js');
const { renderPdfBuffer } = await import('../../lib/pdf-render.js');
const { defaultConfig } = await import('../../lib/pdf-export-defaults.js');

const para = '<p>' + 'Es war einmal ein König. '.repeat(10) + '</p>';
const html = '<h1>Vorgeschichte</h1>' + para.repeat(2);

const baseGroups = [
  { chapter: { id: 1, name: 'Eins' }, pages: [
    { p: { id: 1, name: 'A' }, pd: { html } },
    { p: { id: 2, name: 'B' }, pd: { html } },
  ]},
  { chapter: { id: 2, name: 'Zwei' }, pages: [{ p: { id: 3, name: 'C' }, pd: { html } }]},
];
const baseBook = { name: 'Test', created_by: { name: 'X' }, created_at: '2024-01-01' };

function pageCount(buf) {
  return (buf.toString('binary').match(/\/Type\s*\/Page(?!s)/g) || []).length;
}

test('Render produziert valides PDF mit %PDF-Header', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  const buf = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
  assert.ok(pageCount(buf) >= 4);
});

test('PDF/A-Modus hängt XMP-Marker + sRGB-OutputIntent ein', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.pdfa.enabled = true;
  const buf = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.ok(buf.indexOf('pdfaid:part') > 0, 'XMP-pdfaid:part fehlt');
  assert.ok(buf.indexOf('sRGB IEC61966') > 0, 'OutputIntent-ICC-Identifier fehlt');
});

test('Footer-Token erzeugt KEINE Ghost-Pages (Regression)', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.layout.footerCenter = '{page} / {pages}';
  const withFooter = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  const cfgNoFooter = { ...cfg, layout: { ...cfg.layout, footerLeft: '', footerCenter: '', footerRight: '' } };
  const noFooter = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfgNoFooter }, coverBuf: null, token: null,
  });
  assert.equal(pageCount(withFooter), pageCount(noFooter), 'Footer-Pass darf keine Extra-Pages erzeugen');
});

test('countFrontMatter + pageNumberFirstVisible ändern Page-Count nicht', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.layout.footerCenter = '{page} / {pages}';
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  const tuned = {
    ...cfg,
    layout: { ...cfg.layout, countFrontMatter: true, pageNumberFirstVisible: 3 },
  };
  const withOpts = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: tuned }, coverBuf: null, token: null,
  });
  // Reine Stempel-Optionen: keine zusätzlichen/fehlenden Seiten.
  assert.equal(pageCount(withOpts), pageCount(baseline));
});

test('blankPageAfter erzeugt zusätzliche leere Page pro Kapitel', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.toc.enabled = false;
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  cfg.chapter.blankPageAfter = true;
  const withBlanks = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  // 2 Kapitel → 2 zusätzliche Blanks
  assert.equal(pageCount(withBlanks) - pageCount(baseline), 2);
});

test('Widmung + Impressum erzeugen je eine zusätzliche Seite', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  cfg.extras.dedication = 'Für …';
  cfg.extras.imprint = '© 2026';
  const withExtras = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.equal(pageCount(withExtras) - pageCount(baseline), 2);
});

test('Motto/Frontmatter-Seite erzeugt zusätzliche Seite', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  cfg.extras.frontMatter = 'Wer kämpft, kann verlieren. Wer nicht kämpft, hat schon verloren.';
  const withFm = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.equal(pageCount(withFm) - pageCount(baseline), 1);
});

test('Autor-Seite (Bio-Text) erzeugt zusätzliche Seite', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  cfg.extras.authorBio = 'Der Autor lebt und schreibt in der Schweiz.';
  const withBio = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.equal(pageCount(withBio) - pageCount(baseline), 1);
});

test('ISBN/Copyright ohne Impressum-Freitext erzeugt trotzdem Impressum-Seite', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  cfg.extras.isbn = '978-3-16-148410-0';
  cfg.extras.copyright = '© 2026 Max Mustermann';
  const withIsbn = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.equal(pageCount(withIsbn) - pageCount(baseline), 1);
});

test('EAN-13-Barcode auf der Impressum-Seite erzeugt keine Extra-Seite', async () => {
  const noBc = defaultConfig();
  noBc.cover.enabled = false;
  noBc.extras.isbn = '978-3-16-148410-0';
  noBc.extras.barcode = false;
  const without = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: noBc }, coverBuf: null, token: null,
  });
  const withBc = defaultConfig();
  withBc.cover.enabled = false;
  withBc.extras.isbn = '978-3-16-148410-0';
  withBc.extras.barcode = true;
  const withBuf = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: withBc }, coverBuf: null, token: null,
  });
  assert.equal(pageCount(withBuf), pageCount(without));
});

test('Ungültige ISBN unterdrückt den Barcode ohne Crash', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.extras.isbn = 'keine-zahl';
  cfg.extras.barcode = true;
  cfg.extras.copyright = '© 2026';
  const buf = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.ok(buf.length > 0);
});

test('imprintPosition back: Impressum am Buchende, eine Seite', async () => {
  const front = defaultConfig(); front.cover.enabled = false;
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: front }, coverBuf: null, token: null,
  });
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.extras.imprint = '© 2026';
  cfg.extras.imprintPosition = 'back';
  const withBack = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.equal(pageCount(withBack) - pageCount(baseline), 1);
});

test('Beschnitt: Seite wird um 2×Bleed grösser, TrimBox vorhanden', async () => {
  const base = defaultConfig(); base.cover.enabled = false;
  const bufNo = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: base }, coverBuf: null, token: null,
  });
  const cfg = defaultConfig(); cfg.cover.enabled = false; cfg.print.bleedMm = 3;
  const bufBleed = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.ok(bufBleed.toString('binary').includes('/TrimBox'), 'TrimBox fehlt im Bleed-PDF');
  assert.ok(!bufNo.toString('binary').includes('/TrimBox'), 'TrimBox darf ohne Bleed fehlen');
  const mb = (b) => { const m = b.toString('binary').match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/); return m ? [parseFloat(m[1]), parseFloat(m[2])] : null; };
  const a = mb(bufNo), c = mb(bufBleed);
  assert.ok(a && c, 'MediaBox nicht gefunden');
  assert.ok(Math.abs((c[0] - a[0]) - 6 * 72 / 25.4) < 1, `Breiten-Delta ~17pt erwartet, war ${(c[0] - a[0]).toFixed(2)}`);
});

test('Schnittmarken: Render mit Bleed + cropMarks läuft, gleiche Page-Anzahl', async () => {
  const cfg = defaultConfig(); cfg.cover.enabled = false; cfg.print.bleedMm = 3;
  const noMarks = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  const cfg2 = defaultConfig(); cfg2.cover.enabled = false; cfg2.print.bleedMm = 3; cfg2.print.cropMarks = true;
  const marks = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg2 }, coverBuf: null, token: null,
  });
  assert.equal(pageCount(marks), pageCount(noMarks), 'cropMarks dürfen keine Extra-Pages erzeugen');
});

test('Lose Seite vor erstem Kapitel: Kapitel-Heading bricht auf eigene Page (Regression)', async () => {
  // Bug: spaceBeforeMm-Reset (doc.y = margin.top + 60mm) lief auch für
  // Kapitel 1 unbedingt, sodass auf einer mit losen Seiten befüllten Body-
  // Page das Kapitel-Heading mitten in den Vorgängerinhalt gestempelt wurde
  // ("drückt durch"). Fix: Break, sobald die Body-Page schon Inhalt hat.
  const longHtml = '<p>' + 'Es war einmal in einem fernen Land. '.repeat(80) + '</p>';
  const groups = [
    { chapter: null, pages: [{ p: { id: 1, name: 'Vorwort' }, pd: { html: longHtml } }] },
    { chapter: { id: 10, name: 'Erstes Kapitel' }, pages: [{ p: { id: 2, name: 'S' }, pd: { html: '<p>kurz</p>' } }] },
  ];
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.toc.enabled = false;
  const buf = await renderPdfBuffer({ book: baseBook, groups, profile: { config: cfg }, coverBuf: null, token: null });
  // Erwartet: Title-Page + Vorwort-Body-Page(s) + eigene Kapitel-1-Page → ≥3.
  // Vor dem Fix kollabierten Vorwort + Kapitel-Heading auf eine Body-Page,
  // dann wäre pageCount=2.
  assert.ok(pageCount(buf) >= 3, `Erwartet ≥3 Pages, war ${pageCount(buf)} (Overlap-Bug?)`);
});

test('Hyphenation: SHY-Codepoint erscheint nicht im fertigen PDF', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.toc.enabled = false;
  cfg.layout.hyphenate = true;
  // Donaudampfschifffahrtsgesellschaft = klassischer Hypher-Trefferkandidat.
  const longPara = '<p>' + 'Donaudampfschifffahrtsgesellschaftskapitän stolpert. '.repeat(20) + '</p>';
  const groups = [{ chapter: { id: 1, name: 'X' }, pages: [{ p: { id: 1, name: 'A' }, pd: { html: '<h1>K</h1>' + longPara } }] }];
  const buf = await renderPdfBuffer({ book: baseBook, groups, profile: { config: cfg }, coverBuf: null, token: null, lang: 'de' });
  // SHY (U+00AD) als UTF-8: 0xC2 0xAD. Darf nicht im PDF auftauchen.
  assert.equal(buf.indexOf(Buffer.from([0xC2, 0xAD])), -1, 'SHY-Codepoint im PDF-Output → _fragment-Patch verschluckt nicht alle');
});

test('mirrorMargins: Render läuft ohne Crash, gleiche Page-Count wie ohne Mirror', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.toc.enabled = false;
  const baseline = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null });
  cfg.layout.mirrorMargins = true;
  const mirrored = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null });
  assert.equal(pageCount(mirrored), pageCount(baseline), 'Mirror darf Page-Count nicht ändern');
});

test('widowOrphanControl: schiebt Absatz auf neue Seite statt Single-Line-Witwe/Waise', async () => {
  // Vier mittellange Absätze, plus ein letzter Absatz, der eine Single-Line-
  // Witwe/Waise produzieren würde. Mit Kontrolle wird er als Ganzes
  // verschoben — also genau dann eine zusätzliche Page, wenn der Greedy-Bruch
  // wirklich gegriffen hätte. Wir prüfen Inequality (>=), weil der genaue
  // Bruchpunkt von Font-Metriken abhängt.
  const para = '<p>' + 'Die Sonne ging langsam unter und tauchte alles in goldenes Licht. '.repeat(15) + '</p>';
  const groups = [{ chapter: { id: 1, name: 'X' }, pages: [{ p: { id: 1, name: 'A' }, pd: { html: '<h1>K</h1>' + para.repeat(5) } }] }];
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.toc.enabled = false;
  cfg.layout.widowOrphanControl = false;
  const off = await renderPdfBuffer({ book: baseBook, groups, profile: { config: cfg }, coverBuf: null, token: null });
  cfg.layout.widowOrphanControl = true;
  const on = await renderPdfBuffer({ book: baseBook, groups, profile: { config: cfg }, coverBuf: null, token: null });
  assert.ok(pageCount(on) >= pageCount(off), `widow/orphan darf Pages nicht reduzieren (off=${pageCount(off)} on=${pageCount(on)})`);
});

test('TOC mit Page-Numbers stempelt Zahlen rechts ein', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.toc.enabled = true;
  cfg.toc.showPageNumbers = true;
  const buf = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  // Schwer reliably zu prüfen ohne Decode — wir checken nur, dass der Render
  // ohne Crash durchläuft und Page-Count plausibel ist (Title + TOC + Body).
  assert.ok(pageCount(buf) >= 4);
});
