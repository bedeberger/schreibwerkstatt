#!/usr/bin/env node
// Boots a fresh DB under a tmp path, runs all migrations,
// dumps a canonical schema snapshot to stdout.
//
// Canonical form:
//   - Filter out FTS5 shadow tables (parent VIRTUAL TABLE recreates them)
//   - Filter out sqlite_autoindex_* (auto-generated)
//   - Sort by (type, name) with stable type priority
//   - Trim each statement; join with ";\n\n"
//   - Append sqlite_sequence watermarks for books/chapters/pages
//
// Used by:
//   - manual regeneration of db/squashed-schema.js
//   - tests/unit/squash-drift.test.mjs (via spawn)

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squash-dump-'));
process.env.DB_PATH = path.join(tmpDir, 'fresh.db');
process.env.LOG_LEVEL = 'error';

const cwd = path.resolve(__dirname, '..');
process.chdir(cwd);

try {
  const { runMigrations } = require(path.join(cwd, 'db/migrations.js'));
  runMigrations();
  const { db } = require(path.join(cwd, 'db/connection.js'));
  process.stdout.write(dumpCanonical(db));
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

function dumpCanonical(db) {
  const FTS5_SHADOW_SUFFIXES = ['_config', '_content', '_data', '_docsize', '_idx'];
  const ftsParents = new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%USING fts5%'`)
      .all()
      .map(r => r.name),
  );
  const isFtsShadow = (name) => {
    for (const parent of ftsParents) {
      for (const suffix of FTS5_SHADOW_SUFFIXES) {
        if (name === parent + suffix) return true;
      }
    }
    return false;
  };

  const TYPE_PRIORITY = { table: 1, index: 2, trigger: 3, view: 4 };
  const rows = db.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
      AND sql IS NOT NULL
  `).all();

  const filtered = rows.filter(r => !isFtsShadow(r.name));
  filtered.sort((a, b) => {
    const ta = TYPE_PRIORITY[a.type] ?? 9;
    const tb = TYPE_PRIORITY[b.type] ?? 9;
    if (ta !== tb) return ta - tb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const stmts = filtered.map(r => r.sql.trim());

  const seqRows = db.prepare(`SELECT name, seq FROM sqlite_sequence WHERE seq > 0 ORDER BY name`).all();
  const sqlString = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  for (const r of seqRows) {
    stmts.push(`INSERT INTO sqlite_sequence(name, seq) VALUES (${sqlString(r.name)}, ${r.seq})`);
  }

  const version = db.prepare('SELECT version FROM schema_version').get().version;
  stmts.push(`INSERT INTO schema_version(version) VALUES (${version})`);

  return stmts.join(';\n\n') + ';\n';
}
