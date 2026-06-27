'use strict';
// Reconcile-Netz fuer Orte (saveOrteToDb matchBy:'name') und Szenen
// (saveSzenenAndEvents): locations.id / figure_scenes.id bleiben ueber Re-Analysen
// stabil, verschwundene Eintraege werden als stale=1 markiert statt geloescht — damit
// FK-Refs (hier: research_item_links.location_id/scene_id) NICHT per CASCADE wegbrechen.
// Spiegelt das figures.stale-Netz. Reine DB-Logik (kein AI-Mock noetig).

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { bootstrap } = require('./_helpers/setup');

const BOOK = 9200;
const EMAIL = 'test@example.com';
let ctx, db, dbSchema, saveSzenenAndEvents;

before(() => {
  ctx = bootstrap();
  db = require('../../db/connection').db;
  dbSchema = ctx.dbSchema;
  ({ saveSzenenAndEvents } = require('../../routes/jobs/komplett/remap'));
  ctx.dbSeed.setBook({ books: [{ id: BOOK, name: 'Reconcile-Test' }] });
});
after(() => ctx.cleanup());

const log = { info() {}, warn() {} };

// Legt einen Recherche-Eintrag + Link auf ein Ziel an. Gibt die link-id zurueck.
function linkResearch(targetKind, idCol, targetId) {
  const { lastInsertRowid: itemId } = db.prepare(
    `INSERT INTO research_items (book_id, user_email, kind, title) VALUES (?, ?, 'note', 'ref')`
  ).run(BOOK, EMAIL);
  const { lastInsertRowid: linkId } = db.prepare(
    `INSERT INTO research_item_links (item_id, target_kind, ${idCol}) VALUES (?, ?, ?)`
  ).run(itemId, targetKind, targetId);
  return linkId;
}
const linkExists = (linkId) =>
  !!db.prepare('SELECT 1 FROM research_item_links WHERE id = ?').get(linkId);

// ── Orte ────────────────────────────────────────────────────────────────────

test('Ort: Re-Analyse mit neuer loc_id behaelt die DB-id und den Recherche-Link', () => {
  db.prepare('DELETE FROM locations WHERE book_id = ?').run(BOOK);
  const opts = { matchBy: 'name', onMissing: 'stale' };

  dbSchema.saveOrteToDb(BOOK, [{ id: 'ort_1', name: 'Burg Falkenstein' }], EMAIL, {}, {}, opts);
  const id1 = db.prepare('SELECT id FROM locations WHERE book_id = ? AND loc_id = ?').get(BOOK, 'ort_1').id;
  const linkId = linkResearch('location', 'location_id', id1);

  // AI regeneriert die loc_id (ort_1 → ort_3), gleicher Name → Match per Name.
  dbSchema.saveOrteToDb(BOOK, [{ id: 'ort_3', name: 'Burg Falkenstein' }], EMAIL, {}, {}, opts);
  const row = db.prepare('SELECT id, loc_id, stale FROM locations WHERE book_id = ?').get(BOOK);
  assert.equal(row.id, id1, 'DB-id muss stabil bleiben');
  assert.equal(row.loc_id, 'ort_3', 'loc_id wird auf den frischen Lauf-Wert gebogen');
  assert.equal(row.stale, 0);
  assert.ok(linkExists(linkId), 'Recherche-Link ueberlebt die Re-Analyse');
});

test('Ort: verschwundener Ort wird stale=1 (nicht geloescht), Link bleibt; Wiederauftauchen revived', () => {
  db.prepare('DELETE FROM locations WHERE book_id = ?').run(BOOK);
  const opts = { matchBy: 'name', onMissing: 'stale' };

  dbSchema.saveOrteToDb(BOOK, [{ id: 'ort_1', name: 'Burg Falkenstein' }], EMAIL, {}, {}, opts);
  const id1 = db.prepare('SELECT id FROM locations WHERE book_id = ?').get(BOOK).id;
  const linkId = linkResearch('location', 'location_id', id1);

  // Naechster Lauf findet den Ort nicht mehr → stale, nicht geloescht.
  dbSchema.saveOrteToDb(BOOK, [{ id: 'ort_1', name: 'Ganz anderer Ort' }], EMAIL, {}, {}, opts);
  const stale = db.prepare('SELECT id, loc_id, stale FROM locations WHERE id = ?').get(id1);
  assert.ok(stale, 'Ort darf NICHT geloescht werden');
  assert.equal(stale.stale, 1);
  assert.match(stale.loc_id, /^orphan_/, 'loc_id raeumt den ort_N-Namespace');
  assert.ok(linkExists(linkId), 'Link bleibt trotz stale erhalten');

  // Wiederauftauchen → revived (gleiche id, stale=0).
  dbSchema.saveOrteToDb(BOOK, [{ id: 'ort_9', name: 'Burg Falkenstein' }], EMAIL, {}, {}, opts);
  const revived = db.prepare('SELECT id, stale FROM locations WHERE id = ?').get(id1);
  assert.equal(revived.stale, 0, 'wiederaufgetauchter Ort wird revived');
});

// ── Szenen ────────────────────────────────────────────────────────────────────

test('Szene: Re-Analyse behaelt die DB-id (Match per Kapitel+Titel) und den Recherche-Link', () => {
  db.prepare('DELETE FROM figure_scenes WHERE book_id = ?').run(BOOK);
  db.prepare('DELETE FROM chapters WHERE book_id = ?').run(BOOK);
  const { lastInsertRowid: chapId } = db.prepare(
    `INSERT INTO chapters (book_id, chapter_name, updated_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')`
  ).run(BOOK, 'Kapitel Eins');
  const idMaps = { chNameToId: { 'Kapitel Eins': chapId }, pageNameToIdByChapter: {} };
  const mkScene = (titel, wertung) => ([{
    kapitel: 'Kapitel Eins', seite: null, titel, wertung, kommentar: null,
    fig_ids: [], ort_ids: [], sort_order: 0,
  }]);

  saveSzenenAndEvents(BOOK, EMAIL, mkScene('Der Sturm', 'gut'), [], {}, idMaps, log, null);
  const id1 = db.prepare('SELECT id FROM figure_scenes WHERE book_id = ?').get(BOOK).id;
  const linkId = linkResearch('scene', 'scene_id', id1);

  // Gleicher Titel + Kapitel, geaenderte Wertung → Match, UPDATE in-place.
  saveSzenenAndEvents(BOOK, EMAIL, mkScene('Der Sturm', 'mittel'), [], {}, idMaps, log, null);
  const row = db.prepare('SELECT id, wertung, stale FROM figure_scenes WHERE book_id = ?').get(BOOK);
  assert.equal(row.id, id1, 'Szenen-id muss stabil bleiben');
  assert.equal(row.wertung, 'mittel', 'Felder werden in-place aktualisiert');
  assert.equal(row.stale, 0);
  assert.ok(linkExists(linkId), 'Recherche-Link ueberlebt die Re-Analyse');

  // Szene verschwindet → stale=1, nicht geloescht, Link bleibt.
  saveSzenenAndEvents(BOOK, EMAIL, mkScene('Eine voellig andere Szene', null), [], {}, idMaps, log, null);
  const stale = db.prepare('SELECT stale FROM figure_scenes WHERE id = ?').get(id1);
  assert.ok(stale, 'Szene darf NICHT geloescht werden');
  assert.equal(stale.stale, 1);
  assert.ok(linkExists(linkId), 'Link bleibt trotz stale erhalten');

  // Wiederauftauchen → revived.
  saveSzenenAndEvents(BOOK, EMAIL, mkScene('Der Sturm', 'gut'), [], {}, idMaps, log, null);
  const revived = db.prepare('SELECT stale FROM figure_scenes WHERE id = ?').get(id1);
  assert.equal(revived.stale, 0, 'wiederaufgetauchte Szene wird revived');
});
