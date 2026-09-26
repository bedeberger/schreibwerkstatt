// Abbildungsverzeichnis im gesetzten PDF — die Verdrahtung, nicht die Typografie.
//
// Geprüft wird, dass die Verzeichnisseite überhaupt entsteht und an den drei
// Schaltern hängt, die sie steuern sollen: Nummerierung des Buchs, Umfang des
// Exports (nur ganzes Buch) und das Vorhandensein nummerierter Anker. Im
// PDF-Binär steht der Text komprimiert; geprüft wird deshalb über die
// Seitenzahl-Differenz — dasselbe Vorgehen wie in pdf-render.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { useTmpDb } from './_helpers/tmp-db.js';

useTmpDb('pdf-anchordir');
// Migrationen VOR pdf-render (font_cache-Statements beim Modul-Load).
// CJS ueber dynamic import: die benannten Exporte haengen am default-Namespace.
const schemaMod = await import('../../db/schema.js');
const schema = schemaMod.default || schemaMod;
const { db } = schema;
const { renderPdfBuffer } = await import('../../lib/pdf-render.js');
const { defaultConfig } = await import('../../lib/pdf-export-defaults.js');

const BOOK = 931;
schema.upsertBookByName(BOOK, 'Verzeichnis-Buch');
db.prepare(`INSERT INTO chapters (chapter_id, book_id, chapter_name, position)
            VALUES (7310, ${BOOK}, 'Anfang', 0)`).run();

const FIG = (bid, cap) =>
  `<figure data-bid="${bid}"><img src="/content/page-image/999"><figcaption>${cap}</figcaption></figure>`;
const para = '<p>' + 'Es war einmal ein König. '.repeat(10) + '</p>';

const groupsWith = (extra) => ([{
  chapterId: 7310,
  chapter: { id: 7310, name: 'Anfang', chapter_name: 'Anfang', parent_chapter_id: null },
  pages: [{ p: { id: 8310, name: 'A' }, pd: { html: '<h1>Anfang</h1>' + para + extra } }],
}]);

const book = { book_id: BOOK, name: 'Verzeichnis-Buch', created_by: { name: 'X' }, created_at: '2024-01-01' };

function pageCount(buf) {
  return (buf.toString('binary').match(/\/Type\s*\/Page(?!s)/g) || []).length;
}

function cfg() {
  const c = defaultConfig();
  c.cover.enabled = false;
  // Paritätsregeln aus: eingeschobene Leerseiten verfälschen die Differenz.
  c.toc.startOnRecto = false;
  c.chapter.firstChapterOnRecto = false;
  c.extras.dedicationOnRecto = false;
  c.extras.imprintOnVerso = false;
  c.print.padToEvenPages = false;
  return c;
}

async function render({ numbering, extra, scope = 'book' }) {
  schema.setBookXrefSettings(BOOK, { figure_numbering: numbering, table_numbering: 0 });
  return renderPdfBuffer({
    book, groups: groupsWith(extra), profile: { config: cfg() }, coverBuf: null, token: null, scope,
  });
}

test('nummeriertes Buch mit Abbildung bekommt eine Verzeichnisseite', async () => {
  const ohne = await render({ numbering: 1, extra: '' });
  const mit = await render({ numbering: 1, extra: FIG('aaaaaaaaaaaaaaaa', 'Der Käfer') });
  assert.equal(pageCount(mit) - pageCount(ohne), 1,
    'genau eine zusätzliche Seite: das Abbildungsverzeichnis');
});

test('ohne Nummerierung kein Verzeichnis', async () => {
  // Die Nummerierung des Buchs IST der Schalter — einen eigenen Profil-Schalter
  // gibt es bewusst nicht. Ohne Nummern gäbe es nichts, worauf man zeigen könnte.
  const aus = await render({ numbering: 0, extra: FIG('aaaaaaaaaaaaaaaa', 'Der Käfer') });
  const an = await render({ numbering: 1, extra: FIG('aaaaaaaaaaaaaaaa', 'Der Käfer') });
  assert.equal(pageCount(an) - pageCount(aus), 1);
});

test('Kapitel-Export bekommt kein Verzeichnis', async () => {
  // Sichtbarkeitsregel wie beim Quellenverzeichnis: ein Kapitel-PDF ist keine
  // Publikation mit eigenem Apparat. Verglichen wird Kapitel-Scope mit und ohne
  // Abbildung — ein Vergleich gegen den Buch-Scope bewiese nichts, weil dort
  // ohnehin Titelei und Inhaltsverzeichnis dazukommen.
  const ohne = await render({ numbering: 1, extra: '', scope: 'chapter' });
  const mit = await render({ numbering: 1, extra: FIG('aaaaaaaaaaaaaaaa', 'Der Käfer'), scope: 'chapter' });
  assert.equal(pageCount(mit), pageCount(ohne));
});
