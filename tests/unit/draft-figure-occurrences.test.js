'use strict';
// Ist-Index des Figurenbogens (db/draft-figure-occurrences.js) an echten Zeilen.
//
// Der Kern der Pruefung ist die Kapitel-Aufloesung: die Zellzahl des Verlaufs-
// bands und ihre Aufloesung im Zell-Detail muessen dieselbe Frage stellen —
// sonst zaehlt das Band einen Szenen-Fund in seiner Zelle, waehrend dieselbe
// Zelle im Detail leer bleibt.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const tmp = path.join('/tmp', `draft-fig-occ-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;

require('../../db/schema');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const draftDb = require('../../db/draft-figures');
const occDb = require('../../db/draft-figure-occurrences');

const USER = 'occ@x.test';
appUsers.createUser({ email: USER, displayName: USER });

const NOW = new Date().toISOString();
db.prepare('INSERT INTO books (book_id, name, slug, owner_email, created_at, updated_at) VALUES (?,?,?,?,?,?)')
  .run(1, 'Buch', 'buch', USER, NOW, NOW);
db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, slug, position, updated_at) VALUES (?,?,?,?,?,?)')
  .run(10, 1, 'Kapitel A', 'kap-a', 0, NOW);
db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, slug, position, updated_at) VALUES (?,?,?,?,?,?)')
  .run(11, 1, 'Kapitel B', 'kap-b', 1, NOW);
db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, slug, position, updated_at) VALUES (?,?,?,?,?,?,?)')
  .run(100, 1, 10, 'Seite 1', 's1', 0, NOW);
db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, slug, position, updated_at) VALUES (?,?,?,?,?,?,?)')
  .run(101, 1, 11, 'Seite 2', 's2', 0, NOW);
// Szene mit Ankerseite in Kapitel B — der Fall, an dem die beiden Aufloesungen
// auseinanderlaufen koennten.
db.prepare('INSERT INTO figure_scenes (id, book_id, user_email, titel, page_id, updated_at) VALUES (?,?,?,?,?,?)')
  .run(500, 1, USER, 'Szene X', 101, NOW);

const draft = draftDb.createDraftFigure(1, USER, {
  name: 'Mara',
  mindmap: { meta: {}, format: 'node_tree', data: { id: 'root', topic: 'Mara', children: [] } },
});

test('Full-Replace gilt pro (Draft, Kern) — andere Kerne bleiben stehen', () => {
  occDb.replaceKernOccurrences(draft.id, 1, 'lie', [
    { kind: 'page', pageId: 100, score: 0.8, snippet: 'a', source: 'semantic' },
  ]);
  occDb.replaceKernOccurrences(draft.id, 1, 'wound', [
    { kind: 'page', pageId: 101, score: 0.6, snippet: 'b', source: 'semantic' },
  ]);
  assert.equal(occDb.listDraftOccurrences(draft.id).length, 2);

  // Erneuter Lauf fuer EINEN Kern ersetzt nur dessen Zeilen.
  occDb.replaceKernOccurrences(draft.id, 1, 'lie', [
    { kind: 'page', pageId: 101, score: 0.9, snippet: 'c', source: 'semantic' },
  ]);
  const alle = occDb.listDraftOccurrences(draft.id);
  assert.equal(alle.length, 2);
  assert.equal(alle.filter(r => r.kern === 'lie').length, 1);
  assert.equal(alle.filter(r => r.kern === 'wound').length, 1);
});

test('Kern-Filter und Score-Floor am Lesepfad', () => {
  assert.equal(occDb.listDraftOccurrences(draft.id, { kern: 'lie' }).length, 1);
  // Floor 0.8 wirft den 0.6er wound-Treffer raus, nicht den 0.9er lie-Treffer.
  assert.equal(occDb.listDraftOccurrences(draft.id, { minScore: 0.8 }).length, 1);
});

test('Szenen-Fund loest sein Kapitel ueber die Ankerseite auf', () => {
  occDb.replaceKernOccurrences(draft.id, 1, 'bogen', [
    { kind: 'scene', sceneId: 500, score: 0.7, snippet: 'szene', source: 'semantic' },
  ]);
  // Die Zellzahl des Bands …
  const ch = occDb.occChapters(1, USER).filter(r => r.kern === 'bogen');
  assert.deepEqual(ch.map(r => [r.chapter_id, r.n]), [[11, 1]],
    'Szenen-Fund zaehlt im Kapitel seiner Ankerseite');
  // … und die Aufloesung im Detail muessen uebereinstimmen.
  const detail = occDb.listDraftOccurrences(draft.id, { kern: 'bogen' });
  assert.equal(detail.length, 1);
  assert.equal(detail[0].chapter_id, 11,
    'Detail loest dasselbe Kapitel auf wie die Zellzahl');
  assert.equal(detail[0].scene_page_id, 101, 'Ankerseite macht den Fund anspringbar');
});

test('Score-Floor wirkt pro Fundstelle gleich auf Zahl, Zellen und Detail', () => {
  occDb.replaceKernOccurrences(draft.id, 1, 'konflikt', [
    { kind: 'page', pageId: 100, score: 0.9, snippet: 'stark', source: 'semantic' },
    { kind: 'page', pageId: 100, score: 0.2, snippet: 'schwach', source: 'semantic' },
    { kind: 'page', pageId: 100, score: null, snippet: 'woertlich', source: 'trigger' },
  ]);
  const floor = 0.5;
  const count = occDb.occCounts(1, USER, floor).find(r => r.kern === 'konflikt');
  const cells = occDb.occChapters(1, USER, floor).filter(r => r.kern === 'konflikt');
  const detail = occDb.listDraftOccurrences(draft.id, { kern: 'konflikt', minScore: floor });
  assert.equal(count.n, 2, 'schwacher Treffer faellt, woertlicher bleibt');
  assert.equal(cells.reduce((s, r) => s + r.n, 0), 2, 'Zellen zaehlen dieselbe Menge');
  assert.equal(detail.length, 2, 'Detail loest dieselbe Menge auf');
  assert.equal(occDb.occCounts(1, USER).find(r => r.kern === 'konflikt').n, 3, 'ohne Floor alles');
});

test('hasDraftOccurrences trennt „nie verankert" von „nichts gefunden"', () => {
  assert.equal(occDb.hasDraftOccurrences(1, USER), true);
  const leer = draftDb.createDraftFigure(1, USER, {
    name: 'Leer',
    mindmap: { meta: {}, format: 'node_tree', data: { id: 'root', topic: 'Leer', children: [] } },
  });
  // Ein Draft ohne Fundstellen aendert die BUCHWEITE Antwort nicht — sie sagt,
  // ob ueberhaupt gemessen wurde, nicht ob diese Figur Treffer hat.
  assert.equal(occDb.hasDraftOccurrences(1, USER), true);
  occDb.clearDraftOccurrences(leer.id);
  assert.equal(occDb.hasDraftOccurrences(1, USER), true);
});

test('clearDraftOccurrences raeumt genau einen Draft', () => {
  occDb.clearDraftOccurrences(draft.id);
  assert.equal(occDb.listDraftOccurrences(draft.id).length, 0);
  assert.equal(occDb.hasDraftOccurrences(1, USER), false);
});

test('CASCADE: Draft loeschen nimmt seine Fundstellen mit', () => {
  occDb.replaceKernOccurrences(draft.id, 1, 'lie', [
    { kind: 'page', pageId: 100, score: 0.8, snippet: 'a', source: 'semantic' },
  ]);
  assert.equal(occDb.listDraftOccurrences(draft.id).length, 1);
  draftDb.deleteDraftFigure(draft.id);
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM draft_figure_occurrences WHERE draft_id = ?').get(draft.id).n,
    0,
  );
});

test('setDraftSourceFigure setzt und loest den Katalog-Zeiger', () => {
  db.prepare('INSERT INTO figures (id, book_id, fig_id, name, user_email, updated_at) VALUES (?,?,?,?,?,?)')
    .run(900, 1, 'fig-mara', 'Mara', USER, NOW);
  const d = draftDb.createDraftFigure(1, USER, {
    name: 'Mara',
    mindmap: { meta: {}, format: 'node_tree', data: { id: 'root', topic: 'Mara', children: [] } },
  });
  assert.equal(d.source_figure_id, null);

  const verknuepft = draftDb.setDraftSourceFigure(d.id, 900);
  assert.equal(verknuepft.source_figure_id, 900);
  // Die TEXT-fig_id ist die Identitaet, mit der das Frontend
  // Katalog-Figuren adressiert — sie muss am Lesepfad mitkommen.
  assert.equal(verknuepft.source_fig_id, 'fig-mara');
  assert.equal(verknuepft.source_figure_name, 'Mara');

  const geloest = draftDb.setDraftSourceFigure(d.id, null);
  assert.equal(geloest.source_figure_id, null);
  assert.equal(geloest.source_fig_id, null);
});

test('listLinkCandidates bietet nur Katalog-Figuren ohne Draft an', () => {
  db.prepare('INSERT INTO figures (id, book_id, fig_id, name, user_email, updated_at) VALUES (?,?,?,?,?,?)')
    .run(901, 1, 'fig-jonas', 'Jonas', USER, NOW);
  const namen = () => draftDb.listLinkCandidates(1, USER).map(f => f.name).sort();
  assert.ok(namen().includes('Jonas'));
  assert.ok(namen().includes('Mara'));

  const d = draftDb.createDraftFigure(1, USER, {
    name: 'Jonas',
    mindmap: { meta: {}, format: 'node_tree', data: { id: 'root', topic: 'Jonas', children: [] } },
  });
  draftDb.setDraftSourceFigure(d.id, 901);
  assert.ok(!namen().includes('Jonas'), 'verknuepfte Figur faellt aus den Kandidaten');
});
