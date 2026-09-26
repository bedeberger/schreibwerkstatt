'use strict';
// Wegwerf-SQLite fuer Unit-Tests, die ein DB-Modul laden (db/connection oeffnet
// die Datei an DB_PATH beim ersten require). Pendant zu
// tests/integration/_helpers/setup.js#bootstrap, aber ohne Migrations-/Seed-
// Vorspann: die Unit-Files ziehen ihre Module selbst.
//
//   const { useTmpDb } = require('./_helpers/tmp-db');        // CJS
//   import { useTmpDb } from './_helpers/tmp-db.js';           // ESM
//   const tmpDb = useTmpDb('sources-db');   // VOR dem ersten require von db/…
//
// Aufruf auf Modul-Ebene, nicht in einem Test: der after()-Hook haengt dann am
// Root des Files und laeuft nach dem letzten Test. Er schliesst die Connection
// (falls db/connection geladen wurde) und loescht Datei + -wal/-shm/-journal.
// Der exit-Handler raeumt zusaetzlich ab, wenn der Prozess ohne after() endet
// (Crash, process.exit in einem Test) — sonst bleibt die Datei in /tmp liegen.
//
// Why zentral: ein pro File handgeschriebenes DB_PATH vergisst leicht das
// Aufraeumen, und jede `npm run test:unit`-Runde laesst dann Dutzende DBs samt
// WAL in /tmp zurueck. Neue Unit-Tests mit DB nutzen ausschliesslich diesen Helper.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { after } = require('node:test');

// RAM-Dateisystem bevorzugen (wie tests/integration/_helpers/setup.js): auf
// dem CI-Runner mit Ceph-RBD kostet sonst jeder SQLite-Write Netz-Latenz.
function tmpBase() {
  if (process.env.TEST_TMPDIR) return process.env.TEST_TMPDIR;
  try {
    fs.accessSync('/dev/shm', fs.constants.W_OK);
    return '/dev/shm';
  } catch (_) {
    return os.tmpdir();
  }
}

const CONNECTION_PATH = path.resolve(__dirname, '..', '..', '..', 'db', 'connection.js');
const SUFFIXES = ['', '-wal', '-shm', '-journal'];

function closeIfLoaded() {
  // Nur eine bereits geladene Connection schliessen — ein require an dieser
  // Stelle wuerde die DB erst anlegen, um sie gleich wieder zu loeschen.
  const cached = require.cache[CONNECTION_PATH];
  const db = cached && cached.exports && cached.exports.db;
  if (db && db.open) {
    try { db.close(); } catch (_) { /* egal, Datei wird ohnehin geloescht */ }
  }
}

function removeFiles(file) {
  for (const s of SUFFIXES) {
    try { fs.unlinkSync(file + s); } catch (_) { /* nicht vorhanden */ }
  }
}

/**
 * Setzt process.env.DB_PATH auf eine eindeutige Wegwerf-Datei und registriert
 * das Aufraeumen. Gibt den Pfad zurueck (fuer Tests, die eine zweite
 * Connection auf dieselbe Datei oeffnen).
 * @param {string} [label] Kurzname fuer den Dateinamen (Diagnose bei Resten).
 */
function useTmpDb(label = 'unit') {
  const safe = String(label).replace(/[^a-z0-9_-]+/gi, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  const file = path.join(tmpBase(), `sw-unit-${safe}-${process.pid}-${Date.now()}-${rand}.db`);
  process.env.DB_PATH = file;

  after(() => {
    closeIfLoaded();
    removeFiles(file);
  });
  process.once('exit', () => removeFiles(file));
  return file;
}

module.exports = { useTmpDb };
