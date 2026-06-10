'use strict';
// Geocode-Resolve-Cache (locations.geo_query/geo_land): Invalidierung + Erhalt im
// Schreibpfad saveOrteToDb. Reine DB-Logik (kein AI-Mock noetig). Deckt die vier
// neuen Branches ab: Cache bleibt bei gleichem Label, faellt bei Umbenennung,
// faellt bei manuellem Georeferenz-Entfernen, ueberlebt die Komplett-
// Reextraktion (preserveExistingCoords) per Name-Reattach.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { bootstrap } = require('./_helpers/setup');

const BOOK = 9100;
let ctx, db, dbSchema, persistCoords;

before(() => {
  ctx = bootstrap();
  db = require('../../db/connection').db;
  dbSchema = ctx.dbSchema;
  // Nach bootstrap requiren — der Job zieht ./shared (Job-Queue) mit rein.
  persistCoords = require('../../routes/jobs/geocode')._persistCoords;
  ctx.dbSeed.setBook({ books: [{ id: BOOK, name: 'Geo-Cache-Test' }] });
});
after(() => ctx.cleanup());
beforeEach(() => { db.prepare('DELETE FROM locations WHERE book_id = ?').run(BOOK); });

const getLoc = (locId) =>
  db.prepare('SELECT geo_query, geo_land, lat, lng FROM locations WHERE book_id = ? AND loc_id = ?').get(BOOK, locId);
// Simuliert _persistResolved des Resolve-Jobs.
const setGeo = (locId, q, land) =>
  db.prepare('UPDATE locations SET geo_query = ?, geo_land = ? WHERE book_id = ? AND loc_id = ?').run(q, land, BOOK, locId);

test('Cache bleibt bei gleichem Label, faellt bei Umbenennung', () => {
  dbSchema.saveOrteToDb(BOOK, [{ id: 'a', name: 'Badi Olten', lat: 47.35, lng: 7.9 }], null);
  setGeo('a', 'Olten', 'ch');

  // Re-Save mit unveraendertem Label → Auflosung bleibt gueltig.
  dbSchema.saveOrteToDb(BOOK, [{ id: 'a', name: 'Badi Olten', lat: 47.35, lng: 7.9 }], null);
  assert.equal(getLoc('a').geo_query, 'Olten');
  assert.equal(getLoc('a').geo_land, 'ch');

  // Umbenennung → Toponym ist stale, Cache faellt.
  dbSchema.saveOrteToDb(BOOK, [{ id: 'a', name: 'Hallenbad Aarau', lat: 47.35, lng: 7.9 }], null);
  assert.equal(getLoc('a').geo_query, null);
  assert.equal(getLoc('a').geo_land, null);
});

test('Manuelles Georeferenz-Entfernen (Coords → null) nullt den Cache', () => {
  dbSchema.saveOrteToDb(BOOK, [{ id: 'a', name: 'Olten', lat: 47.35, lng: 7.9 }], null);
  setGeo('a', 'Olten', 'ch');

  dbSchema.saveOrteToDb(BOOK, [{ id: 'a', name: 'Olten', lat: null, lng: null }], null);
  const r = getLoc('a');
  assert.equal(r.lat, null);
  assert.equal(r.geo_query, null);
});

test('preserveExistingCoords erhaelt Coords UND Cache trotz null-Input', () => {
  dbSchema.saveOrteToDb(BOOK, [{ id: 'a', name: 'Olten', lat: 47.35, lng: 7.9 }], null);
  setGeo('a', 'Olten', 'ch');

  // Komplett-Reextraktion liefert kein lat/lng → coordByName reattacht; die
  // Coord-Clear-Heuristik darf hier NICHT greifen (sonst Nacht-Cron wischt Cache).
  dbSchema.saveOrteToDb(BOOK, [{ id: 'a', name: 'Olten', lat: null, lng: null }], null, null, null, { preserveExistingCoords: true });
  const r = getLoc('a');
  assert.equal(r.lat, 47.35);
  assert.equal(r.geo_query, 'Olten');
  assert.equal(r.geo_land, 'ch');
});

test('Komplett-Reextraktion mit neuer loc_id reattacht den Cache per Name', () => {
  dbSchema.saveOrteToDb(BOOK, [{ id: 'a', name: 'Olten', lat: 47.35, lng: 7.9 }], null);
  setGeo('a', 'Olten', 'ch');

  // AI regeneriert die loc_id (a → b), gleicher Name. Alte Row wird geloescht,
  // neue per Name aus coordByName + geoByName angereichert.
  dbSchema.saveOrteToDb(BOOK, [{ id: 'b', name: 'Olten' }], null, null, null, { preserveExistingCoords: true });
  assert.equal(getLoc('a'), undefined);
  const r = getLoc('b');
  assert.equal(r.geo_query, 'Olten');
  assert.equal(r.geo_land, 'ch');
  assert.equal(r.lat, 47.35);
});

// --- _persistCoords: der Job ist SSoT der Verortung (nicht der Client) --------

test('_persistCoords schreibt lat/lng und laesst den Resolve-Cache unberuehrt', () => {
  dbSchema.saveOrteToDb(BOOK, [{ id: 'a', name: 'Olten' }], null);
  setGeo('a', 'Olten', 'ch');           // simuliert _persistResolved (laeuft vor dem Lookup)
  assert.equal(getLoc('a').lat, null);  // noch unverortet

  persistCoords([{ id: 'a', lat: 47.35, lng: 7.9 }], BOOK, null);

  const r = getLoc('a');
  assert.equal(r.lat, 47.35);
  assert.equal(r.lng, 7.9);
  assert.equal(r.geo_query, 'Olten');   // Cache bleibt erhalten
  assert.equal(r.geo_land, 'ch');
});

test('_persistCoords ist auf book_id + user_email + loc_id gescoped', () => {
  dbSchema.saveOrteToDb(BOOK, [{ id: 'a', name: 'Olten' }], null);

  // Falscher User → kein Update (Row gehoert user_email IS NULL).
  persistCoords([{ id: 'a', lat: 1, lng: 2 }], BOOK, 'fremd@example.com');
  assert.equal(getLoc('a').lat, null);

  // Falsches Buch → kein Update.
  persistCoords([{ id: 'a', lat: 1, lng: 2 }], BOOK + 1, null);
  assert.equal(getLoc('a').lat, null);

  // Korrekter Scope → Update.
  persistCoords([{ id: 'a', lat: 47.35, lng: 7.9 }], BOOK, null);
  assert.equal(getLoc('a').lat, 47.35);
});

test('Full-Replace mit coord-losem Array wuerde Coords+Cache nullen (darum spiegelt das Frontend nach dem Job nur in-memory, kein saveOrte)', () => {
  dbSchema.saveOrteToDb(BOOK, [{ id: 'a', name: 'Olten' }], null);
  setGeo('a', 'Olten', 'ch');
  persistCoords([{ id: 'a', lat: 47.35, lng: 7.9 }], BOOK, null);  // Job verortet

  // Schriebe das Frontend jetzt sein altes (vor dem Job geladenes) coord-loses
  // Array zurueck, greift clearedCoords (hatte Coords, jetzt null) → alles weg.
  // Genau dieser Pfad ist im Frontend entfernt; der Test friert die Begruendung ein.
  dbSchema.saveOrteToDb(BOOK, [{ id: 'a', name: 'Olten', lat: null, lng: null }], null);
  const r = getLoc('a');
  assert.equal(r.lat, null);
  assert.equal(r.geo_query, null);
});
