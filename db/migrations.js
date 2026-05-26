const fs = require('fs');
const path = require('path');
const { db, DB_FILE } = require('./connection');
const logger = require('../logger');
const { SQUASHED_SCHEMA, SQUASHED_VERSION } = require('./squashed-schema');

// Fresh-DB fast path: skip 119-step legacy migration chain by installing the
// squashed final schema as a single SQL batch. Detection: schema_version table
// is missing iff this is a brand-new install (legacy initial block always
// creates it). On legacy installs we fall through to the unchanged top-level
// skeleton (idempotent IF NOT EXISTS) plus runMigrations() chain.
//
// Drift between SQUASHED_SCHEMA and the legacy chain is gated by
// tests/unit/squash-drift.test.mjs.
const _hasSchemaVersion = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
).get();
// FORCE_LEGACY_MIGRATIONS=1 makes the squash-drift test exercise the legacy
// migration chain even on a fresh DB. Never set in production.
const IS_FRESH_INSTALL =
  !_hasSchemaVersion && process.env.FORCE_LEGACY_MIGRATIONS !== '1';

if (IS_FRESH_INSTALL) {
  db.exec(SQUASHED_SCHEMA);
  logger.info(`DB frisch initialisiert via Schema-Squash (Version ${SQUASHED_VERSION}).`);
}

// Serialisiert parallele Migrations-Runner (z.B. node --test --test-concurrency
// mit geteiltem DB_PATH). Ohne Lock racen mehrere Worker auf ALTER TABLE und
// laufen in "duplicate column"-Fehler, weil Pragma-Reads vor dem Write
// stattfinden. Lock haelt nur den Migrations-Scope, kein Runtime-Block.
function _withMigrationLock(fn) {
  const lockPath = `${DB_FILE}.migration-lock`;
  const start = Date.now();
  let fd;
  while (true) {
    try { fd = fs.openSync(lockPath, 'wx'); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - start > 30000) throw new Error(`Migration lock timeout: ${lockPath}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); }
  finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

if (!IS_FRESH_INSTALL) db.exec(`
  CREATE TABLE IF NOT EXISTS page_checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id     INTEGER NOT NULL,
    page_name   TEXT,
    book_id     INTEGER,
    checked_at  TEXT NOT NULL,
    error_count INTEGER DEFAULT 0,
    errors_json TEXT,
    stilanalyse TEXT,
    fazit       TEXT,
    model       TEXT,
    saved       INTEGER DEFAULT 0,
    saved_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS book_reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id     INTEGER NOT NULL,
    book_name   TEXT,
    reviewed_at TEXT NOT NULL,
    review_json TEXT,
    model       TEXT
  );

  CREATE TABLE IF NOT EXISTS figures (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id      INTEGER NOT NULL,
    fig_id       TEXT NOT NULL,
    name         TEXT NOT NULL,
    kurzname     TEXT,
    typ          TEXT,
    geburtstag   TEXT,
    geschlecht   TEXT,
    beruf        TEXT,
    wohnadresse  TEXT,
    beschreibung TEXT,
    sort_order   INTEGER DEFAULT 0,
    meta         TEXT,
    updated_at   TEXT NOT NULL,
    UNIQUE(book_id, fig_id)
  );
  CREATE INDEX IF NOT EXISTS idx_fig_book_id ON figures(book_id);

  CREATE TABLE IF NOT EXISTS figure_tags (
    figure_id INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    PRIMARY KEY (figure_id, tag)
  );

  CREATE TABLE IF NOT EXISTS figure_appearances (
    figure_id    INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
    chapter_id   INTEGER NOT NULL,
    chapter_name TEXT,
    haeufigkeit  INTEGER DEFAULT 1,
    UNIQUE(figure_id, chapter_id)
  );
  -- chapter_name wird in Migration 70 entfernt; bleibt im initial-Schema, damit
  -- Daten-Migrationen 39-69 (UPDATE figure_appearances SET chapter_id ...
  -- WHERE chapter_name = ...) auf frischer DB durchlaufen.

  CREATE TABLE IF NOT EXISTS figure_events (
    figure_id  INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
    datum      TEXT NOT NULL,
    ereignis   TEXT NOT NULL,
    bedeutung  TEXT,
    typ        TEXT DEFAULT 'persoenlich',
    sort_order INTEGER DEFAULT 0
  );
  -- kapitel/seite/chapter_id/page_id werden via spätere ALTER/Migration ergänzt;
  -- kapitel und seite in Migration 70 entfernt.

  CREATE TABLE IF NOT EXISTS figure_relations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id      INTEGER NOT NULL,
    from_fig_id  TEXT NOT NULL,
    to_fig_id    TEXT NOT NULL,
    typ          TEXT NOT NULL,
    beschreibung TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_frel_book_id ON figure_relations(book_id);

  CREATE TABLE IF NOT EXISTS page_stats (
    page_id    INTEGER PRIMARY KEY,
    book_id    INTEGER NOT NULL,
    tok        INTEGER,
    words      INTEGER,
    chars      INTEGER,
    updated_at TEXT,
    cached_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ps_book_id ON page_stats(book_id);

  CREATE TABLE IF NOT EXISTS book_stats_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id     INTEGER NOT NULL,
    book_name   TEXT,
    recorded_at TEXT NOT NULL,
    page_count  INTEGER,
    words       INTEGER,
    chars       INTEGER,
    tok         INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bsh_book_date ON book_stats_history(book_id, recorded_at);
  CREATE INDEX IF NOT EXISTS idx_bsh_book_id ON book_stats_history(book_id);

  CREATE TABLE IF NOT EXISTS chat_sessions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id           INTEGER NOT NULL,
    book_name         TEXT,
    kind              TEXT    NOT NULL DEFAULT 'page' CHECK(kind IN ('page','book')),
    page_id           INTEGER,
    page_name         TEXT,
    user_email        TEXT    NOT NULL,
    created_at        TEXT    NOT NULL,
    last_message_at   TEXT    NOT NULL,
    opening_page_text TEXT,
    CHECK ((kind = 'page' AND page_id IS NOT NULL)
        OR (kind = 'book' AND page_id IS NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_cs_page_id ON chat_sessions(page_id, user_email);
  CREATE INDEX IF NOT EXISTS idx_cs_book_id ON chat_sessions(book_id, user_email);
  -- idx_cs_book_singleton (partial UNIQUE on kind='book') wird in Migration 69 angelegt

  CREATE TABLE IF NOT EXISTS chat_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role         TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content      TEXT NOT NULL,
    vorschlaege  TEXT,
    tokens_in    INTEGER,
    tokens_out   INTEGER,
    created_at   TEXT NOT NULL,
    context_info TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cm_session_created ON chat_messages(session_id, created_at);

  CREATE TABLE IF NOT EXISTS user_tokens (
    email      TEXT PRIMARY KEY,
    token_id   TEXT NOT NULL,
    token_pw   TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS figure_scenes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id    INTEGER NOT NULL,
    user_email TEXT,
    kapitel    TEXT NOT NULL,
    seite      TEXT,
    titel      TEXT NOT NULL,
    wertung    TEXT,
    kommentar  TEXT,
    sort_order INTEGER DEFAULT 0,
    chapter_id INTEGER,
    page_id    INTEGER,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_fscene_book ON figure_scenes(book_id, user_email);
  -- kapitel/seite werden in Migration 70 entfernt.

  CREATE TABLE IF NOT EXISTS locations (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id                  INTEGER NOT NULL,
    loc_id                   TEXT NOT NULL,
    name                     TEXT NOT NULL,
    typ                      TEXT,
    beschreibung             TEXT,
    erste_erwaehnung         TEXT,
    erste_erwaehnung_page_id INTEGER,
    stimmung                 TEXT,
    sort_order               INTEGER DEFAULT 0,
    user_email               TEXT,
    updated_at               TEXT NOT NULL,
    UNIQUE(book_id, loc_id, user_email)
  );
  CREATE INDEX IF NOT EXISTS idx_loc_book_id ON locations(book_id, user_email);

  CREATE TABLE IF NOT EXISTS scene_figures (
    scene_id INTEGER NOT NULL REFERENCES figure_scenes(id) ON DELETE CASCADE,
    fig_id   TEXT NOT NULL,
    PRIMARY KEY (scene_id, fig_id)
  );

  CREATE TABLE IF NOT EXISTS location_figures (
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    fig_id      TEXT NOT NULL,
    PRIMARY KEY (location_id, fig_id)
  );

  CREATE TABLE IF NOT EXISTS scene_locations (
    scene_id    INTEGER NOT NULL REFERENCES figure_scenes(id) ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    PRIMARY KEY (scene_id, location_id)
  );

  CREATE TABLE IF NOT EXISTS location_chapters (
    location_id  INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    chapter_id   INTEGER NOT NULL,
    chapter_name TEXT,
    haeufigkeit  INTEGER DEFAULT 1,
    PRIMARY KEY (location_id, chapter_id)
  );
  -- chapter_name wird in Migration 70 entfernt.

  CREATE TABLE IF NOT EXISTS continuity_checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id     INTEGER NOT NULL,
    user_email  TEXT,
    checked_at  TEXT NOT NULL,
    summary     TEXT,
    model       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cc_book_id ON continuity_checks(book_id, user_email);

  CREATE TABLE IF NOT EXISTS continuity_issues (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id     INTEGER NOT NULL REFERENCES continuity_checks(id) ON DELETE CASCADE,
    book_id      INTEGER NOT NULL,
    user_email   TEXT,
    schwere      TEXT,
    typ          TEXT,
    beschreibung TEXT,
    stelle_a     TEXT,
    stelle_b     TEXT,
    empfehlung   TEXT,
    sort_order   INTEGER DEFAULT 0,
    updated_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ci_check ON continuity_issues(check_id);
  CREATE INDEX IF NOT EXISTS idx_ci_book  ON continuity_issues(book_id, user_email);

  CREATE TABLE IF NOT EXISTS continuity_issue_figures (
    issue_id   INTEGER NOT NULL REFERENCES continuity_issues(id) ON DELETE CASCADE,
    fig_id     TEXT,
    figur_name TEXT,
    sort_order INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_cif_issue ON continuity_issue_figures(issue_id);

  CREATE TABLE IF NOT EXISTS continuity_issue_chapters (
    issue_id     INTEGER NOT NULL REFERENCES continuity_issues(id) ON DELETE CASCADE,
    chapter_id   INTEGER,
    chapter_name TEXT,
    sort_order   INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_cic_issue ON continuity_issue_chapters(issue_id);
  -- chapter_name wird in Migration 70 entfernt.

  CREATE TABLE IF NOT EXISTS zeitstrahl_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id    INTEGER NOT NULL,
    user_email TEXT NOT NULL DEFAULT '',
    datum      TEXT NOT NULL,
    ereignis   TEXT NOT NULL,
    typ        TEXT DEFAULT 'persoenlich',
    bedeutung  TEXT,
    kapitel     TEXT,
    chapter_ids TEXT,
    seiten      TEXT,
    figuren     TEXT,
    sort_order  INTEGER DEFAULT 0,
    updated_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ze_book_id ON zeitstrahl_events(book_id, user_email);

  CREATE TABLE IF NOT EXISTS chapter_extract_cache (
    book_id     INTEGER NOT NULL,
    user_email  TEXT NOT NULL DEFAULT '',
    chapter_key TEXT NOT NULL,
    pages_sig   TEXT NOT NULL,
    extract_json TEXT NOT NULL,
    cached_at   TEXT NOT NULL,
    PRIMARY KEY (book_id, user_email, chapter_key)
  );

  CREATE TABLE IF NOT EXISTS job_checkpoints (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type   TEXT NOT NULL,
    book_id    INTEGER NOT NULL,
    user_email TEXT NOT NULL DEFAULT '',
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(job_type, book_id, user_email)
  );

  CREATE TABLE IF NOT EXISTS pages (
    page_id      INTEGER PRIMARY KEY,
    book_id      INTEGER NOT NULL,
    page_name    TEXT,
    chapter_id   INTEGER,
    chapter_name TEXT,
    updated_at   TEXT,
    preview_text TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pages_book_id    ON pages(book_id);
  CREATE INDEX IF NOT EXISTS idx_pages_chapter_id ON pages(chapter_id);

  CREATE TABLE IF NOT EXISTS job_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL UNIQUE,
    type        TEXT NOT NULL,
    book_id     INTEGER,
    user_email  TEXT,
    label       TEXT,
    status      TEXT NOT NULL DEFAULT 'queued',
    queued_at   TEXT NOT NULL,
    started_at  TEXT,
    ended_at    TEXT,
    tokens_in   INTEGER DEFAULT 0,
    tokens_out  INTEGER DEFAULT 0,
    error       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jr_book ON job_runs(book_id);
  CREATE INDEX IF NOT EXISTS idx_jr_user ON job_runs(user_email);

  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
  INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);

  CREATE TABLE IF NOT EXISTS chapters (
    chapter_id   INTEGER NOT NULL,
    book_id      INTEGER NOT NULL,
    chapter_name TEXT    NOT NULL,
    updated_at   TEXT,
    PRIMARY KEY (chapter_id, book_id)
  );

  CREATE TABLE IF NOT EXISTS book_settings (
    book_id    INTEGER PRIMARY KEY,
    language   TEXT NOT NULL DEFAULT 'de',
    region     TEXT NOT NULL DEFAULT 'CH',
    updated_at TEXT NOT NULL
  );

`);

function runMigrations() {
  return _withMigrationLock(_runMigrationsLocked);
}

function _runMigrationsLocked() {
  const { version } = db.prepare('SELECT version FROM schema_version').get();
  if (version < 2) {
    db.exec('ALTER TABLE page_checks ADD COLUMN applied_errors_json TEXT');
    db.prepare('UPDATE schema_version SET version = 2').run();
    logger.info('DB-Migration auf Version 2 abgeschlossen.');
  }
  if (version < 3) {
    db.exec(`
      ALTER TABLE page_checks      ADD COLUMN user_email TEXT;
      ALTER TABLE book_reviews     ADD COLUMN user_email TEXT;
      ALTER TABLE figures          ADD COLUMN user_email TEXT;
      ALTER TABLE figure_relations ADD COLUMN user_email TEXT;
      CREATE INDEX IF NOT EXISTS idx_pc_page_user_date ON page_checks(page_id, user_email, checked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pc_book_user      ON page_checks(book_id, user_email);
      CREATE INDEX IF NOT EXISTS idx_br_book_user_date ON book_reviews(book_id, user_email, reviewed_at DESC);
    `);
    db.prepare('UPDATE schema_version SET version = 3').run();
    logger.info('DB-Migration auf Version 3 abgeschlossen (user_email zu allen Datentabellen hinzugefügt).');
  }
  if (version < 4) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE figures_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          book_id      INTEGER NOT NULL,
          fig_id       TEXT NOT NULL,
          name         TEXT NOT NULL,
          kurzname     TEXT,
          typ          TEXT,
          geburtstag   TEXT,
          geschlecht   TEXT,
          beruf        TEXT,
          beschreibung TEXT,
          sort_order   INTEGER DEFAULT 0,
          meta         TEXT,
          updated_at   TEXT NOT NULL,
          user_email   TEXT,
          UNIQUE(book_id, fig_id, user_email)
        );
        INSERT INTO figures_new
          SELECT id, book_id, fig_id, name, kurzname, typ, geburtstag, geschlecht,
                 beruf, beschreibung, sort_order, meta, updated_at, user_email
          FROM figures;
        DROP TABLE figures;
        ALTER TABLE figures_new RENAME TO figures;
        CREATE INDEX IF NOT EXISTS idx_fig_book_id ON figures(book_id);
      `);
    })();
    db.pragma('foreign_keys = ON');
    db.prepare('UPDATE schema_version SET version = 4').run();
    logger.info('DB-Migration auf Version 4 abgeschlossen (figures UNIQUE-Constraint auf (book_id, fig_id, user_email) erweitert).');
  }
  if (version < 5) {
    db.exec('ALTER TABLE page_checks ADD COLUMN selected_errors_json TEXT');
    db.prepare('UPDATE schema_version SET version = 5').run();
    logger.info('DB-Migration auf Version 5 abgeschlossen (selected_errors_json zu page_checks hinzugefügt).');
  }
  if (version < 6) {
    const cols6 = db.pragma('table_info(chat_messages)').map(c => c.name);
    if (!cols6.includes('context_info')) {
      db.exec('ALTER TABLE chat_messages ADD COLUMN context_info TEXT');
    }
    db.prepare('UPDATE schema_version SET version = 6').run();
    logger.info('DB-Migration auf Version 6 abgeschlossen (context_info zu chat_messages hinzugefügt).');
  }
  if (version < 7) {
    const cols = db.pragma('table_info(chat_messages)').map(c => c.name);
    if (!cols.includes('context_info')) {
      db.exec('ALTER TABLE chat_messages ADD COLUMN context_info TEXT');
      logger.info('DB-Migration auf Version 7: context_info-Spalte nachgerüstet.');
    }
    db.prepare('UPDATE schema_version SET version = 7').run();
    logger.info('DB-Migration auf Version 7 abgeschlossen.');
  }
  if (version < 8) {
    db.exec('ALTER TABLE book_stats_history ADD COLUMN unique_words INTEGER');
    db.prepare('UPDATE schema_version SET version = 8').run();
    logger.info('DB-Migration auf Version 8 abgeschlossen (unique_words zu book_stats_history hinzugefügt).');
  }
  if (version < 9) {
    const bshCols = db.pragma('table_info(book_stats_history)').map(c => c.name);
    if (!bshCols.includes('chapter_count')) {
      db.exec('ALTER TABLE book_stats_history ADD COLUMN chapter_count INTEGER');
      logger.info('DB-Migration auf Version 9: chapter_count nachgerüstet.');
    }
    if (!bshCols.includes('avg_sentence_len')) {
      db.exec('ALTER TABLE book_stats_history ADD COLUMN avg_sentence_len REAL');
      logger.info('DB-Migration auf Version 9: avg_sentence_len nachgerüstet.');
    }
    db.prepare('UPDATE schema_version SET version = 9').run();
    logger.info('DB-Migration auf Version 9 abgeschlossen.');
  }
  if (version < 10) {
    const feCols = db.pragma('table_info(figure_events)').map(c => c.name);
    if (!feCols.includes('typ')) {
      db.exec("ALTER TABLE figure_events ADD COLUMN typ TEXT DEFAULT 'persoenlich'");
      logger.info('DB-Migration auf Version 10: figure_events.typ nachgerüstet.');
    }
    db.prepare('UPDATE schema_version SET version = 10').run();
    logger.info('DB-Migration auf Version 10 abgeschlossen.');
  }
  if (version < 11) {
    db.exec('ALTER TABLE page_checks ADD COLUMN szenen_json TEXT');
    db.prepare('UPDATE schema_version SET version = 11').run();
    logger.info('DB-Migration auf Version 11 abgeschlossen (szenen_json zu page_checks hinzugefügt).');
  }
  if (version < 12) {
    db.exec(`CREATE TABLE IF NOT EXISTS figure_scenes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id    INTEGER NOT NULL,
      user_email TEXT,
      kapitel    TEXT NOT NULL,
      seite      TEXT,
      titel      TEXT NOT NULL,
      wertung    TEXT,
      kommentar  TEXT,
      fig_ids    TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_fscene_book ON figure_scenes(book_id, user_email);`);
    db.prepare('UPDATE schema_version SET version = 12').run();
    logger.info('DB-Migration auf Version 12 abgeschlossen (figure_scenes Tabelle hinzugefügt).');
  }
  if (version < 13) {
    const fsCols13 = db.pragma('table_info(figure_scenes)').map(c => c.name);
    if (!fsCols13.includes('updated_at')) db.exec('ALTER TABLE figure_scenes ADD COLUMN updated_at TEXT');
    db.prepare('UPDATE schema_version SET version = 13').run();
    logger.info('DB-Migration auf Version 13 abgeschlossen (updated_at zu figure_scenes hinzugefügt).');
  }
  if (version < 14) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS locations (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id          INTEGER NOT NULL,
        loc_id           TEXT NOT NULL,
        name             TEXT NOT NULL,
        typ              TEXT,
        beschreibung     TEXT,
        erste_erwaehnung TEXT,
        stimmung         TEXT,
        figuren_json     TEXT,
        kapitel_json     TEXT,
        sort_order       INTEGER DEFAULT 0,
        user_email       TEXT,
        updated_at       TEXT NOT NULL,
        UNIQUE(book_id, loc_id, user_email)
      );
      CREATE INDEX IF NOT EXISTS idx_loc_book_id ON locations(book_id, user_email);
    `);
    db.prepare('UPDATE schema_version SET version = 14').run();
    logger.info('DB-Migration auf Version 14 abgeschlossen (locations Tabelle hinzugefügt).');
  }
  if (version < 15) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS continuity_checks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL,
        user_email  TEXT,
        checked_at  TEXT NOT NULL,
        issues_json TEXT,
        summary     TEXT,
        model       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cc_book_id ON continuity_checks(book_id, user_email);
    `);
    db.prepare('UPDATE schema_version SET version = 15').run();
    logger.info('DB-Migration auf Version 15 abgeschlossen (continuity_checks Tabelle hinzugefügt).');
  }
  if (version < 16) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_checkpoints (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type   TEXT NOT NULL,
        book_id    INTEGER NOT NULL,
        user_email TEXT NOT NULL DEFAULT '',
        data       TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(job_type, book_id, user_email)
      )
    `);
    db.prepare('UPDATE schema_version SET version = 16').run();
    logger.info('DB-Migration auf Version 16 abgeschlossen (job_checkpoints Tabelle hinzugefügt).');
  }
  if (version < 17) {
    const feCols17 = db.pragma('table_info(figure_events)').map(c => c.name);
    if (!feCols17.includes('kapitel')) db.exec('ALTER TABLE figure_events ADD COLUMN kapitel TEXT');
    if (!feCols17.includes('seite'))   db.exec('ALTER TABLE figure_events ADD COLUMN seite TEXT');
    db.prepare('UPDATE schema_version SET version = 17').run();
    logger.info('DB-Migration auf Version 17 abgeschlossen (figure_events kapitel + seite hinzugefügt).');
  }
  if (version < 18) {
    const faCols = db.pragma('table_info(figure_appearances)').map(c => c.name);
    if (!faCols.includes('chapter_id')) db.exec('ALTER TABLE figure_appearances ADD COLUMN chapter_id INTEGER');
    const feCols18 = db.pragma('table_info(figure_events)').map(c => c.name);
    if (!feCols18.includes('chapter_id')) db.exec('ALTER TABLE figure_events ADD COLUMN chapter_id INTEGER');
    if (!feCols18.includes('page_id'))    db.exec('ALTER TABLE figure_events ADD COLUMN page_id INTEGER');
    const fsCols = db.pragma('table_info(figure_scenes)').map(c => c.name);
    if (!fsCols.includes('chapter_id')) db.exec('ALTER TABLE figure_scenes ADD COLUMN chapter_id INTEGER');
    if (!fsCols.includes('page_id'))    db.exec('ALTER TABLE figure_scenes ADD COLUMN page_id INTEGER');
    db.prepare('UPDATE schema_version SET version = 18').run();
    logger.info('DB-Migration auf Version 18 abgeschlossen (chapter_id/page_id zu figure_appearances, figure_events, figure_scenes hinzugefügt).');
  }
  if (version < 19) {
    const pagesCols = db.pragma('table_info(pages)').map(c => c.name);
    if (!pagesCols.includes('chapter_id'))   db.exec('ALTER TABLE pages ADD COLUMN chapter_id INTEGER');
    if (!pagesCols.includes('chapter_name')) db.exec('ALTER TABLE pages ADD COLUMN chapter_name TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pages_chapter_id ON pages(chapter_id)');
    db.prepare('UPDATE schema_version SET version = 19').run();
    logger.info('DB-Migration auf Version 19 abgeschlossen (pages: chapter_id + chapter_name hinzugefügt).');
  }
  if (version < 20) {
    const pagesCols20 = db.pragma('table_info(pages)').map(c => c.name);
    if (!pagesCols20.includes('preview_text')) db.exec('ALTER TABLE pages ADD COLUMN preview_text TEXT');
    db.prepare('UPDATE schema_version SET version = 20').run();
    logger.info('DB-Migration auf Version 20 abgeschlossen (pages: preview_text hinzugefügt).');
  }
  if (version < 21) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS zeitstrahl_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    INTEGER NOT NULL,
        user_email TEXT NOT NULL DEFAULT '',
        datum      TEXT NOT NULL,
        ereignis   TEXT NOT NULL,
        typ        TEXT DEFAULT 'persoenlich',
        bedeutung  TEXT,
        kapitel    TEXT,
        seiten     TEXT,
        figuren    TEXT,
        sort_order INTEGER DEFAULT 0,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ze_book_id ON zeitstrahl_events(book_id, user_email);
    `);
    db.prepare('UPDATE schema_version SET version = 21').run();
    logger.info('DB-Migration auf Version 21 abgeschlossen (zeitstrahl_events Tabelle hinzugefügt).');
  }
  if (version < 22) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scene_figures (
        scene_id INTEGER NOT NULL REFERENCES figure_scenes(id) ON DELETE CASCADE,
        fig_id   TEXT NOT NULL,
        PRIMARY KEY (scene_id, fig_id)
      );
      CREATE TABLE IF NOT EXISTS location_figures (
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        fig_id      TEXT NOT NULL,
        PRIMARY KEY (location_id, fig_id)
      );
      CREATE TABLE IF NOT EXISTS scene_locations (
        scene_id    INTEGER NOT NULL REFERENCES figure_scenes(id) ON DELETE CASCADE,
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        PRIMARY KEY (scene_id, location_id)
      );
    `);
    const fsCols22 = db.pragma('table_info(figure_scenes)').map(c => c.name);
    if (fsCols22.includes('fig_ids')) {
      const sceneRows22 = db.prepare('SELECT id, fig_ids FROM figure_scenes WHERE fig_ids IS NOT NULL').all();
      const insSf22 = db.prepare('INSERT OR IGNORE INTO scene_figures (scene_id, fig_id) VALUES (?, ?)');
      db.transaction(() => {
        for (const sc of sceneRows22) {
          let ids; try { ids = JSON.parse(sc.fig_ids); } catch { ids = []; }
          if (Array.isArray(ids)) for (const fid of ids) if (fid) insSf22.run(sc.id, fid);
        }
      })();
    }
    const locCols22 = db.pragma('table_info(locations)').map(c => c.name);
    if (locCols22.includes('figuren_json')) {
      const locRows22 = db.prepare('SELECT id, figuren_json FROM locations WHERE figuren_json IS NOT NULL').all();
      const insLf22 = db.prepare('INSERT OR IGNORE INTO location_figures (location_id, fig_id) VALUES (?, ?)');
      db.transaction(() => {
        for (const loc of locRows22) {
          let fids; try { fids = JSON.parse(loc.figuren_json); } catch { fids = []; }
          if (Array.isArray(fids)) for (const fid of fids) if (fid) insLf22.run(loc.id, fid);
        }
      })();
    }
    db.prepare('UPDATE schema_version SET version = 22').run();
    logger.info('DB-Migration auf Version 22 abgeschlossen (scene_figures, location_figures, scene_locations + Datenmigration).');
  }

  if (version < 23) {
    const locCols23 = db.pragma('table_info(locations)').map(c => c.name);
    if (!locCols23.includes('erste_erwaehnung_page_id')) {
      db.exec('ALTER TABLE locations ADD COLUMN erste_erwaehnung_page_id INTEGER');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS location_chapters (
        location_id  INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        chapter_id   INTEGER,
        chapter_name TEXT NOT NULL,
        haeufigkeit  INTEGER DEFAULT 1,
        PRIMARY KEY (location_id, chapter_name)
      );
    `);
    const locColsKap = db.pragma('table_info(locations)').map(c => c.name);
    if (locColsKap.includes('kapitel_json')) {
      const locRows23 = db.prepare('SELECT id, kapitel_json FROM locations WHERE kapitel_json IS NOT NULL').all();
      const insLc23 = db.prepare('INSERT OR IGNORE INTO location_chapters (location_id, chapter_name, haeufigkeit) VALUES (?, ?, ?)');
      db.transaction(() => {
        for (const loc of locRows23) {
          let kaps; try { kaps = JSON.parse(loc.kapitel_json); } catch { kaps = []; }
          if (Array.isArray(kaps)) {
            for (const k of kaps) {
              const name = typeof k === 'string' ? k : k?.name;
              const hf   = typeof k === 'object' ? (k?.haeufigkeit || 1) : 1;
              if (name) insLc23.run(loc.id, name, hf);
            }
          }
        }
      })();
    }
    db.prepare(`
      UPDATE locations
      SET erste_erwaehnung_page_id = (
        SELECT p.page_id FROM pages p
        WHERE p.book_id = locations.book_id
          AND p.page_name = locations.erste_erwaehnung
        LIMIT 1
      )
      WHERE erste_erwaehnung_page_id IS NULL AND erste_erwaehnung IS NOT NULL
    `).run();
    db.prepare('UPDATE schema_version SET version = 23').run();
    logger.info('DB-Migration auf Version 23 abgeschlossen (location_chapters + erste_erwaehnung_page_id).');
  }

  if (version < 24) {
    const hasTagPK = db.pragma('table_info(figure_tags)').some(c => c.pk > 0);
    if (!hasTagPK) {
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE figure_tags_new (
            figure_id INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
            tag       TEXT NOT NULL,
            PRIMARY KEY (figure_id, tag)
          );
          INSERT OR IGNORE INTO figure_tags_new SELECT figure_id, tag FROM figure_tags;
          DROP TABLE figure_tags;
          ALTER TABLE figure_tags_new RENAME TO figure_tags;
        `);
      })();
      db.pragma('foreign_keys = ON');
    }
    db.prepare('UPDATE schema_version SET version = 24').run();
    logger.info('DB-Migration auf Version 24 abgeschlossen (figure_tags PRIMARY KEY hinzugefügt).');
  }

  if (version < 25) {
    const hasAppUnique = db.pragma('index_list(figure_appearances)').some(i => i.unique === 1);
    if (!hasAppUnique) {
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE figure_appearances_new (
            figure_id    INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
            chapter_name TEXT NOT NULL,
            haeufigkeit  INTEGER DEFAULT 1,
            chapter_id   INTEGER,
            UNIQUE(figure_id, chapter_name)
          );
          INSERT OR IGNORE INTO figure_appearances_new (figure_id, chapter_name, haeufigkeit, chapter_id)
            SELECT figure_id, chapter_name, SUM(haeufigkeit), MAX(chapter_id)
            FROM figure_appearances
            GROUP BY figure_id, chapter_name;
          DROP TABLE figure_appearances;
          ALTER TABLE figure_appearances_new RENAME TO figure_appearances;
        `);
      })();
      db.pragma('foreign_keys = ON');
    }
    db.prepare('UPDATE schema_version SET version = 25').run();
    logger.info('DB-Migration auf Version 25 abgeschlossen (figure_appearances UNIQUE-Constraint hinzugefügt).');
  }

  if (version < 26) {
    const fsCols26  = db.pragma('table_info(figure_scenes)').map(c => c.name);
    const locCols26 = db.pragma('table_info(locations)').map(c => c.name);
    if (fsCols26.includes('fig_ids'))       db.exec('ALTER TABLE figure_scenes DROP COLUMN fig_ids');
    if (locCols26.includes('figuren_json')) db.exec('ALTER TABLE locations DROP COLUMN figuren_json');
    if (locCols26.includes('kapitel_json')) db.exec('ALTER TABLE locations DROP COLUMN kapitel_json');
    db.prepare('UPDATE schema_version SET version = 26').run();
    logger.info('DB-Migration auf Version 26 abgeschlossen (veraltete JSON-Spalten fig_ids / figuren_json / kapitel_json entfernt).');
  }

  if (version < 27) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE job_runs_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id      TEXT NOT NULL UNIQUE,
          type        TEXT NOT NULL,
          book_id     INTEGER,
          user_email  TEXT,
          label       TEXT,
          status      TEXT NOT NULL DEFAULT 'queued',
          queued_at   TEXT NOT NULL,
          started_at  TEXT,
          ended_at    TEXT,
          tokens_in   INTEGER DEFAULT 0,
          tokens_out  INTEGER DEFAULT 0,
          error       TEXT
        );
        INSERT INTO job_runs_new
          SELECT id, job_id, type, CAST(book_id AS INTEGER), user_email, label, status,
                 queued_at, started_at, ended_at, tokens_in, tokens_out, error
          FROM job_runs;
        DROP TABLE job_runs;
        ALTER TABLE job_runs_new RENAME TO job_runs;
        CREATE INDEX IF NOT EXISTS idx_jr_book ON job_runs(book_id);
        CREATE INDEX IF NOT EXISTS idx_jr_user ON job_runs(user_email);
      `);
    })();
    db.pragma('foreign_keys = ON');
    db.prepare('UPDATE schema_version SET version = 27').run();
    logger.info('DB-Migration auf Version 27 abgeschlossen (job_runs.book_id TEXT → INTEGER).');
  }

  if (version < 28) {
    const cmSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_messages'").get()?.sql || '';
    if (!cmSql.includes('CHECK')) {
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE chat_messages_new (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id   INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            role         TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
            content      TEXT NOT NULL,
            vorschlaege  TEXT,
            tokens_in    INTEGER,
            tokens_out   INTEGER,
            created_at   TEXT NOT NULL,
            context_info TEXT
          );
          INSERT INTO chat_messages_new
            SELECT id, session_id, role, content, vorschlaege, tokens_in, tokens_out, created_at, context_info
            FROM chat_messages;
          DROP TABLE chat_messages;
          ALTER TABLE chat_messages_new RENAME TO chat_messages;
          CREATE INDEX IF NOT EXISTS idx_cm_session_id ON chat_messages(session_id);
        `);
      })();
      db.pragma('foreign_keys = ON');
    }
    db.prepare('UPDATE schema_version SET version = 28').run();
    logger.info('DB-Migration auf Version 28 abgeschlossen (chat_messages.role CHECK-Constraint hinzugefügt).');
  }
  if (version < 29) {
    db.exec('ALTER TABLE job_runs ADD COLUMN tokens_per_sec REAL');
    db.prepare('UPDATE schema_version SET version = 29').run();
    logger.info('DB-Migration auf Version 29 abgeschlossen (job_runs.tokens_per_sec hinzugefügt).');
  }
  if (version < 30) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS book_settings (
        book_id    INTEGER PRIMARY KEY,
        language   TEXT NOT NULL DEFAULT 'de',
        region     TEXT NOT NULL DEFAULT 'CH',
        updated_at TEXT NOT NULL
      )
    `);
    db.prepare('UPDATE schema_version SET version = 30').run();
    logger.info('DB-Migration auf Version 30 abgeschlossen (book_settings Tabelle hinzugefügt).');
  }

  if (version < 31) {
    const figCols31  = db.pragma('table_info(figures)').map(c => c.name);
    const frelCols31 = db.pragma('table_info(figure_relations)').map(c => c.name);
    if (!figCols31.includes('sozialschicht'))    db.exec('ALTER TABLE figures ADD COLUMN sozialschicht TEXT');
    if (!frelCols31.includes('machtverhaltnis')) db.exec('ALTER TABLE figure_relations ADD COLUMN machtverhaltnis INTEGER');
    db.prepare('UPDATE schema_version SET version = 31').run();
    logger.info('DB-Migration auf Version 31 abgeschlossen (figures.sozialschicht + figure_relations.machtverhaltnis hinzugefügt).');
  }

  if (version < 32) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS character_arcs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id         INTEGER NOT NULL,
        fig_id          TEXT NOT NULL,
        user_email      TEXT,
        arc_typ         TEXT,
        ausgangszustand TEXT,
        endzustand      TEXT,
        gesamtbogen     TEXT,
        updated_at      TEXT NOT NULL,
        UNIQUE(book_id, fig_id, user_email)
      );
      CREATE INDEX IF NOT EXISTS idx_carc_book ON character_arcs(book_id, user_email);
      CREATE TABLE IF NOT EXISTS arc_stages (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        arc_id           INTEGER NOT NULL REFERENCES character_arcs(id) ON DELETE CASCADE,
        sort_order       INTEGER DEFAULT 0,
        kapitel          TEXT,
        soziale_position TEXT,
        innere_haltung   TEXT,
        beziehungsstatus TEXT,
        wendepunkt       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_astage_arc ON arc_stages(arc_id);
    `);
    db.prepare('UPDATE schema_version SET version = 32').run();
    logger.info('DB-Migration auf Version 32 abgeschlossen (character_arcs + arc_stages Tabellen hinzugefügt).');
  }
  if (version < 33) {
    const cols33 = db.pragma('table_info(arc_stages)').map(c => c.name);
    if (!cols33.includes('chapter_id')) {
      db.exec('ALTER TABLE arc_stages ADD COLUMN chapter_id INTEGER');
    }
    db.prepare('UPDATE schema_version SET version = 33').run();
    logger.info('DB-Migration auf Version 33 abgeschlossen (arc_stages.chapter_id hinzugefügt).');
  }
  if (version < 34) {
    const cols34 = db.pragma('table_info(chat_messages)').map(c => c.name);
    if (!cols34.includes('tps')) {
      db.exec('ALTER TABLE chat_messages ADD COLUMN tps REAL');
    }
    db.prepare('UPDATE schema_version SET version = 34').run();
    logger.info('DB-Migration auf Version 34 abgeschlossen (chat_messages.tps hinzugefügt).');
  }
  if (version < 35) {
    db.exec(`
      DROP TABLE IF EXISTS arc_stages;
      DROP TABLE IF EXISTS character_arcs;
    `);
    db.prepare('UPDATE schema_version SET version = 35').run();
    logger.info('DB-Migration auf Version 35 abgeschlossen (character_arcs + arc_stages entfernt).');
  }
  if (version < 36) {
    const bsCols36 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols36.includes('buchtyp'))     db.exec('ALTER TABLE book_settings ADD COLUMN buchtyp TEXT');
    if (!bsCols36.includes('buch_kontext')) db.exec('ALTER TABLE book_settings ADD COLUMN buch_kontext TEXT');
    db.prepare('UPDATE schema_version SET version = 36').run();
    logger.info('DB-Migration auf Version 36 abgeschlossen (book_settings.buchtyp + buch_kontext hinzugefügt).');
  }
  if (version < 37) {
    db.exec('ALTER TABLE page_checks ADD COLUMN chapter_id INTEGER');
    db.prepare('UPDATE schema_version SET version = 37').run();
    logger.info('DB-Migration auf Version 37 abgeschlossen (page_checks.chapter_id hinzugefügt).');
  }
  if (version < 38) {
    db.exec(`CREATE TABLE IF NOT EXISTS chapters (
      chapter_id   INTEGER NOT NULL,
      book_id      INTEGER NOT NULL,
      chapter_name TEXT    NOT NULL,
      updated_at   TEXT,
      PRIMARY KEY (chapter_id, book_id)
    )`);
    db.prepare('UPDATE schema_version SET version = 38').run();
    logger.info('DB-Migration auf Version 38 abgeschlossen (chapters-Tabelle hinzugefügt).');
  }
  if (version < 39) {
    db.exec(`
      UPDATE figure_appearances
      SET chapter_id = (
        SELECT DISTINCT p.chapter_id FROM pages p
        JOIN figures f ON f.book_id = p.book_id
        WHERE f.id = figure_appearances.figure_id
          AND p.chapter_name = figure_appearances.chapter_name
          AND p.chapter_id IS NOT NULL
        LIMIT 1
      )
      WHERE chapter_id IS NULL AND chapter_name IS NOT NULL
    `);
    db.exec(`
      UPDATE location_chapters
      SET chapter_id = (
        SELECT DISTINCT p.chapter_id FROM pages p
        JOIN locations l ON l.id = location_chapters.location_id
        WHERE p.book_id = l.book_id
          AND p.chapter_name = location_chapters.chapter_name
          AND p.chapter_id IS NOT NULL
        LIMIT 1
      )
      WHERE chapter_id IS NULL AND chapter_name IS NOT NULL
    `);
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE figure_appearances_v39 (
        figure_id    INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        chapter_id   INTEGER NOT NULL,
        chapter_name TEXT,
        haeufigkeit  INTEGER DEFAULT 1,
        UNIQUE(figure_id, chapter_id)
      );
      INSERT OR IGNORE INTO figure_appearances_v39 (figure_id, chapter_id, chapter_name, haeufigkeit)
        SELECT figure_id, chapter_id, chapter_name, haeufigkeit
        FROM figure_appearances WHERE chapter_id IS NOT NULL;
      DROP TABLE figure_appearances;
      ALTER TABLE figure_appearances_v39 RENAME TO figure_appearances;
    `);
    db.pragma('foreign_keys = ON');
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE location_chapters_v39 (
        location_id  INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        chapter_id   INTEGER NOT NULL,
        chapter_name TEXT,
        haeufigkeit  INTEGER DEFAULT 1,
        PRIMARY KEY (location_id, chapter_id)
      );
      INSERT OR IGNORE INTO location_chapters_v39 (location_id, chapter_id, chapter_name, haeufigkeit)
        SELECT location_id, chapter_id, chapter_name, haeufigkeit
        FROM location_chapters WHERE chapter_id IS NOT NULL;
      DROP TABLE location_chapters;
      ALTER TABLE location_chapters_v39 RENAME TO location_chapters;
    `);
    db.pragma('foreign_keys = ON');
    const zeCols = db.pragma('table_info(zeitstrahl_events)').map(c => c.name);
    if (!zeCols.includes('chapter_ids')) {
      db.exec('ALTER TABLE zeitstrahl_events ADD COLUMN chapter_ids TEXT');
    }
    db.prepare('UPDATE schema_version SET version = 39').run();
    logger.info('DB-Migration auf Version 39 abgeschlossen (chapter_id als PK in figure_appearances + location_chapters; chapter_ids in zeitstrahl_events).');
  }
  if (version < 40) {
    db.exec(`
      DROP INDEX IF EXISTS idx_pc_page_id;
      DROP INDEX IF EXISTS idx_pc_book_id;
      DROP INDEX IF EXISTS idx_br_book_id;
      DROP INDEX IF EXISTS idx_cm_session_id;
      CREATE INDEX IF NOT EXISTS idx_pc_page_user_date  ON page_checks(page_id, user_email, checked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pc_book_user       ON page_checks(book_id, user_email);
      CREATE INDEX IF NOT EXISTS idx_br_book_user_date  ON book_reviews(book_id, user_email, reviewed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cm_session_created ON chat_messages(session_id, created_at);
    `);
    db.prepare('UPDATE schema_version SET version = 40').run();
    logger.info('DB-Migration auf Version 40 abgeschlossen (Composite-Indizes für page_checks, book_reviews, chat_messages).');
  }
  if (version < 41) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        email            TEXT PRIMARY KEY,
        name             TEXT,
        created_at       TEXT NOT NULL,
        last_login_at    TEXT,
        locale           TEXT,
        theme            TEXT,
        default_buchtyp  TEXT,
        default_language TEXT,
        default_region   TEXT
      );
      INSERT OR IGNORE INTO users (email, created_at)
      SELECT email, datetime('now') FROM user_tokens;
    `);
    db.prepare('UPDATE schema_version SET version = 41').run();
    logger.info('DB-Migration auf Version 41 abgeschlossen (users-Tabelle).');
  }
  if (version < 42) {
    const psCols42 = db.pragma('table_info(page_stats)').map(c => c.name);
    if (!psCols42.includes('sentences'))       db.exec('ALTER TABLE page_stats ADD COLUMN sentences INTEGER');
    if (!psCols42.includes('dialog_chars'))    db.exec('ALTER TABLE page_stats ADD COLUMN dialog_chars INTEGER');
    if (!psCols42.includes('pronoun_counts'))  db.exec('ALTER TABLE page_stats ADD COLUMN pronoun_counts TEXT');
    if (!psCols42.includes('metrics_version')) db.exec('ALTER TABLE page_stats ADD COLUMN metrics_version INTEGER DEFAULT 0');
    if (!psCols42.includes('content_sig'))     db.exec('ALTER TABLE page_stats ADD COLUMN content_sig TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS page_figure_mentions (
        page_id      INTEGER NOT NULL,
        figure_id    INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        count        INTEGER NOT NULL DEFAULT 0,
        first_offset INTEGER,
        PRIMARY KEY (page_id, figure_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pfm_figure ON page_figure_mentions(figure_id);
      CREATE INDEX IF NOT EXISTS idx_pfm_page   ON page_figure_mentions(page_id);
    `);
    db.prepare('UPDATE schema_version SET version = 42').run();
    logger.info('DB-Migration auf Version 42 abgeschlossen (page_stats-Index-Felder + page_figure_mentions).');
  }
  if (version < 43) {
    const healed = db.prepare(`
      UPDATE page_stats
      SET book_id = (SELECT p.book_id FROM pages p WHERE p.page_id = page_stats.page_id)
      WHERE EXISTS (SELECT 1 FROM pages p WHERE p.page_id = page_stats.page_id)
        AND book_id <> (SELECT p.book_id FROM pages p WHERE p.page_id = page_stats.page_id)
    `).run();
    db.prepare('UPDATE schema_version SET version = 43').run();
    logger.info(`DB-Migration auf Version 43 abgeschlossen (page_stats.book_id für ${healed.changes} verschobene Seiten geheilt).`);
  }
  if (version < 44) {
    const figCols44 = db.pragma('table_info(figures)').map(c => c.name);
    const addCol = (name, def) => {
      if (!figCols44.includes(name)) db.exec(`ALTER TABLE figures ADD COLUMN ${name} ${def}`);
    };
    addCol('praesenz',                 'TEXT');
    addCol('rolle',                    'TEXT');
    addCol('motivation',               'TEXT');
    addCol('konflikt',                 'TEXT');
    addCol('entwicklung',              'TEXT');
    addCol('erste_erwaehnung',         'TEXT');
    addCol('erste_erwaehnung_page_id', 'INTEGER');
    addCol('schluesselzitate',         'TEXT');
    const bf = db.prepare(`
      UPDATE figures SET praesenz = CASE
        WHEN typ = 'hauptfigur' THEN 'zentral'
        WHEN (SELECT COUNT(*) FROM figure_appearances WHERE figure_id = figures.id) >= 5 THEN 'zentral'
        WHEN COALESCE((SELECT SUM(haeufigkeit) FROM figure_appearances WHERE figure_id = figures.id), 0) >= 20 THEN 'zentral'
        WHEN typ IN ('antagonist','mentor') THEN 'regelmaessig'
        WHEN (SELECT COUNT(*) FROM figure_appearances WHERE figure_id = figures.id) >= 2 THEN 'regelmaessig'
        WHEN COALESCE((SELECT SUM(haeufigkeit) FROM figure_appearances WHERE figure_id = figures.id), 0) >= 3 THEN 'punktuell'
        ELSE 'randfigur'
      END
      WHERE praesenz IS NULL
    `).run();
    db.prepare('UPDATE schema_version SET version = 44').run();
    logger.info(`DB-Migration auf Version 44 abgeschlossen (figures-Anreicherung: praesenz/rolle/motivation/konflikt/entwicklung/erste_erwaehnung/schluesselzitate; ${bf.changes} Figuren praesenz-gebackfillt).`);
  }
  if (version < 45) {
    const frelCols45 = db.pragma('table_info(figure_relations)').map(c => c.name);
    if (!frelCols45.includes('belege')) db.exec('ALTER TABLE figure_relations ADD COLUMN belege TEXT');
    db.prepare('UPDATE schema_version SET version = 45').run();
    logger.info('DB-Migration auf Version 45 abgeschlossen (figure_relations.belege hinzugefügt).');
  }
  if (version < 46) {
    const psCols46 = db.pragma('table_info(page_stats)').map(c => c.name);
    if (!psCols46.includes('filler_count'))      db.exec('ALTER TABLE page_stats ADD COLUMN filler_count INTEGER');
    if (!psCols46.includes('passive_count'))     db.exec('ALTER TABLE page_stats ADD COLUMN passive_count INTEGER');
    if (!psCols46.includes('adverb_count'))      db.exec('ALTER TABLE page_stats ADD COLUMN adverb_count INTEGER');
    if (!psCols46.includes('avg_sentence_len'))  db.exec('ALTER TABLE page_stats ADD COLUMN avg_sentence_len REAL');
    if (!psCols46.includes('sentence_len_p90'))  db.exec('ALTER TABLE page_stats ADD COLUMN sentence_len_p90 INTEGER');
    if (!psCols46.includes('repetition_data'))   db.exec('ALTER TABLE page_stats ADD COLUMN repetition_data TEXT');
    if (!psCols46.includes('lix'))               db.exec('ALTER TABLE page_stats ADD COLUMN lix REAL');
    if (!psCols46.includes('flesch_de'))         db.exec('ALTER TABLE page_stats ADD COLUMN flesch_de REAL');
    const bshCols46 = db.pragma('table_info(book_stats_history)').map(c => c.name);
    if (!bshCols46.includes('avg_lix'))          db.exec('ALTER TABLE book_stats_history ADD COLUMN avg_lix REAL');
    if (!bshCols46.includes('avg_flesch_de'))    db.exec('ALTER TABLE book_stats_history ADD COLUMN avg_flesch_de REAL');
    db.prepare('UPDATE schema_version SET version = 46').run();
    logger.info('DB-Migration auf Version 46 abgeschlossen (Stil-Heatmap + Lesbarkeit: page_stats + book_stats_history).');
  }
  if (version < 47) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chapter_reviews (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL,
        book_name    TEXT,
        chapter_id   INTEGER NOT NULL,
        chapter_name TEXT,
        reviewed_at  TEXT NOT NULL,
        review_json  TEXT,
        model        TEXT,
        user_email   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cr_book_chapter_user_date
        ON chapter_reviews(book_id, chapter_id, user_email, reviewed_at DESC);
    `);
    db.prepare('UPDATE schema_version SET version = 47').run();
    logger.info('DB-Migration auf Version 47 abgeschlossen (chapter_reviews für Kapitel-Makroreviews).');
  }
  if (version < 48) {
    const psCols48 = db.pragma('table_info(page_stats)').map(c => c.name);
    if (!psCols48.includes('style_samples')) db.exec('ALTER TABLE page_stats ADD COLUMN style_samples TEXT');
    db.prepare('UPDATE schema_version SET version = 48').run();
    logger.info('DB-Migration auf Version 48 abgeschlossen (page_stats.style_samples für Stil-Heatmap-Drilldown).');
  }
  if (version < 49) {
    const bsCols49 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols49.includes('erzaehlperspektive')) db.exec('ALTER TABLE book_settings ADD COLUMN erzaehlperspektive TEXT');
    if (!bsCols49.includes('erzaehlzeit'))        db.exec('ALTER TABLE book_settings ADD COLUMN erzaehlzeit TEXT');
    db.prepare('UPDATE schema_version SET version = 49').run();
    logger.info('DB-Migration auf Version 49 abgeschlossen (book_settings.erzaehlperspektive + erzaehlzeit für Lektorat-Kontext).');
  }
  if (version < 50) {
    db.exec('CREATE TABLE IF NOT EXISTS writing_time (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT NOT NULL, book_id INTEGER NOT NULL, date TEXT NOT NULL, seconds INTEGER NOT NULL DEFAULT 0)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_wt_user_book_date ON writing_time(user_email, book_id, date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wt_book ON writing_time(book_id)');
    db.prepare('UPDATE schema_version SET version = 50').run();
    logger.info('DB-Migration auf Version 50 abgeschlossen (writing_time für Edit-/Fokus-Zeit-Tracking).');
  }
  if (version < 51) {
    const zeCols51 = db.pragma('table_info(zeitstrahl_events)').map(c => c.name);
    if (!zeCols51.includes('page_ids')) {
      db.exec('ALTER TABLE zeitstrahl_events ADD COLUMN page_ids TEXT');
    }
    db.prepare('UPDATE schema_version SET version = 51').run();
    logger.info('DB-Migration auf Version 51 abgeschlossen (page_ids in zeitstrahl_events für robusten Klick-Link auf Seiten).');
  }
  if (version < 52) {
    const userCols52 = db.pragma('table_info(users)').map(c => c.name);
    if (!userCols52.includes('last_seen_at')) {
      db.exec('ALTER TABLE users ADD COLUMN last_seen_at TEXT');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_activity (
        user_email TEXT NOT NULL,
        date       TEXT NOT NULL,
        seconds    INTEGER NOT NULL DEFAULT 0,
        first_at   TEXT,
        last_at    TEXT,
        PRIMARY KEY (user_email, date)
      );
      CREATE INDEX IF NOT EXISTS idx_ua_date ON user_activity(date);
    `);
    db.prepare('UPDATE schema_version SET version = 52').run();
    logger.info('DB-Migration auf Version 52 abgeschlossen (users.last_seen_at + user_activity für Session-Aktivitätszeit).');
  }
  if (version < 53) {
    // Szenen-Seite: historisch hat die KI die Markdown-Header wortwörtlich kopiert
    // («### Was macht Adrian?» statt nur «Was macht Adrian?»), sodass der
    // page_id-Lookup im Komplettanalyse-Save immer null ergeben hat. Jetzt
    // strippen wir den Präfix einmalig und holen fehlende page_ids aus
    // pages (unser lokaler BookStack-Cache), gescoped auf book_id + chapter_id.
    const stripped = db.prepare(`
      UPDATE figure_scenes
      SET seite = TRIM(SUBSTR(seite, 5))
      WHERE seite LIKE '### %'
    `).run().changes;
    const strippedH2 = db.prepare(`
      UPDATE figure_scenes
      SET seite = TRIM(SUBSTR(seite, 4))
      WHERE seite LIKE '## %'
    `).run().changes;
    const backfilled = db.prepare(`
      UPDATE figure_scenes
      SET page_id = (
        SELECT p.page_id FROM pages p
        WHERE p.book_id = figure_scenes.book_id
          AND ((p.chapter_id IS NULL AND figure_scenes.chapter_id IS NULL)
               OR p.chapter_id = figure_scenes.chapter_id)
          AND p.page_name = figure_scenes.seite
        LIMIT 1
      )
      WHERE page_id IS NULL AND seite IS NOT NULL AND seite != ''
    `).run().changes;
    db.prepare('UPDATE schema_version SET version = 53').run();
    logger.info(`DB-Migration auf Version 53 abgeschlossen (figure_scenes.seite: ${stripped + strippedH2} Präfix-Strips, ${backfilled} page_id-Backfills).`);
  }
  if (version < 54) {
    // job_runs.book_id enthielt für page-/session-scoped Jobs (check, chat,
    // book-chat, synonym) bisher die Dedup-Entity-ID (page_id / session_id /
    // entityKey) statt der echten book_id. Dadurch fehlten diese Jobs in der
    // per-Buch-Statistik. Ab jetzt speichert createJob die echte book_id und
    // trennt Dedup über dedupId; historische Zeilen werden hier gebackfillt.
    const checkBack = db.prepare(`
      UPDATE job_runs
      SET book_id = (SELECT p.book_id FROM pages p WHERE p.page_id = job_runs.book_id LIMIT 1)
      WHERE type = 'check'
        AND EXISTS (SELECT 1 FROM pages p WHERE p.page_id = job_runs.book_id)
    `).run().changes;
    const chatBack = db.prepare(`
      UPDATE job_runs
      SET book_id = (SELECT cs.book_id FROM chat_sessions cs WHERE cs.id = job_runs.book_id LIMIT 1)
      WHERE type IN ('chat', 'book-chat')
        AND EXISTS (SELECT 1 FROM chat_sessions cs WHERE cs.id = job_runs.book_id)
    `).run().changes;
    // Synonym-entityKey hatte Format "<bookId>|wort|satz"; erstes Segment extrahieren.
    const synBack = db.prepare(`
      UPDATE job_runs
      SET book_id = CAST(SUBSTR(book_id, 1, INSTR(book_id, '|') - 1) AS INTEGER)
      WHERE type = 'synonym' AND INSTR(CAST(book_id AS TEXT), '|') > 0
    `).run().changes;
    db.prepare('UPDATE schema_version SET version = 54').run();
    logger.info(`DB-Migration auf Version 54 abgeschlossen (job_runs.book_id Backfill: check=${checkBack}, chat/book-chat=${chatBack}, synonym=${synBack}).`);
  }

  if (version < 55) {
    // Hot-Path-Indexes für Lookups, die bisher Full-Scans waren.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_lc_chapter_id  ON location_chapters(chapter_id);
      CREATE INDEX IF NOT EXISTS idx_fa_chapter_id  ON figure_appearances(chapter_id);
      CREATE INDEX IF NOT EXISTS idx_fscene_chapter ON figure_scenes(chapter_id);
      CREATE INDEX IF NOT EXISTS idx_fscene_page    ON figure_scenes(page_id);
      CREATE INDEX IF NOT EXISTS idx_jr_status      ON job_runs(status);
      CREATE INDEX IF NOT EXISTS idx_jr_queued_at   ON job_runs(queued_at DESC);
      CREATE INDEX IF NOT EXISTS idx_frel_from      ON figure_relations(from_fig_id);
      CREATE INDEX IF NOT EXISTS idx_frel_to        ON figure_relations(to_fig_id);
    `);
    db.prepare('UPDATE schema_version SET version = 55').run();
    logger.info('DB-Migration auf Version 55 abgeschlossen (Hot-Path-Indexes für location_chapters, figure_appearances, figure_scenes, job_runs, figure_relations).');
  }

  if (version < 56) {
    // reconcilePageIds() filtert jetzt per book_id; ohne diesen Index landen die
    // Korrelations-Subqueries (chapter_name -> chapter_id) auf einem Full-Scan.
    db.exec('CREATE INDEX IF NOT EXISTS idx_pages_book_chapter_name ON pages(book_id, chapter_name)');
    db.prepare('UPDATE schema_version SET version = 56').run();
    logger.info('DB-Migration auf Version 56 abgeschlossen (Index pages(book_id, chapter_name) fuer reconcilePageIds).');
  }

  if (version < 57) {
    const figCols57 = db.pragma('table_info(figures)').map(c => c.name);
    if (!figCols57.includes('wohnadresse')) {
      db.exec('ALTER TABLE figures ADD COLUMN wohnadresse TEXT');
    }
    db.prepare('UPDATE schema_version SET version = 57').run();
    logger.info('DB-Migration auf Version 57 abgeschlossen (figures.wohnadresse).');
  }

  if (version < 58) {
    const csCols58 = db.pragma('table_info(chat_sessions)').map(c => c.name);
    if (!csCols58.includes('opening_page_text')) {
      db.prepare('ALTER TABLE chat_sessions ADD COLUMN opening_page_text TEXT').run();
    }
    db.prepare('UPDATE schema_version SET version = 58').run();
    logger.info('DB-Migration auf Version 58 abgeschlossen (chat_sessions.opening_page_text).');
  }

  if (version < 59) {
    // continuity_checks.issues_json (JSON-Blob) → eigene Tabelle continuity_issues + Bridge-Tabellen.
    // Vorbild: figure_scenes mit scene_figures/scene_locations.
    db.exec(`
      CREATE TABLE IF NOT EXISTS continuity_issues (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        check_id     INTEGER NOT NULL REFERENCES continuity_checks(id) ON DELETE CASCADE,
        book_id      INTEGER NOT NULL,
        user_email   TEXT,
        schwere      TEXT,
        typ          TEXT,
        beschreibung TEXT,
        stelle_a     TEXT,
        stelle_b     TEXT,
        empfehlung   TEXT,
        sort_order   INTEGER DEFAULT 0,
        updated_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ci_check ON continuity_issues(check_id);
      CREATE INDEX IF NOT EXISTS idx_ci_book  ON continuity_issues(book_id, user_email);

      CREATE TABLE IF NOT EXISTS continuity_issue_figures (
        issue_id   INTEGER NOT NULL REFERENCES continuity_issues(id) ON DELETE CASCADE,
        fig_id     TEXT,
        figur_name TEXT,
        sort_order INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_cif_issue ON continuity_issue_figures(issue_id);

      CREATE TABLE IF NOT EXISTS continuity_issue_chapters (
        issue_id     INTEGER NOT NULL REFERENCES continuity_issues(id) ON DELETE CASCADE,
        chapter_id   INTEGER,
        chapter_name TEXT,
        sort_order   INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_cic_issue ON continuity_issue_chapters(issue_id);
    `);

    const ccCols59 = db.pragma('table_info(continuity_checks)').map(c => c.name);
    if (ccCols59.includes('issues_json')) {
      const insIssue = db.prepare(`INSERT INTO continuity_issues
        (check_id, book_id, user_email, schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung, sort_order, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insIssueFig = db.prepare(`INSERT INTO continuity_issue_figures
        (issue_id, fig_id, figur_name, sort_order) VALUES (?, ?, ?, ?)`);
      const insIssueCh = db.prepare(`INSERT INTO continuity_issue_chapters
        (issue_id, chapter_id, chapter_name, sort_order) VALUES (?, ?, ?, ?)`);
      const figByName = db.prepare('SELECT fig_id FROM figures WHERE book_id = ? AND name = ? LIMIT 1');
      const chByName  = db.prepare('SELECT chapter_id FROM chapters WHERE book_id = ? AND chapter_name = ? LIMIT 1');

      const rows = db.prepare('SELECT id, book_id, user_email, checked_at, issues_json FROM continuity_checks WHERE issues_json IS NOT NULL').all();
      let migrated = 0;
      db.transaction(() => {
        for (const r of rows) {
          let issues;
          try { issues = JSON.parse(r.issues_json); } catch { continue; }
          if (!Array.isArray(issues)) continue;
          for (let i = 0; i < issues.length; i++) {
            const it = issues[i] || {};
            const { lastInsertRowid: issueId } = insIssue.run(
              r.id, r.book_id, r.user_email,
              it.schwere || null, it.typ || null, it.beschreibung || null,
              it.stelle_a || null, it.stelle_b || null, it.empfehlung || null,
              i, r.checked_at,
            );
            // Namen sind authoritativ — das alte normalizedProbleme.fig_ids/chapter_ids
            // war .filter(Boolean) und damit positional NICHT mehr alignt. Daher per
            // chapter_name/figur_name in chapters/figures nachschlagen.
            const figNames = Array.isArray(it.figuren) ? it.figuren : [];
            const seenFig = new Set();
            for (let j = 0; j < figNames.length; j++) {
              const name = typeof figNames[j] === 'string' ? figNames[j].trim() : null;
              if (!name || seenFig.has(name)) continue;
              seenFig.add(name);
              const fid = figByName.get(r.book_id, name)?.fig_id || null;
              insIssueFig.run(issueId, fid, name, j);
            }
            const chNames = Array.isArray(it.kapitel) ? it.kapitel : [];
            const seenCh = new Set();
            for (let j = 0; j < chNames.length; j++) {
              const name = typeof chNames[j] === 'string' ? chNames[j].trim() : null;
              if (!name || seenCh.has(name)) continue;
              seenCh.add(name);
              const cid = chByName.get(r.book_id, name)?.chapter_id ?? null;
              insIssueCh.run(issueId, cid, name, j);
            }
            migrated++;
          }
        }
      })();
      db.exec('ALTER TABLE continuity_checks DROP COLUMN issues_json');
      logger.info(`DB-Migration auf Version 59: ${migrated} Kontinuitäts-Issues aus issues_json migriert; Spalte gedroppt.`);
    } else {
      logger.info('DB-Migration auf Version 59: continuity_checks.issues_json nicht vorhanden — Backfill übersprungen.');
    }
    db.prepare('UPDATE schema_version SET version = 59').run();
    logger.info('DB-Migration auf Version 59 abgeschlossen (continuity_issues + Bridge-Tabellen).');
  }

  if (version < 60) {
    // Korrektur: v59-Backfill alignte chapter_ids/fig_ids positional zu kapitel/figuren,
    // aber das alte normalizedProbleme-Format filterte unaufgelöste IDs raus
    // (positional alignment falsch). Hier neu auflösen anhand chapter_name/figur_name.
    const fixCh = db.prepare(`
      UPDATE continuity_issue_chapters
      SET chapter_id = (
        SELECT c.chapter_id FROM chapters c
        JOIN continuity_issues i ON i.id = continuity_issue_chapters.issue_id
        WHERE c.book_id = i.book_id AND c.chapter_name = continuity_issue_chapters.chapter_name
        LIMIT 1
      )
      WHERE chapter_name IS NOT NULL
    `);
    const fixFig = db.prepare(`
      UPDATE continuity_issue_figures
      SET fig_id = (
        SELECT f.fig_id FROM figures f
        JOIN continuity_issues i ON i.id = continuity_issue_figures.issue_id
        WHERE f.book_id = i.book_id AND f.name = continuity_issue_figures.figur_name
        LIMIT 1
      )
      WHERE figur_name IS NOT NULL
    `);
    const chFixed = fixCh.run().changes;
    const figFixed = fixFig.run().changes;
    db.prepare('UPDATE schema_version SET version = 60').run();
    logger.info(`DB-Migration auf Version 60: ${chFixed} chapter_id- / ${figFixed} fig_id-Verknüpfungen neu aufgelöst.`);
  }

  if (version < 61) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ideen (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL,
        page_id     INTEGER NOT NULL,
        page_name   TEXT,
        user_email  TEXT NOT NULL,
        content     TEXT NOT NULL,
        erledigt    INTEGER NOT NULL DEFAULT 0,
        erledigt_at TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ideen_page_user ON ideen(page_id, user_email)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ideen_book_user ON ideen(book_id, user_email)').run();
    db.prepare('UPDATE schema_version SET version = 61').run();
    logger.info('DB-Migration auf Version 61 abgeschlossen (ideen-Tabelle).');
  }

  if (version < 62) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS finetune_ai_cache (
        book_id    INTEGER NOT NULL,
        user_email TEXT NOT NULL DEFAULT '',
        scope      TEXT NOT NULL,
        scope_key  TEXT NOT NULL,
        sig        TEXT NOT NULL,
        version    TEXT NOT NULL,
        result_json TEXT NOT NULL,
        cached_at  TEXT NOT NULL,
        PRIMARY KEY (book_id, user_email, scope, scope_key, version)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ftai_book_user ON finetune_ai_cache(book_id, user_email)').run();
    db.prepare('UPDATE schema_version SET version = 62').run();
    logger.info('DB-Migration auf Version 62 abgeschlossen (finetune_ai_cache).');
  }
  if (version < 63) {
    const userCols63 = db.pragma('table_info(users)').map(c => c.name);
    if (!userCols63.includes('focus_granularity')) {
      db.exec("ALTER TABLE users ADD COLUMN focus_granularity TEXT");
    }
    db.prepare('UPDATE schema_version SET version = 63').run();
    logger.info('DB-Migration auf Version 63 abgeschlossen (users.focus_granularity).');
  }
  if (version < 64) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS user_feature_usage (
        user_email   TEXT NOT NULL,
        feature_key  TEXT NOT NULL,
        last_used    INTEGER NOT NULL,
        use_count    INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_email, feature_key)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ufu_user_lastused ON user_feature_usage(user_email, last_used DESC)').run();
    db.prepare('UPDATE schema_version SET version = 64').run();
    logger.info('DB-Migration auf Version 64 abgeschlossen (user_feature_usage).');
  }
  if (version < 65) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS user_page_usage (
        user_email   TEXT NOT NULL,
        page_id      INTEGER NOT NULL,
        book_id      INTEGER NOT NULL,
        last_used    INTEGER NOT NULL,
        use_count    INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_email, page_id)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_upu_user_book_lastused ON user_page_usage(user_email, book_id, last_used DESC)').run();
    db.prepare('UPDATE schema_version SET version = 65').run();
    logger.info('DB-Migration auf Version 65 abgeschlossen (user_page_usage).');
  }

  if (version < 66) {
    const cols = db.pragma('table_info(page_checks)').map(c => c.name);
    if (!cols.includes('stilkorrektur_log')) {
      db.exec('ALTER TABLE page_checks ADD COLUMN stilkorrektur_log TEXT');
    }
    db.prepare('UPDATE schema_version SET version = 66').run();
    logger.info('DB-Migration auf Version 66 abgeschlossen (stilkorrektur_log zu page_checks).');
  }

  if (version < 67) {
    db.exec('CREATE TABLE IF NOT EXISTS lektorat_time (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT NOT NULL, book_id INTEGER NOT NULL, page_id INTEGER NOT NULL, date TEXT NOT NULL, seconds INTEGER NOT NULL DEFAULT 0)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_lt_user_book_page_date ON lektorat_time(user_email, book_id, page_id, date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_lt_book ON lektorat_time(book_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_lt_page ON lektorat_time(page_id)');
    db.prepare('UPDATE schema_version SET version = 67').run();
    logger.info('DB-Migration auf Version 67 abgeschlossen (lektorat_time für Prüfmodus-Zeit-Tracking).');
  }

  if (version < 68) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS pdf_export_profile (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL,
        user_email   TEXT    NOT NULL,
        name         TEXT    NOT NULL,
        config_json  TEXT    NOT NULL,
        cover_image  BLOB,
        cover_mime   TEXT,
        is_default   INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        UNIQUE (book_id, user_email, name)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pdf_profile_book_user ON pdf_export_profile (book_id, user_email)').run();
    db.prepare(`
      CREATE TABLE IF NOT EXISTS font_cache (
        family       TEXT NOT NULL,
        weight       INTEGER NOT NULL,
        style        TEXT NOT NULL,
        ttf          BLOB NOT NULL,
        fetched_at   INTEGER NOT NULL,
        PRIMARY KEY (family, weight, style)
      )
    `).run();
    db.prepare('UPDATE schema_version SET version = 68').run();
    logger.info('DB-Migration auf Version 68 abgeschlossen (pdf_export_profile + font_cache).');
  }

  if (version < 69) {
    // chat_sessions: Sentinel page_name='__book__' + page_id=0 durch
    // explizite kind-Spalte ersetzen. Voraussetzung fuer FK auf pages(page_id):
    // page_id darf bei Buch-Chat NULL sein, statt einen FK-blockierenden Sentinel
    // zu tragen. Recreate-Pattern, weil page_id von NOT NULL auf NULLABLE wechselt.
    db.pragma('foreign_keys = OFF');
    db.exec(`
      DROP TABLE IF EXISTS chat_sessions_new;
      CREATE TABLE chat_sessions_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id           INTEGER NOT NULL,
        book_name         TEXT,
        kind              TEXT    NOT NULL DEFAULT 'page' CHECK(kind IN ('page','book')),
        page_id           INTEGER,
        page_name         TEXT,
        user_email        TEXT    NOT NULL,
        created_at        TEXT    NOT NULL,
        last_message_at   TEXT    NOT NULL,
        opening_page_text TEXT,
        CHECK ((kind = 'page' AND page_id IS NOT NULL)
            OR (kind = 'book' AND page_id IS NULL))
      );
      INSERT INTO chat_sessions_new
        (id, book_id, book_name, kind, page_id, page_name,
         user_email, created_at, last_message_at, opening_page_text)
      SELECT id, book_id, book_name,
             CASE WHEN page_name = '__book__' OR page_id IS NULL OR page_id = 0
                  THEN 'book' ELSE 'page' END,
             CASE WHEN page_name = '__book__' OR page_id IS NULL OR page_id = 0
                  THEN NULL ELSE page_id END,
             CASE WHEN page_name = '__book__' OR page_id IS NULL OR page_id = 0
                  THEN NULL ELSE page_name END,
             user_email, created_at, last_message_at, opening_page_text
      FROM chat_sessions;
      DROP TABLE chat_sessions;
      ALTER TABLE chat_sessions_new RENAME TO chat_sessions;
      CREATE INDEX idx_cs_page_id ON chat_sessions(page_id, user_email);
      CREATE INDEX idx_cs_book_id ON chat_sessions(book_id, user_email);
      CREATE INDEX idx_cs_kind    ON chat_sessions(book_id, user_email, kind);
    `);
    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      throw new Error(`Migration 69: foreign_key_check meldet ${fkErrors.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 69').run();
    logger.info('DB-Migration auf Version 69 abgeschlossen (chat_sessions kind-Spalte, Sentinel __book__ aufgeloest).');
  }

  if (version < 70) {
    // Snapshot-Spalten in user-kuratierten Tabellen droppen. Display-Werte
    // (chapter_name, kapitel, seite, page_name) werden zur Lese-Zeit per JOIN
    // auf chapters/pages gewonnen. Vorteile:
    //   - keine Stale-Snapshots bei Kapitel-/Seiten-Rename in BookStack
    //   - reconcilePageIds()-Heilung (~180 SQL-Zeilen) entfaellt
    //   - Voraussetzung fuer FK auf chapters(chapter_id) und pages(page_id)
    db.pragma('foreign_keys = OFF');
    db.exec(`
      DROP TABLE IF EXISTS figure_appearances_new;
      DROP TABLE IF EXISTS figure_events_new;
      DROP TABLE IF EXISTS figure_scenes_new;
      DROP TABLE IF EXISTS location_chapters_new;
      DROP TABLE IF EXISTS continuity_issue_chapters_new;

      CREATE TABLE figure_appearances_new (
        figure_id   INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        chapter_id  INTEGER NOT NULL,
        haeufigkeit INTEGER DEFAULT 1,
        UNIQUE(figure_id, chapter_id)
      );
      INSERT INTO figure_appearances_new (figure_id, chapter_id, haeufigkeit)
        SELECT figure_id, chapter_id, haeufigkeit FROM figure_appearances;
      DROP TABLE figure_appearances;
      ALTER TABLE figure_appearances_new RENAME TO figure_appearances;
      CREATE INDEX idx_fa_chapter_id ON figure_appearances(chapter_id);

      CREATE TABLE figure_events_new (
        figure_id  INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        datum      TEXT NOT NULL,
        ereignis   TEXT NOT NULL,
        bedeutung  TEXT,
        typ        TEXT DEFAULT 'persoenlich',
        sort_order INTEGER DEFAULT 0,
        chapter_id INTEGER,
        page_id    INTEGER
      );
      INSERT INTO figure_events_new
        (figure_id, datum, ereignis, bedeutung, typ, sort_order, chapter_id, page_id)
        SELECT figure_id, datum, ereignis, bedeutung, typ, sort_order, chapter_id, page_id
        FROM figure_events;
      DROP TABLE figure_events;
      ALTER TABLE figure_events_new RENAME TO figure_events;
      CREATE INDEX idx_fe_chapter ON figure_events(chapter_id);
      CREATE INDEX idx_fe_page    ON figure_events(page_id);

      CREATE TABLE figure_scenes_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    INTEGER NOT NULL,
        user_email TEXT,
        titel      TEXT NOT NULL,
        wertung    TEXT,
        kommentar  TEXT,
        sort_order INTEGER DEFAULT 0,
        chapter_id INTEGER,
        page_id    INTEGER,
        updated_at TEXT
      );
      INSERT INTO figure_scenes_new
        (id, book_id, user_email, titel, wertung, kommentar, sort_order, chapter_id, page_id, updated_at)
        SELECT id, book_id, user_email, titel, wertung, kommentar, sort_order, chapter_id, page_id, updated_at
        FROM figure_scenes;
      DROP TABLE figure_scenes;
      ALTER TABLE figure_scenes_new RENAME TO figure_scenes;
      CREATE INDEX idx_fscene_book    ON figure_scenes(book_id, user_email);
      CREATE INDEX idx_fscene_chapter ON figure_scenes(chapter_id);
      CREATE INDEX idx_fscene_page    ON figure_scenes(page_id);

      CREATE TABLE location_chapters_new (
        location_id  INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        chapter_id   INTEGER NOT NULL,
        haeufigkeit  INTEGER DEFAULT 1,
        PRIMARY KEY (location_id, chapter_id)
      );
      INSERT INTO location_chapters_new (location_id, chapter_id, haeufigkeit)
        SELECT location_id, chapter_id, haeufigkeit FROM location_chapters;
      DROP TABLE location_chapters;
      ALTER TABLE location_chapters_new RENAME TO location_chapters;
      CREATE INDEX idx_lc_chapter_id ON location_chapters(chapter_id);

      CREATE TABLE continuity_issue_chapters_new (
        issue_id     INTEGER NOT NULL REFERENCES continuity_issues(id) ON DELETE CASCADE,
        chapter_id   INTEGER,
        sort_order   INTEGER DEFAULT 0
      );
      INSERT INTO continuity_issue_chapters_new (issue_id, chapter_id, sort_order)
        SELECT issue_id, chapter_id, sort_order FROM continuity_issue_chapters
        WHERE chapter_id IS NOT NULL;
      DROP TABLE continuity_issue_chapters;
      ALTER TABLE continuity_issue_chapters_new RENAME TO continuity_issue_chapters;
      CREATE INDEX idx_cic_issue   ON continuity_issue_chapters(issue_id);
      CREATE INDEX idx_cic_chapter ON continuity_issue_chapters(chapter_id);
    `);
    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      throw new Error(`Migration 70: foreign_key_check meldet ${fkErrors.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 70').run();
    logger.info('DB-Migration auf Version 70 abgeschlossen (Snapshot-Spalten chapter_name/kapitel/seite entfernt).');
  }

  if (version < 71) {
    // FK-Anreicherung: harte Refs auf chapters(chapter_id) und pages(page_id).
    //   - CASCADE fuer reine Caches/Aggregationen (page_stats, page_checks,
    //     page_figure_mentions, lektorat_time, chat_sessions[kind=page],
    //     chapter_reviews, chapter_extract_cache, figure_appearances,
    //     location_chapters).
    //   - SET NULL fuer user-kuratierte Refs (figure_events, figure_scenes,
    //     locations.erste_erwaehnung_page_id, continuity_issue_chapters,
    //     page_checks.chapter_id, ideen.page_id, pages.chapter_id).
    // Vorbedingung: UNIQUE INDEX auf chapters(chapter_id) (composite PK reicht
    // nicht als FK-Target). chapter_extract_cache.chapter_key TEXT wird zu
    // chapter_id INTEGER konvertiert.

    db.pragma('foreign_keys = OFF');

    // Pre-Cleanup: Orphans (chapter_id/page_id auf nicht-existente Eltern) nullen,
    // damit FK-Migration nicht crasht. SET NULL passt fuer alle SET-NULL-Targets;
    // CASCADE-Targets bekommen die orphans direkt geloescht.
    db.exec(`
      DELETE FROM page_stats           WHERE page_id NOT IN (SELECT page_id FROM pages);
      DELETE FROM page_checks          WHERE page_id NOT IN (SELECT page_id FROM pages);
      DELETE FROM page_figure_mentions WHERE page_id NOT IN (SELECT page_id FROM pages);
      DELETE FROM lektorat_time        WHERE page_id NOT IN (SELECT page_id FROM pages);
      DELETE FROM chat_sessions        WHERE kind = 'page' AND page_id NOT IN (SELECT page_id FROM pages);
      DELETE FROM chapter_reviews      WHERE chapter_id NOT IN (SELECT chapter_id FROM chapters);
      DELETE FROM figure_appearances   WHERE chapter_id NOT IN (SELECT chapter_id FROM chapters);
      DELETE FROM location_chapters    WHERE chapter_id NOT IN (SELECT chapter_id FROM chapters);
      -- chapter_extract_cache bleibt String-keyed (kein FK), weil Sub-Phase-Keys
      -- ('13:figuren', '13:orte', '__singlepass__') noch existieren. Cache wird
      -- weiterhin manuell beim Kapitel-Drop in pruneStaleBookData invalidiert.

      UPDATE pages                     SET chapter_id = NULL WHERE chapter_id IS NOT NULL AND chapter_id NOT IN (SELECT chapter_id FROM chapters);
      UPDATE figure_events             SET chapter_id = NULL WHERE chapter_id IS NOT NULL AND chapter_id NOT IN (SELECT chapter_id FROM chapters);
      UPDATE figure_events             SET page_id    = NULL WHERE page_id    IS NOT NULL AND page_id    NOT IN (SELECT page_id    FROM pages);
      UPDATE figure_scenes             SET chapter_id = NULL WHERE chapter_id IS NOT NULL AND chapter_id NOT IN (SELECT chapter_id FROM chapters);
      UPDATE figure_scenes             SET page_id    = NULL WHERE page_id    IS NOT NULL AND page_id    NOT IN (SELECT page_id    FROM pages);
      UPDATE locations                 SET erste_erwaehnung_page_id = NULL
        WHERE erste_erwaehnung_page_id IS NOT NULL
          AND erste_erwaehnung_page_id NOT IN (SELECT page_id FROM pages);
      UPDATE continuity_issue_chapters SET chapter_id = NULL WHERE chapter_id IS NOT NULL AND chapter_id NOT IN (SELECT chapter_id FROM chapters);
      UPDATE page_checks               SET chapter_id = NULL WHERE chapter_id IS NOT NULL AND chapter_id NOT IN (SELECT chapter_id FROM chapters);
      UPDATE ideen                     SET page_id    = NULL WHERE page_id    IS NOT NULL AND page_id    NOT IN (SELECT page_id    FROM pages);
    `);

    db.exec(`
      DROP TABLE IF EXISTS chapters_new;
      DROP TABLE IF EXISTS pages_new;
      DROP TABLE IF EXISTS page_stats_new;
      DROP TABLE IF EXISTS page_checks_new;
      DROP TABLE IF EXISTS page_figure_mentions_new;
      DROP TABLE IF EXISTS lektorat_time_new;
      DROP TABLE IF EXISTS chat_sessions_new;
      DROP TABLE IF EXISTS ideen_new;
      DROP TABLE IF EXISTS chapter_reviews_new;
      DROP TABLE IF EXISTS chapter_extract_cache_new;
      DROP TABLE IF EXISTS figure_appearances_new;
      DROP TABLE IF EXISTS figure_events_new;
      DROP TABLE IF EXISTS figure_scenes_new;
      DROP TABLE IF EXISTS location_chapters_new;
      DROP TABLE IF EXISTS continuity_issue_chapters_new;
      DROP TABLE IF EXISTS locations_new;

      -- 1) chapters: composite PK + UNIQUE auf chapter_id alleine
      CREATE TABLE chapters_new (
        chapter_id   INTEGER NOT NULL,
        book_id      INTEGER NOT NULL,
        chapter_name TEXT    NOT NULL,
        updated_at   TEXT,
        PRIMARY KEY (chapter_id, book_id),
        UNIQUE (chapter_id)
      );
      INSERT INTO chapters_new SELECT chapter_id, book_id, chapter_name, updated_at FROM chapters;
      DROP TABLE chapters;
      ALTER TABLE chapters_new RENAME TO chapters;

      -- 2) pages.chapter_id → FK SET NULL
      CREATE TABLE pages_new (
        page_id      INTEGER PRIMARY KEY,
        book_id      INTEGER NOT NULL,
        page_name    TEXT,
        chapter_id   INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        chapter_name TEXT,
        updated_at   TEXT,
        preview_text TEXT
      );
      INSERT INTO pages_new SELECT page_id, book_id, page_name, chapter_id, chapter_name, updated_at, preview_text FROM pages;
      DROP TABLE pages;
      ALTER TABLE pages_new RENAME TO pages;
      CREATE INDEX idx_pages_book_id    ON pages(book_id);
      CREATE INDEX idx_pages_chapter_id ON pages(chapter_id);

      -- 3) page_stats → CASCADE
      CREATE TABLE page_stats_new (
        page_id          INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
        book_id          INTEGER NOT NULL,
        tok              INTEGER,
        words            INTEGER,
        chars            INTEGER,
        updated_at       TEXT,
        cached_at        TEXT,
        sentences        INTEGER,
        dialog_chars     INTEGER,
        pronoun_counts   TEXT,
        metrics_version  INTEGER DEFAULT 0,
        content_sig      TEXT,
        filler_count     INTEGER,
        passive_count    INTEGER,
        adverb_count     INTEGER,
        avg_sentence_len REAL,
        sentence_len_p90 INTEGER,
        repetition_data  TEXT,
        lix              REAL,
        flesch_de        REAL,
        style_samples    TEXT
      );
      INSERT INTO page_stats_new SELECT
        page_id, book_id, tok, words, chars, updated_at, cached_at,
        sentences, dialog_chars, pronoun_counts, metrics_version, content_sig,
        filler_count, passive_count, adverb_count, avg_sentence_len, sentence_len_p90,
        repetition_data, lix, flesch_de, style_samples FROM page_stats;
      DROP TABLE page_stats;
      ALTER TABLE page_stats_new RENAME TO page_stats;
      CREATE INDEX idx_ps_book_id ON page_stats(book_id);

      -- 4) page_checks → page_id CASCADE, chapter_id SET NULL
      CREATE TABLE page_checks_new (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id              INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        page_name            TEXT,
        book_id              INTEGER,
        checked_at           TEXT NOT NULL,
        error_count          INTEGER DEFAULT 0,
        errors_json          TEXT,
        stilanalyse          TEXT,
        fazit                TEXT,
        model                TEXT,
        saved                INTEGER DEFAULT 0,
        saved_at             TEXT,
        applied_errors_json  TEXT,
        user_email           TEXT,
        selected_errors_json TEXT,
        szenen_json          TEXT,
        chapter_id           INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        stilkorrektur_log    TEXT
      );
      INSERT INTO page_checks_new SELECT
        id, page_id, page_name, book_id, checked_at, error_count, errors_json,
        stilanalyse, fazit, model, saved, saved_at, applied_errors_json,
        user_email, selected_errors_json, szenen_json, chapter_id, stilkorrektur_log
        FROM page_checks;
      DROP TABLE page_checks;
      ALTER TABLE page_checks_new RENAME TO page_checks;
      CREATE INDEX idx_pc_page_user_date ON page_checks(page_id, user_email, checked_at DESC);
      CREATE INDEX idx_pc_book_user      ON page_checks(book_id, user_email);

      -- 5) page_figure_mentions → page_id CASCADE (figure_id hatte schon FK)
      CREATE TABLE page_figure_mentions_new (
        page_id      INTEGER NOT NULL REFERENCES pages(page_id)  ON DELETE CASCADE,
        figure_id    INTEGER NOT NULL REFERENCES figures(id)     ON DELETE CASCADE,
        count        INTEGER NOT NULL DEFAULT 0,
        first_offset INTEGER,
        PRIMARY KEY (page_id, figure_id)
      );
      INSERT INTO page_figure_mentions_new SELECT page_id, figure_id, count, first_offset FROM page_figure_mentions;
      DROP TABLE page_figure_mentions;
      ALTER TABLE page_figure_mentions_new RENAME TO page_figure_mentions;
      CREATE INDEX idx_pfm_figure ON page_figure_mentions(figure_id);
      CREATE INDEX idx_pfm_page   ON page_figure_mentions(page_id);

      -- 6) lektorat_time → CASCADE
      CREATE TABLE lektorat_time_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        book_id    INTEGER NOT NULL,
        page_id    INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        date       TEXT NOT NULL,
        seconds    INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO lektorat_time_new SELECT id, user_email, book_id, page_id, date, seconds FROM lektorat_time;
      DROP TABLE lektorat_time;
      ALTER TABLE lektorat_time_new RENAME TO lektorat_time;
      CREATE UNIQUE INDEX idx_lt_user_book_page_date ON lektorat_time(user_email, book_id, page_id, date);
      CREATE INDEX idx_lt_book ON lektorat_time(book_id);
      CREATE INDEX idx_lt_page ON lektorat_time(page_id);

      -- 7) chat_sessions.page_id → CASCADE (kind='page'). kind='book' hat page_id NULL.
      CREATE TABLE chat_sessions_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id           INTEGER NOT NULL,
        book_name         TEXT,
        kind              TEXT    NOT NULL DEFAULT 'page' CHECK(kind IN ('page','book')),
        page_id           INTEGER REFERENCES pages(page_id) ON DELETE CASCADE,
        page_name         TEXT,
        user_email        TEXT    NOT NULL,
        created_at        TEXT    NOT NULL,
        last_message_at   TEXT    NOT NULL,
        opening_page_text TEXT,
        CHECK ((kind = 'page' AND page_id IS NOT NULL)
            OR (kind = 'book' AND page_id IS NULL))
      );
      INSERT INTO chat_sessions_new SELECT
        id, book_id, book_name, kind, page_id, page_name,
        user_email, created_at, last_message_at, opening_page_text FROM chat_sessions;
      DROP TABLE chat_sessions;
      ALTER TABLE chat_sessions_new RENAME TO chat_sessions;
      CREATE INDEX idx_cs_page_id ON chat_sessions(page_id, user_email);
      CREATE INDEX idx_cs_book_id ON chat_sessions(book_id, user_email);
      CREATE INDEX idx_cs_kind    ON chat_sessions(book_id, user_email, kind);

      -- 8) ideen.page_id → SET NULL (war NOT NULL, jetzt nullable)
      CREATE TABLE ideen_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL,
        page_id     INTEGER REFERENCES pages(page_id) ON DELETE SET NULL,
        page_name   TEXT,
        user_email  TEXT NOT NULL,
        content     TEXT NOT NULL,
        erledigt    INTEGER NOT NULL DEFAULT 0,
        erledigt_at TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      INSERT INTO ideen_new SELECT id, book_id, page_id, page_name, user_email, content,
        erledigt, erledigt_at, created_at, updated_at FROM ideen;
      DROP TABLE ideen;
      ALTER TABLE ideen_new RENAME TO ideen;
      CREATE INDEX idx_ideen_page_user ON ideen(page_id, user_email);
      CREATE INDEX idx_ideen_book_user ON ideen(book_id, user_email);

      -- 9) chapter_reviews → CASCADE
      CREATE TABLE chapter_reviews_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL,
        book_name    TEXT,
        chapter_id   INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        chapter_name TEXT,
        reviewed_at  TEXT NOT NULL,
        review_json  TEXT,
        model        TEXT,
        user_email   TEXT
      );
      INSERT INTO chapter_reviews_new SELECT
        id, book_id, book_name, chapter_id, chapter_name, reviewed_at, review_json, model, user_email
        FROM chapter_reviews;
      DROP TABLE chapter_reviews;
      ALTER TABLE chapter_reviews_new RENAME TO chapter_reviews;
      CREATE INDEX idx_cr_book_chapter_user_date
        ON chapter_reviews(book_id, chapter_id, user_email, reviewed_at DESC);

      -- 10) figure_appearances → CASCADE auf chapters
      CREATE TABLE figure_appearances_new (
        figure_id   INTEGER NOT NULL REFERENCES figures(id)            ON DELETE CASCADE,
        chapter_id  INTEGER NOT NULL REFERENCES chapters(chapter_id)   ON DELETE CASCADE,
        haeufigkeit INTEGER DEFAULT 1,
        UNIQUE(figure_id, chapter_id)
      );
      INSERT INTO figure_appearances_new SELECT figure_id, chapter_id, haeufigkeit FROM figure_appearances;
      DROP TABLE figure_appearances;
      ALTER TABLE figure_appearances_new RENAME TO figure_appearances;
      CREATE INDEX idx_fa_chapter_id ON figure_appearances(chapter_id);

      -- 12) figure_events → SET NULL chapter_id + page_id (User-kuratiert)
      CREATE TABLE figure_events_new (
        figure_id  INTEGER NOT NULL REFERENCES figures(id)         ON DELETE CASCADE,
        datum      TEXT NOT NULL,
        ereignis   TEXT NOT NULL,
        bedeutung  TEXT,
        typ        TEXT DEFAULT 'persoenlich',
        sort_order INTEGER DEFAULT 0,
        chapter_id INTEGER REFERENCES chapters(chapter_id)         ON DELETE SET NULL,
        page_id    INTEGER REFERENCES pages(page_id)               ON DELETE SET NULL
      );
      INSERT INTO figure_events_new SELECT
        figure_id, datum, ereignis, bedeutung, typ, sort_order, chapter_id, page_id FROM figure_events;
      DROP TABLE figure_events;
      ALTER TABLE figure_events_new RENAME TO figure_events;
      CREATE INDEX idx_fe_chapter ON figure_events(chapter_id);
      CREATE INDEX idx_fe_page    ON figure_events(page_id);

      -- 13) figure_scenes → SET NULL chapter_id + page_id
      CREATE TABLE figure_scenes_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    INTEGER NOT NULL,
        user_email TEXT,
        titel      TEXT NOT NULL,
        wertung    TEXT,
        kommentar  TEXT,
        sort_order INTEGER DEFAULT 0,
        chapter_id INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        page_id    INTEGER REFERENCES pages(page_id)       ON DELETE SET NULL,
        updated_at TEXT
      );
      INSERT INTO figure_scenes_new SELECT
        id, book_id, user_email, titel, wertung, kommentar, sort_order, chapter_id, page_id, updated_at
        FROM figure_scenes;
      DROP TABLE figure_scenes;
      ALTER TABLE figure_scenes_new RENAME TO figure_scenes;
      CREATE INDEX idx_fscene_book    ON figure_scenes(book_id, user_email);
      CREATE INDEX idx_fscene_chapter ON figure_scenes(chapter_id);
      CREATE INDEX idx_fscene_page    ON figure_scenes(page_id);

      -- 14) location_chapters → CASCADE (PK enthaelt chapter_id, kein NULL moeglich)
      CREATE TABLE location_chapters_new (
        location_id INTEGER NOT NULL REFERENCES locations(id)         ON DELETE CASCADE,
        chapter_id  INTEGER NOT NULL REFERENCES chapters(chapter_id)  ON DELETE CASCADE,
        haeufigkeit INTEGER DEFAULT 1,
        PRIMARY KEY (location_id, chapter_id)
      );
      INSERT INTO location_chapters_new SELECT location_id, chapter_id, haeufigkeit FROM location_chapters;
      DROP TABLE location_chapters;
      ALTER TABLE location_chapters_new RENAME TO location_chapters;
      CREATE INDEX idx_lc_chapter_id ON location_chapters(chapter_id);

      -- 15) continuity_issue_chapters → SET NULL
      CREATE TABLE continuity_issue_chapters_new (
        issue_id   INTEGER NOT NULL REFERENCES continuity_issues(id)  ON DELETE CASCADE,
        chapter_id INTEGER          REFERENCES chapters(chapter_id)   ON DELETE SET NULL,
        sort_order INTEGER DEFAULT 0
      );
      INSERT INTO continuity_issue_chapters_new SELECT issue_id, chapter_id, sort_order FROM continuity_issue_chapters;
      DROP TABLE continuity_issue_chapters;
      ALTER TABLE continuity_issue_chapters_new RENAME TO continuity_issue_chapters;
      CREATE INDEX idx_cic_issue   ON continuity_issue_chapters(issue_id);
      CREATE INDEX idx_cic_chapter ON continuity_issue_chapters(chapter_id);

      -- 16) locations.erste_erwaehnung_page_id → SET NULL
      CREATE TABLE locations_new (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id                  INTEGER NOT NULL,
        loc_id                   TEXT NOT NULL,
        name                     TEXT NOT NULL,
        typ                      TEXT,
        beschreibung             TEXT,
        erste_erwaehnung         TEXT,
        erste_erwaehnung_page_id INTEGER REFERENCES pages(page_id) ON DELETE SET NULL,
        stimmung                 TEXT,
        sort_order               INTEGER DEFAULT 0,
        user_email               TEXT,
        updated_at               TEXT NOT NULL,
        UNIQUE(book_id, loc_id, user_email)
      );
      INSERT INTO locations_new SELECT
        id, book_id, loc_id, name, typ, beschreibung, erste_erwaehnung, erste_erwaehnung_page_id,
        stimmung, sort_order, user_email, updated_at FROM locations;
      DROP TABLE locations;
      ALTER TABLE locations_new RENAME TO locations;
      CREATE INDEX idx_loc_book_id ON locations(book_id, user_email);
    `);

    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      throw new Error(`Migration 71: foreign_key_check meldet ${fkErrors.length} Verstoesse: ${JSON.stringify(fkErrors.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 71').run();
    logger.info('DB-Migration auf Version 71 abgeschlossen (FK CASCADE/SET NULL fuer pages/chapters-Refs).');
  }

  if (version < 72) {
    // figure_relations: TEXT-Refs (from_fig_id/to_fig_id auf figures.fig_id)
    // durch INTEGER-FK auf figures.id (PK) ersetzen. Spalten bleiben namens-
    // gleich (from_fig_id/to_fig_id), Typ ändert sich auf INTEGER + FK CASCADE.
    // Aufrufer (Reads/Writes) übersetzen TEXT-fig_id ↔ INTEGER-id über JOIN.
    db.pragma('foreign_keys = OFF');

    // Pre-Cleanup: orphans entfernen (rows ohne figures-Match)
    db.exec(`
      DELETE FROM figure_relations
      WHERE NOT EXISTS (
        SELECT 1 FROM figures f
        WHERE f.book_id = figure_relations.book_id
          AND f.fig_id  = figure_relations.from_fig_id
          AND (f.user_email IS figure_relations.user_email
               OR (f.user_email IS NULL AND figure_relations.user_email IS NULL))
      )
      OR NOT EXISTS (
        SELECT 1 FROM figures f
        WHERE f.book_id = figure_relations.book_id
          AND f.fig_id  = figure_relations.to_fig_id
          AND (f.user_email IS figure_relations.user_email
               OR (f.user_email IS NULL AND figure_relations.user_email IS NULL))
      );
    `);

    db.exec(`
      DROP TABLE IF EXISTS figure_relations_new;
      CREATE TABLE figure_relations_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id         INTEGER NOT NULL,
        from_fig_id     INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        to_fig_id       INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        typ             TEXT NOT NULL,
        beschreibung    TEXT,
        user_email      TEXT,
        machtverhaltnis INTEGER,
        belege          TEXT
      );
      INSERT INTO figure_relations_new
        (id, book_id, from_fig_id, to_fig_id, typ, beschreibung, user_email, machtverhaltnis, belege)
      SELECT
        fr.id, fr.book_id,
        (SELECT f.id FROM figures f WHERE f.book_id = fr.book_id AND f.fig_id = fr.from_fig_id
           AND (f.user_email IS fr.user_email OR (f.user_email IS NULL AND fr.user_email IS NULL))),
        (SELECT f.id FROM figures f WHERE f.book_id = fr.book_id AND f.fig_id = fr.to_fig_id
           AND (f.user_email IS fr.user_email OR (f.user_email IS NULL AND fr.user_email IS NULL))),
        fr.typ, fr.beschreibung, fr.user_email, fr.machtverhaltnis, fr.belege
      FROM figure_relations fr;
      DROP TABLE figure_relations;
      ALTER TABLE figure_relations_new RENAME TO figure_relations;
      CREATE INDEX idx_frel_book_id ON figure_relations(book_id);
      CREATE INDEX idx_frel_from    ON figure_relations(from_fig_id);
      CREATE INDEX idx_frel_to      ON figure_relations(to_fig_id);
    `);

    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      throw new Error(`Migration 72: foreign_key_check meldet ${fkErrors.length} Verstoesse: ${JSON.stringify(fkErrors.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 72').run();
    logger.info('DB-Migration auf Version 72 abgeschlossen (figure_relations.from/to_fig_id INTEGER + FK CASCADE auf figures.id).');
  }

  if (version < 73) {
    // scene_figures, location_figures, continuity_issue_figures:
    // TEXT-fig_id (BookStack-fig_id-String) → INTEGER figure_id (figures.id PK)
    // mit FK. CASCADE für scene_figures/location_figures (Junction-Tabellen ohne
    // eigenen Display-State). SET NULL für continuity_issue_figures
    // (figur_name bleibt als Snapshot, falls KI fig_id=null hatte).
    db.pragma('foreign_keys = OFF');

    // Pre-Cleanup: orphans entfernen (rows ohne figures-Match via book_id+fig_id+user_email)
    db.exec(`
      DELETE FROM scene_figures
      WHERE NOT EXISTS (
        SELECT 1 FROM figures f JOIN figure_scenes fs ON fs.id = scene_figures.scene_id
        WHERE f.book_id = fs.book_id AND f.fig_id = scene_figures.fig_id
          AND (f.user_email IS fs.user_email OR (f.user_email IS NULL AND fs.user_email IS NULL))
      );
      DELETE FROM location_figures
      WHERE NOT EXISTS (
        SELECT 1 FROM figures f JOIN locations l ON l.id = location_figures.location_id
        WHERE f.book_id = l.book_id AND f.fig_id = location_figures.fig_id
          AND (f.user_email IS l.user_email OR (f.user_email IS NULL AND l.user_email IS NULL))
      );
      -- continuity_issue_figures.fig_id NULLABLE: NULL erlaubt (KI lieferte keinen ID-Match);
      -- nicht-NULL ohne figures-Match -> auf NULL setzen (figur_name bleibt als Snapshot).
      UPDATE continuity_issue_figures
      SET fig_id = NULL
      WHERE fig_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM figures f JOIN continuity_issues ci ON ci.id = continuity_issue_figures.issue_id
          WHERE f.book_id = ci.book_id AND f.fig_id = continuity_issue_figures.fig_id
            AND (f.user_email IS ci.user_email OR (f.user_email IS NULL AND ci.user_email IS NULL))
        );
    `);

    db.exec(`
      DROP TABLE IF EXISTS scene_figures_new;
      DROP TABLE IF EXISTS location_figures_new;
      DROP TABLE IF EXISTS continuity_issue_figures_new;

      -- scene_figures
      CREATE TABLE scene_figures_new (
        scene_id  INTEGER NOT NULL REFERENCES figure_scenes(id) ON DELETE CASCADE,
        figure_id INTEGER NOT NULL REFERENCES figures(id)       ON DELETE CASCADE,
        PRIMARY KEY (scene_id, figure_id)
      );
      INSERT OR IGNORE INTO scene_figures_new (scene_id, figure_id)
      SELECT sf.scene_id,
             (SELECT f.id FROM figures f JOIN figure_scenes fs ON fs.id = sf.scene_id
              WHERE f.book_id = fs.book_id AND f.fig_id = sf.fig_id
                AND (f.user_email IS fs.user_email OR (f.user_email IS NULL AND fs.user_email IS NULL)))
      FROM scene_figures sf;
      DROP TABLE scene_figures;
      ALTER TABLE scene_figures_new RENAME TO scene_figures;
      CREATE INDEX idx_sf_figure ON scene_figures(figure_id);

      -- location_figures
      CREATE TABLE location_figures_new (
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        figure_id   INTEGER NOT NULL REFERENCES figures(id)   ON DELETE CASCADE,
        PRIMARY KEY (location_id, figure_id)
      );
      INSERT OR IGNORE INTO location_figures_new (location_id, figure_id)
      SELECT lf.location_id,
             (SELECT f.id FROM figures f JOIN locations l ON l.id = lf.location_id
              WHERE f.book_id = l.book_id AND f.fig_id = lf.fig_id
                AND (f.user_email IS l.user_email OR (f.user_email IS NULL AND l.user_email IS NULL)))
      FROM location_figures lf;
      DROP TABLE location_figures;
      ALTER TABLE location_figures_new RENAME TO location_figures;
      CREATE INDEX idx_lf_figure ON location_figures(figure_id);

      -- continuity_issue_figures: figure_id NULLABLE + SET NULL; figur_name bleibt
      CREATE TABLE continuity_issue_figures_new (
        issue_id   INTEGER NOT NULL REFERENCES continuity_issues(id) ON DELETE CASCADE,
        figure_id  INTEGER          REFERENCES figures(id)            ON DELETE SET NULL,
        figur_name TEXT,
        sort_order INTEGER DEFAULT 0
      );
      INSERT INTO continuity_issue_figures_new (issue_id, figure_id, figur_name, sort_order)
      SELECT cif.issue_id,
             CASE WHEN cif.fig_id IS NULL THEN NULL ELSE
               (SELECT f.id FROM figures f JOIN continuity_issues ci ON ci.id = cif.issue_id
                WHERE f.book_id = ci.book_id AND f.fig_id = cif.fig_id
                  AND (f.user_email IS ci.user_email OR (f.user_email IS NULL AND ci.user_email IS NULL)))
             END,
             cif.figur_name, cif.sort_order
      FROM continuity_issue_figures cif;
      DROP TABLE continuity_issue_figures;
      ALTER TABLE continuity_issue_figures_new RENAME TO continuity_issue_figures;
      CREATE INDEX idx_cif_issue  ON continuity_issue_figures(issue_id);
      CREATE INDEX idx_cif_figure ON continuity_issue_figures(figure_id);
    `);

    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      throw new Error(`Migration 73: foreign_key_check meldet ${fkErrors.length} Verstoesse: ${JSON.stringify(fkErrors.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 73').run();
    logger.info('DB-Migration auf Version 73 abgeschlossen (scene_figures/location_figures/continuity_issue_figures fig_id INTEGER + FK).');
  }

  if (version < 74) {
    // zeitstrahl_events: JSON-Spalten (kapitel, chapter_ids, seiten, page_ids,
    // figuren) durch Junction-Tabellen mit FK ersetzen. Display-Werte (Namen)
    // werden zur Lese-Zeit aus chapters/pages/figures gejoined.
    db.pragma('foreign_keys = OFF');

    db.exec(`
      DROP TABLE IF EXISTS zeitstrahl_event_chapters;
      DROP TABLE IF EXISTS zeitstrahl_event_pages;
      DROP TABLE IF EXISTS zeitstrahl_event_figures;

      CREATE TABLE zeitstrahl_event_chapters (
        event_id   INTEGER NOT NULL REFERENCES zeitstrahl_events(id) ON DELETE CASCADE,
        chapter_id INTEGER          REFERENCES chapters(chapter_id)  ON DELETE SET NULL,
        sort_order INTEGER DEFAULT 0
      );
      CREATE INDEX idx_zec_event   ON zeitstrahl_event_chapters(event_id);
      CREATE INDEX idx_zec_chapter ON zeitstrahl_event_chapters(chapter_id);

      CREATE TABLE zeitstrahl_event_pages (
        event_id   INTEGER NOT NULL REFERENCES zeitstrahl_events(id) ON DELETE CASCADE,
        page_id    INTEGER          REFERENCES pages(page_id)        ON DELETE SET NULL,
        sort_order INTEGER DEFAULT 0
      );
      CREATE INDEX idx_zep_event ON zeitstrahl_event_pages(event_id);
      CREATE INDEX idx_zep_page  ON zeitstrahl_event_pages(page_id);

      CREATE TABLE zeitstrahl_event_figures (
        event_id   INTEGER NOT NULL REFERENCES zeitstrahl_events(id) ON DELETE CASCADE,
        figure_id  INTEGER          REFERENCES figures(id)            ON DELETE SET NULL,
        figur_name TEXT,
        sort_order INTEGER DEFAULT 0
      );
      CREATE INDEX idx_zef_event  ON zeitstrahl_event_figures(event_id);
      CREATE INDEX idx_zef_figure ON zeitstrahl_event_figures(figure_id);
    `);

    // JSON in JS parsen und in Junction-Tabellen einfuegen.
    const events = db.prepare(
      'SELECT id, book_id, user_email, kapitel, chapter_ids, seiten, page_ids, figuren FROM zeitstrahl_events'
    ).all();
    const insZec = db.prepare('INSERT INTO zeitstrahl_event_chapters (event_id, chapter_id, sort_order) VALUES (?, ?, ?)');
    const insZep = db.prepare('INSERT INTO zeitstrahl_event_pages    (event_id, page_id, sort_order)    VALUES (?, ?, ?)');
    const insZef = db.prepare('INSERT INTO zeitstrahl_event_figures  (event_id, figure_id, figur_name, sort_order) VALUES (?, ?, ?, ?)');
    const validChapters = new Set(db.prepare('SELECT chapter_id FROM chapters').all().map(r => r.chapter_id));
    const validPages    = new Set(db.prepare('SELECT page_id FROM pages').all().map(r => r.page_id));
    const _safeJson = (s) => { if (!s) return []; try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
    for (const ev of events) {
      const chapIds = _safeJson(ev.chapter_ids).map(x => Number(x)).filter(Number.isInteger);
      let i = 0;
      for (const cid of chapIds) {
        insZec.run(ev.id, validChapters.has(cid) ? cid : null, i++);
      }
      const pageIds = _safeJson(ev.page_ids).map(x => Number(x)).filter(Number.isInteger);
      i = 0;
      for (const pid of pageIds) {
        insZep.run(ev.id, validPages.has(pid) ? pid : null, i++);
      }
      // figuren: [{id, name, typ}] oder ["Name"]. id ist TEXT-fig_id → INTEGER lookup
      // pro book/user_email Scope.
      const figs = _safeJson(ev.figuren);
      if (figs.length) {
        const figRows = db.prepare(
          'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
        ).all(ev.book_id, ev.user_email || null);
        const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
        i = 0;
        for (const f of figs) {
          if (!f) continue;
          if (typeof f === 'string') {
            const name = f.trim();
            if (name) insZef.run(ev.id, null, name, i++);
            continue;
          }
          if (typeof f === 'object') {
            const name = (f.name || f.kurzname || '').trim() || null;
            const figIdText = f.id ? String(f.id) : null;
            const rowId = figIdText ? (figIdToRowId[figIdText] ?? null) : null;
            insZef.run(ev.id, rowId, name, i++);
          }
        }
      }
    }

    // Recreate zeitstrahl_events ohne JSON-Spalten
    db.exec(`
      DROP TABLE IF EXISTS zeitstrahl_events_new;
      CREATE TABLE zeitstrahl_events_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    INTEGER NOT NULL,
        user_email TEXT NOT NULL DEFAULT '',
        datum      TEXT NOT NULL,
        ereignis   TEXT NOT NULL,
        typ        TEXT DEFAULT 'persoenlich',
        bedeutung  TEXT,
        sort_order INTEGER DEFAULT 0,
        updated_at TEXT
      );
      INSERT INTO zeitstrahl_events_new (id, book_id, user_email, datum, ereignis, typ, bedeutung, sort_order, updated_at)
      SELECT id, book_id, user_email, datum, ereignis, typ, bedeutung, sort_order, updated_at FROM zeitstrahl_events;
      DROP TABLE zeitstrahl_events;
      ALTER TABLE zeitstrahl_events_new RENAME TO zeitstrahl_events;
      CREATE INDEX idx_ze_book_id ON zeitstrahl_events(book_id, user_email);
    `);

    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      throw new Error(`Migration 74: foreign_key_check meldet ${fkErrors.length} Verstoesse: ${JSON.stringify(fkErrors.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 74').run();
    logger.info('DB-Migration auf Version 74 abgeschlossen (zeitstrahl_events JSON-Spalten -> Junction-Tabellen mit FK).');
  }

  if (version < 75) {
    // chapter_extract_cache: chapter_key TEXT (Mix aus chapter_id, sub-chunks und
    // sub-pass-suffixes) -> chapter_id INTEGER FK + phase TEXT. Buch-Level-Cache
    // (chapter_key='__singlepass__') wandert in eigene Tabelle book_extract_cache
    // (FK auf book_id nicht moeglich — keine lokale books-Tabelle).
    //
    // Format chapter_key: <chapter_id>(__sub<N>)?(:phase)?
    // Mapping: chapter_id := numerischer Praefix, phase := __sub<N>(:figuren|:orte)?
    db.pragma('foreign_keys = OFF');

    db.exec(`
      DROP TABLE IF EXISTS chapter_extract_cache_new;
      DROP TABLE IF EXISTS book_extract_cache;

      CREATE TABLE chapter_extract_cache_new (
        book_id      INTEGER NOT NULL,
        user_email   TEXT    NOT NULL DEFAULT '',
        chapter_id   INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        phase        TEXT    NOT NULL DEFAULT '',
        pages_sig    TEXT    NOT NULL,
        extract_json TEXT    NOT NULL,
        cached_at    TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email, chapter_id, phase)
      );

      CREATE TABLE book_extract_cache (
        book_id      INTEGER NOT NULL,
        user_email   TEXT    NOT NULL DEFAULT '',
        pages_sig    TEXT    NOT NULL,
        extract_json TEXT    NOT NULL,
        cached_at    TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email)
      );
    `);

    const oldRows = db.prepare(
      'SELECT book_id, user_email, chapter_key, pages_sig, extract_json, cached_at FROM chapter_extract_cache'
    ).all();
    const validChapters = new Set(db.prepare('SELECT chapter_id FROM chapters').all().map(r => r.chapter_id));
    const insChapter = db.prepare(`
      INSERT OR REPLACE INTO chapter_extract_cache_new
        (book_id, user_email, chapter_id, phase, pages_sig, extract_json, cached_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insBook = db.prepare(`
      INSERT OR REPLACE INTO book_extract_cache
        (book_id, user_email, pages_sig, extract_json, cached_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    let migratedChapter = 0, migratedBook = 0, dropped = 0;
    for (const r of oldRows) {
      const key = r.chapter_key;
      if (key === '__singlepass__') {
        insBook.run(r.book_id, r.user_email || '', r.pages_sig, r.extract_json, r.cached_at);
        migratedBook++;
        continue;
      }
      const m = String(key).match(/^(\d+)(__sub\d+)?(?::(.+))?$/);
      if (!m) { dropped++; continue; }
      const chapterId = parseInt(m[1]);
      if (!validChapters.has(chapterId)) { dropped++; continue; }
      const sub = m[2] ? m[2].slice(2) : '';
      const phaseSuffix = m[3] || '';
      const phase = sub ? (phaseSuffix ? `${sub}:${phaseSuffix}` : sub) : phaseSuffix;
      insChapter.run(r.book_id, r.user_email || '', chapterId, phase, r.pages_sig, r.extract_json, r.cached_at);
      migratedChapter++;
    }
    logger.info(`Migration 75: chapter_extract_cache migriert: ${migratedChapter} chapter, ${migratedBook} book, ${dropped} verworfen.`);

    db.exec(`
      DROP TABLE chapter_extract_cache;
      ALTER TABLE chapter_extract_cache_new RENAME TO chapter_extract_cache;
    `);

    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      throw new Error(`Migration 75: foreign_key_check meldet ${fkErrors.length} Verstoesse: ${JSON.stringify(fkErrors.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 75').run();
    logger.info('DB-Migration auf Version 75 abgeschlossen (chapter_extract_cache split + FK CASCADE auf chapters).');
  }

  if (version < 76) {
    // CHECK-Constraints fuer server-kontrollierte Spalten:
    //   job_runs.status: festes Enum (5 Zustaende vom Job-Lifecycle).
    //   page_stats.{tok,words,chars,sentences,dialog_chars,filler_count,
    //                passive_count,adverb_count,sentence_len_p90}: NULL OK, sonst >= 0.
    // Spalten von KI-Output (figures.geschlecht, continuity_issues.schwere etc.)
    // bleiben constraint-frei — KI kann atypische Werte liefern.
    db.pragma('foreign_keys = OFF');

    // Pre-Cleanup: ungueltige status-Werte (defensive — sollte nicht vorkommen).
    db.exec(`
      UPDATE job_runs SET status = 'error'
      WHERE status NOT IN ('queued','running','done','error','cancelled');
      UPDATE page_stats SET tok = NULL WHERE tok < 0;
      UPDATE page_stats SET words = NULL WHERE words < 0;
      UPDATE page_stats SET chars = NULL WHERE chars < 0;
      UPDATE page_stats SET sentences = NULL WHERE sentences < 0;
      UPDATE page_stats SET dialog_chars = NULL WHERE dialog_chars < 0;
      UPDATE page_stats SET filler_count = NULL WHERE filler_count < 0;
      UPDATE page_stats SET passive_count = NULL WHERE passive_count < 0;
      UPDATE page_stats SET adverb_count = NULL WHERE adverb_count < 0;
      UPDATE page_stats SET sentence_len_p90 = NULL WHERE sentence_len_p90 < 0;
    `);

    db.exec(`
      DROP TABLE IF EXISTS job_runs_new;
      CREATE TABLE job_runs_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id         TEXT NOT NULL UNIQUE,
        type           TEXT NOT NULL,
        book_id        INTEGER,
        user_email     TEXT,
        label          TEXT,
        status         TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','running','done','error','cancelled')),
        queued_at      TEXT NOT NULL,
        started_at     TEXT,
        ended_at       TEXT,
        tokens_in      INTEGER DEFAULT 0,
        tokens_out     INTEGER DEFAULT 0,
        error          TEXT,
        tokens_per_sec REAL
      );
      INSERT INTO job_runs_new
        (id, job_id, type, book_id, user_email, label, status, queued_at, started_at, ended_at, tokens_in, tokens_out, error, tokens_per_sec)
      SELECT
        id, job_id, type, book_id, user_email, label, status, queued_at, started_at, ended_at, tokens_in, tokens_out, error, tokens_per_sec
      FROM job_runs;
      DROP TABLE job_runs;
      ALTER TABLE job_runs_new RENAME TO job_runs;
      CREATE INDEX idx_jr_book      ON job_runs(book_id);
      CREATE INDEX idx_jr_user      ON job_runs(user_email);
      CREATE INDEX idx_jr_status    ON job_runs(status);
      CREATE INDEX idx_jr_queued_at ON job_runs(queued_at DESC);

      DROP TABLE IF EXISTS page_stats_new;
      CREATE TABLE page_stats_new (
        page_id          INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
        book_id          INTEGER NOT NULL,
        tok              INTEGER CHECK (tok IS NULL OR tok >= 0),
        words            INTEGER CHECK (words IS NULL OR words >= 0),
        chars            INTEGER CHECK (chars IS NULL OR chars >= 0),
        updated_at       TEXT,
        cached_at        TEXT,
        sentences        INTEGER CHECK (sentences IS NULL OR sentences >= 0),
        dialog_chars     INTEGER CHECK (dialog_chars IS NULL OR dialog_chars >= 0),
        pronoun_counts   TEXT,
        metrics_version  INTEGER DEFAULT 0,
        content_sig      TEXT,
        filler_count     INTEGER CHECK (filler_count IS NULL OR filler_count >= 0),
        passive_count    INTEGER CHECK (passive_count IS NULL OR passive_count >= 0),
        adverb_count     INTEGER CHECK (adverb_count IS NULL OR adverb_count >= 0),
        avg_sentence_len REAL,
        sentence_len_p90 INTEGER CHECK (sentence_len_p90 IS NULL OR sentence_len_p90 >= 0),
        repetition_data  TEXT,
        lix              REAL,
        flesch_de        REAL,
        style_samples    TEXT
      );
      INSERT INTO page_stats_new SELECT
        page_id, book_id, tok, words, chars, updated_at, cached_at,
        sentences, dialog_chars, pronoun_counts, metrics_version, content_sig,
        filler_count, passive_count, adverb_count, avg_sentence_len, sentence_len_p90,
        repetition_data, lix, flesch_de, style_samples FROM page_stats;
      DROP TABLE page_stats;
      ALTER TABLE page_stats_new RENAME TO page_stats;
      CREATE INDEX idx_ps_book_id ON page_stats(book_id);
    `);

    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      throw new Error(`Migration 76: foreign_key_check meldet ${fkErrors.length} Verstoesse: ${JSON.stringify(fkErrors.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 76').run();
    logger.info('DB-Migration auf Version 76 abgeschlossen (CHECK-Constraints: job_runs.status enum, page_stats numeric >= 0).');
  }

  if (version < 77) {
    // Lokale `books`-Tabelle als FK-Target. `bookstack_book_id` ist der
    // BookStack-externe Identifier (UNIQUE). Bestehende `book_id`-Spalten in
    // den 26+ Tabellen behalten ihren Wert; FK-Constraints auf
    // books(bookstack_book_id) folgen tabellenweise in spaeteren Migrationen.
    //
    // Backfill: DISTINCT book_ids aus allen bekannten Tabellen + juengste
    // bekannte Namen aus Snapshot-Spalten (book_stats_history,
    // chat_sessions, book_reviews, chapter_reviews). Sentinel-Zeile
    // (bookstack_book_id=0) fuer pdf_export_profile.book_id=0
    // (User-Default-Vorlagen).
    db.prepare(
      'CREATE TABLE IF NOT EXISTS books ('
      + ' id                INTEGER PRIMARY KEY AUTOINCREMENT,'
      + ' bookstack_book_id INTEGER NOT NULL UNIQUE,'
      + ' name              TEXT    NOT NULL,'
      + ' slug              TEXT,'
      + ' created_at        TEXT    NOT NULL,'
      + ' updated_at        TEXT    NOT NULL'
      + ')'
    ).run();

    const nowIso77 = new Date().toISOString();

    db.prepare(
      "INSERT OR IGNORE INTO books (bookstack_book_id, name, created_at, updated_at) VALUES (0, '__user_default__', ?, ?)"
    ).run(nowIso77, nowIso77);

    // Juengsten bekannten Namen pro book_id aus Snapshot-Spalten sammeln.
    // Reihenfolge nach Frische: book_stats_history (taeglicher Cron) >
    // chat_sessions (Session-Erstellung) > book_reviews / chapter_reviews
    // (Job-Ergebnisse). Erste Eintragung gewinnt — daher frischeste zuerst.
    const nameByBook77 = new Map();
    const collect77 = (sql) => {
      for (const r of db.prepare(sql).all()) {
        if (!r.book_id || r.book_id === 0) continue;
        if (!r.book_name) continue;
        if (!nameByBook77.has(r.book_id)) nameByBook77.set(r.book_id, r.book_name);
      }
    };
    const knownTables77 = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    );
    if (knownTables77.has('book_stats_history')) collect77("SELECT book_id, book_name FROM book_stats_history WHERE book_name IS NOT NULL ORDER BY recorded_at DESC");
    if (knownTables77.has('chat_sessions'))      collect77("SELECT book_id, book_name FROM chat_sessions       WHERE book_name IS NOT NULL ORDER BY created_at  DESC");
    if (knownTables77.has('book_reviews'))       collect77("SELECT book_id, book_name FROM book_reviews        WHERE book_name IS NOT NULL ORDER BY reviewed_at DESC");
    if (knownTables77.has('chapter_reviews'))    collect77("SELECT book_id, book_name FROM chapter_reviews     WHERE book_name IS NOT NULL ORDER BY reviewed_at DESC");

    // Alle DISTINCT book_ids aus allen book_id-tragenden Tabellen sammeln.
    // Tabellen, die auf einer alten DB evtl. fehlen, werden uebersprungen.
    const bookIdTables77 = [
      'figures', 'figure_relations', 'page_stats', 'book_stats_history',
      'chat_sessions', 'figure_scenes', 'locations', 'continuity_checks',
      'continuity_issues', 'pages', 'chapters', 'job_runs', 'job_checkpoints',
      'book_settings', 'page_checks', 'book_reviews', 'zeitstrahl_events',
      'character_arcs', 'chapter_extract_cache', 'book_extract_cache',
      'ideen', 'finetune_ai_cache', 'writing_time', 'lektorat_time',
      'user_page_usage', 'pdf_export_profile', 'chapter_reviews',
    ];
    const bookIds77 = new Set();
    for (const t of bookIdTables77) {
      if (!knownTables77.has(t)) continue;
      const rows = db.prepare(`SELECT DISTINCT book_id FROM ${t} WHERE book_id IS NOT NULL AND book_id > 0`).all();
      for (const r of rows) bookIds77.add(r.book_id);
    }

    const insBook77 = db.prepare(
      'INSERT OR IGNORE INTO books (bookstack_book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)'
    );
    let inserted77 = 0;
    db.transaction(() => {
      for (const bsId of bookIds77) {
        const name = nameByBook77.get(bsId) || `Buch ${bsId}`;
        const r = insBook77.run(bsId, name, nowIso77, nowIso77);
        if (r.changes) inserted77++;
      }
    })();

    const fkErrors77 = db.pragma('foreign_key_check');
    if (fkErrors77.length) {
      throw new Error(`Migration 77: foreign_key_check meldet ${fkErrors77.length} Verstoesse: ${JSON.stringify(fkErrors77.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 77').run();
    logger.info(`DB-Migration auf Version 77 abgeschlossen (books-Tabelle + Backfill: ${inserted77} Buecher aus ${bookIds77.size} bekannten BookStack-IDs).`);
  }

  if (version < 78) {
    // Snapshot-Spalten in user-kuratierten und Cache-Tabellen entfernen.
    // Wahrheit lebt nur in pages.page_name (BookStack-Tree-Cache) und
    // chapters.chapter_name (BookStack-Cache). Display-Werte zur Lese-Zeit
    // per JOIN.
    //
    // Index pages(book_id, chapter_name) ist seit Mig 70 tot (reconcilePageIds
    // braucht ihn nicht mehr) und blockiert DROP COLUMN — daher zuerst weg.
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP INDEX IF EXISTS idx_pages_book_chapter_name').run();
    db.prepare('ALTER TABLE pages           DROP COLUMN chapter_name').run();
    db.prepare('ALTER TABLE page_checks     DROP COLUMN page_name').run();
    db.prepare('ALTER TABLE chat_sessions   DROP COLUMN page_name').run();
    db.prepare('ALTER TABLE ideen           DROP COLUMN page_name').run();
    db.prepare('ALTER TABLE chapter_reviews DROP COLUMN chapter_name').run();
    db.pragma('foreign_keys = ON');
    const fkErrors78 = db.pragma('foreign_key_check');
    if (fkErrors78.length) {
      throw new Error(`Migration 78: foreign_key_check meldet ${fkErrors78.length} Verstoesse: ${JSON.stringify(fkErrors78.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 78').run();
    logger.info('DB-Migration auf Version 78 abgeschlossen (Snapshot-Spalten page_name/chapter_name aus user-kuratierten Tabellen entfernt; Display per JOIN auf pages/chapters).');
  }

  if (version < 79) {
    // book_name-Snapshot-Spalten entfernen — Wahrheit lebt seit Mig 77 in
    // books(name). Display-Werte zur Lese-Zeit per JOIN auf
    // books.bookstack_book_id. Spalten haben keine Indexe oder Constraints,
    // ALTER TABLE DROP COLUMN reicht (kein Recreate-Pattern noetig).
    db.pragma('foreign_keys = OFF');
    db.prepare('ALTER TABLE chat_sessions      DROP COLUMN book_name').run();
    db.prepare('ALTER TABLE book_stats_history DROP COLUMN book_name').run();
    db.prepare('ALTER TABLE book_reviews       DROP COLUMN book_name').run();
    db.prepare('ALTER TABLE chapter_reviews    DROP COLUMN book_name').run();
    db.pragma('foreign_keys = ON');
    const fkErrors79 = db.pragma('foreign_key_check');
    if (fkErrors79.length) {
      throw new Error(`Migration 79: foreign_key_check meldet ${fkErrors79.length} Verstoesse: ${JSON.stringify(fkErrors79.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 79').run();
    logger.info('DB-Migration auf Version 79 abgeschlossen (Snapshot-Spalte book_name aus 4 Tabellen entfernt; Display per JOIN auf books(name)).');
  }

  if (version < 80) {
    // last_seen_at: Discovery-Marker, wird bei jedem Sync (BookStack-Discovery)
    // auf jetzt gesetzt. Cron prunt Eintraege deren last_seen_at aelter als
    // STALE_DAYS — zeitbasierte Bereinigung obendrein zur bestehenden
    // presence-basierten pruneStaleBookData.
    // Backfill auf jetzt: alle Bestandseintraege bekommen frische Schonfrist.
    const now80 = new Date().toISOString();
    db.prepare('ALTER TABLE books    ADD COLUMN last_seen_at TEXT').run();
    db.prepare('ALTER TABLE chapters ADD COLUMN last_seen_at TEXT').run();
    db.prepare('ALTER TABLE pages    ADD COLUMN last_seen_at TEXT').run();
    db.prepare('UPDATE books    SET last_seen_at = ?').run(now80);
    db.prepare('UPDATE chapters SET last_seen_at = ?').run(now80);
    db.prepare('UPDATE pages    SET last_seen_at = ?').run(now80);
    db.prepare('CREATE INDEX IF NOT EXISTS idx_books_last_seen    ON books(last_seen_at)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_chapters_last_seen ON chapters(last_seen_at)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_last_seen    ON pages(last_seen_at)').run();
    const fkErrors80 = db.pragma('foreign_key_check');
    if (fkErrors80.length) {
      throw new Error(`Migration 80: foreign_key_check meldet ${fkErrors80.length} Verstoesse: ${JSON.stringify(fkErrors80.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 80').run();
    logger.info('DB-Migration auf Version 80 abgeschlossen (last_seen_at + Indexe fuer books/chapters/pages; Backfill auf jetzt).');
  }

  if (version < 81) {
    // FK-Anreicherung: book_id -> books(bookstack_book_id) fuer 15
    // nicht-strukturelle Tabellen (Caches, Stats, Logs, Konfigurations-
    // Singletons, Job-Tracking). Strukturelle Tabellen (chat_sessions,
    // book_reviews, chapter_reviews, ideen, page_checks, locations,
    // figure_scenes, pages, chapters, figures, figure_relations) folgen.
    //
    // Default ON DELETE CASCADE — Inhalt ist an die BookStack-Buchexistenz
    // gebunden und ohne Buch sinnlos. Ausnahme: job_runs.book_id (nullable;
    // System-Jobs ohne Buchkontext erlaubt) -> SET NULL.
    //
    // Pre-Cleanup: book_ids ohne Eintrag in books loeschen (sollten dank
    // Mig 77-Backfill keine sein, Schutz gegen post-77-Inserts ohne
    // upsertBook-Hook).
    db.pragma('foreign_keys = OFF');

    const cleanupTables81 = [
      'chapter_extract_cache', 'book_extract_cache', 'finetune_ai_cache',
      'page_stats', 'book_stats_history', 'lektorat_time', 'writing_time',
      'user_page_usage', 'continuity_checks', 'continuity_issues',
      'zeitstrahl_events', 'pdf_export_profile', 'book_settings',
      'job_checkpoints',
    ];
    let orphans81 = 0;
    for (const t of cleanupTables81) {
      const r = db.prepare(`DELETE FROM ${t} WHERE book_id NOT IN (SELECT bookstack_book_id FROM books)`).run();
      orphans81 += r.changes;
    }
    // job_runs: book_id nullable, SET NULL fuer Orphans statt Loeschen.
    const jrSetNull = db.prepare(
      'UPDATE job_runs SET book_id = NULL WHERE book_id IS NOT NULL AND book_id NOT IN (SELECT bookstack_book_id FROM books)'
    ).run();
    if (orphans81 || jrSetNull.changes) {
      logger.info(`Mig 81 Pre-Cleanup: ${orphans81} Orphan-Rows geloescht, ${jrSetNull.changes} job_runs.book_id genullt.`);
    }

    // Helper: Recreate-Pattern in einer Funktion buendeln. createSql muss
    // Tabelle als `<table>_new` benennen.
    const _recreate81 = (table, createSql, indexSqls) => {
      db.prepare(`DROP TABLE IF EXISTS ${table}_new`).run();
      db.prepare(createSql).run();
      db.prepare(`INSERT INTO ${table}_new SELECT * FROM ${table}`).run();
      db.prepare(`DROP TABLE ${table}`).run();
      db.prepare(`ALTER TABLE ${table}_new RENAME TO ${table}`).run();
      for (const ix of indexSqls) db.prepare(ix).run();
    };

    // 1) chapter_extract_cache (FK chapter_id bleibt; book_id wird FK)
    _recreate81('chapter_extract_cache', `
      CREATE TABLE chapter_extract_cache_new (
        book_id      INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email   TEXT    NOT NULL DEFAULT '',
        chapter_id   INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        phase        TEXT    NOT NULL DEFAULT '',
        pages_sig    TEXT    NOT NULL,
        extract_json TEXT    NOT NULL,
        cached_at    TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email, chapter_id, phase)
      )
    `, []);

    // 2) book_extract_cache
    _recreate81('book_extract_cache', `
      CREATE TABLE book_extract_cache_new (
        book_id      INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email   TEXT    NOT NULL DEFAULT '',
        pages_sig    TEXT    NOT NULL,
        extract_json TEXT    NOT NULL,
        cached_at    TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email)
      )
    `, []);

    // 3) finetune_ai_cache
    _recreate81('finetune_ai_cache', `
      CREATE TABLE finetune_ai_cache_new (
        book_id     INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL DEFAULT '',
        scope       TEXT    NOT NULL,
        scope_key   TEXT    NOT NULL,
        sig         TEXT    NOT NULL,
        version     TEXT    NOT NULL,
        result_json TEXT    NOT NULL,
        cached_at   TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email, scope, scope_key, version)
      )
    `, [
      'CREATE INDEX idx_ftai_book_user ON finetune_ai_cache(book_id, user_email)',
    ]);

    // 4) page_stats (FK page_id bleibt; book_id wird FK; CHECK aus Mig 76 bleiben)
    _recreate81('page_stats', `
      CREATE TABLE page_stats_new (
        page_id          INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
        book_id          INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        tok              INTEGER CHECK (tok IS NULL OR tok >= 0),
        words            INTEGER CHECK (words IS NULL OR words >= 0),
        chars            INTEGER CHECK (chars IS NULL OR chars >= 0),
        updated_at       TEXT,
        cached_at        TEXT,
        sentences        INTEGER CHECK (sentences IS NULL OR sentences >= 0),
        dialog_chars     INTEGER CHECK (dialog_chars IS NULL OR dialog_chars >= 0),
        pronoun_counts   TEXT,
        metrics_version  INTEGER DEFAULT 0,
        content_sig      TEXT,
        filler_count     INTEGER CHECK (filler_count IS NULL OR filler_count >= 0),
        passive_count    INTEGER CHECK (passive_count IS NULL OR passive_count >= 0),
        adverb_count     INTEGER CHECK (adverb_count IS NULL OR adverb_count >= 0),
        avg_sentence_len REAL,
        sentence_len_p90 INTEGER CHECK (sentence_len_p90 IS NULL OR sentence_len_p90 >= 0),
        repetition_data  TEXT,
        lix              REAL,
        flesch_de        REAL,
        style_samples    TEXT
      )
    `, [
      'CREATE INDEX idx_ps_book_id ON page_stats(book_id)',
    ]);

    // 5) book_stats_history
    _recreate81('book_stats_history', `
      CREATE TABLE book_stats_history_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id          INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        recorded_at      TEXT    NOT NULL,
        page_count       INTEGER,
        words            INTEGER,
        chars            INTEGER,
        tok              INTEGER,
        unique_words     INTEGER,
        chapter_count    INTEGER,
        avg_sentence_len REAL,
        avg_lix          REAL,
        avg_flesch_de    REAL
      )
    `, [
      'CREATE UNIQUE INDEX idx_bsh_book_date ON book_stats_history(book_id, recorded_at)',
      'CREATE INDEX idx_bsh_book_id ON book_stats_history(book_id)',
    ]);

    // 6) lektorat_time
    _recreate81('lektorat_time', `
      CREATE TABLE lektorat_time_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT    NOT NULL,
        book_id    INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        page_id    INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        date       TEXT    NOT NULL,
        seconds    INTEGER NOT NULL DEFAULT 0
      )
    `, [
      'CREATE UNIQUE INDEX idx_lt_user_book_page_date ON lektorat_time(user_email, book_id, page_id, date)',
      'CREATE INDEX idx_lt_book ON lektorat_time(book_id)',
      'CREATE INDEX idx_lt_page ON lektorat_time(page_id)',
    ]);

    // 7) writing_time
    _recreate81('writing_time', `
      CREATE TABLE writing_time_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT    NOT NULL,
        book_id    INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        date       TEXT    NOT NULL,
        seconds    INTEGER NOT NULL DEFAULT 0
      )
    `, [
      'CREATE UNIQUE INDEX idx_wt_user_book_date ON writing_time(user_email, book_id, date)',
      'CREATE INDEX idx_wt_book ON writing_time(book_id)',
    ]);

    // 8) user_page_usage
    _recreate81('user_page_usage', `
      CREATE TABLE user_page_usage_new (
        user_email TEXT    NOT NULL,
        page_id    INTEGER NOT NULL,
        book_id    INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        last_used  INTEGER NOT NULL,
        use_count  INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_email, page_id)
      )
    `, [
      'CREATE INDEX idx_upu_user_book_lastused ON user_page_usage(user_email, book_id, last_used DESC)',
    ]);

    // 9) continuity_checks (continuity_issues.check_id FK auf id bleibt valide nach RENAME)
    _recreate81('continuity_checks', `
      CREATE TABLE continuity_checks_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email TEXT,
        checked_at TEXT NOT NULL,
        summary    TEXT,
        model      TEXT
      )
    `, [
      'CREATE INDEX idx_cc_book_id ON continuity_checks(book_id, user_email)',
    ]);

    // 10) continuity_issues (FK check_id bleibt; book_id wird FK)
    _recreate81('continuity_issues', `
      CREATE TABLE continuity_issues_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        check_id     INTEGER NOT NULL REFERENCES continuity_checks(id) ON DELETE CASCADE,
        book_id      INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email   TEXT,
        schwere      TEXT,
        typ          TEXT,
        beschreibung TEXT,
        stelle_a     TEXT,
        stelle_b     TEXT,
        empfehlung   TEXT,
        sort_order   INTEGER DEFAULT 0,
        updated_at   TEXT
      )
    `, [
      'CREATE INDEX idx_ci_check ON continuity_issues(check_id)',
      'CREATE INDEX idx_ci_book  ON continuity_issues(book_id, user_email)',
    ]);

    // 11) zeitstrahl_events
    _recreate81('zeitstrahl_events', `
      CREATE TABLE zeitstrahl_events_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email TEXT    NOT NULL DEFAULT '',
        datum      TEXT    NOT NULL,
        ereignis   TEXT    NOT NULL,
        typ        TEXT    DEFAULT 'persoenlich',
        bedeutung  TEXT,
        sort_order INTEGER DEFAULT 0,
        updated_at TEXT
      )
    `, [
      'CREATE INDEX idx_ze_book_id ON zeitstrahl_events(book_id, user_email)',
    ]);

    // 12) pdf_export_profile (Sentinel book_id=0 hat books-Zeile aus Mig 77)
    _recreate81('pdf_export_profile', `
      CREATE TABLE pdf_export_profile_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        config_json TEXT    NOT NULL,
        cover_image BLOB,
        cover_mime  TEXT,
        is_default  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        UNIQUE (book_id, user_email, name)
      )
    `, [
      'CREATE INDEX idx_pdf_profile_book_user ON pdf_export_profile (book_id, user_email)',
    ]);

    // 13) book_settings (PK = FK auf books)
    _recreate81('book_settings', `
      CREATE TABLE book_settings_new (
        book_id            INTEGER PRIMARY KEY REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        language           TEXT    NOT NULL DEFAULT 'de',
        region             TEXT    NOT NULL DEFAULT 'CH',
        updated_at         TEXT    NOT NULL,
        buchtyp            TEXT,
        buch_kontext       TEXT,
        erzaehlperspektive TEXT,
        erzaehlzeit        TEXT
      )
    `, []);

    // 14) job_checkpoints
    _recreate81('job_checkpoints', `
      CREATE TABLE job_checkpoints_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type   TEXT    NOT NULL,
        book_id    INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email TEXT    NOT NULL DEFAULT '',
        data       TEXT    NOT NULL,
        updated_at TEXT    NOT NULL,
        UNIQUE(job_type, book_id, user_email)
      )
    `, []);

    // 15) job_runs (book_id nullable -> SET NULL bei Buchloeschung;
    //     System-Jobs ohne Buchkontext bleiben erhalten)
    _recreate81('job_runs', `
      CREATE TABLE job_runs_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id         TEXT    NOT NULL UNIQUE,
        type           TEXT    NOT NULL,
        book_id        INTEGER REFERENCES books(bookstack_book_id) ON DELETE SET NULL,
        user_email     TEXT,
        label          TEXT,
        status         TEXT    NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','running','done','error','cancelled')),
        queued_at      TEXT    NOT NULL,
        started_at     TEXT,
        ended_at       TEXT,
        tokens_in      INTEGER DEFAULT 0,
        tokens_out     INTEGER DEFAULT 0,
        error          TEXT,
        tokens_per_sec REAL
      )
    `, [
      'CREATE INDEX idx_jr_book      ON job_runs(book_id)',
      'CREATE INDEX idx_jr_user      ON job_runs(user_email)',
      'CREATE INDEX idx_jr_status    ON job_runs(status)',
      'CREATE INDEX idx_jr_queued_at ON job_runs(queued_at DESC)',
    ]);

    db.pragma('foreign_keys = ON');
    const fkErrors81 = db.pragma('foreign_key_check');
    if (fkErrors81.length) {
      throw new Error(`Migration 81: foreign_key_check meldet ${fkErrors81.length} Verstoesse: ${JSON.stringify(fkErrors81.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 81').run();
    logger.info('DB-Migration auf Version 81 abgeschlossen (FK book_id -> books fuer 15 Tabellen: Caches, Stats, Logs, book_settings, job_runs, job_checkpoints, pdf_export_profile, continuity_*, zeitstrahl_events).');
  }

  if (version < 82) {
    // FK-Anreicherung: book_id -> books(bookstack_book_id) fuer
    // strukturelle Tabellen — chat_sessions, book_reviews, chapter_reviews,
    // ideen, page_checks, locations, figure_scenes, pages, chapters, figures,
    // figure_relations. Alle CASCADE — Inhalt ist an Buchexistenz gebunden.
    //
    // pages, chapters, figures sind FK-Targets fuer andere Tabellen
    // (page_stats, chapter_extract_cache, figure_relations etc). Mit
    // foreign_keys=OFF waehrend Recreate sind die Child-FKs unkritisch:
    // SQLite bindet FK-Refs an den Tabellennamen, der nach RENAME _new wieder
    // valid ist. fk_check am Ende verifiziert.
    db.pragma('foreign_keys = OFF');

    // Pre-Cleanup: Orphan-book_ids loeschen. Mit foreign_keys=OFF kein Cascade —
    // pro Tabelle manuell. Reihenfolge egal, kein Dependency-Cleanup noetig.
    const cleanupTables82 = [
      'chat_sessions', 'book_reviews', 'chapter_reviews', 'ideen',
      'page_checks', 'locations', 'figure_scenes', 'pages', 'chapters',
      'figures', 'figure_relations',
    ];
    let orphans82 = 0;
    for (const t of cleanupTables82) {
      const r = db.prepare(`DELETE FROM ${t} WHERE book_id NOT IN (SELECT bookstack_book_id FROM books)`).run();
      orphans82 += r.changes;
    }
    if (orphans82) logger.info(`Mig 82 Pre-Cleanup: ${orphans82} Orphan-Rows entfernt.`);

    const _recreate82 = (table, createSql, indexSqls) => {
      db.prepare(`DROP TABLE IF EXISTS ${table}_new`).run();
      db.prepare(createSql).run();
      db.prepare(`INSERT INTO ${table}_new SELECT * FROM ${table}`).run();
      db.prepare(`DROP TABLE ${table}`).run();
      db.prepare(`ALTER TABLE ${table}_new RENAME TO ${table}`).run();
      for (const ix of indexSqls) db.prepare(ix).run();
    };

    // 1) chat_sessions (page_id-FK + kind-CHECK + page-CHECK bleiben)
    _recreate82('chat_sessions', `
      CREATE TABLE chat_sessions_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id           INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        kind              TEXT    NOT NULL DEFAULT 'page' CHECK(kind IN ('page','book')),
        page_id           INTEGER REFERENCES pages(page_id) ON DELETE CASCADE,
        user_email        TEXT    NOT NULL,
        created_at        TEXT    NOT NULL,
        last_message_at   TEXT    NOT NULL,
        opening_page_text TEXT,
        CHECK ((kind = 'page' AND page_id IS NOT NULL)
            OR (kind = 'book' AND page_id IS NULL))
      )
    `, [
      'CREATE INDEX idx_cs_page_id ON chat_sessions(page_id, user_email)',
      'CREATE INDEX idx_cs_book_id ON chat_sessions(book_id, user_email)',
      'CREATE INDEX idx_cs_kind    ON chat_sessions(book_id, user_email, kind)',
    ]);

    // 2) book_reviews
    _recreate82('book_reviews', `
      CREATE TABLE book_reviews_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        reviewed_at TEXT    NOT NULL,
        review_json TEXT,
        model       TEXT,
        user_email  TEXT
      )
    `, [
      'CREATE INDEX idx_br_book_user_date ON book_reviews(book_id, user_email, reviewed_at DESC)',
    ]);

    // 3) chapter_reviews (chapter_id-FK CASCADE bleibt; book_id wird FK)
    _recreate82('chapter_reviews', `
      CREATE TABLE chapter_reviews_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        chapter_id  INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        reviewed_at TEXT    NOT NULL,
        review_json TEXT,
        model       TEXT,
        user_email  TEXT
      )
    `, [
      'CREATE INDEX idx_cr_book_chapter_user_date ON chapter_reviews(book_id, chapter_id, user_email, reviewed_at DESC)',
    ]);

    // 4) ideen (page_id-FK SET NULL bleibt; book_id wird FK CASCADE)
    _recreate82('ideen', `
      CREATE TABLE ideen_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        page_id     INTEGER REFERENCES pages(page_id) ON DELETE SET NULL,
        user_email  TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        erledigt    INTEGER NOT NULL DEFAULT 0,
        erledigt_at TEXT,
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL
      )
    `, [
      'CREATE INDEX idx_ideen_page_user ON ideen(page_id, user_email)',
      'CREATE INDEX idx_ideen_book_user ON ideen(book_id, user_email)',
    ]);

    // 5) page_checks (page_id-FK CASCADE + chapter_id-FK SET NULL bleiben;
    //    book_id war NULLABLE — bleibt nullable mit FK SET NULL, sonst gehen
    //    historische Eintraege verloren, wenn book_id mal vergessen wurde.)
    _recreate82('page_checks', `
      CREATE TABLE page_checks_new (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id              INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        book_id              INTEGER REFERENCES books(bookstack_book_id) ON DELETE SET NULL,
        checked_at           TEXT NOT NULL,
        error_count          INTEGER DEFAULT 0,
        errors_json          TEXT,
        stilanalyse          TEXT,
        fazit                TEXT,
        model                TEXT,
        saved                INTEGER DEFAULT 0,
        saved_at             TEXT,
        applied_errors_json  TEXT,
        user_email           TEXT,
        selected_errors_json TEXT,
        szenen_json          TEXT,
        chapter_id           INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        stilkorrektur_log    TEXT
      )
    `, [
      'CREATE INDEX idx_pc_page_user_date ON page_checks(page_id, user_email, checked_at DESC)',
      'CREATE INDEX idx_pc_book_user      ON page_checks(book_id, user_email)',
    ]);

    // 6) locations (FK erste_erwaehnung_page_id SET NULL bleibt; UNIQUE bleibt)
    _recreate82('locations', `
      CREATE TABLE locations_new (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id                  INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        loc_id                   TEXT    NOT NULL,
        name                     TEXT    NOT NULL,
        typ                      TEXT,
        beschreibung             TEXT,
        erste_erwaehnung         TEXT,
        erste_erwaehnung_page_id INTEGER REFERENCES pages(page_id) ON DELETE SET NULL,
        stimmung                 TEXT,
        sort_order               INTEGER DEFAULT 0,
        user_email               TEXT,
        updated_at               TEXT NOT NULL,
        UNIQUE(book_id, loc_id, user_email)
      )
    `, [
      'CREATE INDEX idx_loc_book_id ON locations(book_id, user_email)',
    ]);

    // 7) figure_scenes (FK chapter_id, page_id SET NULL bleiben)
    _recreate82('figure_scenes', `
      CREATE TABLE figure_scenes_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email TEXT,
        titel      TEXT    NOT NULL,
        wertung    TEXT,
        kommentar  TEXT,
        sort_order INTEGER DEFAULT 0,
        chapter_id INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        page_id    INTEGER REFERENCES pages(page_id)       ON DELETE SET NULL,
        updated_at TEXT
      )
    `, [
      'CREATE INDEX idx_fscene_book    ON figure_scenes(book_id, user_email)',
      'CREATE INDEX idx_fscene_chapter ON figure_scenes(chapter_id)',
      'CREATE INDEX idx_fscene_page    ON figure_scenes(page_id)',
    ]);

    // 8) pages (FK chapter_id SET NULL bleibt; last_seen_at aus Mig 80 bleibt)
    _recreate82('pages', `
      CREATE TABLE pages_new (
        page_id      INTEGER PRIMARY KEY,
        book_id      INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        page_name    TEXT,
        chapter_id   INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        updated_at   TEXT,
        preview_text TEXT,
        last_seen_at TEXT
      )
    `, [
      'CREATE INDEX idx_pages_book_id    ON pages(book_id)',
      'CREATE INDEX idx_pages_chapter_id ON pages(chapter_id)',
      'CREATE INDEX idx_pages_last_seen  ON pages(last_seen_at)',
    ]);

    // 9) chapters (composite PK + UNIQUE(chapter_id) bleiben — UNIQUE
    //    notwendig, weil pages.chapter_id, chapter_reviews.chapter_id,
    //    chapter_extract_cache.chapter_id u.a. auf chapters(chapter_id)
    //    referenzieren; FK-Target braucht entweder PK oder UNIQUE.)
    _recreate82('chapters', `
      CREATE TABLE chapters_new (
        chapter_id   INTEGER NOT NULL,
        book_id      INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        chapter_name TEXT    NOT NULL,
        updated_at   TEXT,
        last_seen_at TEXT,
        PRIMARY KEY (chapter_id, book_id),
        UNIQUE (chapter_id)
      )
    `, [
      'CREATE INDEX idx_chapters_last_seen ON chapters(last_seen_at)',
    ]);

    // 10) figures (UNIQUE(book_id, fig_id, user_email) bleibt)
    _recreate82('figures', `
      CREATE TABLE figures_new (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id                  INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        fig_id                   TEXT    NOT NULL,
        name                     TEXT    NOT NULL,
        kurzname                 TEXT,
        typ                      TEXT,
        geburtstag               TEXT,
        geschlecht               TEXT,
        beruf                    TEXT,
        beschreibung             TEXT,
        sort_order               INTEGER DEFAULT 0,
        meta                     TEXT,
        updated_at               TEXT    NOT NULL,
        user_email               TEXT,
        sozialschicht            TEXT,
        praesenz                 TEXT,
        rolle                    TEXT,
        motivation               TEXT,
        konflikt                 TEXT,
        entwicklung              TEXT,
        erste_erwaehnung         TEXT,
        erste_erwaehnung_page_id INTEGER,
        schluesselzitate         TEXT,
        wohnadresse              TEXT,
        UNIQUE(book_id, fig_id, user_email)
      )
    `, [
      'CREATE INDEX idx_fig_book_id ON figures(book_id)',
    ]);

    // 11) figure_relations (FK from/to_fig_id CASCADE auf figures.id bleiben)
    _recreate82('figure_relations', `
      CREATE TABLE figure_relations_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id         INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        from_fig_id     INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        to_fig_id       INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        typ             TEXT    NOT NULL,
        beschreibung    TEXT,
        user_email      TEXT,
        machtverhaltnis INTEGER,
        belege          TEXT
      )
    `, [
      'CREATE INDEX idx_frel_book_id ON figure_relations(book_id)',
      'CREATE INDEX idx_frel_from    ON figure_relations(from_fig_id)',
      'CREATE INDEX idx_frel_to      ON figure_relations(to_fig_id)',
    ]);

    db.pragma('foreign_keys = ON');
    const fkErrors82 = db.pragma('foreign_key_check');
    if (fkErrors82.length) {
      throw new Error(`Migration 82: foreign_key_check meldet ${fkErrors82.length} Verstoesse: ${JSON.stringify(fkErrors82.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 82').run();
    logger.info('DB-Migration auf Version 82 abgeschlossen (FK book_id -> books fuer 11 strukturelle Tabellen: chat_sessions, book_reviews, chapter_reviews, ideen, page_checks, locations, figure_scenes, pages, chapters, figures, figure_relations).');
  }

  if (version < 83) {
    // Sentinel-Aufloesung pdf_export_profile.book_id=0 (User-Default-Vorlagen).
    // Analog zur chat_sessions-Sentinel-Aufloesung in Mig 69:
    //   book_id IS NULL  + kind='user_default'  → User-Default-Vorlage
    //   book_id NOT NULL + kind='book'          → Buch-spezifisches Profil
    // CHECK-Constraint erzwingt Konsistenz.
    //
    // UNIQUE(book_id, user_email, name) wird durch zwei partial UNIQUEs ersetzt
    // (NULL waere in normalen UNIQUEs nicht-vergleichbar):
    //   - book-scope:    UNIQUE(book_id, user_email, name) WHERE kind='book'
    //   - default-scope: UNIQUE(user_email, name)          WHERE kind='user_default'
    //
    // Nach der Datenmigration wird die books-Sentinel-Zeile (bookstack_book_id=0,
    // name='__user_default__') aus Mig 77 geloescht — sie ist nun unbenutzt.
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP TABLE IF EXISTS pdf_export_profile_new').run();
    db.prepare(`
      CREATE TABLE pdf_export_profile_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        kind        TEXT    NOT NULL DEFAULT 'book' CHECK(kind IN ('book','user_default')),
        user_email  TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        config_json TEXT    NOT NULL,
        cover_image BLOB,
        cover_mime  TEXT,
        is_default  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        CHECK ((kind = 'book' AND book_id IS NOT NULL)
            OR (kind = 'user_default' AND book_id IS NULL))
      )
    `).run();
    db.prepare(`
      INSERT INTO pdf_export_profile_new
        (id, book_id, kind, user_email, name, config_json, cover_image, cover_mime, is_default, created_at, updated_at)
      SELECT id,
             CASE WHEN book_id = 0 THEN NULL ELSE book_id END,
             CASE WHEN book_id = 0 THEN 'user_default' ELSE 'book' END,
             user_email, name, config_json, cover_image, cover_mime, is_default, created_at, updated_at
        FROM pdf_export_profile
    `).run();
    db.prepare('DROP TABLE pdf_export_profile').run();
    db.prepare('ALTER TABLE pdf_export_profile_new RENAME TO pdf_export_profile').run();
    db.prepare(
      'CREATE UNIQUE INDEX idx_pdf_profile_book_name        ON pdf_export_profile(book_id, user_email, name) WHERE kind = \'book\''
    ).run();
    db.prepare(
      'CREATE UNIQUE INDEX idx_pdf_profile_userdefault_name ON pdf_export_profile(user_email, name)          WHERE kind = \'user_default\''
    ).run();
    db.prepare(
      'CREATE INDEX idx_pdf_profile_book_user ON pdf_export_profile(book_id, user_email)'
    ).run();

    // Pre-Cleanup vor DELETE der Sentinel-Zeile: Mit foreign_keys=OFF
    // triggert der DELETE keine FK-Cascades, daher explizit alle book_id=0
    // Refs aufloesen.
    //   - job_runs.book_id (nullable, Mig 81 SET NULL): → NULL
    // Andere book_id-Spalten sind NOT NULL und Pre-Cleanups in Mig 81/82
    // haetten 0-Werte bereits geloescht (NOT IN books); 0 selbst war jedoch
    // in books. Daher hier expliziter Sentinel-Cleanup.
    const jr0_83 = db.prepare('UPDATE job_runs SET book_id = NULL WHERE book_id = 0').run();
    if (jr0_83.changes) logger.info(`Mig 83: ${jr0_83.changes} job_runs.book_id=0 → NULL.`);

    // Sentinel-books-Zeile entfernen — keine Refs mehr.
    db.prepare("DELETE FROM books WHERE bookstack_book_id = 0").run();

    db.pragma('foreign_keys = ON');
    const fkErrors83 = db.pragma('foreign_key_check');
    if (fkErrors83.length) {
      throw new Error(`Migration 83: foreign_key_check meldet ${fkErrors83.length} Verstoesse: ${JSON.stringify(fkErrors83.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 83').run();
    logger.info('DB-Migration auf Version 83 abgeschlossen (pdf_export_profile.book_id Sentinel 0 -> NULL + kind-Spalte; books-Sentinel-Zeile entfernt).');
  }

  if (version < 84) {
    // PDF-Export-Profile sind ab jetzt user-scoped (nicht mehr buch-scoped).
    // Bestehende kind='book'-Eintraege werden zu kind='user_default' migriert.
    // Bei Namens-Kollision (z.B. zwei Buecher haben dasselbe Profil 'A4 Print')
    // wird der Buchname als Suffix angehaengt, damit der UNIQUE-Index
    // (user_email, name) WHERE kind='user_default' nicht bricht.
    const bookProfiles = db.prepare(
      `SELECT p.id, p.user_email, p.name, COALESCE(b.name, '') AS book_name, p.book_id
         FROM pdf_export_profile p
         LEFT JOIN books b ON b.bookstack_book_id = p.book_id
        WHERE p.kind = 'book'`
    ).all();

    const existingNames = new Map(); // userEmail → Set<name>
    db.prepare(
      `SELECT user_email, name FROM pdf_export_profile WHERE kind = 'user_default'`
    ).all().forEach(r => {
      if (!existingNames.has(r.user_email)) existingNames.set(r.user_email, new Set());
      existingNames.get(r.user_email).add(r.name);
    });

    const updateStmt = db.prepare(
      `UPDATE pdf_export_profile
          SET kind = 'user_default', book_id = NULL, name = ?, is_default = 0, updated_at = ?
        WHERE id = ?`
    );

    let migrated = 0;
    db.transaction(() => {
      for (const p of bookProfiles) {
        const userSet = existingNames.get(p.user_email) || new Set();
        let newName = p.name;
        if (userSet.has(newName)) {
          const base = p.book_name ? `${p.name} (${p.book_name})` : `${p.name} (Buch ${p.book_id})`;
          newName = base;
          let i = 2;
          while (userSet.has(newName)) {
            newName = `${base} #${i++}`;
          }
        }
        userSet.add(newName);
        existingNames.set(p.user_email, userSet);
        updateStmt.run(newName, Date.now(), p.id);
        migrated++;
      }
    })();

    db.prepare('UPDATE schema_version SET version = 84').run();
    logger.info(`DB-Migration auf Version 84 abgeschlossen (pdf_export_profile: ${migrated} kind='book' -> 'user_default' migriert).`);
  }

  if (version < 85) {
    // books-PK-Konsolidierung: bookstack_book_id wird zum PRIMARY KEY (analog
    // pages.page_id und chapters.chapter_id, die ebenfalls die externe
    // BookStack-ID direkt als PK nutzen). Surrogate `books.id` AUTOINCREMENT-PK
    // wird entfernt — war intern ungenutzt.
    //
    // Schritt 1: RENAME COLUMN bookstack_book_id -> book_id. SQLite >= 3.25
    // cascadiert FK-Refs in allen child-Tabellen automatisch (REFERENCES
    // books(bookstack_book_id) -> REFERENCES books(book_id)).
    // Schritt 2: Recreate books mit book_id als PK, surrogate `id` entfernt.
    db.pragma('foreign_keys = OFF');

    db.prepare('ALTER TABLE books RENAME COLUMN bookstack_book_id TO book_id').run();

    db.prepare('DROP TABLE IF EXISTS books_new').run();
    db.prepare(`
      CREATE TABLE books_new (
        book_id      INTEGER PRIMARY KEY,
        name         TEXT    NOT NULL,
        slug         TEXT,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        last_seen_at TEXT
      )
    `).run();
    db.prepare(`
      INSERT INTO books_new (book_id, name, slug, created_at, updated_at, last_seen_at)
      SELECT book_id, name, slug, created_at, updated_at, last_seen_at FROM books
    `).run();
    db.prepare('DROP TABLE books').run();
    db.prepare('ALTER TABLE books_new RENAME TO books').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_books_last_seen ON books(last_seen_at)').run();

    db.pragma('foreign_keys = ON');
    const fkErrors85 = db.pragma('foreign_key_check');
    if (fkErrors85.length) {
      throw new Error(`Migration 85: foreign_key_check meldet ${fkErrors85.length} Verstoesse: ${JSON.stringify(fkErrors85.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 85').run();
    logger.info('DB-Migration auf Version 85 abgeschlossen (books.bookstack_book_id -> book_id PK; surrogate id-Spalte entfernt; FK-Refs in child-Tabellen cascadiert).');
  }

  if (version < 86) {
    // job_runs.error_params (JSON-TEXT) — speichert die i18n-Params zum error-Key,
    // damit /jobs/runs (book-settings Run-History) die Meldung mit eingesetzten
    // Platzhaltern rendern kann. Vorher: nur error-Key persistiert, UI zeigte
    // literal {count}/{details}.
    db.prepare('ALTER TABLE job_runs ADD COLUMN error_params TEXT').run();
    const fkErrors86 = db.pragma('foreign_key_check');
    if (fkErrors86.length) {
      throw new Error(`Migration 86: foreign_key_check meldet ${fkErrors86.length} Verstoesse: ${JSON.stringify(fkErrors86.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 86').run();
    logger.info('DB-Migration auf Version 86 abgeschlossen (job_runs.error_params).');
  }

  if (version < 87) {
    // users.daily_goal_chars — Zielwert für Heute-Ring auf der Buch-Übersicht.
    // 1500 Zeichen ≈ 1 Normseite. NULL = User hat kein eigenes Ziel gesetzt
    // → Frontend nutzt 1500 als Fallback.
    const userCols87 = db.pragma('table_info(users)').map(c => c.name);
    if (!userCols87.includes('daily_goal_chars')) {
      db.prepare('ALTER TABLE users ADD COLUMN daily_goal_chars INTEGER').run();
    }
    const fkErrors87 = db.pragma('foreign_key_check');
    if (fkErrors87.length) {
      throw new Error(`Migration 87: foreign_key_check meldet ${fkErrors87.length} Verstoesse: ${JSON.stringify(fkErrors87.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 87').run();
    logger.info('DB-Migration auf Version 87 abgeschlossen (users.daily_goal_chars).');
  }

  if (version < 88) {
    // book_settings.is_finished — markiert Buch als abgeschlossen.
    // Wenn 1, blendet die Buch-Übersicht die "wie viel pro Tag geschrieben"-Kacheln
    // (Trend-Sparkline, 7-Tage-Balken, Heute-Ring, Streak-Heatmap) aus, da bei
    // einem fertigen Buch nicht mehr aktiv geschrieben wird.
    const bsCols88 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols88.includes('is_finished')) {
      db.prepare('ALTER TABLE book_settings ADD COLUMN is_finished INTEGER NOT NULL DEFAULT 0').run();
    }
    const fkErrors88 = db.pragma('foreign_key_check');
    if (fkErrors88.length) {
      throw new Error(`Migration 88: foreign_key_check meldet ${fkErrors88.length} Verstoesse: ${JSON.stringify(fkErrors88.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 88').run();
    logger.info('DB-Migration auf Version 88 abgeschlossen (book_settings.is_finished).');
  }

  if (version < 89) {
    // Token-Verbrauch pro Provider/Modell tracken (Cache-Hits trennen).
    // job_runs: alle Hintergrund-Jobs (Lektorat, Review, Komplett, Synonyme, …).
    // chat_messages: Seiten-Chat (läuft nicht über Job-Queue, eigener Pfad).
    // cache_read_in / cache_creation_in nur Claude (lokale Modelle: 0).
    const jrCols89 = db.pragma('table_info(job_runs)').map(c => c.name);
    if (!jrCols89.includes('provider'))          db.prepare('ALTER TABLE job_runs ADD COLUMN provider TEXT').run();
    if (!jrCols89.includes('model'))             db.prepare('ALTER TABLE job_runs ADD COLUMN model TEXT').run();
    if (!jrCols89.includes('cache_read_in'))     db.prepare('ALTER TABLE job_runs ADD COLUMN cache_read_in INTEGER DEFAULT 0').run();
    if (!jrCols89.includes('cache_creation_in')) db.prepare('ALTER TABLE job_runs ADD COLUMN cache_creation_in INTEGER DEFAULT 0').run();

    const cmCols89 = db.pragma('table_info(chat_messages)').map(c => c.name);
    if (!cmCols89.includes('provider'))          db.prepare('ALTER TABLE chat_messages ADD COLUMN provider TEXT').run();
    if (!cmCols89.includes('model'))             db.prepare('ALTER TABLE chat_messages ADD COLUMN model TEXT').run();
    if (!cmCols89.includes('cache_read_in'))     db.prepare('ALTER TABLE chat_messages ADD COLUMN cache_read_in INTEGER DEFAULT 0').run();
    if (!cmCols89.includes('cache_creation_in')) db.prepare('ALTER TABLE chat_messages ADD COLUMN cache_creation_in INTEGER DEFAULT 0').run();

    db.prepare('CREATE INDEX IF NOT EXISTS idx_jr_user_day ON job_runs(user_email, queued_at)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_cm_created_at ON chat_messages(created_at)').run();

    const fkErrors89 = db.pragma('foreign_key_check');
    if (fkErrors89.length) {
      throw new Error(`Migration 89: foreign_key_check meldet ${fkErrors89.length} Verstoesse: ${JSON.stringify(fkErrors89.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 89').run();
    logger.info('DB-Migration auf Version 89 abgeschlossen (provider/model + cache_read_in/cache_creation_in in job_runs + chat_messages).');
  }

  if (version < 90) {
    // draft_figures: Figuren-Werkstatt (vorwärts-entwickelte Figuren als
    // Mindmap, isoliert von der figures-Tabelle, kein Promotion-Pfad).
    // mindmap_json hält die jsMind-Baumstruktur direkt.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS draft_figures (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email   TEXT    NOT NULL,
        name         TEXT    NOT NULL,
        archetype    TEXT,
        mindmap_json TEXT    NOT NULL,
        notes        TEXT,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_df_book_user ON draft_figures(book_id, user_email)').run();

    const fkErrors90 = db.pragma('foreign_key_check');
    if (fkErrors90.length) {
      throw new Error(`Migration 90: foreign_key_check meldet ${fkErrors90.length} Verstoesse: ${JSON.stringify(fkErrors90.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 90').run();
    logger.info('DB-Migration auf Version 90 abgeschlossen (draft_figures).');
  }

  if (version < 91) {
    // user_tokens.email als FK auf users(email) ON DELETE CASCADE.
    // Token ohne User-Eintrag ist wertlos — sauberer Cascade-Delete.
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM user_tokens WHERE email NOT IN (SELECT email FROM users)').run();

    db.prepare('DROP TABLE IF EXISTS user_tokens_new').run();
    db.prepare(`
      CREATE TABLE user_tokens_new (
        email      TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
        token_id   TEXT NOT NULL,
        token_pw   TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `).run();
    db.prepare('INSERT INTO user_tokens_new SELECT email, token_id, token_pw, updated_at FROM user_tokens').run();
    db.prepare('DROP TABLE user_tokens').run();
    db.prepare('ALTER TABLE user_tokens_new RENAME TO user_tokens').run();

    db.pragma('foreign_keys = ON');
    const fkErrors91 = db.pragma('foreign_key_check');
    if (fkErrors91.length) {
      throw new Error(`Migration 91: foreign_key_check meldet ${fkErrors91.length} Verstoesse: ${JSON.stringify(fkErrors91.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 91').run();
    logger.info('DB-Migration auf Version 91 abgeschlossen (user_tokens.email FK auf users(email) ON DELETE CASCADE).');
  }

  if (version < 92) {
    // figures.erste_erwaehnung_page_id: FK auf pages(page_id) ON DELETE SET NULL.
    // Analog locations.erste_erwaehnung_page_id (gleiche Semantik). Page-Delete
    // hinterlaesst sonst dangling Refs.
    db.pragma('foreign_keys = OFF');
    const orphans92 = db.prepare(`
      UPDATE figures SET erste_erwaehnung_page_id = NULL
       WHERE erste_erwaehnung_page_id IS NOT NULL
         AND erste_erwaehnung_page_id NOT IN (SELECT page_id FROM pages)
    `).run().changes;
    if (orphans92) logger.info(`Mig 92 Pre-Cleanup: ${orphans92} dangling figures.erste_erwaehnung_page_id genullt.`);

    db.prepare('DROP TABLE IF EXISTS figures_new').run();
    db.prepare(`
      CREATE TABLE figures_new (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id                  INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        fig_id                   TEXT    NOT NULL,
        name                     TEXT    NOT NULL,
        kurzname                 TEXT,
        typ                      TEXT,
        geburtstag               TEXT,
        geschlecht               TEXT,
        beruf                    TEXT,
        beschreibung             TEXT,
        sort_order               INTEGER DEFAULT 0,
        meta                     TEXT,
        updated_at               TEXT    NOT NULL,
        user_email               TEXT,
        sozialschicht            TEXT,
        praesenz                 TEXT,
        rolle                    TEXT,
        motivation               TEXT,
        konflikt                 TEXT,
        entwicklung              TEXT,
        erste_erwaehnung         TEXT,
        erste_erwaehnung_page_id INTEGER REFERENCES pages(page_id) ON DELETE SET NULL,
        schluesselzitate         TEXT,
        wohnadresse              TEXT,
        UNIQUE(book_id, fig_id, user_email)
      )
    `).run();
    db.prepare(`
      INSERT INTO figures_new
        (id, book_id, fig_id, name, kurzname, typ, geburtstag, geschlecht, beruf, beschreibung,
         sort_order, meta, updated_at, user_email, sozialschicht, praesenz, rolle, motivation,
         konflikt, entwicklung, erste_erwaehnung, erste_erwaehnung_page_id, schluesselzitate, wohnadresse)
      SELECT
         id, book_id, fig_id, name, kurzname, typ, geburtstag, geschlecht, beruf, beschreibung,
         sort_order, meta, updated_at, user_email, sozialschicht, praesenz, rolle, motivation,
         konflikt, entwicklung, erste_erwaehnung, erste_erwaehnung_page_id, schluesselzitate, wohnadresse
      FROM figures
    `).run();
    db.prepare('DROP TABLE figures').run();
    db.prepare('ALTER TABLE figures_new RENAME TO figures').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_fig_book_id ON figures(book_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_fig_eepage  ON figures(erste_erwaehnung_page_id)').run();

    db.pragma('foreign_keys = ON');
    const fkErrors92 = db.pragma('foreign_key_check');
    if (fkErrors92.length) {
      throw new Error(`Migration 92: foreign_key_check meldet ${fkErrors92.length} Verstoesse: ${JSON.stringify(fkErrors92.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 92').run();
    logger.info('DB-Migration auf Version 92 abgeschlossen (figures.erste_erwaehnung_page_id FK auf pages(page_id) ON DELETE SET NULL).');
  }

  if (version < 93) {
    // chapters: PRIMARY KEY (chapter_id, book_id) + UNIQUE(chapter_id) ist redundant.
    // chapter_id allein ist global eindeutig (BookStack-ID). PK auf chapter_id reduziert,
    // Composite-UNIQUE entfernt — kein Konsument verlaesst sich auf composite-FK.
    db.pragma('foreign_keys = OFF');

    const dupes93 = db.prepare(`
      SELECT chapter_id, COUNT(*) AS c FROM chapters GROUP BY chapter_id HAVING c > 1
    `).all();
    if (dupes93.length) {
      throw new Error(`Migration 93: ${dupes93.length} chapter_ids mit mehrfachen Eintraegen; manuelle Bereinigung noetig.`);
    }

    db.prepare('DROP TABLE IF EXISTS chapters_new').run();
    db.prepare(`
      CREATE TABLE chapters_new (
        chapter_id   INTEGER PRIMARY KEY,
        book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        chapter_name TEXT    NOT NULL,
        updated_at   TEXT,
        last_seen_at TEXT
      )
    `).run();
    db.prepare(`
      INSERT INTO chapters_new (chapter_id, book_id, chapter_name, updated_at, last_seen_at)
      SELECT chapter_id, book_id, chapter_name, updated_at, last_seen_at FROM chapters
    `).run();
    db.prepare('DROP TABLE chapters').run();
    db.prepare('ALTER TABLE chapters_new RENAME TO chapters').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_chapters_last_seen ON chapters(last_seen_at)').run();

    db.pragma('foreign_keys = ON');
    const fkErrors93 = db.pragma('foreign_key_check');
    if (fkErrors93.length) {
      throw new Error(`Migration 93: foreign_key_check meldet ${fkErrors93.length} Verstoesse: ${JSON.stringify(fkErrors93.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 93').run();
    logger.info('DB-Migration auf Version 93 abgeschlossen (chapters PK auf chapter_id reduziert; Composite-UNIQUE entfernt).');
  }

  if (version < 94) {
    // chat_messages: Spaltenreihenfolge konsolidieren. Mehrere ALTERs haben tps/provider/model/
    // cache_read_in/cache_creation_in ans Ende gehaengt — kosmetisch, aber Drift-Indikator.
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP TABLE IF EXISTS chat_messages_new').run();
    db.prepare(`
      CREATE TABLE chat_messages_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id        INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role              TEXT    NOT NULL CHECK(role IN ('user','assistant')),
        content           TEXT    NOT NULL,
        vorschlaege       TEXT,
        context_info      TEXT,
        provider          TEXT,
        model             TEXT,
        tokens_in         INTEGER,
        tokens_out        INTEGER,
        cache_read_in     INTEGER DEFAULT 0,
        cache_creation_in INTEGER DEFAULT 0,
        tps               REAL,
        created_at        TEXT NOT NULL
      )
    `).run();
    db.prepare(`
      INSERT INTO chat_messages_new
        (id, session_id, role, content, vorschlaege, context_info, provider, model,
         tokens_in, tokens_out, cache_read_in, cache_creation_in, tps, created_at)
      SELECT
         id, session_id, role, content, vorschlaege, context_info, provider, model,
         tokens_in, tokens_out, cache_read_in, cache_creation_in, tps, created_at
      FROM chat_messages
    `).run();
    db.prepare('DROP TABLE chat_messages').run();
    db.prepare('ALTER TABLE chat_messages_new RENAME TO chat_messages').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_cm_session_created ON chat_messages(session_id, created_at)').run();

    db.pragma('foreign_keys = ON');
    const fkErrors94 = db.pragma('foreign_key_check');
    if (fkErrors94.length) {
      throw new Error(`Migration 94: foreign_key_check meldet ${fkErrors94.length} Verstoesse: ${JSON.stringify(fkErrors94.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 94').run();
    logger.info('DB-Migration auf Version 94 abgeschlossen (chat_messages Spaltenreihenfolge konsolidiert).');
  }

  if (version < 95) {
    // figure_relations: UNIQUE(book_id, from_fig_id, to_fig_id, typ, user_email)
    // als Defensive-Schicht. Beide Schreibpfade machen bereits Programm-Dedup
    // (saveFigurenToDb: Full-Replace; addFigurenBeziehungen: ungerichteter Pair-Check).
    // Constraint laesst kuenftige Bugs hart scheitern statt Doppel-Edges entstehen.
    db.pragma('foreign_keys = OFF');

    const dedup95 = db.prepare(`
      DELETE FROM figure_relations
       WHERE rowid NOT IN (
         SELECT MIN(rowid) FROM figure_relations
          GROUP BY book_id, from_fig_id, to_fig_id, typ, COALESCE(user_email,'')
       )
    `).run().changes;
    if (dedup95) logger.info(`Mig 95 Pre-Cleanup: ${dedup95} Duplikat-Relations entfernt.`);

    db.prepare('DROP TABLE IF EXISTS figure_relations_new').run();
    db.prepare(`
      CREATE TABLE figure_relations_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id         INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        from_fig_id     INTEGER NOT NULL REFERENCES figures(id)    ON DELETE CASCADE,
        to_fig_id       INTEGER NOT NULL REFERENCES figures(id)    ON DELETE CASCADE,
        typ             TEXT    NOT NULL,
        beschreibung    TEXT,
        user_email      TEXT,
        machtverhaltnis INTEGER,
        belege          TEXT,
        UNIQUE(book_id, from_fig_id, to_fig_id, typ, user_email)
      )
    `).run();
    db.prepare(`
      INSERT INTO figure_relations_new
        (id, book_id, from_fig_id, to_fig_id, typ, beschreibung, user_email, machtverhaltnis, belege)
      SELECT
         id, book_id, from_fig_id, to_fig_id, typ, beschreibung, user_email, machtverhaltnis, belege
      FROM figure_relations
    `).run();
    db.prepare('DROP TABLE figure_relations').run();
    db.prepare('ALTER TABLE figure_relations_new RENAME TO figure_relations').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_frel_book_id ON figure_relations(book_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_frel_from    ON figure_relations(from_fig_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_frel_to      ON figure_relations(to_fig_id)').run();

    db.pragma('foreign_keys = ON');
    const fkErrors95 = db.pragma('foreign_key_check');
    if (fkErrors95.length) {
      throw new Error(`Migration 95: foreign_key_check meldet ${fkErrors95.length} Verstoesse: ${JSON.stringify(fkErrors95.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 95').run();
    logger.info('DB-Migration auf Version 95 abgeschlossen (figure_relations UNIQUE + Dedup).');
  }

  if (version < 96) {
    // Bridge-Tabellen ohne PK -> Surrogate id INTEGER PRIMARY KEY AUTOINCREMENT.
    // Erlaubt Update/Delete einzelner Zeilen; entlastet Schreibpfade von
    // Tupel-WHERE-Klauseln. Composite-PK ginge nicht (nullable Refs in den
    // meisten Bruecken wegen ON DELETE SET NULL).
    db.pragma('foreign_keys = OFF');

    const _recreate96 = (table, createSql, insertCols, indexSqls) => {
      db.prepare(`DROP TABLE IF EXISTS ${table}_new`).run();
      db.prepare(createSql).run();
      db.prepare(`INSERT INTO ${table}_new (${insertCols}) SELECT ${insertCols} FROM ${table}`).run();
      db.prepare(`DROP TABLE ${table}`).run();
      db.prepare(`ALTER TABLE ${table}_new RENAME TO ${table}`).run();
      for (const ix of indexSqls) db.prepare(ix).run();
    };

    _recreate96('continuity_issue_figures', `
      CREATE TABLE continuity_issue_figures_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id   INTEGER NOT NULL REFERENCES continuity_issues(id) ON DELETE CASCADE,
        figure_id  INTEGER          REFERENCES figures(id)            ON DELETE SET NULL,
        figur_name TEXT,
        sort_order INTEGER DEFAULT 0
      )
    `, 'issue_id, figure_id, figur_name, sort_order', [
      'CREATE INDEX idx_cif_issue  ON continuity_issue_figures(issue_id)',
      'CREATE INDEX idx_cif_figure ON continuity_issue_figures(figure_id)',
    ]);

    _recreate96('continuity_issue_chapters', `
      CREATE TABLE continuity_issue_chapters_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id   INTEGER NOT NULL REFERENCES continuity_issues(id) ON DELETE CASCADE,
        chapter_id INTEGER          REFERENCES chapters(chapter_id)  ON DELETE SET NULL,
        sort_order INTEGER DEFAULT 0
      )
    `, 'issue_id, chapter_id, sort_order', [
      'CREATE INDEX idx_cic_issue   ON continuity_issue_chapters(issue_id)',
      'CREATE INDEX idx_cic_chapter ON continuity_issue_chapters(chapter_id)',
    ]);

    _recreate96('zeitstrahl_event_chapters', `
      CREATE TABLE zeitstrahl_event_chapters_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id   INTEGER NOT NULL REFERENCES zeitstrahl_events(id) ON DELETE CASCADE,
        chapter_id INTEGER          REFERENCES chapters(chapter_id)  ON DELETE SET NULL,
        sort_order INTEGER DEFAULT 0
      )
    `, 'event_id, chapter_id, sort_order', [
      'CREATE INDEX idx_zec_event   ON zeitstrahl_event_chapters(event_id)',
      'CREATE INDEX idx_zec_chapter ON zeitstrahl_event_chapters(chapter_id)',
    ]);

    _recreate96('zeitstrahl_event_pages', `
      CREATE TABLE zeitstrahl_event_pages_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id   INTEGER NOT NULL REFERENCES zeitstrahl_events(id) ON DELETE CASCADE,
        page_id    INTEGER          REFERENCES pages(page_id)        ON DELETE SET NULL,
        sort_order INTEGER DEFAULT 0
      )
    `, 'event_id, page_id, sort_order', [
      'CREATE INDEX idx_zep_event ON zeitstrahl_event_pages(event_id)',
      'CREATE INDEX idx_zep_page  ON zeitstrahl_event_pages(page_id)',
    ]);

    _recreate96('zeitstrahl_event_figures', `
      CREATE TABLE zeitstrahl_event_figures_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id   INTEGER NOT NULL REFERENCES zeitstrahl_events(id) ON DELETE CASCADE,
        figure_id  INTEGER          REFERENCES figures(id)            ON DELETE SET NULL,
        figur_name TEXT,
        sort_order INTEGER DEFAULT 0
      )
    `, 'event_id, figure_id, figur_name, sort_order', [
      'CREATE INDEX idx_zef_event  ON zeitstrahl_event_figures(event_id)',
      'CREATE INDEX idx_zef_figure ON zeitstrahl_event_figures(figure_id)',
    ]);

    _recreate96('figure_events', `
      CREATE TABLE figure_events_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        figure_id  INTEGER NOT NULL REFERENCES figures(id)         ON DELETE CASCADE,
        datum      TEXT NOT NULL,
        ereignis   TEXT NOT NULL,
        bedeutung  TEXT,
        typ        TEXT DEFAULT 'persoenlich',
        sort_order INTEGER DEFAULT 0,
        chapter_id INTEGER REFERENCES chapters(chapter_id)         ON DELETE SET NULL,
        page_id    INTEGER REFERENCES pages(page_id)               ON DELETE SET NULL
      )
    `, 'figure_id, datum, ereignis, bedeutung, typ, sort_order, chapter_id, page_id', [
      'CREATE INDEX idx_fe_chapter ON figure_events(chapter_id)',
      'CREATE INDEX idx_fe_page    ON figure_events(page_id)',
    ]);

    db.pragma('foreign_keys = ON');
    const fkErrors96 = db.pragma('foreign_key_check');
    if (fkErrors96.length) {
      throw new Error(`Migration 96: foreign_key_check meldet ${fkErrors96.length} Verstoesse: ${JSON.stringify(fkErrors96.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 96').run();
    logger.info('DB-Migration auf Version 96 abgeschlossen (Surrogate-PK fuer 6 Bridge-Tabellen: continuity_issue_figures/chapters, zeitstrahl_event_chapters/pages/figures, figure_events).');
  }

  if (version < 97) {
    // draft_figures.source_figure_id: Referenz auf Quell-Figur (figures.id),
    // wenn Werkstatt-Draft via Import aus dem Figuren-Katalog erzeugt wurde.
    // ON DELETE SET NULL: User-kuratierte Mindmap-Arbeit bleibt erhalten,
    // wenn die Quell-Figur (z.B. durch Komplettanalyse-Reextraktion) verschwindet.
    // FK in SQLite via ALTER TABLE ADD CONSTRAINT nicht möglich → Recreate-Pattern.
    db.pragma('foreign_keys = OFF');

    db.prepare('DROP TABLE IF EXISTS draft_figures_new').run();
    db.prepare(`
      CREATE TABLE draft_figures_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id          INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email       TEXT    NOT NULL,
        name             TEXT    NOT NULL,
        archetype        TEXT,
        mindmap_json     TEXT    NOT NULL,
        notes            TEXT,
        source_figure_id INTEGER REFERENCES figures(id) ON DELETE SET NULL,
        created_at       TEXT    NOT NULL,
        updated_at       TEXT    NOT NULL
      )
    `).run();
    db.prepare(`
      INSERT INTO draft_figures_new
        (id, book_id, user_email, name, archetype, mindmap_json, notes, created_at, updated_at)
      SELECT id, book_id, user_email, name, archetype, mindmap_json, notes, created_at, updated_at
      FROM draft_figures
    `).run();
    db.prepare('DROP TABLE draft_figures').run();
    db.prepare('ALTER TABLE draft_figures_new RENAME TO draft_figures').run();
    db.prepare('CREATE INDEX idx_df_book_user ON draft_figures(book_id, user_email)').run();
    db.prepare('CREATE INDEX idx_df_source ON draft_figures(source_figure_id)').run();

    db.pragma('foreign_keys = ON');
    const fkErrors97 = db.pragma('foreign_key_check');
    if (fkErrors97.length) {
      throw new Error(`Migration 97: foreign_key_check meldet ${fkErrors97.length} Verstoesse: ${JSON.stringify(fkErrors97.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 97').run();
    logger.info('DB-Migration auf Version 97 abgeschlossen (draft_figures.source_figure_id FK).');
  }

  if (version < 98) {
    // werkstatt_runs: KI-Lauf-Historie für Figuren-Werkstatt (Brainstorm +
    // Consistency). Pro Lauf eine Zeile mit Result-JSON; Frontend zeigt zwei
    // klappbare Sektionen pro Draft. ON DELETE CASCADE: Run-Historie stirbt
    // mit dem Draft (lose Runs ohne Draft hätten keinen Owner mehr).
    // book_id für History-Reset-Pfad (DELETE WHERE book_id = ? AND user_email = ?).
    db.prepare(`
      CREATE TABLE IF NOT EXISTS werkstatt_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        draft_id    INTEGER NOT NULL REFERENCES draft_figures(id) ON DELETE CASCADE,
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL,
        kind        TEXT    NOT NULL CHECK(kind IN ('brainstorm','consistency')),
        created_at  TEXT    NOT NULL,
        knoten_id   TEXT,
        knoten_pfad TEXT,
        result_json TEXT    NOT NULL,
        model       TEXT
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_wr_draft_kind_date ON werkstatt_runs(draft_id, kind, created_at DESC)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_wr_book_user       ON werkstatt_runs(book_id, user_email)').run();
    const fkErrors98 = db.pragma('foreign_key_check');
    if (fkErrors98.length) {
      throw new Error(`Migration 98: foreign_key_check meldet ${fkErrors98.length} Verstoesse: ${JSON.stringify(fkErrors98.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 98').run();
    logger.info('DB-Migration auf Version 98 abgeschlossen (werkstatt_runs).');
  }

  if (version < 99) {
    // tok-Semantik-Wechsel: page_stats.tok und book_stats_history.tok bedeuten
    // ab sofort Text-Tokens (chars / CHARS_PER_TOKEN), nicht mehr Lektorat-
    // Prompt-Tokens. Hero und Sparkline sollen ohne Sprung weiterlaufen, also
    // bestehende Rows recomputen. CHARS_PER_TOKEN aus Provider abgeleitet
    // (Claude=3, sonst=1.5; ENV-Override zieht).
    const provider = (process.env.API_PROVIDER || 'claude').toLowerCase();
    const cptDefault = provider === 'claude' ? 3 : 1.5;
    const cpt = parseFloat(process.env.CHARS_PER_TOKEN) || cptDefault;
    db.prepare('UPDATE page_stats SET tok = ROUND(chars / ?) WHERE chars IS NOT NULL').run(cpt);
    db.prepare('UPDATE book_stats_history SET tok = ROUND(chars / ?) WHERE chars IS NOT NULL').run(cpt);
    const fkErrors99 = db.pragma('foreign_key_check');
    if (fkErrors99.length) {
      throw new Error(`Migration 99: foreign_key_check meldet ${fkErrors99.length} Verstoesse: ${JSON.stringify(fkErrors99.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 99').run();
    logger.info(`DB-Migration auf Version 99 abgeschlossen (tok = chars/${cpt} in page_stats + book_stats_history).`);
  }

  if (version < 100) {
    // chat_sessions: Snapshot-Spalten book_name + page_name fallen weg. Display-
    // Werte werden zur Lese-Zeit per JOIN auf books.name bzw. pages.page_name
    // gezogen (CLAUDE.md «Snapshot-Spalten verboten»). Gleichzeitig book_id zur
    // FK auf books(book_id) härten (DB relational integrity).
    db.pragma('foreign_keys = OFF');
    // Orphan-Cleanup: chat_sessions ohne zugehöriges Buch entfernen
    // (chat_messages folgen via CASCADE).
    db.prepare('DELETE FROM chat_sessions WHERE book_id NOT IN (SELECT book_id FROM books)').run();
    const runStmt100 = (sql) => db.prepare(sql).run();
    runStmt100('DROP TABLE IF EXISTS chat_sessions_new');
    runStmt100(`
      CREATE TABLE chat_sessions_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id           INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        kind              TEXT    NOT NULL DEFAULT 'page' CHECK(kind IN ('page','book')),
        page_id           INTEGER REFERENCES pages(page_id) ON DELETE CASCADE,
        user_email        TEXT    NOT NULL,
        created_at        TEXT    NOT NULL,
        last_message_at   TEXT    NOT NULL,
        opening_page_text TEXT,
        CHECK ((kind = 'page' AND page_id IS NOT NULL)
            OR (kind = 'book' AND page_id IS NULL))
      )
    `);
    runStmt100(`
      INSERT INTO chat_sessions_new
        (id, book_id, kind, page_id, user_email, created_at, last_message_at, opening_page_text)
      SELECT
        id, book_id, kind, page_id, user_email, created_at, last_message_at, opening_page_text
      FROM chat_sessions
    `);
    runStmt100('DROP TABLE chat_sessions');
    runStmt100('ALTER TABLE chat_sessions_new RENAME TO chat_sessions');
    runStmt100('CREATE INDEX idx_cs_page_id ON chat_sessions(page_id, user_email)');
    runStmt100('CREATE INDEX idx_cs_book_id ON chat_sessions(book_id, user_email)');
    runStmt100('CREATE INDEX idx_cs_kind    ON chat_sessions(book_id, user_email, kind)');
    db.pragma('foreign_keys = ON');
    const fkErrors100 = db.pragma('foreign_key_check');
    if (fkErrors100.length) {
      throw new Error(`Migration 100: foreign_key_check meldet ${fkErrors100.length} Verstoesse: ${JSON.stringify(fkErrors100.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 100').run();
    logger.info('DB-Migration auf Version 100 abgeschlossen (chat_sessions: book_name + page_name gedroppt, book_id FK auf books).');
  }

  if (version < 101) {
    // CHARS_PER_TOKEN-Default für non-Claude Provider wurde von 1.5 auf 4
    // angehoben (realistischer für SentencePiece-Tokenizer von Mistral/Llama auf
    // deutschem Fliesstext). Bestehende page_stats.tok / book_stats_history.tok
    // wurden in Migration 99 mit dem alten Wert berechnet – jetzt neu rechnen,
    // damit Hero/Sparkline ohne Sprung weiterlaufen.
    const provider101 = (process.env.API_PROVIDER || 'claude').toLowerCase();
    const cpt101Default = provider101 === 'claude' ? 3 : 4;
    const cpt101 = parseFloat(process.env.CHARS_PER_TOKEN) || cpt101Default;
    db.prepare('UPDATE page_stats SET tok = ROUND(chars / ?) WHERE chars IS NOT NULL').run(cpt101);
    db.prepare('UPDATE book_stats_history SET tok = ROUND(chars / ?) WHERE chars IS NOT NULL').run(cpt101);
    const fkErrors101 = db.pragma('foreign_key_check');
    if (fkErrors101.length) {
      throw new Error(`Migration 101: foreign_key_check meldet ${fkErrors101.length} Verstoesse: ${JSON.stringify(fkErrors101.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 101').run();
    logger.info(`DB-Migration auf Version 101 abgeschlossen (tok = chars/${cpt101} in page_stats + book_stats_history; non-Claude default 1.5 → 4).`);
  }

  if (version < 102) {
    // Delta-Cache für Buch-Review (analog chapter_extract_cache / book_extract_cache
    // aus Komplettanalyse). Spart bei grossen Büchern den Kapitelanalyse-Call,
    // wenn pages_sig + Prompt-Vars unverändert sind.
    const mig102 = `
      CREATE TABLE IF NOT EXISTS chapter_review_cache (
        book_id     INTEGER NOT NULL REFERENCES books(book_id)    ON DELETE CASCADE,
        user_email  TEXT    NOT NULL DEFAULT '',
        chapter_id  INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        phase       TEXT    NOT NULL DEFAULT '',
        pages_sig   TEXT    NOT NULL,
        review_json TEXT    NOT NULL,
        cached_at   TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email, chapter_id, phase)
      );
      CREATE INDEX IF NOT EXISTS idx_crc_book_user
        ON chapter_review_cache(book_id, user_email);

      CREATE TABLE IF NOT EXISTS book_review_cache (
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL DEFAULT '',
        pages_sig   TEXT    NOT NULL,
        review_json TEXT    NOT NULL,
        cached_at   TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email)
      );
      CREATE INDEX IF NOT EXISTS idx_brc_book_user
        ON book_review_cache(book_id, user_email);
    `;
    db.exec(mig102);
    const fkErrors102 = db.pragma('foreign_key_check');
    if (fkErrors102.length) {
      throw new Error(`Migration 102: foreign_key_check meldet ${fkErrors102.length} Verstoesse: ${JSON.stringify(fkErrors102.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 102').run();
    logger.info('DB-Migration auf Version 102 abgeschlossen (chapter_review_cache + book_review_cache für Buch-Review Delta-Caching).');
  }

  if (version < 103) {
    // Delta-Caches für Kapitel-Bewertung, Synonym-Suche, Seiten-Lektorat.
    // Analog zu chapter_extract_cache: pages_sig/ctx_sig identisch → HIT.
    const mig103 = `
      CREATE TABLE IF NOT EXISTS chapter_macro_review_cache (
        book_id     INTEGER NOT NULL REFERENCES books(book_id)       ON DELETE CASCADE,
        user_email  TEXT    NOT NULL DEFAULT '',
        chapter_id  INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        pages_sig   TEXT    NOT NULL,
        review_json TEXT    NOT NULL,
        cached_at   TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email, chapter_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cmrc_book_user
        ON chapter_macro_review_cache(book_id, user_email);

      CREATE TABLE IF NOT EXISTS synonym_cache (
        user_email  TEXT    NOT NULL DEFAULT '',
        key_hash    TEXT    NOT NULL,
        result_json TEXT    NOT NULL,
        cached_at   TEXT    NOT NULL,
        PRIMARY KEY (user_email, key_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_sc_user ON synonym_cache(user_email);

      CREATE TABLE IF NOT EXISTS lektorat_cache (
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL DEFAULT '',
        page_id     INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        ctx_sig     TEXT    NOT NULL,
        result_json TEXT    NOT NULL,
        cached_at   TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email, page_id)
      );
      CREATE INDEX IF NOT EXISTS idx_lc_book_user ON lektorat_cache(book_id, user_email);
    `;
    db.exec(mig103);
    const fkErrors103 = db.pragma('foreign_key_check');
    if (fkErrors103.length) {
      throw new Error(`Migration 103: foreign_key_check meldet ${fkErrors103.length} Verstoesse: ${JSON.stringify(fkErrors103.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 103').run();
    logger.info('DB-Migration auf Version 103 abgeschlossen (chapter_macro_review_cache + synonym_cache + lektorat_cache).');
  }

  if (version < 104) {
    // Idempotency-Key für Chat-Send: client_msg_id (UUID) + job_id-Backreferenz.
    // Verhindert Doppel-Inserts bei Connection-Loss-Retry (siehe chat.js _handleChatPost).
    const cmCols104 = db.pragma('table_info(chat_messages)').map(c => c.name);
    if (!cmCols104.includes('client_msg_id')) {
      db.prepare('ALTER TABLE chat_messages ADD COLUMN client_msg_id TEXT').run();
    }
    if (!cmCols104.includes('job_id')) {
      db.prepare('ALTER TABLE chat_messages ADD COLUMN job_id TEXT').run();
    }
    const mig104 = `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cm_session_clientmsg
        ON chat_messages(session_id, client_msg_id)
        WHERE client_msg_id IS NOT NULL;
    `;
    db.exec(mig104);
    const fkErrors104 = db.pragma('foreign_key_check');
    if (fkErrors104.length) {
      throw new Error(`Migration 104: foreign_key_check meldet ${fkErrors104.length} Verstoesse: ${JSON.stringify(fkErrors104.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 104').run();
    logger.info('DB-Migration auf Version 104 abgeschlossen (chat_messages.client_msg_id + job_id für Idempotency).');
  }

  if (version < 105) {
    // Additives Schema-Skelett fuer pages/chapters/books — Body, Order, Owner,
    // Slug, Dirty-Flag fuer Sync-Worker.
    //
    // pages.body_html/body_markdown: lokale Wahrheit im localdb-Backend; im
    //   bookstack-Mode Cache, der beim Backfill gefuellt wird.
    // pages/chapters.position/priority: Sortierung; position lokal, priority
    //   spiegelt BookStack-`priority` im bookstack-Mode.
    // pages.local_updated_at/remote_updated_at/dirty: Konflikterkennung beim
    //   Sync-Pull (bookstack-Mode).
    // books.owner_email: Erst-Backfiller; Sharing-Regel via book_access.
    // books.cover_image: BLOB, optional.
    const pagesCols105 = db.pragma('table_info(pages)').map(c => c.name);
    if (!pagesCols105.includes('body_html'))         db.prepare('ALTER TABLE pages ADD COLUMN body_html TEXT').run();
    if (!pagesCols105.includes('body_markdown'))     db.prepare('ALTER TABLE pages ADD COLUMN body_markdown TEXT').run();
    if (!pagesCols105.includes('position'))          db.prepare('ALTER TABLE pages ADD COLUMN position INTEGER').run();
    if (!pagesCols105.includes('priority'))          db.prepare('ALTER TABLE pages ADD COLUMN priority INTEGER').run();
    if (!pagesCols105.includes('slug'))              db.prepare('ALTER TABLE pages ADD COLUMN slug TEXT').run();
    if (!pagesCols105.includes('local_updated_at'))  db.prepare('ALTER TABLE pages ADD COLUMN local_updated_at TEXT').run();
    if (!pagesCols105.includes('remote_updated_at')) db.prepare('ALTER TABLE pages ADD COLUMN remote_updated_at TEXT').run();
    if (!pagesCols105.includes('dirty'))             db.prepare('ALTER TABLE pages ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0').run();

    const chapCols105 = db.pragma('table_info(chapters)').map(c => c.name);
    if (!chapCols105.includes('position'))    db.prepare('ALTER TABLE chapters ADD COLUMN position INTEGER').run();
    if (!chapCols105.includes('priority'))    db.prepare('ALTER TABLE chapters ADD COLUMN priority INTEGER').run();
    if (!chapCols105.includes('slug'))        db.prepare('ALTER TABLE chapters ADD COLUMN slug TEXT').run();
    if (!chapCols105.includes('description')) db.prepare('ALTER TABLE chapters ADD COLUMN description TEXT').run();

    const booksCols105 = db.pragma('table_info(books)').map(c => c.name);
    if (!booksCols105.includes('description')) db.prepare('ALTER TABLE books ADD COLUMN description TEXT').run();
    if (!booksCols105.includes('cover_image')) db.prepare('ALTER TABLE books ADD COLUMN cover_image BLOB').run();
    if (!booksCols105.includes('owner_email')) db.prepare('ALTER TABLE books ADD COLUMN owner_email TEXT').run();
    // books.created_at existiert bereits seit Migration 85 — kein ALTER.

    db.prepare('CREATE INDEX IF NOT EXISTS idx_books_owner_email ON books(owner_email)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_dirty       ON pages(dirty) WHERE dirty = 1').run();

    const fkErrors105 = db.pragma('foreign_key_check');
    if (fkErrors105.length) {
      throw new Error(`Migration 105: foreign_key_check meldet ${fkErrors105.length} Verstoesse: ${JSON.stringify(fkErrors105.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 105').run();
    logger.info('DB-Migration auf Version 105 abgeschlossen (Schema-Skelett: pages/chapters/books additive Spalten fuer Body, Order, Owner, Dirty-Flag).');
  }

  if (version < 106) {
    // books/chapters/pages auf INTEGER PRIMARY KEY AUTOINCREMENT umstellen.
    // Wasserzeichen >= 1_000_000, damit `localdb`-Mode frische IDs ausserhalb
    // des BookStack-Range vergibt.
    //
    // Bestandsrows behalten ihre BookStack-IDs (INSERT SELECT preserve), alle
    // ~40 FK-Spalten (figures.book_id, page_revisions.page_id, …) bleiben
    // gueltig — keine ID-Map noetig.
    //
    // Recreate-Pattern aus CLAUDE.md: foreign_keys=OFF -> CREATE _new -> INSERT
    // SELECT -> DROP old -> RENAME -> recreate indexes -> foreign_keys=ON ->
    // foreign_key_check. Reihenfolge: books -> chapters -> pages (FK-Kette).
    db.pragma('foreign_keys = OFF');

    // 1) books
    db.prepare('DROP TABLE IF EXISTS books_new').run();
    db.prepare(`
      CREATE TABLE books_new (
        book_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL,
        slug         TEXT,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        last_seen_at TEXT,
        description  TEXT,
        cover_image  BLOB,
        owner_email  TEXT
      )
    `).run();
    db.prepare(`
      INSERT INTO books_new (book_id, name, slug, created_at, updated_at, last_seen_at, description, cover_image, owner_email)
      SELECT                book_id, name, slug, created_at, updated_at, last_seen_at, description, cover_image, owner_email
        FROM books
    `).run();
    db.prepare('DROP TABLE books').run();
    db.prepare('ALTER TABLE books_new RENAME TO books').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_books_last_seen   ON books(last_seen_at)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_books_owner_email ON books(owner_email)').run();

    // 2) chapters
    db.prepare('DROP TABLE IF EXISTS chapters_new').run();
    db.prepare(`
      CREATE TABLE chapters_new (
        chapter_id   INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        chapter_name TEXT    NOT NULL,
        updated_at   TEXT,
        last_seen_at TEXT,
        position     INTEGER,
        priority     INTEGER,
        slug         TEXT,
        description  TEXT
      )
    `).run();
    db.prepare(`
      INSERT INTO chapters_new (chapter_id, book_id, chapter_name, updated_at, last_seen_at, position, priority, slug, description)
      SELECT                   chapter_id, book_id, chapter_name, updated_at, last_seen_at, position, priority, slug, description
        FROM chapters
    `).run();
    db.prepare('DROP TABLE chapters').run();
    db.prepare('ALTER TABLE chapters_new RENAME TO chapters').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_chapters_last_seen ON chapters(last_seen_at)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_chapters_book_id   ON chapters(book_id)').run();

    // 3) pages
    db.prepare('DROP TABLE IF EXISTS pages_new').run();
    db.prepare(`
      CREATE TABLE pages_new (
        page_id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id           INTEGER NOT NULL,
        page_name         TEXT,
        chapter_id        INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        updated_at        TEXT,
        preview_text      TEXT,
        last_seen_at      TEXT,
        body_html         TEXT,
        body_markdown     TEXT,
        position          INTEGER,
        priority          INTEGER,
        slug              TEXT,
        local_updated_at  TEXT,
        remote_updated_at TEXT,
        dirty             INTEGER NOT NULL DEFAULT 0
      )
    `).run();
    db.prepare(`
      INSERT INTO pages_new (page_id, book_id, page_name, chapter_id, updated_at, preview_text, last_seen_at,
                             body_html, body_markdown, position, priority, slug, local_updated_at, remote_updated_at, dirty)
      SELECT                page_id, book_id, page_name, chapter_id, updated_at, preview_text, last_seen_at,
                             body_html, body_markdown, position, priority, slug, local_updated_at, remote_updated_at, dirty
        FROM pages
    `).run();
    db.prepare('DROP TABLE pages').run();
    db.prepare('ALTER TABLE pages_new RENAME TO pages').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_book_id     ON pages(book_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_chapter_id  ON pages(chapter_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_dirty       ON pages(dirty) WHERE dirty = 1').run();

    // Wasserzeichen: nextID >= MAX(1_000_000, MAX(existing_id)). Trennt
    // localdb-Range (>=1_000_001) sauber vom BookStack-Range (<100k typisch).
    //
    // sqlite_sequence hat keinen UNIQUE-Constraint auf `name` — INSERT OR REPLACE
    // wuerde Duplikate erzeugen, weil das INSERT INTO ... SELECT oben bereits
    // automatisch eine Row mit dem alten max(rowid) angelegt hat. Erst DELETE,
    // dann INSERT, damit pro Tabelle genau eine Wasserzeichen-Row entsteht.
    const WATERMARK = 1_000_000;
    const maxBook    = db.prepare('SELECT COALESCE(MAX(book_id),    0) AS m FROM books').get().m;
    const maxChapter = db.prepare('SELECT COALESCE(MAX(chapter_id), 0) AS m FROM chapters').get().m;
    const maxPage    = db.prepare('SELECT COALESCE(MAX(page_id),    0) AS m FROM pages').get().m;
    db.prepare(`DELETE FROM sqlite_sequence WHERE name IN ('books','chapters','pages')`).run();
    db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('books',    ?)`).run(Math.max(WATERMARK, maxBook));
    db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('chapters', ?)`).run(Math.max(WATERMARK, maxChapter));
    db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('pages',    ?)`).run(Math.max(WATERMARK, maxPage));

    db.pragma('foreign_keys = ON');
    const fkErrors106 = db.pragma('foreign_key_check');
    if (fkErrors106.length) {
      throw new Error(`Migration 106: foreign_key_check meldet ${fkErrors106.length} Verstoesse: ${JSON.stringify(fkErrors106.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 106').run();
    logger.info('DB-Migration auf Version 106 abgeschlossen (books/chapters/pages auf AUTOINCREMENT umgestellt, sqlite_sequence Wasserzeichen >= 1_000_000).');
  }

  if (version < 107) {
    // App-eigene User-DB.
    // Drei neue Tabellen: app_users (Identity + Role + Status), user_invites
    // (Token-Workflow), user_sessions_audit (Login-Events fuer Admin).
    //
    // Bestehende `users`-Tabelle (Profil/Settings, seit Mig 41) bleibt — sie
    // wird hier nur um eine FK auf app_users(email) ON DELETE CASCADE erweitert,
    // damit beim Hard-Delete eines App-Users (selten; Default ist Soft-Delete
    // via status='deleted') auch Profile/Tokens kaskadieren.
    //
    // Backfill: alle distinct user_email-Werte aus users + job_runs +
    // chat_sessions + user_tokens + page_checks bekommen app_users-Rows mit
    // status='active', global_role='user'. ADMIN_EMAIL-Bootstrap laeuft NICHT
    // hier (Migration ist data-frei), sondern beim Server-Start (separater
    // Helper, damit ENV-Wechsel ohne Re-Migration wirkt).
    db.pragma('foreign_keys = OFF');

    db.prepare(`
      CREATE TABLE IF NOT EXISTS app_users (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        email            TEXT NOT NULL UNIQUE,
        display_name     TEXT,
        avatar_url       TEXT,
        global_role      TEXT NOT NULL DEFAULT 'user'
                              CHECK(global_role IN ('admin','user')),
        status           TEXT NOT NULL DEFAULT 'active'
                              CHECK(status IN ('invited','active','suspended','deleted')),
        language         TEXT DEFAULT 'de',
        model_override   TEXT,
        can_invite_users INTEGER NOT NULL DEFAULT 1,
        first_seen_at    TEXT,
        last_seen_at     TEXT,
        invited_by       TEXT,
        invited_at       TEXT,
        created_at       TEXT DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_app_users_status ON app_users(status)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS user_invites (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        email        TEXT NOT NULL,
        global_role  TEXT NOT NULL DEFAULT 'user'
                          CHECK(global_role IN ('admin','user')),
        invite_token TEXT NOT NULL UNIQUE,
        invited_by   TEXT NOT NULL,
        invited_at   TEXT DEFAULT (datetime('now')),
        expires_at   TEXT NOT NULL,
        accepted_at  TEXT,
        revoked_at   TEXT
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_invites_token ON user_invites(invite_token)').run();
    // Partial UNIQUE: nur aktive Invites blockieren erneutes Senden.
    db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_invites_active_email
        ON user_invites(email)
        WHERE revoked_at IS NULL AND accepted_at IS NULL
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS user_sessions_audit (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        event      TEXT NOT NULL CHECK(event IN
                       ('login','logout','login-denied','suspended','reactivated','role-changed','deleted')),
        ip         TEXT,
        user_agent TEXT,
        meta_json  TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_audit_user ON user_sessions_audit(user_email, created_at DESC)').run();

    // Bestandsbackfill: distinct user_email aus allen user-scoped Tabellen.
    const sources = [
      "SELECT email AS email, name AS display_name, created_at, last_seen_at FROM users",
      "SELECT DISTINCT user_email AS email, NULL AS display_name, NULL AS created_at, NULL AS last_seen_at FROM job_runs WHERE user_email IS NOT NULL AND user_email <> ''",
      "SELECT DISTINCT user_email AS email, NULL AS display_name, NULL AS created_at, NULL AS last_seen_at FROM chat_sessions WHERE user_email IS NOT NULL AND user_email <> ''",
      "SELECT email AS email, NULL AS display_name, NULL AS created_at, NULL AS last_seen_at FROM user_tokens WHERE email IS NOT NULL AND email <> ''",
      "SELECT DISTINCT user_email AS email, NULL AS display_name, NULL AS created_at, NULL AS last_seen_at FROM page_checks WHERE user_email IS NOT NULL AND user_email <> ''",
    ];
    const insUser = db.prepare(`
      INSERT INTO app_users (email, display_name, status, global_role, first_seen_at, last_seen_at, created_at)
      VALUES (?, ?, 'active', 'user', ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        display_name  = COALESCE(app_users.display_name, excluded.display_name),
        first_seen_at = COALESCE(app_users.first_seen_at, excluded.first_seen_at),
        last_seen_at  = COALESCE(app_users.last_seen_at, excluded.last_seen_at)
    `);
    const seen = new Set();
    db.transaction(() => {
      for (const sql of sources) {
        const tableOk = (() => {
          try { return db.prepare(sql + ' LIMIT 0').all() !== undefined; }
          catch { return false; }
        })();
        if (!tableOk) continue;
        const rows = db.prepare(sql).all();
        for (const r of rows) {
          if (!r.email) continue;
          if (seen.has(r.email)) continue;
          seen.add(r.email);
          const nowIso = new Date().toISOString();
          insUser.run(
            r.email,
            r.display_name || null,
            r.created_at || nowIso,
            r.last_seen_at || null,
            r.created_at || nowIso,
          );
        }
      }
    })();
    if (seen.size > 0) logger.info(`Migration 107: ${seen.size} distinct user_email(s) nach app_users gespiegelt.`);

    // FK-Recreate `users`: email REFERENCES app_users(email) ON DELETE CASCADE.
    // Spalten-Reihenfolge entspricht aktuellem Stand (Mig 41 + 52 + 63 + 87).
    db.prepare('DELETE FROM users WHERE email NOT IN (SELECT email FROM app_users)').run();

    db.prepare('DROP TABLE IF EXISTS users_new').run();
    db.prepare(`
      CREATE TABLE users_new (
        email             TEXT PRIMARY KEY REFERENCES app_users(email) ON DELETE CASCADE,
        name              TEXT,
        created_at        TEXT NOT NULL,
        last_login_at     TEXT,
        locale            TEXT,
        theme             TEXT,
        default_buchtyp   TEXT,
        default_language  TEXT,
        default_region    TEXT,
        last_seen_at      TEXT,
        focus_granularity TEXT,
        daily_goal_chars  INTEGER
      )
    `).run();
    db.prepare(`
      INSERT INTO users_new (email, name, created_at, last_login_at, locale, theme,
                             default_buchtyp, default_language, default_region,
                             last_seen_at, focus_granularity, daily_goal_chars)
      SELECT                 email, name, created_at, last_login_at, locale, theme,
                             default_buchtyp, default_language, default_region,
                             last_seen_at, focus_granularity, daily_goal_chars
        FROM users
    `).run();
    db.prepare('DROP TABLE users').run();
    db.prepare('ALTER TABLE users_new RENAME TO users').run();

    db.pragma('foreign_keys = ON');
    const fkErrors107 = db.pragma('foreign_key_check');
    if (fkErrors107.length) {
      throw new Error(`Migration 107: foreign_key_check meldet ${fkErrors107.length} Verstoesse: ${JSON.stringify(fkErrors107.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 107').run();
    logger.info('DB-Migration auf Version 107 abgeschlossen (App-User-DB: app_users + user_invites + user_sessions_audit, users.email FK auf app_users).');
  }

  if (version < 108) {
    // app_settings als Runtime-Config-Store. Auth-/KI-Provider-/Storage-Backend-/Job-Tuning-/
    // Cron-/PDF-A-Werte wandern aus `.env` in die DB; ENV bleibt nur fuer
    // Boot-Layer (PORT, DB_PATH, APP_URL, SESSION_SECRET, ADMIN_EMAIL/PASSWORD,
    // TZ, LOG_LEVEL, LOCAL_DEV_MODE, VERAPDF_BIN).
    //
    // `encrypted=1` markiert Felder mit AES-GCM-verschluesseltem value_json
    // (lib/crypto.js, `enc:v1:`-Prefix). lib/app-settings.js liest sie
    // transparent.
    //
    // app_settings_audit haelt Vor-/Nachwert-Hash + updated_by — kein
    // Klartext-Secret in der Audit-Tabelle.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        encrypted  INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now')),
        updated_by TEXT
      )
    `).run();
    db.prepare(`
      CREATE TABLE IF NOT EXISTS app_settings_audit (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT NOT NULL,
        old_hash    TEXT,
        new_hash    TEXT,
        updated_by  TEXT NOT NULL,
        updated_at  TEXT DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_app_settings_audit_key ON app_settings_audit(key, updated_at DESC)').run();

    const fkErrors108 = db.pragma('foreign_key_check');
    if (fkErrors108.length) {
      throw new Error(`Migration 108: foreign_key_check meldet ${fkErrors108.length} Verstoesse: ${JSON.stringify(fkErrors108.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 108').run();
    logger.info('DB-Migration auf Version 108 abgeschlossen (app_settings + app_settings_audit).');
  }

  if (version < 109) {
    // Book-ACL + Sharing.
    //
    // book_access ist SSoT fuer "wer darf was am Buch". Vier Rollen (Hierarchie
    // absteigend): owner > editor > lektor > viewer. Buchlisten + alle
    // book-scoped Routen filtern strikt darueber; Admin ohne Share-Row sieht
    // leeres Array. PK (book_id, user_email).
    //
    // book_share_invites speichert eingehende Sharing-Einladungen mit
    // accepted_at/revoked_at-Lifecycle (vorerst Auto-Accept; Hooks fuer
    // explizite Annahme bleiben).
    //
    // page_locks blockt waehrend einer Lektorat-Session konkurrierende
    // Free-Text-Edits auf derselben Seite (Heartbeat 30 min). Verhindert
    // Range-Drift in Findings-Positionen.
    //
    // book_settings.allow_lektor_book_chat: Opt-In pro Buch, ob Lektor den
    // Buch-Chat triggern darf (Default 0, Token-Kosten-Vermeidung).
    //
    // Backfill: jede books-Row mit owner_email != NULL bekommt einen owner-
    // Eintrag in book_access. BookStack-Permission-Discovery (Mehrfachzugriff
    // auf geteilte BookStack-Buecher) erfolgt separat ueber CLI bei Bedarf.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS book_access (
        book_id     INTEGER NOT NULL REFERENCES books(book_id)       ON DELETE CASCADE,
        user_email  TEXT    NOT NULL REFERENCES app_users(email)     ON DELETE CASCADE,
        role        TEXT    NOT NULL CHECK(role IN ('owner','editor','lektor','viewer')),
        granted_at  TEXT    DEFAULT (datetime('now')),
        granted_by  TEXT,
        PRIMARY KEY (book_id, user_email)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_book_access_user ON book_access(user_email)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS book_share_invites (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id       INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        invitee_email TEXT    NOT NULL,
        role          TEXT    NOT NULL CHECK(role IN ('editor','lektor','viewer')),
        invited_by    TEXT    NOT NULL,
        invited_at    TEXT    DEFAULT (datetime('now')),
        accepted_at   TEXT,
        revoked_at    TEXT,
        UNIQUE(book_id, invitee_email)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_book_share_invites_book ON book_share_invites(book_id)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS page_locks (
        page_id           INTEGER PRIMARY KEY REFERENCES pages(page_id)     ON DELETE CASCADE,
        book_id           INTEGER NOT NULL    REFERENCES books(book_id)     ON DELETE CASCADE,
        locked_by_email   TEXT    NOT NULL    REFERENCES app_users(email)   ON DELETE CASCADE,
        reason            TEXT    NOT NULL CHECK(reason IN ('lektorat')),
        acquired_at       TEXT    NOT NULL DEFAULT (datetime('now')),
        expires_at        TEXT    NOT NULL,
        last_heartbeat_at TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_locks_book    ON page_locks(book_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_locks_user    ON page_locks(locked_by_email)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_locks_expires ON page_locks(expires_at)').run();

    // book_settings.allow_lektor_book_chat (additiv).
    const bsCols109 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (bsCols109.length > 0 && !bsCols109.includes('allow_lektor_book_chat')) {
      db.prepare('ALTER TABLE book_settings ADD COLUMN allow_lektor_book_chat INTEGER NOT NULL DEFAULT 0').run();
    }

    // Owner-Backfill aus books.owner_email. Nur Bücher mit existierendem
    // app_users-Eintrag — sonst verletzt FK ON DELETE CASCADE. Bücher ohne
    // owner_email oder mit unbekannter Email bleiben im "herrenlos"-Zustand
    // (Admin-Hint sichtbar in BookAccessCard).
    const ownerInsert = db.prepare(`
      INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_by)
      SELECT b.book_id, b.owner_email, 'owner', 'migration-109'
        FROM books b
       WHERE b.owner_email IS NOT NULL
         AND b.owner_email <> ''
         AND EXISTS (SELECT 1 FROM app_users u WHERE u.email = b.owner_email)
    `);
    const ownerRows = ownerInsert.run().changes;
    if (ownerRows > 0) {
      logger.info(`Migration 109: ${ownerRows} Owner-Row(s) aus books.owner_email nach book_access gespiegelt.`);
    }

    const fkErrors109 = db.pragma('foreign_key_check');
    if (fkErrors109.length) {
      throw new Error(`Migration 109: foreign_key_check meldet ${fkErrors109.length} Verstoesse: ${JSON.stringify(fkErrors109.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 109').run();
    logger.info('DB-Migration auf Version 109 abgeschlossen (Book-ACL: book_access + book_share_invites + page_locks + book_settings.allow_lektor_book_chat).');
  }

  if (version < 110) {
    // Token-Budget pro User.
    //
    // monthly_budget_usd = NULL => kein numerisches Limit (nur sinnvoll mit
    //   mode != 'none').
    // budget_mode 'none' deaktiviert Pruefung komplett — Default fuer Neu-User,
    //   damit Bestandsdeployments nicht ploetzlich blocken. 'soft' warnt
    //   (Frontend-Banner + Admin-Markierung), 'hard' blockt Job-/Chat-POSTs
    //   mit HTTP 429 BUDGET_EXCEEDED.
    //
    // Cost wird zur Lese-Zeit aus (provider, model, tokens_*) via
    // lib/pricing.js#costUsd berechnet — keine Materialisierung in job_runs
    // /chat_messages, damit Preis-PRs rueckwirkend wirken.
    const appUserCols = db.pragma('table_info(app_users)').map(c => c.name);
    if (!appUserCols.includes('monthly_budget_usd')) {
      db.prepare('ALTER TABLE app_users ADD COLUMN monthly_budget_usd REAL').run();
    }
    if (!appUserCols.includes('budget_mode')) {
      db.prepare(`ALTER TABLE app_users ADD COLUMN budget_mode TEXT NOT NULL DEFAULT 'none'
                    CHECK(budget_mode IN ('none','soft','hard'))`).run();
    }

    // Audit-CHECK erweitern: 'budget-changed' (Admin setzt Limit/Mode),
    // 'usage-viewed' (Admin liest Usage-Dashboard — Privacy-Boundary-Nachweis).
    // SQLite kann CHECK nur via Table-Recreate aendern.
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP TABLE IF EXISTS user_sessions_audit_new').run();
    db.prepare(`
      CREATE TABLE user_sessions_audit_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        event      TEXT NOT NULL CHECK(event IN
                       ('login','logout','login-denied','suspended','reactivated',
                        'role-changed','deleted','budget-changed','usage-viewed')),
        ip         TEXT,
        user_agent TEXT,
        meta_json  TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare(`
      INSERT INTO user_sessions_audit_new (id, user_email, event, ip, user_agent, meta_json, created_at)
      SELECT id, user_email, event, ip, user_agent, meta_json, created_at FROM user_sessions_audit
    `).run();
    db.prepare('DROP TABLE user_sessions_audit').run();
    db.prepare('ALTER TABLE user_sessions_audit_new RENAME TO user_sessions_audit').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_audit_user ON user_sessions_audit(user_email, created_at DESC)').run();
    db.pragma('foreign_keys = ON');

    const fkErrors110 = db.pragma('foreign_key_check');
    if (fkErrors110.length) {
      throw new Error(`Migration 110: foreign_key_check meldet ${fkErrors110.length} Verstoesse: ${JSON.stringify(fkErrors110.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 110').run();
    logger.info('DB-Migration auf Version 110 abgeschlossen (Token-Budget: app_users.monthly_budget_usd + budget_mode).');
  }

  if (version < 111) {
    // Public-Landing + Request-Register. Frische Besucher koennen Zugang anfordern; Admin
    // moderiert via AdminUsersCard. Partial UNIQUE blockiert nur pending-
    // Requests pro Email — abgelehnte / abgelaufene erlauben neuen Antrag.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS registration_requests (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT    NOT NULL,
        display_name  TEXT,
        message       TEXT,
        ip            TEXT,
        user_agent    TEXT,
        status        TEXT    NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending','approved','denied','expired')),
        created_at    TEXT    DEFAULT (datetime('now')),
        reviewed_at   TEXT,
        reviewed_by   TEXT,
        review_reason TEXT,
        invite_id     INTEGER,
        FOREIGN KEY (invite_id) REFERENCES user_invites(id) ON DELETE SET NULL
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_reg_req_status ON registration_requests(status, created_at DESC)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_reg_req_invite_id ON registration_requests(invite_id)').run();
    db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reg_req_pending_email
        ON registration_requests(email)
        WHERE status = 'pending'
    `).run();

    const fkErrors111 = db.pragma('foreign_key_check');
    if (fkErrors111.length) {
      throw new Error(`Migration 111: foreign_key_check meldet ${fkErrors111.length} Verstoesse: ${JSON.stringify(fkErrors111.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 111').run();
    logger.info('DB-Migration auf Version 111 abgeschlossen (Public Landing + Request-Register: registration_requests).');
  }

  if (version < 112) {
    // Eigene Page-Revisions.
    // Jeder Save-Pfad ueber die content-store-Facade schreibt eine Revision
    // vor dem Backend-Write. source-Tag unterscheidet Editor/Focus/Chat-Apply
    // /Lektorat-Apply/Sync/Import/Conflict-Pfade. Retention: tiered GFS
    // (Tag/Woche/Monat/Jahr, aelteste pro Bucket) plus Floor aus
    // app.page_revision_limit (Default 50 juengste pro Seite) — Cleanup-Hook
    // in lib/cache-cleanup.js POLICIES → db/page-revisions.js#pruneTiered.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS page_revisions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id       INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        book_id       INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        body_html     TEXT NOT NULL,
        body_markdown TEXT,
        chars         INTEGER,
        words         INTEGER,
        tok           INTEGER,
        source        TEXT NOT NULL CHECK(source IN
                          ('focus','main','chat-apply','lektorat-apply',
                           'bookstack-sync','import','conflict')),
        user_email    TEXT,
        created_at    TEXT DEFAULT (datetime('now')),
        summary       TEXT
      )
    `).run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_page_revisions_page ON page_revisions(page_id, created_at DESC)'
    ).run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_page_revisions_book ON page_revisions(book_id, created_at DESC)'
    ).run();

    const fkErrors112 = db.pragma('foreign_key_check');
    if (fkErrors112.length) {
      throw new Error(`Migration 112: foreign_key_check meldet ${fkErrors112.length} Verstoesse: ${JSON.stringify(fkErrors112.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 112').run();
    logger.info('DB-Migration auf Version 112 abgeschlossen (page_revisions).');
  }

  if (version < 113) {
    // auth.allowed_emails entfernt: Zugriff wird ausschliesslich ueber
    // app_users (Invite/Approval/Status) gesteuert. Stale-Setting purgen.
    db.prepare("DELETE FROM app_settings WHERE key = 'auth.allowed_emails'").run();
    db.prepare('UPDATE schema_version SET version = 113').run();
    logger.info('DB-Migration auf Version 113 abgeschlossen (auth.allowed_emails entfernt).');
  }

  if (version < 114) {
    // Eigene Sortierung.
    // book_order ist SSoT fuer Buch-Hierarchie (Kapitel + Seiten, inkl.
    // Top-Level-Seiten). pages.position/chapters.position/pages.chapter_id
    // werden vom PUT-Hook aus order_json materialisiert (fuer Querys/JOINs).
    db.prepare(`
      CREATE TABLE IF NOT EXISTS book_order (
        book_id    INTEGER PRIMARY KEY REFERENCES books(book_id) ON DELETE CASCADE,
        order_json TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        updated_by TEXT
      )
    `).run();

    const fkErrors114 = db.pragma('foreign_key_check');
    if (fkErrors114.length) {
      throw new Error(`Migration 114: foreign_key_check meldet ${fkErrors114.length} Verstoesse: ${JSON.stringify(fkErrors114.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 114').run();
    logger.info('DB-Migration auf Version 114 abgeschlossen (book_order).');
  }

  if (version < 115) {
    // Kategorien + Tags.
    // book_categories: hierarchisch (parent_id), admin-verwaltet, global.
    // book_tags: flach, jeder Auth-User darf erzeugen, admin loescht.
    // book_tag_assignments: M:N-Bridge zwischen books und book_tags.
    // books.category_id: optional. SET NULL beim Loeschen einer Kategorie.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS book_categories (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id   INTEGER REFERENCES book_categories(id) ON DELETE SET NULL,
        name        TEXT NOT NULL,
        slug        TEXT NOT NULL UNIQUE,
        color       TEXT,
        position    INTEGER DEFAULT 0,
        created_by  TEXT,
        created_at  TEXT DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_book_categories_parent ON book_categories(parent_id)'
    ).run();

    // books.category_id: ALTER TABLE ADD COLUMN unterstuetzt FK-Inline-Form
    // in SQLite. Bestandsrows behalten NULL.
    const bookCols115 = db.pragma('table_info(books)').map(c => c.name);
    if (!bookCols115.includes('category_id')) {
      db.prepare('ALTER TABLE books ADD COLUMN category_id INTEGER REFERENCES book_categories(id) ON DELETE SET NULL').run();
    }
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_books_category ON books(category_id)'
    ).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS book_tags (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        slug        TEXT NOT NULL UNIQUE,
        color       TEXT,
        created_by  TEXT,
        created_at  TEXT DEFAULT (datetime('now'))
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS book_tag_assignments (
        book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        tag_id       INTEGER NOT NULL REFERENCES book_tags(id) ON DELETE CASCADE,
        assigned_at  TEXT DEFAULT (datetime('now')),
        assigned_by  TEXT,
        PRIMARY KEY (book_id, tag_id)
      )
    `).run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_bta_tag ON book_tag_assignments(tag_id)'
    ).run();

    const fkErrors115 = db.pragma('foreign_key_check');
    if (fkErrors115.length) {
      throw new Error(`Migration 115: foreign_key_check meldet ${fkErrors115.length} Verstoesse: ${JSON.stringify(fkErrors115.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 115').run();
    logger.info('DB-Migration auf Version 115 abgeschlossen (book_categories, book_tags, book_tag_assignments).');
  }

  if (version < 116) {
    // SQLite-FTS5-Volltextsuche.
    // search_index   – Haupt-Index (BM25, Titel 5x staerker als Body), Unicode61
    //                  mit remove_diacritics=2 (Umlaut-Folding DE+EN), tokenchars
    //                  '-_' fuer Bindestrich-Woerter.
    // search_trigram – Titel-only Trigram-Index (Typo-Toleranz, Single-Word-Fallback).
    // search_meta    – key/value-Store fuer last_optimize/last_reindex/reindex_required.
    // Initialer Reindex: Marker `reindex_required=1` setzen, server.js startet
    // searchIndex.reindexIfNeeded() in setImmediate nach dem Boot.
    db.prepare(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
        kind UNINDEXED,
        entity_id UNINDEXED,
        book_id UNINDEXED,
        lang UNINDEXED,
        title,
        body,
        tokenize="unicode61 remove_diacritics 2 tokenchars '-_'"
      )
    `).run();
    db.prepare(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_trigram USING fts5(
        kind UNINDEXED,
        entity_id UNINDEXED,
        book_id UNINDEXED,
        title,
        tokenize="trigram"
      )
    `).run();
    db.prepare(`
      CREATE TABLE IF NOT EXISTS search_meta (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare(
      `INSERT OR REPLACE INTO search_meta (key, value, updated_at) VALUES ('reindex_required', '1', datetime('now'))`
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO search_meta (key, value) VALUES ('last_optimize', NULL)`
    ).run();

    const fkErrors116 = db.pragma('foreign_key_check');
    if (fkErrors116.length) {
      throw new Error(`Migration 116: foreign_key_check meldet ${fkErrors116.length} Verstoesse: ${JSON.stringify(fkErrors116.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 116').run();
    logger.info('DB-Migration auf Version 116 abgeschlossen (FTS5 search_index + search_trigram + search_meta).');
  }

  if (version < 117) {
    // Per-User-AI-Provider-Override.
    // 1) app_users.ai_provider_override (NULL = follows global ai.provider).
    // 2) provider-Spalte in alle 7 KI-Caches. Verhindert, dass Claude-Output an
    //    Ollama-User ausgeliefert wird (oder umgekehrt). Teil des PRIMARY KEY.
    // Backfill: bestehende Cache-Eintraege bekommen den aktuellen Globalwert
    //   `ai.provider` aus app_settings.
    const auCols117 = db.pragma('table_info(app_users)').map(c => c.name);
    if (!auCols117.includes('ai_provider_override')) {
      db.prepare(`
        ALTER TABLE app_users ADD COLUMN ai_provider_override TEXT
          CHECK(ai_provider_override IN ('claude','ollama','llama') OR ai_provider_override IS NULL)
      `).run();
    }

    let defaultProvider117 = 'claude';
    try {
      const row = db.prepare("SELECT value_json FROM app_settings WHERE key = 'ai.provider'").get();
      if (row && row.value_json) {
        const parsed = JSON.parse(row.value_json);
        if (typeof parsed === 'string' && ['claude','ollama','llama'].includes(parsed)) {
          defaultProvider117 = parsed;
        }
      }
    } catch { /* leave default */ }

    db.pragma('foreign_keys = OFF');

    const recreate117 = (table, createSql, copySql, indexSql) => {
      db.prepare(`DROP TABLE IF EXISTS ${table}_new`).run();
      db.prepare(createSql).run();
      db.prepare(copySql).run(defaultProvider117);
      db.prepare(`DROP TABLE ${table}`).run();
      db.prepare(`ALTER TABLE ${table}_new RENAME TO ${table}`).run();
      if (indexSql) db.prepare(indexSql).run();
    };

    recreate117(
      'chapter_extract_cache',
      `CREATE TABLE chapter_extract_cache_new (
         book_id      INTEGER NOT NULL,
         user_email   TEXT    NOT NULL DEFAULT '',
         chapter_id   INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
         phase        TEXT    NOT NULL DEFAULT '',
         provider     TEXT    NOT NULL DEFAULT '',
         pages_sig    TEXT    NOT NULL,
         extract_json TEXT    NOT NULL,
         cached_at    TEXT    NOT NULL,
         PRIMARY KEY (book_id, user_email, chapter_id, phase, provider)
       )`,
      `INSERT OR REPLACE INTO chapter_extract_cache_new
         (book_id, user_email, chapter_id, phase, provider, pages_sig, extract_json, cached_at)
       SELECT book_id, user_email, chapter_id, phase, ?, pages_sig, extract_json, cached_at
         FROM chapter_extract_cache`,
      null,
    );

    recreate117(
      'book_extract_cache',
      `CREATE TABLE book_extract_cache_new (
         book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
         user_email   TEXT    NOT NULL DEFAULT '',
         provider     TEXT    NOT NULL DEFAULT '',
         pages_sig    TEXT    NOT NULL,
         extract_json TEXT    NOT NULL,
         cached_at    TEXT    NOT NULL,
         PRIMARY KEY (book_id, user_email, provider)
       )`,
      `INSERT OR REPLACE INTO book_extract_cache_new
         (book_id, user_email, provider, pages_sig, extract_json, cached_at)
       SELECT book_id, user_email, ?, pages_sig, extract_json, cached_at
         FROM book_extract_cache`,
      null,
    );

    recreate117(
      'chapter_review_cache',
      `CREATE TABLE chapter_review_cache_new (
         book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
         user_email  TEXT    NOT NULL DEFAULT '',
         chapter_id  INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
         phase       TEXT    NOT NULL DEFAULT '',
         provider    TEXT    NOT NULL DEFAULT '',
         pages_sig   TEXT    NOT NULL,
         review_json TEXT    NOT NULL,
         cached_at   TEXT    NOT NULL,
         PRIMARY KEY (book_id, user_email, chapter_id, phase, provider)
       )`,
      `INSERT OR REPLACE INTO chapter_review_cache_new
         (book_id, user_email, chapter_id, phase, provider, pages_sig, review_json, cached_at)
       SELECT book_id, user_email, chapter_id, phase, ?, pages_sig, review_json, cached_at
         FROM chapter_review_cache`,
      `CREATE INDEX IF NOT EXISTS idx_crc_book_user ON chapter_review_cache(book_id, user_email)`,
    );

    recreate117(
      'book_review_cache',
      `CREATE TABLE book_review_cache_new (
         book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
         user_email  TEXT    NOT NULL DEFAULT '',
         provider    TEXT    NOT NULL DEFAULT '',
         pages_sig   TEXT    NOT NULL,
         review_json TEXT    NOT NULL,
         cached_at   TEXT    NOT NULL,
         PRIMARY KEY (book_id, user_email, provider)
       )`,
      `INSERT OR REPLACE INTO book_review_cache_new
         (book_id, user_email, provider, pages_sig, review_json, cached_at)
       SELECT book_id, user_email, ?, pages_sig, review_json, cached_at
         FROM book_review_cache`,
      `CREATE INDEX IF NOT EXISTS idx_brc_book_user ON book_review_cache(book_id, user_email)`,
    );

    recreate117(
      'chapter_macro_review_cache',
      `CREATE TABLE chapter_macro_review_cache_new (
         book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
         user_email  TEXT    NOT NULL DEFAULT '',
         chapter_id  INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
         provider    TEXT    NOT NULL DEFAULT '',
         pages_sig   TEXT    NOT NULL,
         review_json TEXT    NOT NULL,
         cached_at   TEXT    NOT NULL,
         PRIMARY KEY (book_id, user_email, chapter_id, provider)
       )`,
      `INSERT OR REPLACE INTO chapter_macro_review_cache_new
         (book_id, user_email, chapter_id, provider, pages_sig, review_json, cached_at)
       SELECT book_id, user_email, chapter_id, ?, pages_sig, review_json, cached_at
         FROM chapter_macro_review_cache`,
      `CREATE INDEX IF NOT EXISTS idx_cmrc_book_user ON chapter_macro_review_cache(book_id, user_email)`,
    );

    recreate117(
      'synonym_cache',
      `CREATE TABLE synonym_cache_new (
         user_email  TEXT    NOT NULL DEFAULT '',
         provider    TEXT    NOT NULL DEFAULT '',
         key_hash    TEXT    NOT NULL,
         result_json TEXT    NOT NULL,
         cached_at   TEXT    NOT NULL,
         PRIMARY KEY (user_email, provider, key_hash)
       )`,
      `INSERT OR REPLACE INTO synonym_cache_new
         (user_email, provider, key_hash, result_json, cached_at)
       SELECT user_email, ?, key_hash, result_json, cached_at
         FROM synonym_cache`,
      `CREATE INDEX IF NOT EXISTS idx_sc_user ON synonym_cache(user_email)`,
    );

    recreate117(
      'lektorat_cache',
      `CREATE TABLE lektorat_cache_new (
         book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
         user_email  TEXT    NOT NULL DEFAULT '',
         page_id     INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
         provider    TEXT    NOT NULL DEFAULT '',
         ctx_sig     TEXT    NOT NULL,
         result_json TEXT    NOT NULL,
         cached_at   TEXT    NOT NULL,
         PRIMARY KEY (book_id, user_email, page_id, provider)
       )`,
      `INSERT OR REPLACE INTO lektorat_cache_new
         (book_id, user_email, page_id, provider, ctx_sig, result_json, cached_at)
       SELECT book_id, user_email, page_id, ?, ctx_sig, result_json, cached_at
         FROM lektorat_cache`,
      `CREATE INDEX IF NOT EXISTS idx_lc_book_user ON lektorat_cache(book_id, user_email)`,
    );

    db.pragma('foreign_keys = ON');
    const fkErrors117 = db.pragma('foreign_key_check');
    if (fkErrors117.length) {
      throw new Error(`Migration 117: foreign_key_check meldet ${fkErrors117.length} Verstoesse: ${JSON.stringify(fkErrors117.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 117').run();
    logger.info(`DB-Migration auf Version 117 abgeschlossen (ai_provider_override + provider-Spalte in 7 KI-Caches; Backfill auf '${defaultProvider117}').`);
  }

  if (version < 118) {
    // Backfill setzte books.owner_email aber legte
    // keine book_access-Row an. Migration 109 spiegelte einmalig die damals
    // existenten Owner; alle danach via Backfill angelegten Buecher fielen
    // durch — /content/books filtert strikt ueber book_access und liefert
    // leere Liste. Mirror erneut ausfuehren (idempotent, INSERT OR IGNORE).
    const ownerInsert118 = db.prepare(`
      INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_by)
      SELECT b.book_id, b.owner_email, 'owner', 'migration-118'
        FROM books b
       WHERE b.owner_email IS NOT NULL
         AND b.owner_email <> ''
         AND EXISTS (SELECT 1 FROM app_users u WHERE u.email = b.owner_email)
    `);
    const ownerRows118 = ownerInsert118.run().changes;
    if (ownerRows118 > 0) {
      logger.info(`Migration 118: ${ownerRows118} Owner-Row(s) aus books.owner_email nach book_access nachgespiegelt.`);
    }

    const fkErrors118 = db.pragma('foreign_key_check');
    if (fkErrors118.length) {
      throw new Error(`Migration 118: foreign_key_check meldet ${fkErrors118.length} Verstoesse: ${JSON.stringify(fkErrors118.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 118').run();
    logger.info('DB-Migration auf Version 118 abgeschlossen (Re-Mirror books.owner_email -> book_access fuer Backfill-Buecher).');
  }

  if (version < 119) {
    // 'ai-provider-changed' im user_sessions_audit-Event-CHECK aufnehmen.
    // Migration 110 hatte 'budget-changed' + 'usage-viewed' ergaenzt; hier
    // kommt der naechste Eintrag fuer Override-Aenderungen via AdminUsersCard.
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP TABLE IF EXISTS user_sessions_audit_new').run();
    db.prepare(`
      CREATE TABLE user_sessions_audit_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        event      TEXT NOT NULL CHECK(event IN
                       ('login','logout','login-denied','suspended','reactivated',
                        'role-changed','deleted','budget-changed','usage-viewed',
                        'ai-provider-changed')),
        ip         TEXT,
        user_agent TEXT,
        meta_json  TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare(`
      INSERT INTO user_sessions_audit_new (id, user_email, event, ip, user_agent, meta_json, created_at)
      SELECT id, user_email, event, ip, user_agent, meta_json, created_at FROM user_sessions_audit
    `).run();
    db.prepare('DROP TABLE user_sessions_audit').run();
    db.prepare('ALTER TABLE user_sessions_audit_new RENAME TO user_sessions_audit').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_audit_user ON user_sessions_audit(user_email, created_at DESC)').run();
    db.pragma('foreign_keys = ON');

    const fkErrors119 = db.pragma('foreign_key_check');
    if (fkErrors119.length) {
      throw new Error(`Migration 119: foreign_key_check meldet ${fkErrors119.length} Verstoesse: ${JSON.stringify(fkErrors119.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 119').run();
    logger.info(`DB-Migration auf Version 119 abgeschlossen (audit-Event 'ai-provider-changed').`);
  }

  if (version < 120) {
    // BookStack-Backend entfernt — Cleanup:
    // 1. user_tokens-Tabelle droppen (BookStack-API-Tokens pro User).
    // 2. pages.remote_updated_at + pages.dirty droppen (Sync-Conflict-Detection).
    // 3. page_revisions.source-CHECK ohne 'bookstack-sync' neu setzen.
    // 4. app_settings: app.backend + app.migrate.source_readonly + app.bookstack.base_url loeschen.
    db.pragma('foreign_keys = OFF');

    db.prepare('DROP TABLE IF EXISTS user_tokens').run();

    // pages: Spalten remote_updated_at + dirty entfernen via Recreate.
    const pagesCols = db.pragma('table_info(pages)').map(c => c.name);
    if (pagesCols.includes('remote_updated_at') || pagesCols.includes('dirty')) {
      db.prepare('DROP INDEX IF EXISTS idx_pages_dirty').run();
      db.prepare('DROP TABLE IF EXISTS pages_new').run();
      db.prepare(`
        CREATE TABLE pages_new (
          page_id        INTEGER PRIMARY KEY AUTOINCREMENT,
          book_id        INTEGER NOT NULL,
          page_name      TEXT,
          chapter_id     INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
          updated_at     TEXT,
          preview_text   TEXT,
          last_seen_at   TEXT,
          body_html      TEXT,
          body_markdown  TEXT,
          position       INTEGER,
          priority       INTEGER,
          slug           TEXT,
          local_updated_at TEXT
        )
      `).run();
      db.prepare(`
        INSERT INTO pages_new (page_id, book_id, page_name, chapter_id, updated_at, last_seen_at,
                               preview_text, body_html, body_markdown, position, priority, slug, local_updated_at)
        SELECT page_id, book_id, page_name, chapter_id, updated_at, last_seen_at,
               preview_text, body_html, body_markdown, position, priority, slug, local_updated_at
        FROM pages
      `).run();
      db.prepare('DROP TABLE pages').run();
      db.prepare('ALTER TABLE pages_new RENAME TO pages').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_book_id ON pages(book_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_chapter_id ON pages(chapter_id)').run();
      // Wasserzeichen wiederherstellen: AUTOINCREMENT-Counter min. 1_000_000,
      // damit neue localdb-IDs >= 1_000_001 vergeben werden (Phase-0-Garantie).
      const existing = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'pages'").get();
      if (existing) {
        if (existing.seq < 1000000) {
          db.prepare("UPDATE sqlite_sequence SET seq = 1000000 WHERE name = 'pages'").run();
        }
      } else {
        db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('pages', 1000000)").run();
      }
    }

    // page_revisions: CHECK-Constraint ohne 'bookstack-sync' setzen.
    const prCols = db.pragma('table_info(page_revisions)').map(c => c.name);
    if (prCols.length > 0) {
      db.prepare('DROP TABLE IF EXISTS page_revisions_new').run();
      db.prepare(`
        CREATE TABLE page_revisions_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          page_id       INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
          book_id       INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
          body_html     TEXT NOT NULL,
          body_markdown TEXT,
          chars         INTEGER,
          words         INTEGER,
          tok           INTEGER,
          source        TEXT NOT NULL CHECK(source IN
                          ('focus','main','chat-apply','lektorat-apply','import','conflict')),
          user_email    TEXT,
          summary       TEXT,
          created_at    TEXT DEFAULT (datetime('now'))
        )
      `).run();
      // 'bookstack-sync' auf 'import' mappen (semantisch naechstes Aequivalent).
      db.prepare(`
        INSERT INTO page_revisions_new (id, page_id, book_id, body_html, body_markdown, chars, words, tok, source, user_email, summary, created_at)
        SELECT id, page_id, book_id, body_html, body_markdown, chars, words, tok,
               CASE source WHEN 'bookstack-sync' THEN 'import' ELSE source END,
               user_email, summary, created_at
        FROM page_revisions
      `).run();
      db.prepare('DROP TABLE page_revisions').run();
      db.prepare('ALTER TABLE page_revisions_new RENAME TO page_revisions').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_page_revisions_page ON page_revisions(page_id, created_at DESC)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_page_revisions_book ON page_revisions(book_id, created_at DESC)').run();
    }

    // BookStack-spezifische app_settings entfernen.
    db.prepare(`DELETE FROM app_settings WHERE key IN ('app.backend','app.migrate.source_readonly','app.bookstack.base_url')`).run();

    db.pragma('foreign_keys = ON');

    const fkErrors120 = db.pragma('foreign_key_check');
    if (fkErrors120.length) {
      throw new Error(`Migration 120: foreign_key_check meldet ${fkErrors120.length} Verstoesse: ${JSON.stringify(fkErrors120.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 120').run();
    logger.info('DB-Migration auf Version 120 abgeschlossen (BookStack-Backend entfernt).');
  }

  if (version < 121) {
    // Fix: Migration 120 (initial) hatte chars/words/tok in page_revisions
    // versehentlich nicht mit-recreatet. Nachruesten via ALTER ADD COLUMN.
    const prCols = db.pragma('table_info(page_revisions)').map(c => c.name);
    if (!prCols.includes('chars')) db.prepare('ALTER TABLE page_revisions ADD COLUMN chars INTEGER').run();
    if (!prCols.includes('words')) db.prepare('ALTER TABLE page_revisions ADD COLUMN words INTEGER').run();
    if (!prCols.includes('tok'))   db.prepare('ALTER TABLE page_revisions ADD COLUMN tok INTEGER').run();
    db.prepare('UPDATE schema_version SET version = 121').run();
    logger.info('DB-Migration auf Version 121 abgeschlossen (page_revisions chars/words/tok nachgeruestet).');
  }

  if (version < 122) {
    // Ideen pro Kapitel: chapter_id FK + XOR-CHECK (entweder page_id oder
    // chapter_id, nicht beides/keins). Recreate-Pattern, weil SQLite weder
    // FK noch CHECK via ALTER nachruestet.
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP TABLE IF EXISTS ideen_new').run();
    db.prepare(`
      CREATE TABLE ideen_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(book_id)       ON DELETE CASCADE,
        page_id     INTEGER          REFERENCES pages(page_id)       ON DELETE SET NULL,
        chapter_id  INTEGER          REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        user_email  TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        erledigt    INTEGER NOT NULL DEFAULT 0,
        erledigt_at TEXT,
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL,
        CHECK ((page_id IS NOT NULL AND chapter_id IS NULL)
            OR (page_id IS NULL AND chapter_id IS NOT NULL))
      )
    `).run();
    db.prepare(`
      INSERT INTO ideen_new (id, book_id, page_id, chapter_id, user_email, content,
                             erledigt, erledigt_at, created_at, updated_at)
      SELECT id, book_id, page_id, NULL, user_email, content,
             erledigt, erledigt_at, created_at, updated_at
      FROM ideen
      WHERE page_id IS NOT NULL
    `).run();
    db.prepare('DROP TABLE ideen').run();
    db.prepare('ALTER TABLE ideen_new RENAME TO ideen').run();
    db.prepare('CREATE INDEX idx_ideen_page_user    ON ideen(page_id, user_email)').run();
    db.prepare('CREATE INDEX idx_ideen_chapter_user ON ideen(chapter_id, user_email)').run();
    db.prepare('CREATE INDEX idx_ideen_book_user    ON ideen(book_id, user_email)').run();
    db.pragma('foreign_keys = ON');

    const fkErrors122 = db.pragma('foreign_key_check');
    if (fkErrors122.length) {
      throw new Error(`Migration 122: foreign_key_check meldet ${fkErrors122.length} Verstoesse: ${JSON.stringify(fkErrors122.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 122').run();
    logger.info('DB-Migration auf Version 122 abgeschlossen (ideen.chapter_id FK + XOR-CHECK).');
  }

  if (version < 123) {
    // pages.last_editor_email: Wer hat zuletzt diese Seite geschrieben.
    // Quelle fuer Tree-/Toast-Hinweise „andere User hat editiert" sowie fuer
    // den /content/books/:id/changes-Endpoint (Phase 3). Nullable, kein FK
    // auf app_users (Display-Truth lebt in page_revisions; Email reicht als
    // Anzeige-Hint, Drop eines Users soll den Save-Pfad nicht brechen).
    const pagesCols123 = db.pragma('table_info(pages)').map(c => c.name);
    if (!pagesCols123.includes('last_editor_email')) {
      db.prepare('ALTER TABLE pages ADD COLUMN last_editor_email TEXT').run();
    }
    // Backfill aus juengster page_revisions-Row (best effort).
    db.prepare(`
      UPDATE pages
         SET last_editor_email = (
           SELECT user_email FROM page_revisions r
            WHERE r.page_id = pages.page_id
              AND r.user_email IS NOT NULL
            ORDER BY r.created_at DESC LIMIT 1
         )
       WHERE last_editor_email IS NULL
    `).run();

    const fkErrors123 = db.pragma('foreign_key_check');
    if (fkErrors123.length) {
      throw new Error(`Migration 123: foreign_key_check meldet ${fkErrors123.length} Verstoesse: ${JSON.stringify(fkErrors123.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 123').run();
    logger.info('DB-Migration auf Version 123 abgeschlossen (pages.last_editor_email).');
  }

  if (version < 124) {
    // budget_alerts: Dedup-Tabelle fuer Budget-Overrun-Mails. Pro
    // (email, period='YYYY-MM') hoechstens ein Eintrag => Mail wird exakt einmal
    // pro Monat verschickt. ON DELETE CASCADE: geloeschter User raeumt seine
    // Alerts gleich mit.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS budget_alerts (
        email   TEXT NOT NULL,
        period  TEXT NOT NULL,
        sent_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (email, period),
        FOREIGN KEY (email) REFERENCES app_users(email) ON DELETE CASCADE
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_budget_alerts_period ON budget_alerts(period)').run();

    const fkErrors124 = db.pragma('foreign_key_check');
    if (fkErrors124.length) {
      throw new Error(`Migration 124: foreign_key_check meldet ${fkErrors124.length} Verstoesse: ${JSON.stringify(fkErrors124.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 124').run();
    logger.info('DB-Migration auf Version 124 abgeschlossen (budget_alerts).');
  }

  if (version < 125) {
    // page_presence: Live-Heartbeat fuer „X editiert gerade Seite Y".
    // Client pingt waehrend Edit-Mode alle 30s; Server filtert Stale-Eintraege
    // (>90s) bei jedem List-Read. Pure Ephemeral-Tabelle, kein Audit-Wert.
    // CASCADE auf pages/app_users: geloeschte Seite/User raeumt die Pings mit.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS page_presence (
        page_id     INTEGER NOT NULL REFERENCES pages(page_id)    ON DELETE CASCADE,
        user_email  TEXT    NOT NULL REFERENCES app_users(email)  ON DELETE CASCADE,
        book_id     INTEGER NOT NULL REFERENCES books(book_id)    ON DELETE CASCADE,
        last_ping_at TEXT   NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (page_id, user_email)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_presence_book ON page_presence(book_id, last_ping_at DESC)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_presence_ping ON page_presence(last_ping_at)').run();

    const fkErrors125 = db.pragma('foreign_key_check');
    if (fkErrors125.length) {
      throw new Error(`Migration 125: foreign_key_check meldet ${fkErrors125.length} Verstoesse: ${JSON.stringify(fkErrors125.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 125').run();
    logger.info('DB-Migration auf Version 125 abgeschlossen (page_presence).');
  }

  if (version < 126) {
    // page_locks.reason: 'edit' als zweiter Reason-Wert. Soft-Lock fuer den
    // Free-Edit-Pfad (startEdit acquired ihn, anderer User sieht „X editiert
    // bis HH:MM"). 'lektorat' bleibt Hard-Lock (blockt PUT mit 423); 'edit'
    // wird beim PUT als advisory behandelt (kein 423, nur UI-Signal).
    // CHECK-Constraint erweitert via Table-Recreate (SQLite-Pflicht).
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP TABLE IF EXISTS page_locks_new').run();
    db.prepare(`
      CREATE TABLE page_locks_new (
        page_id           INTEGER PRIMARY KEY REFERENCES pages(page_id)     ON DELETE CASCADE,
        book_id           INTEGER NOT NULL    REFERENCES books(book_id)     ON DELETE CASCADE,
        locked_by_email   TEXT    NOT NULL    REFERENCES app_users(email)   ON DELETE CASCADE,
        reason            TEXT    NOT NULL CHECK(reason IN ('lektorat','edit')),
        acquired_at       TEXT    NOT NULL DEFAULT (datetime('now')),
        expires_at        TEXT    NOT NULL,
        last_heartbeat_at TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare(`
      INSERT INTO page_locks_new (page_id, book_id, locked_by_email, reason, acquired_at, expires_at, last_heartbeat_at)
      SELECT page_id, book_id, locked_by_email, reason, acquired_at, expires_at, last_heartbeat_at
        FROM page_locks
    `).run();
    db.prepare('DROP TABLE page_locks').run();
    db.prepare('ALTER TABLE page_locks_new RENAME TO page_locks').run();
    db.pragma('foreign_keys = ON');

    const fkErrors126 = db.pragma('foreign_key_check');
    if (fkErrors126.length) {
      throw new Error(`Migration 126: foreign_key_check meldet ${fkErrors126.length} Verstoesse: ${JSON.stringify(fkErrors126.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 126').run();
    logger.info('DB-Migration auf Version 126 abgeschlossen (page_locks.reason+edit).');
  }

  if (version < 127) {
    // Musikbibliothek: songs/song_figures/song_chapters/song_scenes, parallel
    // zu locations. songs hält Titel + Interpret + Genre + kontext_typ
    // (hört/spielt/erwähnt/leitmotiv/diegetisch). UNIQUE(book_id, song_uid,
    // user_email) erlaubt UPSERT-Pattern aus saveSongsToDb.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS songs (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id                  INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        song_uid                 TEXT    NOT NULL,
        titel                    TEXT    NOT NULL,
        interpret                TEXT,
        genre                    TEXT,
        kontext_typ              TEXT,
        beschreibung             TEXT,
        stimmung                 TEXT,
        erste_erwaehnung         TEXT,
        erste_erwaehnung_page_id INTEGER REFERENCES pages(page_id) ON DELETE SET NULL,
        sort_order               INTEGER DEFAULT 0,
        user_email               TEXT,
        updated_at               TEXT NOT NULL,
        UNIQUE(book_id, song_uid, user_email)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_songs_book_id ON songs(book_id, user_email)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_songs_erste_page ON songs(erste_erwaehnung_page_id)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS song_figures (
        song_id     INTEGER NOT NULL REFERENCES songs(id)    ON DELETE CASCADE,
        figure_id   INTEGER NOT NULL REFERENCES figures(id)  ON DELETE CASCADE,
        kontext_typ TEXT,
        PRIMARY KEY (song_id, figure_id)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_sf_figure ON song_figures(figure_id)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS song_chapters (
        song_id     INTEGER NOT NULL REFERENCES songs(id)             ON DELETE CASCADE,
        chapter_id  INTEGER NOT NULL REFERENCES chapters(chapter_id)  ON DELETE CASCADE,
        haeufigkeit INTEGER DEFAULT 1,
        PRIMARY KEY (song_id, chapter_id)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_sc_chapter_id ON song_chapters(chapter_id)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS song_scenes (
        scene_id INTEGER NOT NULL REFERENCES figure_scenes(id) ON DELETE CASCADE,
        song_id  INTEGER NOT NULL REFERENCES songs(id)         ON DELETE CASCADE,
        PRIMARY KEY (scene_id, song_id)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_song_scenes_song ON song_scenes(song_id)').run();

    const fkErrors127 = db.pragma('foreign_key_check');
    if (fkErrors127.length) {
      throw new Error(`Migration 127: foreign_key_check meldet ${fkErrors127.length} Verstoesse: ${JSON.stringify(fkErrors127.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 127').run();
    logger.info('DB-Migration auf Version 127 abgeschlossen (songs, song_figures, song_chapters, song_scenes).');
  }

  if (version < 128) {
    // page_locks-Recreate in Migration 126 hat die Indexe (idx_page_locks_book,
    // idx_page_locks_user, idx_page_locks_expires) verloren — SQLite verwirft
    // Indexe beim DROP TABLE. Neu anlegen, damit FK-Lookups (book_id,
    // locked_by_email) und Expire-Sweeps wieder einen Index haben.
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_locks_book    ON page_locks(book_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_locks_user    ON page_locks(locked_by_email)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_locks_expires ON page_locks(expires_at)').run();

    const fkErrors128 = db.pragma('foreign_key_check');
    if (fkErrors128.length) {
      throw new Error(`Migration 128: foreign_key_check meldet ${fkErrors128.length} Verstoesse: ${JSON.stringify(fkErrors128.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 128').run();
    logger.info('DB-Migration auf Version 128 abgeschlossen (page_locks-Indexe wiederhergestellt).');
  }

  if (version < 129) {
    // users-Tabelle in app_users einfalten. Beide hielten parallel Profil-/Identitaets-
    // daten — users diente nur als Settings-Satellit (locale/theme/focus_granularity/
    // daily_goal_chars/default_*) mit FK app_users(email) CASCADE. Spalten wandern
    // nach app_users, users wird gedropt.
    const auCols = db.pragma('table_info(app_users)').map(c => c.name);
    const addCol = (name, decl) => {
      if (!auCols.includes(name)) db.exec(`ALTER TABLE app_users ADD COLUMN ${name} ${decl}`);
    };
    addCol('last_login_at',     'TEXT');
    addCol('theme',             'TEXT');
    addCol('default_buchtyp',   'TEXT');
    addCol('default_language',  'TEXT');
    addCol('default_region',    'TEXT');
    addCol('focus_granularity', 'TEXT');
    addCol('daily_goal_chars',  'INTEGER');

    const usersExists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'"
    ).get();
    if (usersExists) {
      db.exec(`
        UPDATE app_users
           SET last_login_at     = (SELECT u.last_login_at     FROM users u WHERE u.email = app_users.email),
               theme             = (SELECT u.theme             FROM users u WHERE u.email = app_users.email),
               default_buchtyp   = (SELECT u.default_buchtyp   FROM users u WHERE u.email = app_users.email),
               default_language  = (SELECT u.default_language  FROM users u WHERE u.email = app_users.email),
               default_region    = (SELECT u.default_region    FROM users u WHERE u.email = app_users.email),
               focus_granularity = (SELECT u.focus_granularity FROM users u WHERE u.email = app_users.email),
               daily_goal_chars  = (SELECT u.daily_goal_chars  FROM users u WHERE u.email = app_users.email)
         WHERE email IN (SELECT email FROM users);
      `);
      db.exec(`
        UPDATE app_users
           SET language = (SELECT u.locale FROM users u WHERE u.email = app_users.email)
         WHERE EXISTS (SELECT 1 FROM users u WHERE u.email = app_users.email AND u.locale IS NOT NULL);
      `);
      db.exec(`
        UPDATE app_users
           SET display_name = (SELECT u.name FROM users u WHERE u.email = app_users.email)
         WHERE display_name IS NULL
           AND EXISTS (SELECT 1 FROM users u WHERE u.email = app_users.email AND u.name IS NOT NULL);
      `);
      db.exec(`
        UPDATE app_users
           SET last_seen_at = (SELECT u.last_seen_at FROM users u WHERE u.email = app_users.email)
         WHERE EXISTS (
           SELECT 1 FROM users u
            WHERE u.email = app_users.email
              AND u.last_seen_at IS NOT NULL
              AND (app_users.last_seen_at IS NULL OR u.last_seen_at > app_users.last_seen_at)
         );
      `);
      db.exec(`
        UPDATE app_users
           SET created_at = (SELECT u.created_at FROM users u WHERE u.email = app_users.email)
         WHERE EXISTS (
           SELECT 1 FROM users u
            WHERE u.email = app_users.email
              AND u.created_at IS NOT NULL
              AND (app_users.created_at IS NULL OR u.created_at < app_users.created_at)
         );
      `);
      db.exec('DROP TABLE users');
    }

    const fkErrors129 = db.pragma('foreign_key_check');
    if (fkErrors129.length) {
      throw new Error(`Migration 129: foreign_key_check meldet ${fkErrors129.length} Verstoesse: ${JSON.stringify(fkErrors129.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 129').run();
    logger.info('DB-Migration auf Version 129 abgeschlossen (users in app_users konsolidiert, DROP users).');
  }

  if (version < 130) {
    // FK-Hardening: 33 Tabellen mit `user_email` bekommen einen FK auf
    // app_users(email). Strategie pro Tabelle:
    //   - CASCADE: Caches/Logs/User-spezifische Daten, deren Wert ohne User wegfaellt.
    //   - SET NULL: inhaltliche Daten (Figuren, Orte, Songs, ...), die als anonyme
    //     Spur erhalten bleiben sollen. Voraussetzung: user_email-Spalte nullable.
    //
    // Vorab-Cleanup: Rows mit user_email='' oder unbekannter Email werden
    // bereinigt — CASCADE-Tabellen geloescht, SET-NULL-Tabellen genullt — damit
    // der spaetere foreign_key_check sauber durchgeht.

    db.pragma('foreign_keys = OFF');

    const CASCADE_TABLES = [
      'book_extract_cache', 'book_review_cache', 'chapter_extract_cache',
      'chapter_macro_review_cache', 'chapter_review_cache', 'chat_sessions',
      'draft_figures', 'finetune_ai_cache', 'ideen', 'job_checkpoints',
      'lektorat_cache', 'lektorat_time', 'pdf_export_profile', 'synonym_cache',
      'user_activity', 'user_feature_usage', 'user_page_usage',
      'werkstatt_runs', 'writing_time', 'zeitstrahl_events',
    ];
    // user_sessions_audit absichtlich ausgenommen: enthaelt auch Events vor
    // User-Existenz (login-denied, role-changed bei Approval-Vorgaengen) und
    // braucht daher keinen FK auf app_users(email). Anonymisierung beim
    // User-Loeschen geschieht ueber softDeleteUser-Workflow, nicht via CASCADE.
    const SET_NULL_TABLES = [
      'book_reviews', 'chapter_reviews', 'continuity_checks', 'continuity_issues',
      'figure_relations', 'figure_scenes', 'figures', 'job_runs', 'locations',
      'page_checks', 'page_revisions', 'songs',
    ];

    let cleanupDeleted = 0;
    for (const t of CASCADE_TABLES) {
      const r = db.prepare(
        `DELETE FROM ${t} WHERE user_email = '' OR user_email IS NULL OR user_email NOT IN (SELECT email FROM app_users)`
      ).run();
      cleanupDeleted += r.changes;
    }
    let cleanupNulled = 0;
    for (const t of SET_NULL_TABLES) {
      const r = db.prepare(
        `UPDATE ${t} SET user_email = NULL WHERE user_email = '' OR (user_email IS NOT NULL AND user_email NOT IN (SELECT email FROM app_users))`
      ).run();
      cleanupNulled += r.changes;
    }
    if (cleanupDeleted || cleanupNulled) {
      logger.info(`Mig 130 Pre-Cleanup: ${cleanupDeleted} Orphan-Rows geloescht, ${cleanupNulled} user_email genullt.`);
    }

    // Dynamischer Recreate-Helper: zieht das aktuelle CREATE TABLE aus
    // sqlite_master, haengt die FK-Klausel an, recreated die Tabelle mit
    // Datenkopie + Index-Wiederherstellung.
    const _addUserFk = (table, onDelete) => {
      const orig = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?"
      ).get(table);
      if (!orig || !orig.sql) {
        throw new Error(`Migration 130: Tabelle ${table} nicht gefunden`);
      }
      const indexes = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL"
      ).all(table);

      // CREATE TABLE "<name>" → CREATE TABLE <name>_new
      const nameRe = new RegExp('CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?"?' + table + '"?', 'i');
      let newSql = orig.sql.replace(nameRe, 'CREATE TABLE ' + table + '_new');

      // FK-Klausel vor schliessender ) einhaengen.
      const fkClause = `,\n        FOREIGN KEY (user_email) REFERENCES app_users(email) ON DELETE ${onDelete}\n      `;
      const lastParen = newSql.lastIndexOf(')');
      if (lastParen < 0) throw new Error(`Migration 130: kein ) in CREATE fuer ${table}`);
      newSql = newSql.slice(0, lastParen) + fkClause + newSql.slice(lastParen);

      db.prepare(`DROP TABLE IF EXISTS ${table}_new`).run();
      db.exec(newSql);
      db.prepare(`INSERT INTO ${table}_new SELECT * FROM ${table}`).run();
      db.prepare(`DROP TABLE ${table}`).run();
      db.prepare(`ALTER TABLE ${table}_new RENAME TO ${table}`).run();
      for (const ix of indexes) db.exec(ix.sql);
    };

    for (const t of CASCADE_TABLES) _addUserFk(t, 'CASCADE');
    for (const t of SET_NULL_TABLES) _addUserFk(t, 'SET NULL');

    // Index auf jede FK-Spalte (Pflicht laut CLAUDE.md: jede FK-Spalte hat Index).
    // Ausgenommen: Tabellen, deren PRIMARY KEY user_email als ERSTES Feld
    // fuehrt — der PK-Index deckt user_email-Lookups bereits ab. Composite-
    // PKs, die mit book_id (o.ae.) starten, decken user_email NICHT ab und
    // brauchen einen eigenen Index.
    const PK_LEADS_WITH_USER_EMAIL = new Set([
      'user_activity', 'user_feature_usage', 'user_page_usage', 'synonym_cache',
    ]);
    const NEEDS_USER_INDEX = [...CASCADE_TABLES, ...SET_NULL_TABLES]
      .filter(t => !PK_LEADS_WITH_USER_EMAIL.has(t));
    for (const t of NEEDS_USER_INDEX) {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_user_email ON ${t}(user_email)`);
    }

    db.pragma('foreign_keys = ON');

    const fkErrors130 = db.pragma('foreign_key_check');
    if (fkErrors130.length) {
      throw new Error(`Migration 130: foreign_key_check meldet ${fkErrors130.length} Verstoesse: ${JSON.stringify(fkErrors130.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 130').run();
    logger.info(`DB-Migration auf Version 130 abgeschlossen (FK-Hardening: ${CASCADE_TABLES.length} CASCADE + ${SET_NULL_TABLES.length} SET NULL Tabellen auf app_users(email)).`);
  }

  if (version < 131) {
    // Rename app_setting key cron.timezone -> app.timezone. Setting deckt jetzt
    // Cron, Server-Datums-Buckets (lib/local-date.js) und Frontend-Display-
    // Formatter ab (GUI-Zeit muss zur Server-Zeit passen, unabhaengig vom
    // Browser-Standort des Users).
    const oldRow = db.prepare("SELECT value_json, encrypted, updated_by FROM app_settings WHERE key = 'cron.timezone'").get();
    const hasNew = db.prepare("SELECT 1 FROM app_settings WHERE key = 'app.timezone'").get();
    if (oldRow && !hasNew) {
      db.prepare(`
        INSERT INTO app_settings (key, value_json, encrypted, updated_at, updated_by)
        VALUES ('app.timezone', @value_json, @encrypted, datetime('now'), @updated_by)
      `).run({ value_json: oldRow.value_json, encrypted: oldRow.encrypted, updated_by: oldRow.updated_by || 'migration-131' });
    }
    db.prepare("DELETE FROM app_settings WHERE key = 'cron.timezone'").run();

    const fkErrors131 = db.pragma('foreign_key_check');
    if (fkErrors131.length) {
      throw new Error(`Migration 131: foreign_key_check meldet ${fkErrors131.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 131').run();
    logger.info('DB-Migration auf Version 131 abgeschlossen (rename cron.timezone -> app.timezone).');
  }

  if (version < 132) {
    // Composite-Index fuer /history/page-ages/:book_id (cross-user). Bestehender
    // (book_id, user_email)-Index taugt nur als Left-Prefix fuer WHERE book_id=?,
    // zwingt SQLite aber bei ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY
    // checked_at DESC) zum Extra-Sort. (book_id, page_id, checked_at DESC)
    // deckt Filter + PARTITION BY + ORDER BY ab.
    db.exec('CREATE INDEX IF NOT EXISTS idx_pc_book_page_date ON page_checks(book_id, page_id, checked_at DESC)');

    const fkErrors132 = db.pragma('foreign_key_check');
    if (fkErrors132.length) {
      throw new Error(`Migration 132: foreign_key_check meldet ${fkErrors132.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 132').run();
    logger.info('DB-Migration auf Version 132 abgeschlossen (Index idx_pc_book_page_date fuer page-ages-Query).');
  }

  if (version < 133) {
    // SQLite-`datetime('now')` liefert "YYYY-MM-DD HH:MM:SS" (UTC ohne TZ-Marker).
    // JS `new Date("...")` parsed das als lokale Browser-Zeit statt UTC; das UI
    // zeigt dann die UTC-Uhr unter app.timezone-Label (CEST: 2 h zu frueh).
    // Code-Pfade schreiben jetzt ISO+Z via `NOW_ISO_SQL` (db/now.js). Backfill
    // alle Spalten, die von Default oder Inline-`datetime('now')` gefuellt
    // wurden: GLOB matched genau die "YYYY-MM-DD HH:MM:SS"-Form,
    // `strftime('%Y-%m-%dT%H:%M:%fZ', value)` parst die als UTC und liefert
    // die ISO+Z-Form.
    const tsCols = [
      ['app_settings', 'updated_at'],
      ['app_settings_audit', 'updated_at'],
      ['app_users', 'created_at'],
      ['app_users', 'first_seen_at'],
      ['app_users', 'last_seen_at'],
      ['app_users', 'last_login_at'],
      ['app_users', 'invited_at'],
      ['book_access', 'granted_at'],
      ['book_categories', 'created_at'],
      ['book_order', 'updated_at'],
      ['book_share_invites', 'invited_at'],
      ['book_share_invites', 'accepted_at'],
      ['book_share_invites', 'revoked_at'],
      ['book_tag_assignments', 'assigned_at'],
      ['book_tags', 'created_at'],
      ['budget_alerts', 'sent_at'],
      ['page_locks', 'acquired_at'],
      ['page_locks', 'last_heartbeat_at'],
      ['page_presence', 'last_ping_at'],
      ['page_revisions', 'created_at'],
      ['registration_requests', 'created_at'],
      ['registration_requests', 'reviewed_at'],
      ['search_meta', 'updated_at'],
      ['user_invites', 'invited_at'],
      ['user_invites', 'accepted_at'],
      ['user_invites', 'revoked_at'],
      ['user_sessions_audit', 'created_at'],
    ];
    for (const [tbl, col] of tsCols) {
      db.prepare(
        `UPDATE ${tbl}
            SET ${col} = strftime('%Y-%m-%dT%H:%M:%fZ', ${col})
          WHERE ${col} IS NOT NULL
            AND ${col} GLOB '????-??-?? ??:??:??'`
      ).run();
    }

    const fkErrors133 = db.pragma('foreign_key_check');
    if (fkErrors133.length) {
      throw new Error(`Migration 133: foreign_key_check meldet ${fkErrors133.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 133').run();
    logger.info('DB-Migration auf Version 133 abgeschlossen (Timestamp-Backfill UTC-no-Z -> ISO+Z).');
  }

  if (version < 134) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS blog_connections (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id                INTEGER NOT NULL UNIQUE REFERENCES books(book_id) ON DELETE CASCADE,
        base_url               TEXT    NOT NULL,
        username               TEXT    NOT NULL,
        password_enc           BLOB    NOT NULL,
        default_status         TEXT    NOT NULL DEFAULT 'draft' CHECK(default_status IN ('draft','publish','private')),
        initial_import_done_at TEXT,
        last_pull_at           TEXT,
        last_push_at           TEXT,
        created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS blog_page_links (
        page_id         INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
        blog_id         INTEGER NOT NULL    REFERENCES blog_connections(id) ON DELETE CASCADE,
        wp_post_id      INTEGER NOT NULL,
        wp_modified_at  TEXT    NOT NULL,
        wp_status       TEXT,
        wp_slug         TEXT,
        last_pulled_at  TEXT,
        last_pushed_at  TEXT,
        conflict_state  TEXT    CHECK(conflict_state IN ('detected','resolved-app','resolved-wp')),
        UNIQUE(blog_id, wp_post_id)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_blog_page_links_blog ON blog_page_links(blog_id)').run();

    const fkErrors134 = db.pragma('foreign_key_check');
    if (fkErrors134.length) {
      throw new Error(`Migration 134: foreign_key_check meldet ${fkErrors134.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 134').run();
    logger.info('DB-Migration auf Version 134 abgeschlossen (blog_connections + blog_page_links).');
  }

  if (version < 135) {
    const chaptersCols135 = db.pragma('table_info(chapters)').map(c => c.name);
    if (!chaptersCols135.includes('parent_chapter_id')) {
      db.prepare('ALTER TABLE chapters ADD COLUMN parent_chapter_id INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL').run();
    }
    db.prepare('CREATE INDEX IF NOT EXISTS idx_chapters_parent ON chapters(parent_chapter_id)').run();

    const fkErrors135 = db.pragma('foreign_key_check');
    if (fkErrors135.length) {
      throw new Error(`Migration 135: foreign_key_check meldet ${fkErrors135.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 135').run();
    logger.info('DB-Migration auf Version 135 abgeschlossen (chapters.parent_chapter_id fuer Hierarchie).');
  }

  if (version < 136) {
    // Tagesziel wandert vom User-Profil aufs Buch. Pro-Buch-Konfiguration
    // passt besser, weil ein Autor mehrere Bücher parallel betreut und das
    // Zielvolumen pro Projekt unterschiedlich ist.
    const bsCols136 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols136.includes('daily_goal_chars')) {
      db.prepare('ALTER TABLE book_settings ADD COLUMN daily_goal_chars INTEGER').run();
    }
    // Backfill: existierende book_settings-Zeilen erben den daily_goal_chars
    // ihres Buch-Owners (best effort). NULL bleibt NULL — Frontend fällt auf
    // 1500 zurück (eine Normseite).
    db.prepare(`
      UPDATE book_settings
         SET daily_goal_chars = (
           SELECT au.daily_goal_chars
             FROM books b
             JOIN app_users au ON au.email = b.owner_email
            WHERE b.book_id = book_settings.book_id
              AND au.daily_goal_chars IS NOT NULL
         )
       WHERE daily_goal_chars IS NULL
    `).run();

    // app_users.daily_goal_chars entfällt (Recreate-Pattern).
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS app_users_new');
    db.exec(`
      CREATE TABLE app_users_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        email            TEXT NOT NULL UNIQUE,
        display_name     TEXT,
        avatar_url       TEXT,
        global_role      TEXT NOT NULL DEFAULT 'user'
                              CHECK(global_role IN ('admin','user')),
        status           TEXT NOT NULL DEFAULT 'active'
                              CHECK(status IN ('invited','active','suspended','deleted')),
        language         TEXT DEFAULT 'de',
        model_override   TEXT,
        can_invite_users INTEGER NOT NULL DEFAULT 1,
        first_seen_at    TEXT,
        last_seen_at     TEXT,
        invited_by       TEXT,
        invited_at       TEXT,
        created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        monthly_budget_usd REAL,
        budget_mode      TEXT NOT NULL DEFAULT 'none'
                              CHECK(budget_mode IN ('none','soft','hard')),
        ai_provider_override TEXT
                              CHECK(ai_provider_override IN ('claude','ollama','llama') OR ai_provider_override IS NULL),
        last_login_at    TEXT,
        theme            TEXT,
        default_buchtyp  TEXT,
        default_language TEXT,
        default_region   TEXT,
        focus_granularity TEXT
      )
    `);
    db.exec(`
      INSERT INTO app_users_new (id, email, display_name, avatar_url, global_role, status,
                                 language, model_override, can_invite_users, first_seen_at,
                                 last_seen_at, invited_by, invited_at, created_at,
                                 monthly_budget_usd, budget_mode, ai_provider_override,
                                 last_login_at, theme, default_buchtyp, default_language,
                                 default_region, focus_granularity)
      SELECT id, email, display_name, avatar_url, global_role, status,
             language, model_override, can_invite_users, first_seen_at,
             last_seen_at, invited_by, invited_at, created_at,
             monthly_budget_usd, budget_mode, ai_provider_override,
             last_login_at, theme, default_buchtyp, default_language,
             default_region, focus_granularity
        FROM app_users
    `);
    db.exec('DROP TABLE app_users');
    db.exec('ALTER TABLE app_users_new RENAME TO app_users');
    db.pragma('foreign_keys = ON');

    const fkErrors136 = db.pragma('foreign_key_check');
    if (fkErrors136.length) {
      throw new Error(`Migration 136: foreign_key_check meldet ${fkErrors136.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 136').run();
    logger.info('DB-Migration auf Version 136 abgeschlossen (Tagesziel pro Buch: book_settings.daily_goal_chars hinzugefuegt, app_users.daily_goal_chars entfernt).');
  }

  if (version < 137) {
    db.exec(`
      DROP INDEX IF EXISTS idx_bta_tag;
      DROP TABLE IF EXISTS book_tag_assignments;
      DROP TABLE IF EXISTS book_tags;
    `);
    const fkErrors137 = db.pragma('foreign_key_check');
    if (fkErrors137.length) {
      throw new Error(`Migration 137: foreign_key_check meldet ${fkErrors137.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 137').run();
    logger.info('DB-Migration auf Version 137 abgeschlossen (Tags-Feature entfernt: book_tags + book_tag_assignments gedroppt).');
  }

  if (version < 138) {
    // Stilkorrektur-Feature entfernt: page_checks.stilkorrektur_log war seit Mig 66
    // angelegt, aber nie vom Frontend befuellt (Spalte immer NULL). Recreate-Pattern,
    // weil SQLite DROP COLUMN nicht zuverlaessig FK-Constraints beibehaelt.
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS page_checks_new');
    db.exec(
      'CREATE TABLE page_checks_new (' +
      '  id                   INTEGER PRIMARY KEY AUTOINCREMENT,' +
      '  page_id              INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,' +
      '  book_id              INTEGER REFERENCES books(book_id) ON DELETE SET NULL,' +
      '  checked_at           TEXT NOT NULL,' +
      '  error_count          INTEGER DEFAULT 0,' +
      '  errors_json          TEXT,' +
      '  stilanalyse          TEXT,' +
      '  fazit                TEXT,' +
      '  model                TEXT,' +
      '  saved                INTEGER DEFAULT 0,' +
      '  saved_at             TEXT,' +
      '  applied_errors_json  TEXT,' +
      '  user_email           TEXT REFERENCES app_users(email) ON DELETE SET NULL,' +
      '  selected_errors_json TEXT,' +
      '  szenen_json          TEXT,' +
      '  chapter_id           INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL' +
      ')'
    );
    db.exec(
      'INSERT INTO page_checks_new (' +
      '  id, page_id, book_id, checked_at, error_count, errors_json,' +
      '  stilanalyse, fazit, model, saved, saved_at, applied_errors_json,' +
      '  user_email, selected_errors_json, szenen_json, chapter_id' +
      ') SELECT' +
      '  id, page_id, book_id, checked_at, error_count, errors_json,' +
      '  stilanalyse, fazit, model, saved, saved_at, applied_errors_json,' +
      '  user_email, selected_errors_json, szenen_json, chapter_id' +
      ' FROM page_checks'
    );
    db.exec('DROP TABLE page_checks');
    db.exec('ALTER TABLE page_checks_new RENAME TO page_checks');
    db.exec('CREATE INDEX idx_pc_book_page_date  ON page_checks(book_id, page_id, checked_at DESC)');
    db.exec('CREATE INDEX idx_pc_book_user       ON page_checks(book_id, user_email)');
    db.exec('CREATE INDEX idx_pc_page_user_date  ON page_checks(page_id, user_email, checked_at DESC)');
    db.exec('CREATE INDEX idx_page_checks_user_email ON page_checks(user_email)');
    db.pragma('foreign_keys = ON');
    const fkErrors138 = db.pragma('foreign_key_check');
    if (fkErrors138.length) {
      throw new Error(`Migration 138: foreign_key_check meldet ${fkErrors138.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 138').run();
    logger.info('DB-Migration auf Version 138 abgeschlossen (page_checks.stilkorrektur_log entfernt — Feature nie aktiv).');
  }

  if (version < 139) {
    // page_revisions.source-CHECK erweitern um 'book' (Bucheditor-Saves).
    // JS-VALID_SOURCES kennt 'book' seit Bucheditor-Einfuehrung, CHECK nicht →
    // Inserts liefen still in CHECK-Verletzung und wurden im content-store
    // weggeloggt; Bucheditor-Edits erzeugten 0 Revisionen.
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP TABLE IF EXISTS page_revisions_new').run();
    db.prepare(`
      CREATE TABLE page_revisions_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id       INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        book_id       INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        body_html     TEXT NOT NULL,
        body_markdown TEXT,
        chars         INTEGER,
        words         INTEGER,
        tok           INTEGER,
        source        TEXT NOT NULL CHECK(source IN
                        ('focus','main','book','chat-apply','lektorat-apply','import','conflict')),
        user_email    TEXT REFERENCES app_users(email) ON DELETE SET NULL,
        summary       TEXT,
        created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).run();
    db.prepare(`
      INSERT INTO page_revisions_new (id, page_id, book_id, body_html, body_markdown, chars, words, tok, source, user_email, summary, created_at)
      SELECT id, page_id, book_id, body_html, body_markdown, chars, words, tok, source, user_email, summary, created_at
        FROM page_revisions
    `).run();
    db.prepare('DROP TABLE page_revisions').run();
    db.prepare('ALTER TABLE page_revisions_new RENAME TO page_revisions').run();
    db.prepare('CREATE INDEX idx_page_revisions_page ON page_revisions(page_id, created_at DESC)').run();
    db.prepare('CREATE INDEX idx_page_revisions_book ON page_revisions(book_id, created_at DESC)').run();
    db.pragma('foreign_keys = ON');
    const fkErrors139 = db.pragma('foreign_key_check');
    if (fkErrors139.length) {
      throw new Error(`Migration 139: foreign_key_check meldet ${fkErrors139.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 139').run();
    logger.info("DB-Migration auf Version 139 abgeschlossen (page_revisions.source-CHECK um 'book' erweitert).");
  }

  if (version < 140) {
    // Index auf page_revisions.user_email — FK auf app_users.email lief bisher
    // ohne Index. Reverse-Lookup "alle Revisionen von User X" und FK-Integrity-
    // Checks beim Löschen eines Users (ON DELETE SET NULL) scannen sonst die
    // gesamte Tabelle.
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_revisions_user ON page_revisions(user_email)').run();
    const fkErrors140 = db.pragma('foreign_key_check');
    if (fkErrors140.length) {
      throw new Error(`Migration 140: foreign_key_check meldet ${fkErrors140.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 140').run();
    logger.info('DB-Migration auf Version 140 abgeschlossen (idx_page_revisions_user).');
  }

  if (version < 141) {
    // LanguageTool-Cache pro Page + User-Custom-Dictionary (Phase-2-Features).
    // page_languagetool_cache: PK = (page_id, content_hash, lang, picky) --
    // mehrere Eintraege pro Page moeglich (Sprachwechsel, Picky-Toggle). FK
    // CASCADE; Cache-Eintrag fuer geloeschte Page macht keinen Sinn.
    // user_dictionary: User-spezifisches Woerterbuch. book_id=0 = global,
    // sonst pro Buch. lang='*' = alle Sprachen, sonst LT-Locale-Tag.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS page_languagetool_cache (
        page_id INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        lang TEXT NOT NULL,
        picky INTEGER NOT NULL DEFAULT 0,
        matches_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (page_id, content_hash, lang, picky),
        FOREIGN KEY (page_id) REFERENCES pages(page_id) ON DELETE CASCADE
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_lt_cache_created ON page_languagetool_cache(created_at)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS user_dictionary (
        user_email TEXT NOT NULL,
        book_id INTEGER NOT NULL DEFAULT 0,
        word TEXT NOT NULL,
        lang TEXT NOT NULL DEFAULT '*',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (user_email, book_id, word, lang),
        FOREIGN KEY (user_email) REFERENCES app_users(email) ON DELETE CASCADE
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_dictionary_user ON user_dictionary(user_email)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_dictionary_book ON user_dictionary(book_id)').run();

    const fkErrors141 = db.pragma('foreign_key_check');
    if (fkErrors141.length) {
      throw new Error(`Migration 141: foreign_key_check meldet ${fkErrors141.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 141').run();
    logger.info('DB-Migration auf Version 141 abgeschlossen (page_languagetool_cache, user_dictionary).');
  }

  if (version < 142) {
    // user_dictionary.lang='auto' normalisieren auf '*': 'auto' war kein
    // gueltiger LT-Locale-Tag — Lookup `lang='*' OR lang=:current` matched
    // bei Page-Locale 'de-CH' nie. Eintraege waren tote Daten + UI-Display
    // zeigte sinnlose "Nur dieses Buch: auto"-Zeile.
    db.prepare("UPDATE OR IGNORE user_dictionary SET lang='*' WHERE lang='auto'").run();
    db.prepare("DELETE FROM user_dictionary WHERE lang='auto'").run();
    const fkErrors142 = db.pragma('foreign_key_check');
    if (fkErrors142.length) {
      throw new Error(`Migration 142: foreign_key_check meldet ${fkErrors142.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 142').run();
    logger.info('DB-Migration auf Version 142 abgeschlossen (user_dictionary.lang auto -> *).');
  }

  if (version < 143) {
    // page_languagetool_cache einmalig leeren: Vor Migration 142 wurden
    // user_dictionary-Eintraege mit lang='auto' gespeichert; der LT-Filter-
    // Lookup matchte nie und schrieb unfiltered Matches in den Cache. Diese
    // Rows leben weiter, bis ihr content_hash invalidiert wird. Pauschaler
    // Wipe erzwingt frische, korrekt gefilterte Caches.
    const cleared = db.prepare('DELETE FROM page_languagetool_cache').run();
    const fkErrors143 = db.pragma('foreign_key_check');
    if (fkErrors143.length) {
      throw new Error(`Migration 143: foreign_key_check meldet ${fkErrors143.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 143').run();
    logger.info(`DB-Migration auf Version 143 abgeschlossen (page_languagetool_cache geleert, ${cleared.changes} Rows).`);
  }

  if (version < 144) {
    // Invite-Click- und Reminder-Tracking. Admin-Tab "Eingeladene Benutzer"
    // sieht so, ob der User den Link geoeffnet hat und kann Erinnerungen senden.
    const uiCols = db.pragma('table_info(user_invites)').map(c => c.name);
    if (!uiCols.includes('last_clicked_at')) {
      db.prepare('ALTER TABLE user_invites ADD COLUMN last_clicked_at TEXT').run();
    }
    if (!uiCols.includes('click_count')) {
      db.prepare('ALTER TABLE user_invites ADD COLUMN click_count INTEGER NOT NULL DEFAULT 0').run();
    }
    if (!uiCols.includes('last_reminder_at')) {
      db.prepare('ALTER TABLE user_invites ADD COLUMN last_reminder_at TEXT').run();
    }
    if (!uiCols.includes('reminder_count')) {
      db.prepare('ALTER TABLE user_invites ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0').run();
    }
    const fkErrors144 = db.pragma('foreign_key_check');
    if (fkErrors144.length) {
      throw new Error(`Migration 144: foreign_key_check meldet ${fkErrors144.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 144').run();
    logger.info('DB-Migration auf Version 144 abgeschlossen (user_invites: Click+Reminder-Tracking).');
  }

  if (version < 145) {
    // Share-Links: opaque Tokens, mit denen Owner einzelne Seiten oder
    // Kapitel an externe Reader ohne Account verschicken kann. CHECK-Constraint
    // erzwingt, dass je nach `kind` genau eine der Spalten page_id/chapter_id
    // gesetzt ist. owner_last_seen_at trackt Unread-Kommentare in der Owner-UI.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS share_links (
        token TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('page','chapter')),
        page_id INTEGER REFERENCES pages(page_id) ON DELETE CASCADE,
        chapter_id INTEGER REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        book_id INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        owner_email TEXT NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        intro TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        view_count INTEGER NOT NULL DEFAULT 0,
        owner_last_seen_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK (
          (kind='page' AND page_id IS NOT NULL AND chapter_id IS NULL) OR
          (kind='chapter' AND chapter_id IS NOT NULL AND page_id IS NULL)
        )
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_share_links_book ON share_links(book_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_share_links_owner ON share_links(owner_email)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_share_links_page ON share_links(page_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_share_links_chapter ON share_links(chapter_id)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS share_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        share_token TEXT NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,
        reader_name TEXT,
        body TEXT NOT NULL,
        ip_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_share_comments_token ON share_comments(share_token)').run();

    const fkErrors145 = db.pragma('foreign_key_check');
    if (fkErrors145.length) {
      throw new Error(`Migration 145: foreign_key_check meldet ${fkErrors145.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 145').run();
    logger.info('DB-Migration auf Version 145 abgeschlossen (share_links, share_comments).');
  }

  if (version < 146) {
    // api_tokens: Bearer-Tokens fuer externe Metrics-Scraper (Prometheus/HA/Grafana).
    // Plain-Token wird nur einmal beim Create zurueckgegeben; in der DB lebt nur der
    // SHA-256-Hash. scopes als kommaseparierte Liste (aktuell nur 'metrics:read').
    db.prepare(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_email   TEXT NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        token_hash    TEXT NOT NULL UNIQUE,
        display_name  TEXT NOT NULL,
        scopes        TEXT NOT NULL DEFAULT 'metrics:read',
        last_used_at  TEXT,
        last_used_ip  TEXT,
        expires_at    TEXT,
        revoked_at    TEXT,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_api_tokens_admin ON api_tokens(admin_email)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash)').run();

    const fkErrors146 = db.pragma('foreign_key_check');
    if (fkErrors146.length) {
      throw new Error(`Migration 146: foreign_key_check meldet ${fkErrors146.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 146').run();
    logger.info('DB-Migration auf Version 146 abgeschlossen (api_tokens fuer Prometheus-Scraper).');
  }

  if (version < 147) {
    // HubSpot-Sync: pro Buch eine Connection (Token verschluesselt via lib/crypto.js,
    // Blog-ID + Author-ID als Fix-Wahl beim Connect). Pro gepushter Page ein Link auf
    // den HubSpot-Post. Push erstellt ausschliesslich DRAFTs; Re-Push ist UI- und
    // Backend-blockiert (Existenz des Links).
    db.prepare(`
      CREATE TABLE IF NOT EXISTS hubspot_connections (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id                INTEGER NOT NULL UNIQUE REFERENCES books(book_id) ON DELETE CASCADE,
        token_enc              BLOB NOT NULL,
        blog_id                TEXT NOT NULL,
        author_id              TEXT NOT NULL,
        initial_import_done_at TEXT,
        last_import_at         TEXT,
        last_push_at           TEXT,
        created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_hubspot_conn_book ON hubspot_connections(book_id)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS hubspot_page_links (
        page_id            INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
        hub_id             INTEGER NOT NULL REFERENCES hubspot_connections(id) ON DELETE CASCADE,
        hubspot_post_id    TEXT NOT NULL,
        hubspot_state      TEXT,
        hubspot_created_at TEXT,
        last_pushed_at     TEXT,
        UNIQUE(hub_id, hubspot_post_id)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_hubspot_links_hub ON hubspot_page_links(hub_id)').run();

    const fkErrors147 = db.pragma('foreign_key_check');
    if (fkErrors147.length) {
      throw new Error(`Migration 147: foreign_key_check meldet ${fkErrors147.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 147').run();
    logger.info('DB-Migration auf Version 147 abgeschlossen (hubspot_connections + hubspot_page_links).');
  }

  // Schutzchecks: idempotent bei jedem Start.
  const feColsCheck = db.pragma('table_info(figure_events)').map(c => c.name);
  if (feColsCheck.length > 0 && !feColsCheck.includes('typ')) {
    db.exec("ALTER TABLE figure_events ADD COLUMN typ TEXT DEFAULT 'persoenlich'");
    logger.info('figure_events.typ nachgerüstet.');
  }
  const pagesCols20Check = db.pragma('table_info(pages)').map(c => c.name);
  if (pagesCols20Check.length > 0 && !pagesCols20Check.includes('chapter_id')) {
    db.exec('ALTER TABLE pages ADD COLUMN chapter_id INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pages_chapter_id ON pages(chapter_id)');
    logger.info('pages.chapter_id nachgerüstet.');
  }
  if (pagesCols20Check.length > 0 && !pagesCols20Check.includes('preview_text')) {
    db.exec('ALTER TABLE pages ADD COLUMN preview_text TEXT');
    logger.info('pages.preview_text nachgerüstet.');
  }
  const fsColsCheck = db.pragma('table_info(figure_scenes)').map(c => c.name);
  if (fsColsCheck.length > 0 && !fsColsCheck.includes('chapter_id')) {
    db.exec('ALTER TABLE figure_scenes ADD COLUMN chapter_id INTEGER');
    logger.info('figure_scenes.chapter_id nachgerüstet.');
  }
  if (fsColsCheck.length > 0 && !fsColsCheck.includes('page_id')) {
    db.exec('ALTER TABLE figure_scenes ADD COLUMN page_id INTEGER');
    logger.info('figure_scenes.page_id nachgerüstet.');
  }
  const bshColsCheck = db.pragma('table_info(book_stats_history)').map(c => c.name);
  if (!bshColsCheck.includes('chapter_count')) {
    db.exec('ALTER TABLE book_stats_history ADD COLUMN chapter_count INTEGER');
    logger.info('book_stats_history.chapter_count nachgerüstet.');
  }
  if (!bshColsCheck.includes('avg_sentence_len')) {
    db.exec('ALTER TABLE book_stats_history ADD COLUMN avg_sentence_len REAL');
    logger.info('book_stats_history.avg_sentence_len nachgerüstet.');
  }
}
runMigrations();

module.exports = { runMigrations };
