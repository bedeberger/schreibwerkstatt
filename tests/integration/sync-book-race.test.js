'use strict';
// syncBook vs. gleichzeitige Schreibzugriffe.
//
// syncBook liest die Seitenliste einmal am Anfang und rechnet dann in Batches
// mit _yield — bei einem grossen Buch Sekunden, in denen andere Requests
// laufen. `pages`/`chapters` sind der Content-Store selbst; der Sync darf aus
// seinem Snapshot deshalb nichts zurueckschreiben und nichts loeschen:
//   - eine im Sync-Fenster angelegte Seite ueberlebt den Sync (samt Inhalt)
//   - eine im Fenster gespeicherte Seite behaelt ihr neues updated_at
//     (sonst scheitert der naechste Save des Editors an PAGE_CONFLICT)
//   - eine im Fenster geloeschte Seite kommt nicht als Stub zurueck,
//     und der Sync bricht nicht am page_stats-FK ab

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

const USER = 'race@x.test';
let contentStore, syncBook, db, bookId, chapterId;
const pageIds = [];

test.before(async () => {
  bootstrap();
  contentStore = require('../../lib/content-store');
  ({ syncBook } = require('../../routes/sync'));
  db = require('../../db/connection').db;
  const book = await contentStore.createBook({ name: 'Race-Buch' }, { session: { user: { email: USER } } });
  bookId = book.id;
  const chapter = await contentStore.createChapter({ book_id: bookId, name: 'K1' }, null);
  chapterId = chapter.id;
  // Genug Seiten fuer mehrere Batches (BATCH=5) → mehrere _yield im Sync.
  for (let i = 0; i < 30; i++) {
    const p = await contentStore.createPage({ book_id: bookId, chapter_id: chapterId, name: `S${i}`, html: `<p>Text ${i}</p>` }, null);
    pageIds.push(p.id);
  }
});

const row = (id) => db.prepare('SELECT page_id, page_name, updated_at, body_html FROM pages WHERE page_id = ?').get(id);

test('Neuanlage, Save und Loeschen waehrend syncBook gehen nicht verloren bzw. kommen nicht zurueck', async () => {
  const syncing = syncBook(bookId, null);

  // Erster Macrotask-Tick: syncBook steht jetzt in seinem ersten _yield,
  // der Seiten-Snapshot ist gezogen.
  await new Promise(r => setImmediate(r));

  const created = await contentStore.createPage(
    { book_id: bookId, chapter_id: chapterId, name: '2026-10-03', html: '<p>Neuer Eintrag</p>' }, null);
  const saved = await contentStore.savePage(pageIds[0], { html: '<p>Frisch gespeichert</p>', name: 'S0' }, null);
  await contentStore.deletePage(pageIds[1], null);

  await syncing;

  const c = row(created.id);
  assert.ok(c, 'im Sync-Fenster angelegte Seite muss den Sync ueberleben');
  assert.match(c.body_html, /Neuer Eintrag/);

  const s = row(pageIds[0]);
  assert.equal(s.updated_at, saved.updated_at, 'updated_at des Saves darf nicht auf den Snapshot zurueckfallen');
  assert.match(s.body_html, /Frisch gespeichert/);

  assert.equal(row(pageIds[1]), undefined, 'geloeschte Seite darf nicht ueber den Sync zurueckkommen');
});
