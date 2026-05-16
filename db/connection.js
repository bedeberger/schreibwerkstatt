const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'schreibwerkstatt.db');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -65536');
db.pragma('mmap_size = 268435456');
db.pragma('temp_store = MEMORY');
db.pragma('busy_timeout = 5000');
db.pragma('wal_autocheckpoint = 1000');

module.exports = { db, DB_FILE };
