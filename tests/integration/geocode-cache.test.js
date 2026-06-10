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
let ctx, db, dbSchema;

before(() => {
  ctx = bootstrap();
  db = require('../../db/connection').db;
  dbSchema = ctx.dbSchema;
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
