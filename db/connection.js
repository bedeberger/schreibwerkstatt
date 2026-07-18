const path = require('path');
const Database = require('better-sqlite3');
const { applyPendingRestore } = require('./apply-pending-restore');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'schreibwerkstatt.db');

// Admin-DB-Restore: liegt eine validierte Pending-Datei vor, wird die DB VOR dem
// Oeffnen geswappt (Sicherheitskopie inklusive). Schlaegt das fehl, brechen wir
// den Boot ab — lieber sichtbar als still auf einer halb-getauschten DB laufen.
try {
  applyPendingRestore(DB_FILE);
} catch (e) {
  console.error(`[db-restore] Pending-Restore FEHLGESCHLAGEN, Boot abgebrochen: ${e.message}`);
  throw e;
}

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
// Wegwerf-Test-DBs brauchen keine Crash-Durability. `synchronous = OFF` (DB_FSYNC=off,
// nur in den Test-Scripts gesetzt) eliminiert jeden fsync — auf langsamem CI-Storage
// (Ceph RBD) stallt ein einzelner Commit-fsync sonst zig Sekunden. In Prod nie gesetzt.
db.pragma(process.env.DB_FSYNC === 'off' ? 'synchronous = OFF' : 'synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -65536');
db.pragma('mmap_size = 268435456');
db.pragma('temp_store = MEMORY');
db.pragma('busy_timeout = 5000');
db.pragma('wal_autocheckpoint = 1000');

module.exports = { db, DB_FILE };
