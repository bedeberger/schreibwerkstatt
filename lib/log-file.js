'use strict';
// Pfad der Winston-Logdatei — geteilt von logger.js (Schreiben) und
// routes/admin-logs.js (Lesen inkl. Rotationen schreibwerkstatt1.log …).
//
// `LOG_DIR` (ENV) legt die Logs ausserhalb des Installationsverzeichnisses ab,
// z.B. /var/log/schreibwerkstatt — dort ueberleben sie jeden Deploy
// unabhaengig von den rsync-Excludes in deploy/deploy.sh. Ohne LOG_DIR liegt
// die Datei wie bisher im App-Wurzelverzeichnis.

const path = require('path');

const LOG_DIR = (process.env.LOG_DIR || '').trim() || path.join(__dirname, '..');
const LOG_FILE = path.join(LOG_DIR, 'schreibwerkstatt.log');

module.exports = { LOG_DIR, LOG_FILE };
