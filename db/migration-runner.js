'use strict';
// Runner fuer datei-basierte Migrationen unter db/migrations/NNNN-name.js.
//
// Jede Datei exportiert `{ version, fkOff?, up(db) }`. Der Runner uebernimmt, was
// jede Migration sonst selbst richtig machen musste:
//   • Reihenfolge + Luecken: Versionen ab LAST_INLINE_VERSION + 1 fortlaufend,
//     Dateipraefix == `version` (sonst Boot-Abbruch — eine vertippte Nummer
//     wuerde still uebersprungen oder doppelt laufen).
//   • `fkOff: true` (Recreate-Pattern): `PRAGMA foreign_keys = OFF` VOR und
//     `= ON` NACH der Transaktion — innerhalb einer Transaktion ist das Pragma
//     ein No-op.
//   • Transaktion um `up` + `foreign_key_check` + `schema_version`-Bump: eine
//     halb gelaufene Migration hinterlaesst nichts.
//   • Log-Zeile mit Version + Name.

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

// Letzte Migration, die noch als `if (version < N)`-Block in db/migrations.js
// steht. Datei-Migrationen beginnen bei LAST_INLINE_VERSION + 1.
const LAST_INLINE_VERSION = 291;
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const FILE_RE = /^(\d{4})-[a-z0-9-]+\.js$/;

/** Liest und validiert alle Datei-Migrationen (sortiert nach Version). */
function loadFileMigrations(dir = MIGRATIONS_DIR, lastInline = LAST_INLINE_VERSION) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  const out = [];
  for (const file of files) {
    const m = FILE_RE.exec(file);
    if (!m) throw new Error(`Migration-Datei ${file}: Name muss NNNN-name.js sein (Kleinbuchstaben, Ziffern, Bindestrich).`);
    const mod = require(path.join(dir, file));
    const version = Number(m[1]);
    if (mod.version !== version) throw new Error(`Migration-Datei ${file}: exportiert version=${mod.version}, Dateiname sagt ${version}.`);
    if (typeof mod.up !== 'function') throw new Error(`Migration-Datei ${file}: up(db) fehlt.`);
    out.push({ file, version, fkOff: !!mod.fkOff, up: mod.up });
  }
  out.sort((a, b) => a.version - b.version);
  out.forEach((mig, i) => {
    const expected = lastInline + 1 + i;
    if (mig.version !== expected) {
      throw new Error(`Migration-Datei ${mig.file}: erwartet Version ${expected} (fortlaufend ab ${lastInline + 1}).`);
    }
  });
  return out;
}

/** Wendet alle Datei-Migrationen oberhalb der aktuellen schema_version an. */
function runFileMigrations(db, migrations = loadFileMigrations()) {
  for (const mig of migrations) {
    const { version: current } = db.prepare('SELECT version FROM schema_version').get();
    if (current >= mig.version) continue;
    if (mig.fkOff) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        mig.up(db);
        const fkErrors = db.pragma('foreign_key_check');
        if (fkErrors.length) {
          throw new Error(`Migration ${mig.version}: foreign_key_check meldet ${fkErrors.length} Verstoesse.`);
        }
        db.prepare('UPDATE schema_version SET version = ?').run(mig.version);
      })();
    } finally {
      if (mig.fkOff) db.pragma('foreign_keys = ON');
    }
    logger.info(`DB-Migration auf Version ${mig.version} abgeschlossen (${mig.file}).`);
  }
}

module.exports = { LAST_INLINE_VERSION, MIGRATIONS_DIR, loadFileMigrations, runFileMigrations };
