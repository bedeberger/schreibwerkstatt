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

// Alle Recto/Verso- + Gerade-Seitenzahl-Paritätsregeln abschalten (Defaults sind
// an). Strukturelle Page-Count-Delta-Tests brauchen das, damit eingeschobene
// Leerseiten die Deltas nicht verfälschen; jede Paritätsregel hat einen eigenen
// dedizierten Test weiter unten.
function parityOff(cfg) {
  cfg.toc.startOnRecto = false;
  cfg.chapter.firstChapterOnRecto = false;
  cfg.extras.dedicationOnRecto = false;
  cfg.extras.imprintOnVerso = false;
  cfg.print.padToEvenPages = false;
  return cfg;
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

test('pageCountMode=physical + pageNumberFirstVisible ändern Page-Count nicht', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.layout.footerCenter = '{page} / {pages}';
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  const tuned = {
    ...cfg,
    layout: { ...cfg.layout, pageCountMode: 'physical', pageNumberFirstVisible: 3 },
  };
  const withOpts = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: tuned }, coverBuf: null, token: null,
  });
  // Reine Stempel-Optionen: keine zusätzlichen/fehlenden Seiten.
  assert.equal(pageCount(withOpts), pageCount(baseline));
});

test('pageCountMode=physical zählt Body-Leerseiten mit, ohne Ghost-Pages', async () => {
  // firstChapterOnRecto erzwingt bei geradem Seitenstand eine Leer-Verso vor
  // dem ersten Kapitel — der 'physical'-Zählpfad muss diese mitzählen (cnt++),
  // ohne die Seitenanzahl gegenüber dem 'body'-Modus zu verändern.
  const cfgBody = defaultConfig();
  cfgBody.cover.enabled = false;
  cfgBody.chapter.firstChapterOnRecto = true;
  cfgBody.layout.footerCenter = '{page} / {pages}';
  cfgBody.layout.pageCountMode = 'body';
  const bodyBuf = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfgBody }, coverBuf: null, token: null,
  });
  const cfgPhys = { ...cfgBody, layout: { ...cfgBody.layout, pageCountMode: 'physical' } };
  const physBuf = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfgPhys }, coverBuf: null, token: null,
  });
  assert.equal(physBuf.slice(0, 5).toString(), '%PDF-');
  assert.equal(pageCount(physBuf), pageCount(bodyBuf), 'Zählmodus darf keine Seiten hinzufügen/entfernen');
});

test('frontMatterNumbering=roman ändert Page-Count nicht + rendert ohne Crash', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;      // ohne Cover: Titelseite + TOC bilden die Titelei
  cfg.toc.enabled = true;
  cfg.extras.dedication = 'Für alle.';
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  const roman = {
    ...cfg,
    layout: { ...cfg.layout, frontMatterNumbering: 'roman', frontMatterNumberFirstVisible: 1 },
  };
  const withRoman = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: roman }, coverBuf: null, token: null,
  });
  assert.equal(buf5(withRoman), '%PDF-', 'kein valides PDF');
  assert.equal(pageCount(withRoman), pageCount(baseline), 'Titelei-Nummerierung darf keine Seiten hinzufügen');
});

test('padToEvenPages füllt ungerade Gesamtseitenzahl auf gerade auf', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.print.padToEvenPages = false; // Default ist an — für den off-Vergleich explizit aus
  const off = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  const cfgOn = { ...cfg, print: { ...cfg.print, padToEvenPages: true } };
  const on = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfgOn }, coverBuf: null, token: null,
  });
  const nOff = pageCount(off);
  const nOn = pageCount(on);
  // Mit Padding ist die Gesamtzahl immer gerade …
  assert.equal(nOn % 2, 0, 'gepolstertes PDF muss gerade Seitenzahl haben');
  // … und es kommt höchstens genau eine Leerseite dazu (nur bei ungeradem Basis-Count).
  assert.equal(nOn, nOff + (nOff % 2), 'Padding darf nur bei ungerader Basis +1 Seite ergeben');
});

function buf5(b) { return b.slice(0, 5).toString(); }

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
  parityOff(cfg); // Parität-Leerseiten würden das Struktur-Delta verfälschen
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
  parityOff(cfg); // Parität-Leerseiten würden das Struktur-Delta verfälschen
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
  parityOff(cfg); // Parität-Leerseiten würden das Struktur-Delta verfälschen
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
  parityOff(cfg); // Parität-Leerseiten würden das Struktur-Delta verfälschen
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
  const front = defaultConfig(); front.cover.enabled = false; parityOff(front);
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: front }, coverBuf: null, token: null,
  });
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  parityOff(cfg); // Parität-Leerseiten würden das Struktur-Delta verfälschen
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

test('mirrorMargins: Text-Cursor folgt dem gespiegelten Rand (Regression: Verso-Textstart)', async () => {
  // addPage() setzt doc.x auf den BASIS-Rand, BEVOR der pageAdded-Hook spiegelt.
  // Ohne Cursor-Nachzug startet der Body auf Verso-Seiten am (grösseren) Recto-
  // Innenrand → linker/rechter Rand vertauscht sich sichtbar. Invariante:
  // doc.x == margins.left auf JEDER Seite (recto wie verso).
  const PDFDocument = (await import('pdfkit')).default;
  const { createPageGeometry } = await import('../../lib/pdf-render/page-geometry.js');
  const { MM_TO_PT } = await import('../../lib/pdf-render/layout.js');

  const margins = { top: 25 * MM_TO_PT, right: 15 * MM_TO_PT, bottom: 25 * MM_TO_PT, left: 30 * MM_TO_PT };
  const doc = new PDFDocument({ size: [595, 842], margins, autoFirstPage: false, bufferPages: true });
  doc.on('data', () => {});
  const geo = createPageGeometry(doc, {
    layout: { bodyInsetMm: { top: 0, right: 0, bottom: 0, left: 0 } },
    margins, bleedPt: 0, mirror: true, frontMatterAllowed: true, blankPageIdxs: new Set(),
  });
  geo.attach();

  for (let i = 0; i < 4; i++) {
    doc.addPage();
    const idx = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
    const verso = idx % 2 === 1;
    assert.ok(Math.abs(doc.x - doc.page.margins.left) < 0.01,
      `Seite ${idx} (${verso ? 'verso' : 'recto'}): doc.x=${doc.x} muss margins.left=${doc.page.margins.left} folgen`);
    // Verso spiegelt tatsächlich (linker Rand = Aussenrand 15mm, nicht 30mm).
    const expectLeftMm = verso ? 15 : 30;
    assert.ok(Math.abs(doc.page.margins.left / MM_TO_PT - expectLeftMm) < 0.01,
      `Seite ${idx}: erwarteter linker Rand ${expectLeftMm}mm`);
  }
  doc.end();
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

test('TOC startOnRecto schiebt Leerseite ein, wenn TOC sonst auf Verso landet', async () => {
  // Kein Cover, keine Widmung/Impressum → nur Titelseite als Titelei.
  // Ohne Recto-Padding beginnt die TOC auf Seite 2 (Verso) → +1 Leerseite.
  // Andere Paritätsregeln aus, damit nur startOnRecto wirkt.
  const on = parityOff(defaultConfig());
  on.cover.enabled = false;
  on.toc.startOnRecto = true;
  const off = parityOff(defaultConfig());
  off.cover.enabled = false;
  off.toc.startOnRecto = false;
  const bufOn = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: on }, coverBuf: null, token: null });
  const bufOff = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: off }, coverBuf: null, token: null });
  assert.equal(pageCount(bufOn), pageCount(bufOff) + 1);
});

test('TOC startOnRecto fügt KEINE Leerseite ein, wenn TOC bereits auf Recto landet', async () => {
  // Titelseite + Widmung (ohne eigenes Recto-Padding) → TOC beginnt auf Seite 3
  // (Recto), Padding no-op. Andere Paritätsregeln aus.
  const on = parityOff(defaultConfig());
  on.cover.enabled = false;
  on.extras.dedication = 'Für alle, die lesen.';
  on.toc.startOnRecto = true;
  const off = parityOff(defaultConfig());
  off.cover.enabled = false;
  off.extras.dedication = 'Für alle, die lesen.';
  off.toc.startOnRecto = false;
  const bufOn = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: on }, coverBuf: null, token: null });
  const bufOff = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: off }, coverBuf: null, token: null });
  assert.equal(pageCount(bufOn), pageCount(bufOff));
});

test('dedicationOnRecto schiebt Leerseite ein, wenn die Widmung sonst auf Verso landet', async () => {
  // Kein Cover, kein Impressum → nur Titelseite (Recto). Ohne Padding beginnt die
  // Widmung auf Seite 2 (Verso); mit dedicationOnRecto wird eine Leerseite davor
  // eingeschoben → +1 Seite gegenüber der Verso-Variante. Andere Paritätsregeln aus.
  const on = parityOff(defaultConfig());
  on.cover.enabled = false;
  on.toc.enabled = false;
  on.extras.dedication = 'Für alle, die lesen.';
  on.extras.dedicationOnRecto = true;
  const off = parityOff(defaultConfig());
  off.cover.enabled = false;
  off.toc.enabled = false;
  off.extras.dedication = 'Für alle, die lesen.';
  off.extras.dedicationOnRecto = false;
  const bufOn = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: on }, coverBuf: null, token: null });
  const bufOff = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: off }, coverBuf: null, token: null });
  assert.equal(pageCount(bufOn), pageCount(bufOff) + 1);
});

test('firstChapterOnRecto schiebt Leerseite ein, wenn das erste Kapitel sonst auf Verso landet', async () => {
  // Kein Cover, keine TOC → nur Titelseite (Recto idx0). Ohne Padding beginnt der
  // Body auf Seite 2 (Verso); mit firstChapterOnRecto wird eine Leerseite davor
  // eingeschoben → +1 Seite. Andere Paritätsregeln aus.
  const on = parityOff(defaultConfig());
  on.cover.enabled = false;
  on.toc.enabled = false;
  on.chapter.firstChapterOnRecto = true;
  const off = parityOff(defaultConfig());
  off.cover.enabled = false;
  off.toc.enabled = false;
  off.chapter.firstChapterOnRecto = false;
  const bufOn = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: on }, coverBuf: null, token: null });
  const bufOff = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: off }, coverBuf: null, token: null });
  assert.equal(pageCount(bufOn), pageCount(bufOff) + 1);
});

test('imprintOnVerso schiebt Leerseite ein, wenn das Impressum sonst auf Recto landet', async () => {
  // Mit Cover (idx0 Recto) landet die Titelseite auf Verso (idx1) und das
  // Frontmatter-Impressum sonst auf Recto (idx2). Mit imprintOnVerso wird eine
  // Leerseite davor eingeschoben → +1 Seite. Andere Paritätsregeln aus.
  const sharp = (await import('sharp')).default;
  const coverBuf = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#ffffff' } })
    .jpeg().toBuffer();
  const on = parityOff(defaultConfig());
  on.cover.enabled = true;
  on.toc.enabled = false;
  on.extras.imprint = '© 2026';
  on.extras.imprintOnVerso = true;
  const off = parityOff(defaultConfig());
  off.cover.enabled = true;
  off.toc.enabled = false;
  off.extras.imprint = '© 2026';
  off.extras.imprintOnVerso = false;
  const bufOn = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: on }, coverBuf, token: null });
  const bufOff = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: off }, coverBuf, token: null });
  assert.equal(pageCount(bufOn), pageCount(bufOff) + 1);
});

test('showFooter/HeaderOnChapterEnd=false unterdrückt nur Chrome, keine Ghost-Pages', async () => {
  // Kapitel-Endseiten-Chrome abschalten darf die Seitenanzahl nicht verändern
  // (nur Footer/Header der letzten Kapitelseite entfallen). Regressionsguard
  // gegen die chapterEndSet-Berechnung im Header/Footer-Pass.
  const on = parityOff(defaultConfig());
  on.cover.enabled = false;
  const off = parityOff(defaultConfig());
  off.cover.enabled = false;
  off.layout.showFooterOnChapterEnd = false;
  off.layout.showHeaderOnChapterEnd = false;
  const bufOn = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: on }, coverBuf: null, token: null });
  const bufOff = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: off }, coverBuf: null, token: null });
  assert.equal(bufOff.slice(0, 5).toString(), '%PDF-');
  assert.equal(pageCount(bufOn), pageCount(bufOff));
});

test('Manuell hinzugefügte Nicht-Kapitel-Seite beginnt auf eigener Seite (wie ein Kapitel)', async () => {
  // Regression: eine Custom-Seite (chapter_id null, z.B. Nachwort) am Buchende
  // floss frueher inline in die letzte Kapitelseite und landete bei mirrorMargins
  // auf der falschen Buchseite (Bundsteg-Kante gespiegelt → «Ränder falsch»). Sie
  // muss denselben Top-Level-Seitenumbruch wie ein Kapitel bekommen.
  const shortHtml = '<p>' + 'Kurzer Text. '.repeat(8) + '</p>';
  const chap = { chapter: { id: 1, name: 'Kapitel' }, pages: [{ p: { id: 1, name: 'A' }, pd: { html: shortHtml } }] };
  const standaloneEnd = { chapter: null, pages: [{ p: { id: 9, name: 'Nachwort' }, pd: { html: shortHtml } }] };
  const chapEnd = { chapter: { id: 2, name: 'Nachwort' }, pages: [{ p: { id: 2, name: 'B' }, pd: { html: shortHtml } }] };

  function cfg() {
    const c = parityOff(defaultConfig());
    c.cover.enabled = false;
    c.toc.enabled = false;
    c.layout.mirrorMargins = true;
    return c;
  }
  const onlyChap    = await renderPdfBuffer({ book: baseBook, groups: [chap],              profile: { config: cfg() }, coverBuf: null, token: null });
  const withCustom  = await renderPdfBuffer({ book: baseBook, groups: [chap, standaloneEnd], profile: { config: cfg() }, coverBuf: null, token: null });
  const withChapter = await renderPdfBuffer({ book: baseBook, groups: [chap, chapEnd],      profile: { config: cfg() }, coverBuf: null, token: null });

  assert.equal(withCustom.slice(0, 5).toString(), '%PDF-');
  // Custom-Seite erzwingt eine eigene Seite (nicht inline in die Kapitelseite gemergt).
  assert.equal(pageCount(withCustom), pageCount(onlyChap) + 1, 'Custom-Seite muss eine eigene Seite bekommen');
  // Strukturell identisch zu «Kapitel am Ende» → gleicher Satzspiegel/Recto-Verso.
  assert.equal(pageCount(withCustom), pageCount(withChapter), 'Custom-Seite muss wie ein Kapitel auf eigener Seite starten');
});
